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

  // Talker indicator (spec §5): who is actively speaking.
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const remote = speakers.find((p) => p.identity !== session.identity);
    if (remote) {
      const who = (remote.name || remote.identity);
      setTalker('◉ ' + who + ' talking');
      emit({ type: 'talking', who, identity: remote.identity });
    } else {
      setTalker('');
      emit({ type: 'talking', who: null });
    }
  });

  room.on(RoomEvent.Disconnected, () => { setBarStatus('Disconnected'); });

  try {
    await room.connect(session.livekitUrl, token);
    // Prime the mic now (still inside the user gesture chain): create the track,
    // then immediately mute it. PTT just toggles mute after this — fast, no
    // re-acquire. Half-duplex talking rule is enforced socially (spec §3).
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setMicrophoneEnabled(false);
    // Unblock autoplay of incoming audio (the whole reason for the join tap, §6).
    try { await room.startAudio(); } catch (e) {}
    renderBar('live');
    emit({ type: 'joined', room: session.room });
  } catch (e) {
    console.error('[voice] connect failed', e);
    setBarStatus('Connect failed');
    emit({ type: 'error', message: 'connect failed: ' + e.message });
  }
}

// PTT key-up / key-down — toggles the published mic mute state.
async function pttDown() {
  if (!room) return;
  try { await room.localParticipant.setMicrophoneEnabled(true); } catch (e) {}
  const btn = barEl && barEl.querySelector('#gv-ptt');
  if (btn) btn.classList.add('gv-keyed');
}
async function pttUp() {
  if (!room) return;
  try { await room.localParticipant.setMicrophoneEnabled(false); } catch (e) {}
  const btn = barEl && barEl.querySelector('#gv-ptt');
  if (btn) btn.classList.remove('gv-keyed');
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
    #gv-bar .gv-talker { font-size: 12px; font-weight: 700; color: #00e676; height: 15px; }
    #gv-bar .gv-status { font-size: 12px; color: #8b949e; }
    #gv-join { background: #00e676; color: #00210f; border: none; border-radius: 10px;
      font-weight: 800; font-size: 14px; padding: 12px 18px; cursor: pointer; }
    #gv-ptt { width: 76px; height: 76px; border-radius: 50%; border: none; flex: 0 0 auto;
      background: #f0a500; color: #1a1200; font-weight: 900; font-size: 13px; cursor: pointer;
      touch-action: none; user-select: none; -webkit-user-select: none;
      box-shadow: 0 3px 0 #b87d00; transition: transform .05s, box-shadow .05s; }
    #gv-ptt.gv-keyed { background: #ff5252; color: #fff; transform: translateY(2px); box-shadow: 0 1px 0 #a30000; }
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
    <div class="gv-meta">
      <div class="gv-to">Talking to</div>
      <div class="gv-name">${escapeHtml(session.partnerName)}</div>
      <div class="gv-talker" id="gv-talker"></div>
    </div>
    <button id="gv-ptt">HOLD<br>TO TALK</button>
    <button class="gv-icon" id="gv-leave" title="Leave">✕</button>`;
  document.body.appendChild(barEl);

  const ptt = barEl.querySelector('#gv-ptt');
  // Pointer events cover mouse + touch + pen with one path.
  ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); pttDown(); });
  ptt.addEventListener('pointerup', (e) => { e.preventDefault(); pttUp(); });
  ptt.addEventListener('pointercancel', () => pttUp());
  ptt.addEventListener('lostpointercapture', () => pttUp());
  barEl.querySelector('#gv-leave').addEventListener('click', leaveVoice);
}

function showBar() { if (barEl) barEl.style.display = 'flex'; }
function removeBar() { if (barEl) { barEl.remove(); barEl = null; } }
function setBarStatus(txt) { const el = barEl && barEl.querySelector('#gv-status'); if (el) el.textContent = txt; }
function setTalker(txt) { const el = barEl && barEl.querySelector('#gv-talker'); if (el) el.textContent = txt; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
