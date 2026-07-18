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
let remoteTalking = false; // true while a REMOTE participant is actively speaking in the main Talk bar
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

// startMediaMode() runs a continuous 1.5s native poll re-asserting audio routing — meant to
// last only as long as a voice session is actually open. Every call site used to turn it ON
// but only the main Talk bar ever turned it back OFF, so the FIRST time the auto-listen
// monitor connected (which happens automatically in the background any time you own a
// device), the poll started running forever — even fully idle, even after the monitor
// disconnected — repeatedly touching system audio APIs and fighting things like Android
// Auto's own audio routing (reported as periodic music "ducking" every few seconds).
// Recomputing from real state on every change, rather than tracking on/off deltas, means it's
// impossible for this to drift out of sync again.
// _syncCarAudio() used to call _carAudio(false) IMMEDIATELY the instant nobody was "actively
// talking" — but LiveKit's ActiveSpeakersChanged naturally flickers true/false several times a
// SECOND during continuous speech (brief pauses between words/syllables cross the detection
// threshold), so every micro-pause tore the native audio route all the way down to MODE_NORMAL
// and straight back up to MODE_IN_COMMUNICATION a moment later. Confirmed via the phone's own
// audio-routing debug log: dozens of start/stop-media-mode calls within a few seconds of one
// continuous test, with the OS audio mode visibly bouncing 0→3→0→3 — reported independently as
// both "choppy audio" and "the volume level flickering up and down" (changing audio mode swaps
// which stream the volume rocker controls). Turning ON stays instant — no reason to delay
// engaging the route the moment real speech starts. Turning OFF is debounced so a brief
// mid-sentence pause doesn't tear the whole route down and rebuild it a moment later.
//
// 700ms fixed the within-utterance flicker but was too short for PTT specifically: separate
// walkie-talkie transmissions naturally have gaps well over 700ms (release button, think, press
// again), so the route was tearing down between EVERY transmission and starting the next one on
// whatever the OS defaults to (earpiece) until re-forced — reported as "starts on earpiece, then
// moves to speaker, on every new transmission". 10s bridges a normal back-and-forth exchange
// while still releasing MODE_IN_COMMUNICATION (and its mic-blocking side effect on other apps —
// see monitorActive below) within seconds of the conversation actually ending, not indefinitely.
const CAR_AUDIO_OFF_DEBOUNCE_MS = 10000;
let _carAudioOffTimer = null;
let _carAudioWantOn = false;

function _setCarAudio(on, immediate) {
  if (on) {
    if (_carAudioOffTimer) { clearTimeout(_carAudioOffTimer); _carAudioOffTimer = null; }
    if (!_carAudioWantOn) { _carAudioWantOn = true; _carAudio(true); }
  } else {
    if (!_carAudioWantOn) return;   // already off
    // Normally debounced (see CAR_AUDIO_OFF_DEBOUNCE_MS above) so a brief mid-sentence pause
    // doesn't tear the route down. But that's a plain setTimeout, and Android pauses the
    // WebView's JS (pending timers included) the moment the app backgrounds — so backgrounding
    // right after talking could freeze this timer mid-countdown, leaving the phone pinned in
    // MODE_IN_COMMUNICATION (blocking the mic for every OTHER app) for as long as GroundLink
    // sits in the background. `immediate` (passed from the visibilitychange handler right
    // before that freeze can happen) skips the debounce entirely — nothing benefits from
    // waiting once nobody's watching the screen anyway.
    if (immediate) {
      if (_carAudioOffTimer) { clearTimeout(_carAudioOffTimer); _carAudioOffTimer = null; }
      _carAudioWantOn = false;
      _carAudio(false);
      return;
    }
    if (_carAudioOffTimer) return;   // already debouncing
    _carAudioOffTimer = setTimeout(() => {
      _carAudioOffTimer = null;
      _carAudioWantOn = false;
      _carAudio(false);
    }, CAR_AUDIO_OFF_DEBOUNCE_MS);
  }
}

function _syncCarAudio(immediate) {
  // Only genuine, ACTIVE speech should force communication-mode audio — not merely having a
  // Talk session or an auto-listen connection open. This used to be `!!(session && room)`,
  // meaning simply having the Talk bar open (regardless of whether anyone was actually
  // speaking) kept the phone pinned in MODE_IN_COMMUNICATION continuously — the SAME
  // mic-blocking bug already fixed for auto-listen (see monitorActive below), just via a
  // different path, which is why the fix for auto-listen alone didn't fully resolve the
  // "blocks speech-to-text" report. Gating on real speech (micOn = I'm transmitting,
  // remoteTalking = someone else is) fixes both paths the same way, while still protecting
  // the audio route for the actual duration of a real conversation.
  const talkActive = !!(session && room) && (micOn || remoteTalking);
  // Only genuine, ACTIVE speech should force communication-mode audio — not merely having an
  // auto-listen connection open. Auto-listen is DESIGNED to stay silently connected in the
  // background the whole time the app is open (that's the entire point of the feature), so
  // gating on "a monitor room is connected" meant the phone was pinned in MODE_IN_COMMUNICATION
  // continuously any time GroundLink was merely open — even fully idle — which blocks OTHER
  // apps' microphone/speech-to-text access system-wide. Gating on "someone is actually talking
  // right now" (monRooms[id].talking, toggled by ActiveSpeakersChanged) fixes that while still
  // protecting the audio route for the real duration of playback.
  const monitorActive = Object.keys(monRooms).some((id) => monRooms[id] && monRooms[id].room && monRooms[id].talking);
  _setCarAudio(talkActive || monitorActive, immediate);
  _syncVoiceService();
}

// Called from the app's visibilitychange handler right before the WebView can be paused by
// Android — forces the car-audio-off debounce to resolve NOW instead of possibly freezing
// mid-countdown in the background. See the `immediate` comment in _setCarAudio for why this
// matters: a stuck debounce there means the microphone stays blocked for every other app on the
// phone for as long as GroundLink sits in the background.
export function flushCarAudioForBackground() {
  try { _syncCarAudio(true); } catch (e) {}
}

// Native foreground service (window.GLAudioRouter.startVoiceService/stopVoiceService) that keeps
// the app's voice pipeline alive and RECEIVING while backgrounded — a real Android requirement,
// not just an audio-routing nicety like _carAudio above. Deliberately broader than talkActive/
// monitorActive: this needs to stay up for the WHOLE time any room is connected (including
// silent auto-listen monitors), not just during active speech bursts, since the point is
// reliable reception for the whole session. No debounce needed — unlike car-audio mode there's
// no per-flicker teardown cost, and a connected room doesn't flap the way "is talking" does.
function _syncVoiceService() {
  try {
    const a = (typeof window !== 'undefined') && window.GLAudioRouter;
    if (!a) return;
    const anyRoomConnected = !!(session && room) || Object.keys(monRooms).some((id) => monRooms[id] && monRooms[id].room);
    if (anyRoomConnected) {
      if (a.startVoiceService) a.startVoiceService();
      // Push the current notification-visibility preference every time the service (re)starts —
      // it may have been changed in a PRIOR session, and the native side has no other way to
      // learn it until the toggle itself is next clicked.
      try {
        const iconOn = (typeof localStorage === 'undefined') || localStorage.getItem('gl_voice_notif_icon') !== '0';
        if (a.setVoiceNotificationVisible) a.setVoiceNotificationVisible(iconOn);
      } catch (e) { /* ignore */ }
    } else if (a.stopVoiceService) {
      a.stopVoiceService();
    }
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
  remoteTalking = false;
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
  remoteTalking = false;
  _syncCarAudio();   // restore normal audio routing UNLESS a device monitor is still active
  removeBar();
  emit({ type: 'left' });
}

// ── Device monitor: stay joined (listen-only) to your OWNED devices' channels so
// you HEAR the watch from any screen without tapping Talk, and get a "talking" event
// for an alert. Runs as SEPARATE LiveKit rooms so it never disturbs the main voice bar.
let monRooms = {};   // deviceId -> { room, name, talking }
let monHearOthers = true;   // play other people talking to the device, not just the device itself

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
let monLastOpts = null;   // last {livekitUrl, tokenEndpoint, identity, hearOthers} — needed to reconnect a dropped monitor
let monWanted = {};       // last-known wanted set (id -> name) — a disconnect handler only reconnects if still wanted
// Consecutive-failure count per device (token mint / connect throwing, e.g. LiveKit project out
// of minutes). A device stuck failing forever (not a fleeting blip) used to retry on a flat 4s
// timer while ALSO re-engaging the preemptive car-audio call below on every single attempt — the
// off side is debounced 10s (see _setCarAudio), so a 4s retry cadence kept cancelling that
// debounce before it ever fired, leaving the native audio-routing poll running continuously with
// no WebRTC audio ever actually flowing. That's the exact "periodic ducking" failure mode this
// file's own _carAudio comment already documents, just reached via infinite connect failures
// instead of a live idle connection. Backing off + skipping the preemptive call once failures are
// clearly not transient fixes it without touching the real, working reconnect-after-a-blip path.
let monRetryCount = {};

async function connectOneMonitor(id, name) {
  const opts = monLastOpts; if (!opts) return;
  if (!monWanted[id]) return;   // no longer an owned/shared device — don't reconnect
  monRooms[id] = { room: null, name: name, talking: monRooms[id] ? monRooms[id].talking : false };
  const roomName = 'gv_dev_' + id + '_ALL';
  const monIdentity = opts.identity + '__mon';   // distinct identity so it never kicks your Talk session
  try {
    const token = await mintToken(opts.tokenEndpoint, roomName, monIdentity, 'monitor');
    const r = new Room();
    // Engage car-audio protection BEFORE connecting (direct call, not _syncCarAudio — this
    // room isn't recorded as "active" in monRooms until after connect succeeds below, so the
    // state-check wouldn't see it yet). Chromium's WebRTC can grab a Bluetooth SCO "call" link
    // to a paired car within milliseconds of connect(), faster than a reactive poll can catch —
    // so our native side needs to already be holding the right mode before that happens, not
    // fix it up afterward. _syncCarAudio() below reconciles the definitive state once we know
    // whether this connection actually succeeded.
    // Skip once this device has already failed 3+ times in a row: at that point this isn't the
    // fleeting blip the preemptive call exists for, and re-engaging it on every retry is what
    // pins the native audio route on indefinitely (see monRetryCount comment above).
    if ((monRetryCount[id] || 0) < 3) _setCarAudio(true);
    r.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      // If you're actively in THIS device's Talk channel, that bar already plays it — skip to avoid echo.
      if (session && session.room === roomName) return;
      // When "hear others" is off, only play the DEVICE itself (its identity === the device id),
      // not other family members talking to it on the shared channel.
      if (!monHearOthers && participant && participant.identity !== id) return;
      const el = track.attach(); el.autoplay = true; el.setAttribute('playsinline', '');
      ensureAudioSink().appendChild(el);
    });
    r.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
    });
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const on = speakers.some((p) => p.identity && p.identity !== monIdentity);
      const slot = monRooms[id]; if (!slot) return;
      if (on !== slot.talking) {
        slot.talking = on;
        emit({ type: 'deviceTalking', id, name: slot.name, on });
        _syncCarAudio();   // engage car-audio protection only for the actual duration of real speech
      }
    });
    // SELF-HEALING: this connection previously had no way to recover from a drop — once the
    // room disconnected (a network blip, a server-side idle-room timeout, anything), the
    // "auto-listen" monitor just stayed dead until the app was fully restarted. Now a drop
    // clears the slot and retries after a short delay, same as the main Talk bar already does.
    r.on(RoomEvent.Disconnected, () => {
      const slot = monRooms[id];
      if (slot && slot.room === r) delete monRooms[id];
      _syncCarAudio();   // this room just went away — turn car-audio mode off unless something else needs it
      setTimeout(() => { try { connectOneMonitor(id, name); } catch (e) {} }, 4000);
    });
    // NOT forcing iceTransportPolicy:'relay' here — decompiling the Android SDK's equivalent
    // merge logic proved that supplying a custom rtcConfig makes it skip loading the server's
    // real TURN credentials (that only happens on the "no custom config" path). A relay-only
    // config with no servers to relay through is strictly worse than the default, since it also
    // excludes host candidates. Default connect() lets the SDK load the real server ICE list.
    await r.connect(opts.livekitUrl, token);
    monRetryCount[id] = 0;   // a real connection landed — this device isn't in a failure loop anymore
    try { await r.startAudio(); } catch (e) {}
    // Route monitor (auto-listen) audio to the LOUDSPEAKER (media path), not the earpiece —
    // but only while a session is genuinely active (_syncCarAudio checks real state, so this
    // never ends up stuck running when nothing needs it, unlike an unconditional _carAudio(true)).
    if (monRooms[id]) { monRooms[id].room = r; _syncCarAudio(); } else { try { r.disconnect(); } catch (e) {} }   // dropped while connecting
  } catch (e) {
    console.error('[voice] device monitor failed for ' + id, e);
    delete monRooms[id];
    _syncCarAudio();
    // Exponential backoff (4s/8s/16s/32s, capped at 60s) once failures stack up — a project out
    // of LiveKit minutes fails every attempt, so a flat 4s retry forever both hammers the token
    // endpoint and (see monRetryCount above) never lets the car-audio route actually turn off.
    monRetryCount[id] = (monRetryCount[id] || 0) + 1;
    const delay = Math.min(4000 * Math.pow(2, Math.min(monRetryCount[id] - 1, 4)), 60000);
    setTimeout(() => { try { connectOneMonitor(id, name); } catch (e2) {} }, delay);
  }
}

export async function startDeviceMonitor(opts) {
  const { devices, identity, livekitUrl, tokenEndpoint, hearOthers } = opts || {};
  if (!devices || !livekitUrl || !tokenEndpoint || !identity) return;
  monHearOthers = (hearOthers !== false);   // false = only play the DEVICE's own audio, not other people
  monLastOpts = { livekitUrl, tokenEndpoint, identity, hearOthers };
  const wanted = {};
  devices.forEach((d) => { if (d && d.id) wanted[d.id] = d.name || 'device'; });
  monWanted = wanted;
  // Drop monitors no longer wanted. (monWanted is already updated above, so the Disconnected
  // handler's own reconnect-check correctly no-ops for these instead of reviving them.)
  Object.keys(monRooms).forEach((id) => {
    if (!wanted[id]) { try { monRooms[id].room && monRooms[id].room.disconnect(); } catch (e) {} delete monRooms[id]; }
  });
  _syncCarAudio();
  // Add monitors for newly-wanted devices.
  for (const id of Object.keys(wanted)) {
    if (monRooms[id]) { monRooms[id].name = wanted[id]; continue; }
    await connectOneMonitor(id, wanted[id]);
  }
}

export function stopDeviceMonitor() {
  monWanted = {};   // clear FIRST — .disconnect() below fires the Disconnected handler, whose
                     // own reconnect-check reads this; otherwise a stray reconnect could fire
                     // seconds after auto-listen was explicitly turned off.
  Object.keys(monRooms).forEach((id) => { try { monRooms[id].room && monRooms[id].room.disconnect(); } catch (e) {} });
  monRooms = {};
  _syncCarAudio();
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
  // Engage car-audio protection BEFORE connecting — not after. Chromium's WebRTC engine makes
  // its OWN automatic Bluetooth/communication-mode routing decision as a side effect of
  // room.connect()/getUserMedia, and it can grab an SCO "call" link to a paired car within
  // milliseconds — faster than our native poll could react to it afterward. Doing this first
  // means our native side is already holding the correct mode before WebRTC ever gets a chance
  // to make its own call-like routing decision, instead of reacting after the fact.
  _syncCarAudio();

  // Remote audio: attach each subscribed audio track to a hidden <audio> element. Skip anyone
  // the user has MUTED (silence-only: their track just never plays — they aren't told).
  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind === Track.Kind.Audio) {
      if (participant && window._isMuted && window._isMuted(participant.identity)) return;
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
    const wasTalking = remoteTalking;
    remoteTalking = !!remote;
    if (remoteTalking !== wasTalking) _syncCarAudio();
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
    // Not forcing iceTransportPolicy:'relay' — see comment in the device-monitor path above.
    await room.connect(session.livekitUrl, token);
    // Don't grab the mic here — connect() is several awaits past the original tap,
    // so the user gesture is gone and getUserMedia would be blocked with no prompt.
    // The mic is acquired on the user's first PTT tap instead (a live gesture).
    try { await room.startAudio(); } catch (e) {}
    updatePresence();
    updatePttButton();
    if (room.canPlaybackAudio === false) showAudioBlocked();
    _syncCarAudio();   // keep the car radio alive — don't let this read as a phone call
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
  _syncCarAudio();   // engage/release car-audio protection for the actual duration of transmitting
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
    micOn = false; _syncCarAudio(); updatePttButton();
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
  // Auto-listen ("__mon") connections are a background listening artifact, not a real person —
  // their display name is the literal internal string 'monitor'. Without this filter, if you (or
  // anyone) had auto-listen on for this device, that connection showed up here as a phantom
  // participant named "monitor", which is exactly the confusing "monitor in room" text reported.
  const remotes = room && room.remoteParticipants
    ? Array.from(room.remoteParticipants.values()).filter((p) => !String(p.identity || '').endsWith('__mon'))
    : [];
  const names = remotes.map((p) => p.name || p.identity);
  if (names.length === 0) setTalker('waiting for others…', '#8b949e');
  else setTalker('✓ Connected — ' + names.join(', '), '#8b949e');
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
    <button id="gv-ptt" title="Hold to talk" aria-label="Hold to talk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg><span class="gv-ptt-hint">HOLD</span></button>
    <button class="gv-icon" id="gv-log" title="Missed transmissions" aria-label="Transmissions"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;display:block"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg><span class="gv-badge" id="gv-log-badge"></span></button>
    <button class="gv-icon" id="gv-leave" title="Leave">✕</button>`;
  document.body.appendChild(barEl);
  document.body.classList.add('gv-active');   // lets the page lift its bottom toolbar above the voice bar

  const ptt = barEl.querySelector('#gv-ptt');
  // HOLD to talk (phone only — the watch keeps its own tap-to-toggle, unrelated code path):
  // press starts transmitting, release stops. setPointerCapture on press guarantees the
  // matching pointerup/pointercancel still reaches THIS element even if the finger slides off
  // the button before releasing — without it, a slide-off would leave the mic stuck open with
  // no way to release it short of leaving the room. Fires on pointerdown (not 'click') so the
  // user gesture is still live for getUserMedia — a plain 'click' several awaits later can lose
  // the gesture on some mobile browsers.
  const _pttDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { ptt.setPointerCapture(e.pointerId); } catch (_) {}
    setPtt(true);
  };
  const _pttUp = (e) => { e.preventDefault(); e.stopPropagation(); setPtt(false); };
  ptt.addEventListener('pointerdown', _pttDown);
  ptt.addEventListener('pointerup', _pttUp);
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
