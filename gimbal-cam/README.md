# Gimbal Cam

A small camera app for iPhone and Android that you control from a DJI Osmo Mobile gimbal
(built for the Osmo Mobile 7 / 7P):

- **Record button on the gimbal:** press to start recording, press again to pause, press again
  to resume. It all stays **one video**.
- **Hold the record button about 1 second** (or tap ■ on screen) to stop and save.
- **Zoom wheel / slider:** roll or push it to zoom in and out. Holding it zooms smoothly. On
  iPhones with several lenses, zoom moves across the ultra-wide, wide and telephoto lenses
  like the built-in Camera app does.
- Pinch the screen to zoom, and use ⟲ to flip cameras (only when not recording).

Android saves videos to **Movies/GimbalCam**. iPhone saves them to **Photos**.

## How the gimbal talks to the app

DJI doesn't publish an SDK for Osmo Mobile gimbals, so no third-party app can use DJI Mimo's
private connection. Gimbal Cam uses the other connection the gimbal has: its **Bluetooth
remote mode**, the same one that lets the shutter work in the phone's built-in camera app. In
that mode the gimbal acts like a Bluetooth keyboard/remote, so its controls reach the app as
key presses:

| Phone | What the app listens for |
|---|---|
| Android | Every key event: volume, camera, media play/pause, Enter, arrows, Page Up/Down, zoom keys, and scroll-wheel input. |
| iPhone | Volume up/down presses, received through Apple's camera-button API (iOS 17.2+), which also blocks the volume change. Also keyboard-style keys (Enter, Space, arrows, Page Up/Down). |

DJI doesn't document which key each control sends, and it can change with firmware. The app
starts with the common defaults (shutter → record, volume down / Page Down / arrows → zoom).
The **⚙ Gimbal buttons** screen shows every press the phone receives, and you can teach it
your gimbal's controls:

1. Pair the gimbal with the phone in **Bluetooth settings**. DJI Mimo pairing alone isn't
   enough. Close DJI Mimo so it doesn't take over the gimbal.
2. Open Gimbal Cam, tap **⚙**, and press each gimbal control. The top line shows what came in.
3. Tap **Learn** next to an action, then press or roll the gimbal control you want for it.

If a control shows **nothing** on the ⚙ screen, the gimbal isn't sending it to the phone
over Bluetooth, and no app outside DJI Mimo can receive it.

## Building

### Android (`gimbal-cam/android`)

- **On your PC:** double-click `gimbal-cam/android/build-apk.bat`. The APK is copied to
  `Tracker\GimbalCam-latest.apk`. It uses GroundLink's SDK setup.
- **On GitHub:** Actions → **Gimbal Cam — Android APK** → *Run workflow* (it also runs on every
  push under `gimbal-cam/android/`). Download `gimbal-cam-apk` from the run.

The app is signed with the same sideload key as GroundLink, so new builds install over old
ones. Package: `com.groundlink.gimbalcam` (Android 7.0+).

### iPhone (`gimbal-cam/ios`)

The Xcode project is generated from `project.yml` by [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen && xcodegen generate`). Requires iOS 17. Gimbal volume-button control
needs iOS 17.2 or later.

- **Compile check:** every push under `gimbal-cam/ios/` runs **Gimbal Cam — iOS**, which builds
  for the simulator.
- **TestFlight:** Actions → **Gimbal Cam — iOS** → *Run workflow* with **testflight** ticked. It
  uses the same App Store Connect key and distribution certificate secrets as GroundLink.

**One-time setup before the first TestFlight upload**, which Apple doesn't allow through the API:

1. developer.apple.com → Identifiers → **+** → App ID `com.groundlink.gimbalcam` (no extra
   capabilities needed).
2. App Store Connect → Apps → **+ New App** → iOS, name "Gimbal Cam", bundle ID
   `com.groundlink.gimbalcam`.
3. After the first build is processed, add yourself to an internal testing group in that
   app's TestFlight tab.
