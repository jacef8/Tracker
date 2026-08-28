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
// Caller feedback + self-healing: a "nobody joined yet" timer so the initiator isn't left on
// "waiting for others…" forever, and reconnect-with-backoff state so a terminal drop on the main
// Talk channel recovers on its own instead of dying silently (LiveKit only auto-recovers blips).
let _waitTimer = null;
let _talkReconnectTimer = null, _talkReconnects = 0;
let barMin = false;          // minimized bar (mic bubble only) — auto-joins start this way
let _reMinTimer = null;      // re-minimize after an auto-expand once the talking stops

function emit(evt) {
  listeners.forEach((cb) => { try { cb(evt); } catch (e) { /* ignore */ } });
}

// Native car-radio fix: ask the Android wrapper (window.GLAudioRouter, injected by
// MainActivity) to keep voice on the MEDIA audio path so a vehicle's Bluetooth doesn't
// treat push-to-talk as a phone call and mute the radio. No-op on the web, or if the user
// turned it off (gl_car_audio === '0'). Safe to call repeatedly.
function _carAudio(on) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('gl_car_audio') === '0' && !_iosNative()) return;
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


// iOS vs Android native shell. Both inject window.GLAudioRouter, but they need OPPOSITE
// treatment for an idle-but-connected room (see _syncVoiceService), so tell them apart.
function _iosNative() {
  try {
    if (typeof window === 'undefined' || !window.GLAudioRouter) return false;
    return !/Android/i.test(navigator.userAgent || '');
  } catch (e) { return false; }
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
    // iOS: startVoiceService maps to a RECORD reason, which puts AVAudioSession into
    // .playAndRecord and holds it there for the whole session. iOS then shows the blue/orange
    // microphone indicator permanently — even sitting idle, never transmitting — because the
    // app genuinely does hold the mic open. The silent auto-listen monitor connects on its own
    // in the background, so this happened without anyone touching the Talk button.
    //
    // Android really does need the foreground service to keep receiving. iOS does not: a
    // .playback session is enough to keep audio alive in the background, and it claims no
    // microphone. Record is claimed only while actually transmitting (startMediaMode, below),
    // which is exactly when the indicator SHOULD be lit.
    if (anyRoomConnected && _iosNative()) {
      if (a.startClipPlayback) a.startClipPlayback();     // play-only session: no mic indicator
      if (a.stopVoiceService) a.stopVoiceService();       // drop any record reason left over
    } else if (anyRoomConnected) {
      if (a.startVoiceService) a.startVoiceService();
      // Push the current notification-visibility preference every time the service (re)starts —
      // it may have been changed in a PRIOR session, and the native side has no other way to
      // learn it until the toggle itself is next clicked.
      try {
        const iconOn = (typeof localStorage === 'undefined') || localStorage.getItem('gl_voice_notif_icon') !== '0';
        if (a.setVoiceNotificationVisible) a.setVoiceNotificationVisible(iconOn);
      } catch (e) { /* ignore */ }
    } else {
      if (a.stopVoiceService) a.stopVoiceService();
      if (_iosNative() && a.stopClipPlayback) a.stopClipPlayback();
    }
  } catch (e) { /* ignore */ }
}

export function onVoiceEvent(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((x) => x !== cb); };
}

// External transmit control — used by the iOS Push to Talk framework, which owns the key/unkey
// decision (system button + audio session) and just tells us to publish/unpublish the mic.
export function pttKey(on) { try { setPtt(!!on); } catch (e) {} }

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
  // Auto-joins (listen:true — the always-on crew channel engaging on room entry) show NO UI at
  // all: the connection runs silently in the background (you hear the crew), and the bar appears
  // only when the user deliberately opens voice (tapping Talk — which re-enters here without
  // listen, or hits the same-room early-return above whose showBar() reveals it).
  barMin = false;
  renderBar();
  // Hidden auto-join: also drop the gv-active class renderBar added — it lifts the map's bottom
  // toolbar ~100px to clear a bar that isn't visible ("toolbar sitting too high up in the map").
  // showBar() restores the class when the bar is deliberately opened.
  if (session.listen && barEl) { barEl.style.display = 'none'; try { document.body.classList.remove('gv-active'); } catch (e) {} }
  setTalker('connecting…', '#8b949e');
  connectVoice();
}

// ── Public: leave + tear down ──────────────────────────────────────────────
export function leaveVoice() {
  // Null session FIRST so the room's Disconnected handler treats this as an intentional exit and
  // doesn't schedule a reconnect against the room we're deliberately tearing down.
  session = null;
  try { if (_waitTimer) { clearTimeout(_waitTimer); _waitTimer = null; } } catch (e) {}
  try { if (_talkReconnectTimer) { clearTimeout(_talkReconnectTimer); _talkReconnectTimer = null; } } catch (e) {}
  _talkReconnects = 0;
  if (room) { try { room.disconnect(); } catch (e) {} }
  room = null;
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
      // CONNECT-DROP CYCLING is a failure too. The 3-strike guard below only counted attempts
      // that THREW — but a connection that succeeds, lives seconds, and drops resets the
      // counter on every success, so an unstable link (one weak-wifi room is enough) engaged
      // the preemptive duck on every 4s reconnect forever, and 4s retries beat the 10s
      // duck-release debounce. That is the reported "music pulses in and out with nobody
      // talking, only in certain rooms". A connection that died young now counts as a strike,
      // and reconnects back off exactly like failed connects do.
      const aliveMs = (slot && slot.connectedAt) ? (Date.now() - slot.connectedAt) : 0;
      if (aliveMs < 60000) monRetryCount[id] = (monRetryCount[id] || 0) + 1;
      if (slot && slot.room === r) delete monRooms[id];
      _syncCarAudio();   // this room just went away — turn car-audio mode off unless something else needs it
      const rdelay = Math.min(4000 * Math.pow(2, Math.min((monRetryCount[id] || 0), 4)), 60000);
      setTimeout(() => { try { connectOneMonitor(id, name); } catch (e) {} }, rdelay);
    });
    // NOT forcing iceTransportPolicy:'relay' here — decompiling the Android SDK's equivalent
    // merge logic proved that supplying a custom rtcConfig makes it skip loading the server's
    // real TURN credentials (that only happens on the "no custom config" path). A relay-only
    // config with no servers to relay through is strictly worse than the default, since it also
    // excludes host candidates. Default connect() lets the SDK load the real server ICE list.
    await r.connect(opts.livekitUrl, token);
    // The counter only resets once the connection PROVES itself by surviving a minute —
    // resetting instantly on connect is what let connect-drop cycles evade the 3-strike guard.
    if (monRooms[id]) monRooms[id].connectedAt = Date.now();
    setTimeout(() => {
      const slot = monRooms[id];
      if (slot && slot.room === r && r.state === 'connected') monRetryCount[id] = 0;
    }, 60000);
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
  const _thisRoom = room;   // capture: if openVoice (room switch) or leaveVoice swaps `room` out,
                            // the Disconnected handler below must NOT reconnect this stale instance.
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
      // iOS: a freshly-attached WebRTC <audio> won't autoplay on its own — EACH transmission
      // creates a new track/element, which is why an already-connected iPhone went silent between
      // taps. Once audio has been unlocked (tap-to-join), an explicit play() + room.startAudio()
      // makes every later transmission audible with no further tapping. If it's still blocked
      // (never unlocked), the AudioPlaybackStatusChanged handler below surfaces the "Tap to hear".
      try { const p = el.play && el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
      try { if (room) room.startAudio(); } catch (e) {}
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
      // Someone's talking — surface the full bar so you can SEE who, even if it was minimized.
      // Re-minimizes on its own a few seconds after the transmission ends (see below).
      if (barMin && barEl) { barEl.classList.remove('gv-min'); barEl._autoExpanded = true; }
      try { if (_reMinTimer) { clearTimeout(_reMinTimer); _reMinTimer = null; } } catch (e) {}
      setTalker('◉ ' + who + ' talking', '#00e676');
      setRx(true);
      emit({ type: 'talking', who, identity: remote.identity });
    } else {
      setRx(false);
      updatePresence();
      emit({ type: 'talking', who: null });
      // If we auto-expanded for an incoming transmission, tuck back down shortly after it ends.
      if (barMin && barEl && barEl._autoExpanded) {
        try { if (_reMinTimer) clearTimeout(_reMinTimer); } catch (e) {}
        _reMinTimer = setTimeout(() => { try { if (barMin && barEl) { barEl.classList.add('gv-min'); barEl._autoExpanded = false; } } catch (e) {} }, 6000);
      }
    }
  });
  room.on(RoomEvent.ParticipantConnected, (p) => { emit({ type: 'diag', message: 'participant JOINED ' + ((p && p.identity) || '?') }); updatePresence(); });
  room.on(RoomEvent.ParticipantDisconnected, (p) => { emit({ type: 'diag', message: 'participant LEFT ' + ((p && p.identity) || '?') }); updatePresence(); });
  // DIAGNOSTIC: connection-state + track-subscription visibility for the "both connected, neither
  // hears the other" investigation — surfaces to the room debug log via the 'diag' event.
  try { room.on(RoomEvent.ConnectionStateChanged, (st) => { emit({ type: 'diag', message: 'conn-state=' + st }); }); } catch (e) {}
  try { room.on(RoomEvent.TrackSubscribed, (t, pub, p) => { emit({ type: 'diag', message: 'track SUBSCRIBED ' + (t && t.kind) + ' from ' + ((p && p.identity) || '?') }); }); } catch (e) {}
  try { room.on(RoomEvent.TrackPublished, (pub, p) => { emit({ type: 'diag', message: 'track PUBLISHED by ' + ((p && p.identity) || '?') }); }); } catch (e) {}
  // Autoplay may be blocked (esp. on an auto-join with no gesture) — surface a tap.
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (room && room.canPlaybackAudio) hideAudioBlocked(); else showAudioBlocked();
  });
  // Self-heal a TERMINAL drop (server idle-room timeout, token expiry, a long outage). LiveKit
  // already recovers transient ICE blips internally, so reaching this handler means the session
  // really ended. If the user didn't leave on purpose (session still set), reconnect with backoff
  // — previously this only printed "disconnected" and the channel stayed dead until a full reload.
  room.on(RoomEvent.Disconnected, () => {
    if (room !== _thisRoom) return;              // superseded by a newer room (switch or leave)
    if (!session) return;                        // leaveVoice() nulls session — an intentional exit
    setTalker('reconnecting…', '#f0a500');
    if (_talkReconnectTimer) return;             // already scheduled
    const delay = Math.min(2000 * Math.pow(2, Math.min(_talkReconnects, 4)), 30000);
    _talkReconnects++;
    _talkReconnectTimer = setTimeout(() => {
      _talkReconnectTimer = null;
      try { if (session) connectVoice(); } catch (e) {}
    }, delay);
  });

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
    _talkReconnects = 0;   // a clean connect resets the backoff ladder
    // Caller feedback: if this is an outgoing call (not a listen-only auto-join) and nobody has
    // joined after 20s, stop implying "connecting" forever — the callee got a push notification.
    try { if (_waitTimer) { clearTimeout(_waitTimer); _waitTimer = null; } } catch (e) {}
    if (session && !session.listen) {
      _waitTimer = setTimeout(() => {
        try {
          const hasRemote = room && room.remoteParticipants &&
            Array.from(room.remoteParticipants.values()).some((p) => !String(p.identity || '').endsWith('__mon'));
          if (!hasRemote && session && !micOn && !remoteTalking) setTalker('No answer yet — they got a notification', '#f0a500');
        } catch (e) {}
      }, 20000);
    }
    emit({ type: 'joined', room: session.room });
    try { const _n = room && room.remoteParticipants ? room.remoteParticipants.size : 0; emit({ type: 'diag', message: 'connected room=' + session.room + ' remoteParticipants=' + _n }); } catch (e) {}
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
  else { try { if (_waitTimer) { clearTimeout(_waitTimer); _waitTimer = null; } } catch (e) {} setTalker('✓ Connected — ' + names.join(', '), '#8b949e'); }
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
      user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none; box-shadow: 0 2px 0 #b87d00;
      -webkit-tap-highlight-color: transparent; transition: transform .08s, box-shadow .12s, background .12s; }
    /* Children must NOT catch the press — on iOS a long-press on the icon/text fired the native
       text-selection / copy callout instead of holding PTT, so the mic never keyed. pointer-events
       none routes every touch to the button itself, and the selection/callout are killed. */
    #gv-ptt * { pointer-events: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
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
    /* Minimized: just the mic bubble (hold to talk) + a small expand chevron, parked bottom-right
       so the map stays clear. The full bar returns on expand or automatically when someone talks. */
    #gv-bar.gv-min { left: auto; right: 10px; width: auto; padding: 5px; border-radius: 44px; gap: 2px; }
    #gv-bar.gv-min .gv-leds, #gv-bar.gv-min .gv-meta, #gv-bar.gv-min #gv-log, #gv-bar.gv-min #gv-leave { display: none; }
    #gv-bar.gv-min #gv-ptt { width: 58px; height: 58px; }
    #gv-bar #gv-expand { display: none; }
    #gv-bar.gv-min #gv-expand { display: flex; align-items: center; justify-content: center; background: none; border: none; color: #8b949e; font-size: 16px; padding: 4px 6px 4px 2px; cursor: pointer; }
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
    <button class="gv-icon" id="gv-leave" title="Leave">✕</button>
    <button id="gv-expand" title="Expand" aria-label="Expand voice bar">⌃</button>`;
  if (barMin) barEl.classList.add('gv-min');
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
    // pointerId only exists on pointer events; touch events set natural capture on their own.
    try { if (e.pointerId != null && ptt.setPointerCapture) ptt.setPointerCapture(e.pointerId); } catch (_) {}
    // iOS 16+ Push to Talk framework owns the transmit (system audio session + UI); it calls back
    // to pttKey() to publish the mic. Elsewhere we key the mic directly.
    try { if (typeof window !== 'undefined' && window.GLPushToTalk && window.GLPushToTalk.available) { window.GLPushToTalk.beginTransmit(); return; } } catch (_) {}
    setPtt(true);
  };
  const _pttUp = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { if (typeof window !== 'undefined' && window.GLPushToTalk && window.GLPushToTalk.available) { window.GLPushToTalk.endTransmit(); return; } } catch (_) {}
    setPtt(false);
  };
  // TOUCH events first — on iOS these fire immediately and reliably, whereas pointer events can lag
  // or drop entirely (reported: sluggish keying + presses that don't register). setPtt is
  // idempotent, so if a device fires both touch and pointer for one press it's a harmless no-op.
  // touchstart's preventDefault also suppresses the synthesized pointer/mouse events + the callout.
  ptt.addEventListener('touchstart', _pttDown, { passive: false });
  ptt.addEventListener('touchend', _pttUp, { passive: false });
  ptt.addEventListener('touchcancel', _pttUp, { passive: false });
  ptt.addEventListener('pointerdown', _pttDown);
  ptt.addEventListener('pointerup', _pttUp);
  ptt.addEventListener('pointercancel', _pttUp);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());  // no long-press menu on mobile
  updatePttButton();
  barEl.querySelector('#gv-log').addEventListener('click', (e) => { e.stopPropagation(); try { if (window._openVoiceLog) window._openVoiceLog(); } catch (_) {} });
  barEl.querySelector('#gv-leave').addEventListener('click', (e) => { e.stopPropagation(); leaveVoice(); });
  barEl.querySelector('#gv-expand').addEventListener('click', (e) => { e.stopPropagation(); setBarMin(false); });
}

function setBarMin(on) {
  barMin = !!on;
  if (barEl) barEl.classList.toggle('gv-min', barMin);
  try { if (_reMinTimer) { clearTimeout(_reMinTimer); _reMinTimer = null; } } catch (e) {}
}

function showBar() { if (barEl) { barEl.style.display = 'flex'; try { document.body.classList.add('gv-active'); } catch (e) {} } }
function removeBar() { if (barEl) { barEl.remove(); barEl = null; } document.body.classList.remove('gv-active'); }
function setTalker(txt, color) { const el = barEl && barEl.querySelector('#gv-talker'); if (el) { el.textContent = txt; if (color) el.style.color = color; } }
function setTx(on) { const el = barEl && barEl.querySelector('#gv-tx'); if (el) el.classList.toggle('tx-on', !!on); }
function setRx(on) { const el = barEl && barEl.querySelector('#gv-rx'); if (el) el.classList.toggle('rx-on', !!on); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Re-assert the audio session after something else releases it (clip playback finishing shares
// the same 'clip' reason as the iOS idle-listen session).
export function resyncAudio() { try { _syncVoiceService(); } catch (e) {} }
