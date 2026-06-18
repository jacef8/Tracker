# GroundLink — Native Android (Capacitor) with background GPS

This folder is a **separate** project from the web app / Railway server. Its only
job is to produce an Android app that loads the live GroundLink site **and** runs
native background location, so tracking continues when the app is backgrounded or
the screen is off (which a plain web app / TWA cannot do).

The web side is already wired: `public/index.html` calls `startNativeBackgroundTracking()`,
which is inert everywhere except inside this Capacitor app. When it detects the
native runtime it starts `@capacitor-community/background-geolocation` (a foreground
service) and feeds fixes into the same Firebase pipeline as the web GPS.

---

## Option A — Sideload APK (no Play Store) ✅ fastest for testing

This skips Play entirely: no review, no signing match, no data-safety form. Background
location still works — the user just grants "Allow all the time" on the device.

From this `native-app/` folder:

```bash
npm install
npx cap add android
npx cap sync android
```

Add the permissions to `android/app/src/main/AndroidManifest.xml` (see the snippet in
"Add permissions" below — this step is the same for both options).

Then build a debug APK:

```bash
cd android
./gradlew assembleDebug          # Windows: .\gradlew.bat assembleDebug
```

The APK lands at:

```
native-app/android/app/build/outputs/apk/debug/app-debug.apk
```

(Or in Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**, then click
"locate" in the popup.)

**Install it on a phone:**
- USB + adb: `adb install -r app-debug.apk`
- Or copy the `.apk` to the phone, tap it, and allow "Install unknown apps" for your
  file manager / browser when prompted.

**After install:** open the app, and when it asks for location choose **Allow**, then
go to Android Settings → Apps → GroundLink → Permissions → Location → **Allow all the
time** (Android won't grant background location from the in-app prompt alone).

### ⚠️ One gotcha: signature conflict with the Play (TWA) app
This build uses the same package id `com.groundlink.app` as your Play TWA but a
*different* (debug) signature, so Android **won't install it over the existing Play
app** — you'll get `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Two options:
- **Uninstall the Play/TWA version first** on the test phone, then install the APK.
- **Or run both side by side:** in `capacitor.config.json` change `appId` to
  `com.groundlink.app.dev`, re-run `npx cap sync android`, and rebuild. It installs as
  a separate app (its own data) and can't clash. (Capacitor loading a remote `server.url`
  doesn't need the domain's assetlinks, so a different id is fine.)

A debug APK is signed with the throwaway debug key — perfect for your own testers. If
you want to hand it out more widely, build a **release** APK with your own keystore
(`./gradlew assembleRelease` after adding a `signingConfig`, or Android Studio →
*Generate Signed Bundle/APK → APK*).

---

## Option B — Google Play (later): two things that will bite you

1. **Package name + signing must match your current Play app**
   The existing Play Store (TWA) app is `com.groundlink.app`. This config reuses
   that `appId`, but Play also requires the **same signing key**. If your TWA used
   **Play App Signing** (most do), you must upload this new build to the **same app**
   in Play Console so Google re-signs it with the same key — then it's an *update*.
   If the upload key differs and you're not on Play App Signing, Play will reject it
   as a different app. Confirm your signing setup in Play Console → *App integrity*
   before you build.

2. **Background location needs Google review**
   `ACCESS_BACKGROUND_LOCATION` triggers a mandatory review: a written justification,
   a short demo video showing the persistent notification, and a *prominent in-app
   disclosure* before you request the permission. Budget several days for approval.

---

## Build steps

From this `native-app/` folder:

```bash
npm install
npx cap add android          # generates the android/ project
npx cap sync android         # installs the plugin into the project
npx cap open android         # opens it in Android Studio
```

### Add permissions to the Android manifest

Open `android/app/src/main/AndroidManifest.xml` and add these inside `<manifest>`
(above `<application>`):

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

The background-geolocation plugin contributes its own foreground `<service>` via
manifest merging, so you don't declare the service yourself.

### Build & ship

1. In Android Studio: **Build → Generate Signed Bundle/APK → Android App Bundle (.aab)**.
2. Use the **same signing** as your existing Play app (see warning #1).
3. Upload the `.aab` to your **closed testing** track in Play Console.
4. Complete the **Data safety** form (Location → collected, shared, background use)
   and the **background location declaration** form. Submit for review.

---

## How tracking behaves

- Foreground: both the web `watchPosition` and the native watcher run — identical
  Firebase writes, just refreshed a bit more often. Harmless.
- Background / screen off / app swiped away (but service alive): only the native
  watcher runs, and it keeps writing the user's position + breadcrumbs to Firebase.
- A persistent "GroundLink is sharing your location" notification is shown while the
  service runs — this is required by Android and is not optional.
- Leaving a room (EXIT) calls `stopNativeBackgroundTracking()`, which removes the
  watcher and stops the service.

## Tuning

- `distanceFilter` (in `public/index.html`, `startNativeBackgroundTracking`) is the
  minimum metres moved before a new fix — raise it to save battery, lower it for
  tighter trails.
- `backgroundTitle` / `backgroundMessage` set the notification text.

## Updating the web app

Because `capacitor.config.json` points `server.url` at the live Railway site, any
web change you deploy to Railway shows up in the native app automatically — you only
rebuild/resubmit the Android app when you change native code, permissions, or the
plugin. (If you'd rather bundle the web assets offline instead, copy `public/` into
`www/` and remove the `server` block from `capacitor.config.json`.)
