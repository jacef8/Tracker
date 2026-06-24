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

function emit(evt) {
  listeners.forEach((cb) => { try { cb(evt); } catch (e) { /* ignore */ } });
}

export function onVoiceEvent(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((x) => x !== cb); };
}

export function currentRoom() { return session ? session.room : null; }

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
  removeBar();
  emit({ type: 'left' });
}

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
    emit({ type: 'joined', room: session.room });
  } catch (e) {
    console.error('[voice] connect failed', e);
    setTalker('connect failed', '#f85149');
    emit({ type: 'error', message: 'connect failed: ' + e.message });
  }
}

// PTT — push ON / push OFF. First tap also acquires the mic (for auto-join
// receivers) and unblocks audio playback, since the tap is a user gesture.
async function togglePtt() {
  if (!room) { setTalker('not connected', '#f85149'); return; }
  const next = !micOn;
  // IMPORTANT: kick off setMicrophoneEnabled SYNCHRONOUSLY inside the tap, before
  // any await. getUserMedia's permission prompt only appears while the user
  // gesture is "active"; an await first (e.g. startAudio, a fetch) consumes that
  // activation and the prompt is silently blocked → "mic blocked, no prompt".
  let micPromise;
  try { micPromise = room.localParticipant.setMicrophoneEnabled(next); }
  catch (e) { micPromise = Promise.reject(e); }
  try {
    await micPromise;
  } catch (e) {
    console.error('[voice] mic toggle failed', e);
    setTalker('⚠ mic blocked — allow it in browser/app settings', '#f85149');
    emit({ type: 'error', message: 'mic: ' + ((e && e.message) || e) });
    return;
  }
  try { await room.startAudio(); } catch (e) {}
  micOn = next;
  updatePttButton();
  emit({ type: 'ptt', on: micOn, room: session && session.room });
}
function updatePttButton() {
  const btn = barEl && barEl.querySelector('#gv-ptt');
  if (!btn) return;
  btn.classList.toggle('gv-keyed', micOn);
  btn.title = micOn ? 'On air — tap to stop' : 'Tap to talk';
  setTx(micOn);
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
  setTalker('🔊 tap to hear', '#f0a500');
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
    #gv-ptt { width: 64px; height: 64px; border-radius: 50%; border: none; flex: 0 0 auto;
      background: #f0a500; color: #1a1200; cursor: pointer; display: flex; align-items: center; justify-content: center;
      user-select: none; -webkit-user-select: none; box-shadow: 0 2px 0 #b87d00;
      transition: transform .08s, box-shadow .12s, background .12s; }
    #gv-ptt svg { width: 28px; height: 28px; }
    #gv-ptt:active { transform: scale(.95); }
    #gv-ptt.gv-keyed { background: #ff5252; color: #fff; box-shadow: 0 0 0 4px rgba(255,82,82,.25), 0 2px 0 #a30000; }
    #gv-bar .gv-icon { background: none; border: none; color: #8b949e; font-size: 18px; cursor: pointer; padding: 6px; }
    #gv-bar .gv-icon:active { color: #e6edf3; }
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
    <button id="gv-ptt" title="Tap to talk" aria-label="Push to talk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg></button>
    <button class="gv-icon" id="gv-leave" title="Leave">✕</button>`;
  document.body.appendChild(barEl);

  const ptt = barEl.querySelector('#gv-ptt');
  ptt.addEventListener('click', (e) => { e.stopPropagation(); togglePtt(); });
  updatePttButton();
  barEl.querySelector('#gv-leave').addEventListener('click', (e) => { e.stopPropagation(); leaveVoice(); });
}

function showBar() { if (barEl) barEl.style.display = 'flex'; }
function removeBar() { if (barEl) { barEl.remove(); barEl = null; } }
function setTalker(txt, color) { const el = barEl && barEl.querySelector('#gv-talker'); if (el) { el.textContent = txt; if (color) el.style.color = color; } }
function setTx(on) { const el = barEl && barEl.querySelector('#gv-tx'); if (el) el.classList.toggle('tx-on', !!on); }
function setRx(on) { const el = barEl && barEl.querySelector('#gv-rx'); if (el) el.classList.toggle('rx-on', !!on); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
