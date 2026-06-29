// ─────────────────────────────────────────────────────────────────────────
// GROUNDWAVE voice module  —  shared push-to-talk client (LiveKit SFU)
//
// This is the seam described in GROUNDWAVE-x-GroundLink-VOICE-SPEC.md.
// Both GroundLink (docked bar) and standalone GROUNDWAVE wrap this same module.
//
// Public surface (keep it small — spec §10):
//   openVoice({ room, identity, name, partnerName, livekitUrl, tokenEndpoint, listen })
//   leaveVoice()
//   currentRoom()      // the room id we're connected to, or null
//   onVoiceEvent(cb)   // cb({ type, ... }) — 'talking', 'joined', 'left', 'error'
//
// `listen: true` = auto-join as a receiver (no user gesture): connect and play
// incoming audio, but don't grab the mic until the user taps PTT. Used when the
// page auto-joins on an incoming voice ping, so audio arrives with no "accept".
//
// Transport is LiveKit (an SFU), NOT mesh. The room CONNECTION is held at module
// scope so collapse/expand/redock never tears it down (spec §5).
// ─────────────────────────────────────────────────────────────────────────

import {
  Room,
  RoomEvent,
  Track,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/+esm';

// ── Module-level session state (the connection lives here, above the bar) ──
let room = null;          // active LiveKit Room, or null
let session = null;       // { room, identity, name, partnerName, listen }
let listeners = [];       // onVoiceEvent subscribers
let barEl = null;         // docked bar DOM root
let audioSink = null;     // hidden container that holds remote <audio> elements
let micOn = false;        // toggle PTT state: true = transmitting (open mic)
// ── Transmission recording: each PTT press is captured as a short clip and handed
// to the page (window._onVoiceClip) so missed transmissions can be replayed later.
let _rec = null, _recChunks = [], _recStart = 0, _recCap = null;

function emit(evt) {
  listeners.forEach((cb) => { try { cb(evt); } catch (e) { /* ignore */ } });
}

// Native car-radio fix: ask the Android wrapper (window.GLAudioRouter, injected by
// MainActivity) to keep voice on the MEDIA audio path so a vehicle's Bluetooth doesn't
// treat push-to-talk as a phone call and mute the radio. No-op on the web, or if the user
// turned it off (gl_car_audio === '0'). Safe to call repeatedly.
function _carAudio(on) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('gl_car_audio') === '0') return;
    const a = (typeof window !== 'undefined') && window.GLAudioRouter;
    if (!a) return;
    if (on) { if (a.startMediaMode) a.startMediaMode(); }
    else { if (a.stopMediaMode) a.stopMediaMode(); }
  } catch (e) { /* ignore */ }
}

export function onVoiceEvent(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((x) => x !== cb); };
}

export function currentRoom() { return session ? session.room : null; }

// iOS won't play WebRTC audio until a user gesture unlocks the audio system. Call this
// SYNCHRONOUSLY from a tap (before any await) to unlock it, and resume any live room audio.
export function unlockAudio() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!window._gvAC) window._gvAC = new AC();
      if (window._gvAC.state === 'suspended') window._gvAC.resume();
      var b = window._gvAC.createBuffer(1, 1, 22050), s = window._gvAC.createBufferSource();
      s.buffer = b; s.connect(window._gvAC.destination); s.start(0);
    }
  } catch (e) {}
  try { if (room) room.startAudio(); } catch (e) {}
  try { Object.keys(monRooms).forEach((id) => { if (monRooms[id].room) monRooms[id].room.startAudio(); }); } catch (e) {}
}

// ── Public: open a voice session and connect right away ─────────────────────
// Idempotent: if already in the SAME room, just re-show the bar (audio survives).
// Initiator path (from a tap) primes the mic. Receiver path (`listen:true`,
// auto-join) connects to hear, and acquires the mic only when the user taps PTT.
export function openVoice(opts) {
  const { room: roomName, identity, name, partnerName, livekitUrl, tokenEndpoint, listen } = opts || {};
  if (!roomName || !identity || !livekitUrl || !tokenEndpoint) {
    console.error('[voice] openVoice missing required fields', opts);
    emit({ type: 'error', message: 'voice not configured' });
    return;
  }
  if (room && session && session.room === roomName) { showBar(); return; }
  if (room) { try { room.disconnect(); } catch (e) {} room = null; }

  session = {
    room: roomName, identity, name: name || identity,
    partnerName: partnerName || 'member', livekitUrl, tokenEndpoint, listen: !!listen,
  };
  micOn = false;
  renderBar();
  setTalker('connecting…', '#8b949e');
  connectVoice();
}

// ── Public: leave + tear down ──────────────────────────────────────────────
export function leaveVoice() {
  if (room) { try { room.disconnect(); } catch (e) {} }
  room = null;
  session = null;
  micOn = false;
  _carAudio(false);   // restore normal audio routing when we leave voice
  removeBar();
  emit({ type: 'left' });
}

// ── Device monitor: stay joined (listen-only) to your OWNED devices' channels so
// you HEAR the watch from any screen without tapping Talk, and get a "talking" event
// for an alert. Runs as SEPARATE LiveKit rooms so it never disturbs the main voice bar.
let monRooms = {};   // deviceId -> { room, name, talking }

async function mintToken(endpoint, roomName, identity, name) {
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomName, identity, name }),
  });
  if (!res.ok) throw new Error('token endpoint ' + res.status);
  const data = await res.json();
  if (!data.token) throw new Error('no token in response');
  return data.token;
}

// devices: [{ id, name }]. Reconciles: joins new ones, drops removed ones, leaves the rest.
export async function startDeviceMonitor(opts) {
  const { devices, identity, livekitUrl, tokenEndpoint } = opts || {};
  if (!devices || !livekitUrl || !tokenEndpoint || !identity) return;
  const wanted = {};
  devices.forEach((d) => { if (d && d.id) wanted[d.id] = d.name || 'device'; });
  // Drop monitors no longer wanted.
  Object.keys(monRooms).forEach((id) => {
    if (!wanted[id]) { try { monRooms[id].room && monRooms[id].room.disconnect(); } catch (e) {} delete monRooms[id]; }
  });
  // Add monitors for newly-wanted devices.
  for (const id of Object.keys(wanted)) {
    if (monRooms[id]) { monRooms[id].name = wanted[id]; continue; }
    monRooms[id] = { room: null, name: wanted[id], talking: false };   // reserve slot (avoid double-join races)
    const roomName = 'gv_dev_' + id + '_ALL';
    const monIdentity = identity + '__mon';   // distinct identity so it never kicks your Talk session
    try {
      const token = await mintToken(tokenEndpoint, roomName, monIdentity, 'monitor');
      const r = new Room();
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        // If you're actively in THIS device's Talk channel, that bar already plays it — skip to avoid echo.
        if (session && session.room === roomName) return;
        const el = track.attach(); el.autoplay = true; el.setAttribute('playsinline', '');
        ensureAudioSink().appendChild(el);
      });
      r.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
      });
      r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const on = speakers.some((p) => p.identity && p.identity !== monIdentity);
        const slot = monRooms[id]; if (!slot) return;
        if (on !== slot.talking) { slot.talking = on; emit({ type: 'deviceTalking', id, name: slot.name, on }); }
      });
      await r.connect(livekitUrl, token);
      try { await r.startAudio(); } catch (e) {}
      if (monRooms[id]) monRooms[id].room = r; else { try { r.disconnect(); } catch (e) {} }   // dropped while connecting
    } catch (e) {
      console.error('[voice] device monitor failed for ' + id, e);
      delete monRooms[id];
    }
  }
}

export function stopDeviceMonitor() {
  Object.keys(monRooms).forEach((id) => { try { monRooms[id].room && monRooms[id].room.disconnect(); } catch (e) {} });
  monRooms = {};
}

export function deviceMonitorIds() { return Object.keys(monRooms); }

// ───────────────────────────── connection ─────────────────────────────────
async function connectVoice() {
  if (!session) return;

  let token;
  try {
    const res = await fetch(session.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: session.room, identity: session.identity, name: session.name }),
    });
    if (!res.ok) throw new Error('token endpoint ' + res.status);
    const data = await res.json();
    token = data.token;
    if (!token) throw new Error('no token in response');
  } catch (e) {
    console.error('[voice] token mint failed', e);
    setTalker('token error', '#f85149');
    emit({ type: 'error', message: 'token mint failed: ' + e.message });
    return;
  }

  room = new Room();

  // Remote audio: attach each subscribed audio track to a hidden <audio> element.
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      ensureAudioSink().appendChild(el);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
  });

  // Talker indicator: who is actively speaking; falls back to presence otherwise.
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const remote = speakers.find((p) => p.identity !== session.identity);
    if (remote) {
      const who = (remote.name || remote.identity);
      setTalker('◉ ' + who + ' talking', '#00e676');
      setRx(true);
      emit({ type: 'talking', who, identity: remote.identity });
    } else {
      setRx(false);
      updatePresence();
      emit({ type: 'talking', who: null });
    }
  });
  room.on(RoomEvent.ParticipantConnected, updatePresence);
  room.on(RoomEvent.ParticipantDisconnected, updatePresence);
  // Autoplay may be blocked (esp. on an auto-join with no gesture) — surface a tap.
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (room && room.canPlaybackAudio) hideAudioBlocked(); else showAudioBlocked();
  });
  room.on(RoomEvent.Disconnected, () => { setTalker('disconnected', '#8b949e'); });

  try {
    await room.connect(session.livekitUrl, token);
    // Don't grab the mic here — connect() is several awaits past the original tap,
    // so the user gesture is gone and getUserMedia would be blocked with no prompt.
    // The mic is acquired on the user's first PTT tap instead (a live gesture).
    try { await room.startAudio(); } catch (e) {}
    updatePresence();
    updatePttButton();
    if (room.canPlaybackAudio === false) showAudioBlocked();
    _carAudio(true);   // keep the car radio alive — don't let this read as a phone call
    emit({ type: 'joined', room: session.room });
  } catch (e) {
    console.error('[voice] connect failed', e);
    setTalker('connect failed', '#f85149');
    emit({ type: 'error', message: 'connect failed: ' + e.message });
  }
}

// Push-to-talk: HOLD to transmit, release to stop. The press is a user gesture, so the
// mic (getUserMedia) is acquired SYNCHRONOUSLY on press — required for the permission
// prompt to appear and for auto-join receivers to unblock audio playback.
async function setPtt(on) {
  if (!room) { setTalker('not connected', '#f85149'); return; }
  if (on === micOn) return;                      // already in the requested state
  // Kick off setMicrophoneEnabled BEFORE any await so the gesture is still active.
  let micPromise;
  try { micPromise = room.localParticipant.setMicrophoneEnabled(on); }
  catch (e) { micPromise = Promise.reject(e); }
  micOn = on;                                    // reflect keyed state immediately (snappy)
  updatePttButton();
  // Ping the room so members with the app backgrounded get a "someone's talking"
  // notification (they can't hear live audio when the app is closed). Page debounces.
  if (on) { try { if (window._onVoiceTx) window._onVoiceTx(); } catch (e) {} }
  else { _stopClipRecording(); }   // release → finalize the clip for replay
  try {
    await micPromise;
  } catch (e) {
    console.error('[voice] mic set failed', e);
    setTalker('⚠ mic blocked — allow it in browser/app settings', '#f85149');
    emit({ type: 'error', message: 'mic: ' + ((e && e.message) || e) });
    micOn = false; updatePttButton();
    return;
  }
  if (on) { try { await room.startAudio(); } catch (e) {} _startClipRecording(); }   // mic live → start capturing
  emit({ type: 'ptt', on: micOn, room: session && session.room });
}
function updatePttButton() {
  const btn = barEl && barEl.querySelector('#gv-ptt');
  if (!btn) return;
  btn.classList.toggle('gv-keyed', micOn);
  btn.title = micOn ? 'On air — release to stop' : 'Hold to talk';
  var hint = btn.querySelector('.gv-ptt-hint'); if (hint) hint.textContent = micOn ? 'ON AIR' : 'HOLD';
  setTx(micOn);
}

// ── Clip recording (for replaying missed transmissions) ────────────────────
// Records straight off the SAME mic track LiveKit is publishing (no second
// getUserMedia / no extra permission). On release the clip is finalized and
// handed to the page via window._onVoiceClip(dataUrl, meta) to store + list.
function _localMicStream() {
  try {
    const lp = room && room.localParticipant;
    if (!lp) return null;
    let pub = null;
    try { pub = lp.getTrackPublication && lp.getTrackPublication(Track.Source.Microphone); } catch (e) {}
    if ((!pub || !pub.track) && lp.audioTrackPublications) {
      for (const p of lp.audioTrackPublications.values()) { if (p && p.track) { pub = p; break; } }
    }
    const mst = pub && pub.track && pub.track.mediaStreamTrack;
    if (mst) return new MediaStream([mst]);
  } catch (e) {}
  return null;
}
function _pickClipMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (let i = 0; i < cands.length; i++) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(cands[i])) return cands[i]; } catch (e) {}
  }
  return '';
}
function _startClipRecording() {
  try {
    if (!window.MediaRecorder) return;
    const stream = _localMicStream();
    if (!stream) return;
    const mime = _pickClipMime();
    _recChunks = [];
    _rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 })
                : new MediaRecorder(stream);
    _rec.ondataavailable = (e) => { if (e.data && e.data.size) _recChunks.push(e.data); };
    _rec.onstop = _onClipStop;
    _recStart = Date.now();
    _rec.start();
    // Hard cap a single clip at 30s so we never store a giant blob.
    _recCap = setTimeout(() => { try { if (_rec && _rec.state !== 'inactive') _rec.stop(); } catch (e) {} }, 30000);
  } catch (e) { _rec = null; }
}
function _stopClipRecording() {
  try { if (_recCap) { clearTimeout(_recCap); _recCap = null; } } catch (e) {}
  try { if (_rec && _rec.state !== 'inactive') _rec.stop(); } catch (e) {}
}
function _onClipStop() {
  const chunks = _recChunks; _recChunks = [];
  const mime = (_rec && _rec.mimeType) || 'audio/webm';
  _rec = null;
  const durMs = Date.now() - _recStart;
  if (!chunks.length || durMs < 600) return;   // ignore accidental taps (<0.6s)
  let blob;
  try { blob = new Blob(chunks, { type: mime }); } catch (e) { return; }
  // Keep RTDB light: skip storing very large clips (live listeners still heard it).
  if (blob.size > 96 * 1024) {
    try { if (window._onVoiceClip) window._onVoiceClip(null, { durMs: durMs, tooBig: true }); } catch (e) {}
    return;
  }
  try {
    const reader = new FileReader();
    reader.onloadend = () => {
      try { if (window._onVoiceClip) window._onVoiceClip(reader.result, { durMs: durMs, mime: mime }); } catch (e) {}
    };
    reader.readAsDataURL(blob);
  } catch (e) {}
}

function updatePresence() {
  if (barEl && barEl._audioBlocked) return; // don't clobber the tap-to-hear prompt
  const remotes = room && room.remoteParticipants ? Array.from(room.remoteParticipants.values()) : [];
  const names = remotes.map((p) => p.name || p.identity);
  if (names.length === 0) setTalker('waiting for others…', '#8b949e');
  else setTalker('✓ ' + names.join(', ') + ' in room', '#8b949e');
}

// ── Autoplay blocked: show a tap target that resumes audio ──────────────────
function showAudioBlocked() {
  if (!barEl) return;
  barEl._audioBlocked = true;
  setTalker('Tap to hear', '#f0a500');
  barEl.style.cursor = 'pointer';
  barEl.addEventListener('click', _resumeAudio);
}
function hideAudioBlocked() {
  if (!barEl) return;
  barEl._audioBlocked = false;
  barEl.style.cursor = '';
  barEl.removeEventListener('click', _resumeAudio);
  updatePresence();
}
function _resumeAudio() { if (room) { try { room.startAudio(); } catch (e) {} } }

// ───────────────────────────── docked bar UI ──────────────────────────────
function ensureAudioSink() {
  if (!audioSink) {
    audioSink = document.createElement('div');
    audioSink.id = 'gv-audio-sink';
    audioSink.style.display = 'none';
    document.body.appendChild(audioSink);
  }
  return audioSink;
}

function injectStylesOnce() {
  if (document.getElementById('gv-styles')) return;
  const s = document.createElement('style');
  s.id = 'gv-styles';
  s.textContent = `
    #gv-bar { position: fixed; left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom,0px));
      z-index: 4000; background: #161b22; border: 1px solid #30363d; border-radius: 14px;
      box-shadow: 0 6px 30px rgba(0,0,0,.55); color: #e6edf3; font-family: system-ui, sans-serif;
      display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
    #gv-bar .gv-meta { flex: 1; min-width: 0; }
    #gv-bar .gv-name { font-size: 15px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #gv-bar .gv-talker { font-size: 12px; font-weight: 700; color: #8b949e; height: 15px; }
    #gv-bar .gv-leds { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
    #gv-bar .gv-ind { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800;
      letter-spacing: .06em; padding: 4px 9px; border-radius: 7px; background: #0d1117;
      color: #3a4150; border: 1px solid #23272e; }
    #gv-bar .gv-ind .gv-led { width: 9px; height: 9px; border-radius: 50%; background: #3a4150; transition: all .1s; }
    #gv-bar .gv-ind.tx-on { color: #ff8a8a; border-color: #5a1f1f; background: #241012; }
    #gv-bar .gv-ind.tx-on .gv-led { background: #ff5252; box-shadow: 0 0 8px #ff5252; }
    #gv-bar .gv-ind.rx-on { color: #5ef0a0; border-color: #1d5236; background: #0f2418; }
    #gv-bar .gv-ind.rx-on .gv-led { background: #00e676; box-shadow: 0 0 8px #00e676; }
    #gv-ptt { width: 66px; height: 66px; border-radius: 50%; border: none; flex: 0 0 auto;
      background: #f0a500; color: #1a1200; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
      user-select: none; -webkit-user-select: none; touch-action: none; box-shadow: 0 2px 0 #b87d00;
      transition: transform .08s, box-shadow .12s, background .12s; }
    #gv-ptt svg { width: 22px; height: 22px; }
    #gv-ptt .gv-ptt-hint { font-size: 10px; font-weight: 900; letter-spacing: .06em; line-height: 1; }
    #gv-ptt:active { transform: scale(.95); }
    #gv-ptt.gv-keyed { background: #ff5252; color: #fff; box-shadow: 0 0 0 4px rgba(255,82,82,.25), 0 2px 0 #a30000; }
    /* Gentle pulse while idle to invite a TAP (people kept trying to hold it). */
    #gv-ptt:not(.gv-keyed) { animation: gvPulse 2s ease-in-out infinite; }
    @keyframes gvPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(240,165,0,.45), 0 2px 0 #b87d00; } 50% { box-shadow: 0 0 0 7px rgba(240,165,0,0), 0 2px 0 #b87d00; } }
    #gv-bar .gv-icon { position: relative; background: none; border: none; color: #8b949e; font-size: 18px; cursor: pointer; padding: 6px; }
    #gv-bar .gv-icon:active { color: #e6edf3; }
    #gv-bar #gv-log { color: #c9d1d9; }
    #gv-bar .gv-badge { position: absolute; top: -1px; right: -1px; min-width: 16px; height: 16px; padding: 0 4px;
      border-radius: 8px; background: #ff5252; color: #fff; font-size: 10px; font-weight: 900; line-height: 16px;
      text-align: center; box-shadow: 0 0 0 2px #161b22; display: none; }
    #gv-bar .gv-badge.show { display: block; }
  `;
  document.head.appendChild(s);
}

function renderBar() {
  injectStylesOnce();
  removeBar();
  barEl = document.createElement('div');
  barEl.id = 'gv-bar';
  barEl.innerHTML = `
    <div class="gv-leds">
      <div class="gv-ind" id="gv-tx"><span class="gv-led"></span>TX</div>
      <div class="gv-ind" id="gv-rx"><span class="gv-led"></span>RX</div>
    </div>
    <div class="gv-meta">
      <div class="gv-name">${escapeHtml(session.partnerName)}</div>
      <div class="gv-talker" id="gv-talker"></div>
    </div>
    <button id="gv-ptt" title="Tap to talk (don't hold)" aria-label="Tap to talk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg><span class="gv-ptt-hint">TAP</span></button>
    <button class="gv-icon" id="gv-log" title="Missed transmissions" aria-label="Transmissions"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;display:block"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg><span class="gv-badge" id="gv-log-badge"></span></button>
    <button class="gv-icon" id="gv-leave" title="Leave">✕</button>`;
  document.body.appendChild(barEl);
  document.body.classList.add('gv-active');   // lets the page lift its bottom toolbar above the voice bar

  const ptt = barEl.querySelector('#gv-ptt');
  const _pttDown = (e) => { e.preventDefault(); e.stopPropagation(); setPtt(true); };
  const _pttUp = (e) => { e.stopPropagation(); setPtt(false); };
  ptt.addEventListener('pointerdown', _pttDown);
  ptt.addEventListener('pointerup', _pttUp);
  ptt.addEventListener('pointerleave', _pttUp);   // slide finger off = release
  ptt.addEventListener('pointercancel', _pttUp);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());  // no long-press menu on mobile
  updatePttButton();
  barEl.querySelector('#gv-log').addEventListener('click', (e) => { e.stopPropagation(); try { if (window._openVoiceLog) window._openVoiceLog(); } catch (_) {} });
  barEl.querySelector('#gv-leave').addEventListener('click', (e) => { e.stopPropagation(); leaveVoice(); });
}

function showBar() { if (barEl) barEl.style.display = 'flex'; }
function removeBar() { if (barEl) { barEl.remove(); barEl = null; } document.body.classList.remove('gv-active'); }
function setTalker(txt, color) { const el = barEl && barEl.querySelector('#gv-talker'); if (el) { el.textContent = txt; if (color) el.style.color = color; } }
function setTx(on) { const el = barEl && barEl.querySelector('#gv-tx'); if (el) el.classList.toggle('tx-on', !!on); }
function setRx(on) { const el = barEl && barEl.querySelector('#gv-rx'); if (el) el.classList.toggle('rx-on', !!on); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
