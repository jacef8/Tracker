# GroundLink — Technical Brief for Second Opinion

## What it is
GroundLink is a **private location-sharing + walkie-talkie system** for a family (primary use: a dad tracking/talking to his young son, who wears a smartwatch). It has three clients that all share one backend:

1. **Web app / PWA** — the main app (a single ~11,000-line `index.html` + a `voice.js` LiveKit module). Runs in a browser or "add to home screen."
2. **Native Android app** (`com.groundlink.app`) — a Capacitor wrapper that loads the **live web app** from the server (so web changes ship instantly without a reinstall) and adds native audio-routing + FCM.
3. **Wear OS watch app** (`com.groundlink.watch`) — a standalone native **Kotlin** app for a Samsung Galaxy Watch Ultra (LTE). Reports GPS and does push-to-talk voice. Does NOT use the web code.

## Backend / stack
- **Firebase Realtime Database** (`tracker-58b87`, `https://tracker-58b87-default-rtdb.firebaseio.com`). **Security rules are essentially OPEN** (no per-user read/write restriction). A dedicated `gl/_presence` index is blocked by rules; account profile path `gl/_users/<account>` IS writable.
- **LiveKit** (self-hosted cloud SFU, `wss://groundwave-mjxcgsrm.livekit.cloud`) for real-time voice. Token minted by a Railway endpoint (`/voice-token`). Voice is an SFU model, never mesh.
- **Railway Node server** (`server.js`, `tracker-production-3b03.up.railway.app`) — serves the live web app, plus:
  - `/wake-device` — sends a **high-priority silent FCM data message** to a device (push-to-wake), using `firebase-admin` with a service-account env var.
  - `/voice-token` proxy, short links `/j/<room>` (room invite) and `/d/<code>` (device share), `/download` (APK install page), `/.well-known/assetlinks.json` (Android App Links).
- **FCM** for push-to-wake (waking a dozing watch) and notifications.

## Key data model
- **Rooms:** `gl/<roomKey>/users/<deviceId>` = live position of each member. Room key is a normalized slug.
- **Private devices (the watch):** `gl/_devices/<deviceId>` = `{ live:{lat,lng,name,ts}, owner, ownerName, sharedWith:{}, fcmToken, shareCode }`. Written by REST from the watch. Rendered only for the owner + shared accounts.
- **Account profile / sync:** `gl/_users/<accountKey>` = `{ name, friends, favs, pins, tracks, colors, sessions:{} }`.
- **Identity model:** each device has its own random `gl_uid` (device id), **decoupled** from the Google account id (`gl_account_uid`). Multiple devices under one Google account each have distinct device ids. Cross-device sync happens by the shared account key.

## Deploy process
- Web: bump `var APP_BUILD=N` in `index.html` (+ a parallel `index-test.html`) + `version.json`, `git push` → Railway auto-deploys, then `PUT gl-root/_forceReload={ts}` in RTDB to make running apps reload. `voice.js` is network-first so it loads fresh.
- Native apps: rebuilt APKs. **Distribution is the pain point** (see below).

---

# What was built / fixed recently (chronological themes)

### Push-to-wake (watch battery goal)
Goal: the watch should **sleep when idle** and only spin up GPS/voice when the phone "pings" it, to save battery — instead of holding an always-on voice connection (which drains it in hours).
- Server `/wake-device` sends high-priority silent FCM `data` messages.
- Watch `WakeMessagingService` (FirebaseMessagingService): `type=voice` → connect voice; `type=locate` → one-shot GPS fix.
- Phone sends a `locate` wake every ~15s **while actively viewing the map**, and a `voice` wake when you tap Talk.

**Two hard bugs found & fixed:**
1. **FCM token would not mint on the original watch** — `AUTHENTICATION_FAILED` from FirebaseMessaging. Verified the project/key/APIs were all fine (Installations API worked server-side). Root cause turned out to be that watch's **Google Play Services device check-in / account-auth state** was broken (a device-side GMS issue, not app/config). A **brand-new LTE watch fixed it on first boot** (clean check-in during setup). Token then registered and a real wake was delivered end-to-end.
2. **The "sleep too hard" catch-22:** the first battery design made the watch's foreground service `START_NOT_STICKY` + self-stop on idle. Result: Wear OS **killed the whole app when idle, and a killed app cannot receive FCM** → unwakeable. Fix: the location service is now **`START_STICKY` and stays resident** (a lightweight keep-alive foreground service) so the process stays alive to receive wakes, while **GPS and the LiveKit voice connection still deactivate on idle** (2.5-min timer) to save battery. Verified: screen off + app backgrounded + fired a wake → watch woke and reported a fresh fix in ~8s. Note: background start of a location/mic foreground service from FCM is permitted on Android 14 via the high-priority-push temp-allowlist (`reasonCode:PUSH_MESSAGING`).

### Phone audio routing (walkie-talkie should be on the loudspeaker)
This was the longest-running problem. On the Samsung phone (Galaxy S25 / SM-S931U), incoming voice kept coming out the **earpiece**, or nothing, or flip-flopping.
- Diagnosis via `adb dumpsys audio`: the WebView's WebRTC audio was creating **two competing players** — a `USAGE_MEDIA` stream (→ speaker) and intermittent `USAGE_VOICE_COMMUNICATION` streams (→ earpiece) — because a legacy "car-radio fix" (hold `MODE_NORMAL`) fought Chromium's WebRTC (which wants communication mode/earpiece).
- Also found **Samsung "AudioHardening" mutes the app's audio when it's in the background** ("background playback would be muted for com.groundlink.app") — so incoming voice is silenced unless the app is the foreground app. Mitigation: add app to Samsung "Never sleeping apps" / unrestricted battery.
- Also: a **paired watch registers as a Bluetooth SCO output**, which made the app think a headset was connected and divert audio off the speaker.
- **Fix (native `MainActivity.java` AudioRouter):** when **no real media headset** (Bluetooth A2DP / wired / USB — deliberately NOT counting Bluetooth SCO, so a watch doesn't count) is connected, **force `MODE_IN_COMMUNICATION` + speakerphone**, re-asserted aggressively via a 1.5s poll + mode-change listener. When a real car/earbuds ARE connected, hold `MODE_NORMAL` (car-radio behavior). User reported this "seems better."
- **Tradeoff acknowledged:** forcing the loudspeaker for live voice inherently puts the phone in Android "communication/call mode" — the two are the same mechanism.

### Watch battery on-demand + Wear tile + UI
- On-demand model as above (keep-alive resident, GPS/voice on wake).
- Added a **Wear OS Tile** (glanceable card with a Talk button) via androidx.wear.tiles/protolayout.
- Redesigned the PTT screen (radial-glow backdrop, pulsing halo, distinct state colors: blue ready / red on-air / teal incoming, minimal text).
- Fixed a "Stop sharing" button that was in the round screen's dead "chin" zone; moved it to the setup page.

### Security / claiming model
- Devices are no longer openly claimable. The watch shows a **6-char link code**; entering it in the phone app **claims** the device (first entry = owner) or grants **view access** (after owned). The same code is how you add family. Removed the old "anyone can claim any unclaimed device" UI.

### Multi-device presence (just built)
- Problem: the user's tablet (same Google account) showed **offline** even while actively in use, and there was no visibility into what each device was doing. Cause: online status is derived only from **the room you're currently viewing**; the cross-room presence index is blocked by DB rules.
- Fix: an **account "sessions" registry** at `gl/_users/<account>/sessions/<deviceId>` (writable under current rules). Every signed-in device heartbeats every ~22s (and on talk/join/leave): `{ name, dev(phone/tablet/pc), room, talking, voice, ts }`. A new **"Your devices"** panel on the Account page lists all of them live (online / which room / 🔊 talking) with Join/Listen buttons.

### Distribution
- Sideloading APKs over adb-over-Wi-Fi is extremely painful: the watch constantly hops Wi-Fi networks and drops the adb connection; pairing codes expire; Wi-Fi powers down when the screen sleeps. A `/download` link **silently failed** to install (signature/version mismatch — looked installed but wasn't; the web build number is unrelated to the native APK).
- Moved phone updates to **Firebase App Distribution** (free, uses the existing Firebase project). Phone works cleanly; **Wear OS installs via App Distribution are finicky** so the watch still often needs adb. Play Store was considered but declined for now (cost + data-safety/child-location declarations).

---

# Current known issues / open questions (where a second opinion would help most)

1. **Wear OS push-to-wake + battery architecture.** Is a resident keep-alive foreground service (to stay reachable for FCM) + on-demand GPS/voice the right pattern, or is there a better way to get "sleep but remain wakeable" on Wear OS 5 / Samsung's aggressive battery management? Is relying on high-priority FCM to start a mic/location FGS from the background robust across reboots and Doze?

2. **Phone WebRTC audio routing across OEMs.** Forcing `MODE_IN_COMMUNICATION` + speakerphone works but means "call mode." Samsung "AudioHardening" mutes background audio (breaks the "hear the watch while the app is backgrounded" use case). Is there a more robust cross-OEM approach for a WebView-based WebRTC walkie-talkie that plays reliably on the loudspeaker, including in the background?

3. **Watch LTE standalone.** Latest real-world test: watch↔phone voice **failed on pure cellular (Wi-Fi off)**. Backend proven working (a server wake got a fresh fix in ~28s when the watch had data). Strong suspicion: the Galaxy Watch's **LTE cellular service isn't actually activated** (hardware present, carrier line not added), so with Wi-Fi/Bluetooth off it has no internet. Needs confirmation. Question: any gotchas making a standalone Wear OS LTE watch reliably reach Firebase/LiveKit on cellular?

4. **Open database rules.** The DB is effectively open; a kid's location is protected only by the app hiding it + an unguessable device id, not by server-side rules. Considering owner-only read rules for `gl/_devices`. Is there a clean rules design that preserves the current anonymous/no-account room model while locking down private devices?

5. **Overall approach.** Is "Wear OS standalone app doing LiveKit WebRTC voice + REST GPS to an open Firebase RTDB, woken by FCM" a sound architecture for a reliable kid tracker/walkie-talkie, or would a different stack (e.g., a purpose-built background service, a different transport, MQTT, a commercial platform) be materially more reliable?

6. **Distribution.** Best path for painless OTA updates to BOTH a Capacitor phone app and a standalone Wear OS app for a tiny private user base (currently Firebase App Distribution for phone; watch still needs adb)?

## Environment facts
- Watch: Samsung Galaxy Watch Ultra (SM-L705U), Wear OS 5 / Android 14, LTE, standalone Kotlin app, minSdk 30 / target 34.
- Phone: Samsung Galaxy S25 (SM-S931U).
- Firebase project `tracker-58b87` (project number 371034128407).
- Web app is one ~11k-line `index.html` + `voice.js`; deployed via Railway; native app loads it live.
- Both apps currently **debug-signed** (same debug keystore, SHA-256 `66:D4:5E…`).
