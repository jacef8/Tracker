// ─────────────────────────────────────────────────────────────────────────
// GROUNDWAVE voice module  —  shared push-to-talk client (LiveKit SFU)
//
// This is the seam described in GROUNDWAVE-x-GroundLink-VOICE-SPEC.md.
// Both GroundLink (docked bar) and standalone GROUNDWAVE wrap this same module.
//
// Public surface (keep it small — spec §10):
//   openVoice({ room, identity, name, partnerName, livekitUrl, tokenEndpoint })
//   leaveVoice()
//   onVoiceEvent(cb)   // cb({ type, ... }) — 'talking', 'joined', 'left', 'error'
//
// Transport is LiveKit (an SFU), NOT mesh. The room CONNECTION is held at module
// scope so collapse/expand/redock never tears it down (spec §5). For M1 there is
// only the collapsed docked bar; the persistent-connection design makes the
// expanded view (M3) a pure rendering change later.
// ─────────────────────────────────────────────────────────────────────────

import {
  Room,
  RoomEvent,
  Track,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/+esm';

// ── Module-level session state (the connection lives here, above the bar) ──
let room = null;          // active LiveKit Room, or null
let session = null;       // { room, identity, name, partnerName } of current voice
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

// ── Public: open (or re-render) a voice session ────────────────────────────
// Idempotent: if already connected to the SAME room, this just re-shows the bar
// and does NOT reconnect (audio survives — spec §5).
export function openVoice(opts) {
  const { room: roomName, identity, name, partnerName, livekitUrl, tokenEndpoint } = opts || {};
  if (!roomName || !identity || !livekitUrl || !tokenEndpoint) {
    console.error('[voice] openVoice missing required fields', opts);
    emit({ type: 'error', message: 'voice not configured' });
    return;
  }

  // Already in this exact room → just surface the bar, keep the live connection.
  if (room && session && session.room === roomName) {
    showBar();
    return;
  }
  // Switching rooms → tear down the old one first.
  if (room) { try { room.disconnect(); } catch (e) {} room = null; }

  session = { room: roomName, identity, name: name || identity, partnerName: partnerName || 'member', livekitUrl, tokenEndpoint };
  renderBar('prime');   // shows the "Join voice" priming tap (spec §6)
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

// ───────────────────────── connection (after priming tap) ─────────────────
async function joinAndConnect() {
  if (!session) return;
  setBarStatus('Connecting…');

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
    setBarStatus('Token error');
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

  // Talker indicator (spec §5): who is actively speaking. When nobody's talking,
  // fall back to a presence line so you can SEE the other side has joined — M1 has
  // no incoming ring, so both people must open voice to the same room themselves.
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

  room.on(RoomEvent.Disconnected, () => { setBarStatus('Disconnected'); });

  try {
    await room.connect(session.livekitUrl, token);
    // Prime the mic now (still inside the user gesture chain): create the track,
    // then immediately mute it. PTT just toggles mute after this — fast, no
    // re-acquire. Half-duplex talking rule is enforced socially (spec §3).
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setMicrophoneEnabled(false);
    micOn = false;
    // Unblock autoplay of incoming audio (the whole reason for the join tap, §6).
    try { await room.startAudio(); } catch (e) {}
    renderBar('live');
    updatePresence();
    emit({ type: 'joined', room: session.room });
  } catch (e) {
    console.error('[voice] connect failed', e);
    setBarStatus('Connect failed');
    emit({ type: 'error', message: 'connect failed: ' + e.message });
  }
}

// PTT — push ON / push OFF. Tap once to start transmitting (open mic), tap again
// to stop. (Replaces hold-to-talk per operator request.)
async function togglePtt() {
  if (!room) return;
  const next = !micOn;
  try { await room.localParticipant.setMicrophoneEnabled(next); } catch (e) { return; }
  micOn = next;
  updatePttButton();
}
function updatePttButton() {
  const btn = barEl && barEl.querySelector('#gv-ptt');
  if (!btn) return;
  if (micOn) { btn.classList.add('gv-keyed');    btn.innerHTML = '● ON<br>AIR'; }
  else       { btn.classList.remove('gv-keyed'); btn.innerHTML = 'TAP TO<br>TALK'; }
  setTx(micOn);
}

// Show who else is in the room when nobody is actively talking, so it's obvious
// the other person has joined (M1 has no incoming-call ring).
function updatePresence() {
  const remotes = room && room.remoteParticipants ? Array.from(room.remoteParticipants.values()) : [];
  const names = remotes.map((p) => p.name || p.identity);
  if (names.length === 0) setTalker('waiting for others to join…', '#8b949e');
  else setTalker('✓ ' + names.join(', ') + ' in room', '#8b949e');
}

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
    #gv-bar .gv-to { font-size: 11px; color: #8b949e; letter-spacing: .04em; text-transform: uppercase; }
    #gv-bar .gv-name { font-size: 15px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #gv-bar .gv-talker { font-size: 12px; font-weight: 700; color: #8b949e; height: 15px; }
    #gv-bar .gv-status { font-size: 12px; color: #8b949e; }
    /* TX / RX indicators — dim when idle, glow when active */
    #gv-bar .gv-leds { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
    #gv-bar .gv-ind { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800;
      letter-spacing: .06em; padding: 4px 9px; border-radius: 7px; background: #0d1117;
      color: #3a4150; border: 1px solid #23272e; }
    #gv-bar .gv-ind .gv-led { width: 9px; height: 9px; border-radius: 50%; background: #3a4150; transition: all .1s; }
    #gv-bar .gv-ind.tx-on { color: #ff8a8a; border-color: #5a1f1f; background: #241012; }
    #gv-bar .gv-ind.tx-on .gv-led { background: #ff5252; box-shadow: 0 0 8px #ff5252; }
    #gv-bar .gv-ind.rx-on { color: #5ef0a0; border-color: #1d5236; background: #0f2418; }
    #gv-bar .gv-ind.rx-on .gv-led { background: #00e676; box-shadow: 0 0 8px #00e676; }
    #gv-join { background: #00e676; color: #00210f; border: none; border-radius: 10px;
      font-weight: 800; font-size: 14px; padding: 12px 18px; cursor: pointer; }
    #gv-ptt { min-width: 108px; height: 46px; border-radius: 23px; border: none; flex: 0 0 auto;
      background: #f0a500; color: #1a1200; font-weight: 900; font-size: 13px; line-height: 1.05; cursor: pointer;
      user-select: none; -webkit-user-select: none; box-shadow: 0 2px 0 #b87d00;
      transition: transform .05s, box-shadow .05s; }
    #gv-ptt.gv-keyed { background: #ff5252; color: #fff; transform: translateY(1px); box-shadow: 0 1px 0 #a30000; }
    #gv-bar .gv-icon { background: none; border: none; color: #8b949e; font-size: 18px; cursor: pointer; padding: 6px; }
    #gv-bar .gv-icon:active { color: #e6edf3; }
  `;
  document.head.appendChild(s);
}

function renderBar(mode) {
  injectStylesOnce();
  removeBar();
  barEl = document.createElement('div');
  barEl.id = 'gv-bar';

  if (mode === 'prime') {
    barEl.innerHTML = `
      <div class="gv-meta">
        <div class="gv-to">Talk to</div>
        <div class="gv-name">${escapeHtml(session.partnerName)}</div>
        <div class="gv-status" id="gv-status">Tap to enable mic &amp; audio</div>
      </div>
      <button id="gv-join">🎙 Join voice</button>
      <button class="gv-icon" id="gv-leave" title="Leave">✕</button>`;
    document.body.appendChild(barEl);
    barEl.querySelector('#gv-join').addEventListener('click', joinAndConnect);
    barEl.querySelector('#gv-leave').addEventListener('click', leaveVoice);
    return;
  }

  // mode === 'live'
  barEl.innerHTML = `
    <div class="gv-leds">
      <div class="gv-ind" id="gv-tx"><span class="gv-led"></span>TX</div>
      <div class="gv-ind" id="gv-rx"><span class="gv-led"></span>RX</div>
    </div>
    <div class="gv-meta">
      <div class="gv-name">${escapeHtml(session.partnerName)}</div>
      <div class="gv-talker" id="gv-talker"></div>
    </div>
    <button id="gv-ptt">TAP TO<br>TALK</button>
    <button class="gv-icon" id="gv-leave" title="Leave">✕</button>`;
  document.body.appendChild(barEl);

  const ptt = barEl.querySelector('#gv-ptt');
  ptt.addEventListener('click', togglePtt);   // push ON / push OFF
  updatePttButton();
  barEl.querySelector('#gv-leave').addEventListener('click', leaveVoice);
}

function showBar() { if (barEl) barEl.style.display = 'flex'; }
function removeBar() { if (barEl) { barEl.remove(); barEl = null; } }
function setBarStatus(txt) { const el = barEl && barEl.querySelector('#gv-status'); if (el) el.textContent = txt; }
function setTalker(txt, color) { const el = barEl && barEl.querySelector('#gv-talker'); if (el) { el.textContent = txt; if (color) el.style.color = color; } }
function setTx(on) { const el = barEl && barEl.querySelector('#gv-tx'); if (el) el.classList.toggle('tx-on', !!on); }
function setRx(on) { const el = barEl && barEl.querySelector('#gv-rx'); if (el) el.classList.toggle('rx-on', !!on); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
