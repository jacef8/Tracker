# Turning on Google sign-in — evening checklist

Everything in the app is already built (build 54). Google sign-in is wired but
**dormant** until you do the steps below. Guests + the backup/restore code work
right now without any of this.

Firebase project: **tracker-58b87**
Android package: **com.groundlink.app**
Web/PWA domain: **tracker-production-3b03.up.railway.app**

---

## Part A — Web + PWA Google (no rebuild, ~3 min)
Makes the "Sign in with Google" button work in browsers and installed PWAs.

1. Go to console.firebase.google.com → project **tracker-58b87**.
2. **Build → Authentication → Get started** (if first time).
3. **Sign-in method → Google → Enable**, choose a support email, **Save**.
4. **Authentication → Settings → Authorized domains → Add domain** →
   `tracker-production-3b03.up.railway.app`

➡️ After this, Google login works on desktop browsers and installed PWAs.

---

## Part B — Google inside the native Android app (rebuild)

5. Firebase console → **Project settings (gear) → Your apps → Add app → Android**.
   - Android package name: `com.groundlink.app`
   - Register the app, then **Download google-services.json**.
   - Save it to: `native-app\android\app\google-services.json`

6. Register your app's signing fingerprints so Google trusts it:
   ```powershell
   cd C:\Users\jford\Documents\Tracker\native-app\android
   .\gradlew.bat signingReport
   ```
   - Copy the **SHA1** and **SHA-256** listed under `Variant: debug`.
   - Firebase console → Project settings → Your apps → (the Android app) →
     **Add fingerprint** → paste SHA1, add another for SHA-256 → **Save**.
   - **Re-download google-services.json** (it now contains the OAuth client) and
     replace the file in `native-app\android\app\`.

7. Build the APK:
   ```powershell
   cd C:\Users\jford\Documents\Tracker\native-app
   npm install
   npx cap sync android
   cd android
   .\gradlew.bat assembleDebug
   ```
   APK output: `native-app\android\app\build\outputs\apk\debug\app-debug.apk`

8. (Only if the build errors about a missing Google sign-in class) open
   `native-app\android\app\build.gradle`, add inside `dependencies { }`:
   ```
   implementation 'com.google.android.gms:play-services-auth:21.2.0'
   ```
   then rebuild. Usually not needed — the plugin pulls it in.

---

## Notes
- This same APK also carries the WebView cache fix, Share, Haptics (native
  vibration), and the new join/chat/pin alerts.
- If `signingReport` fails to find a debug keystore, run one `.\gradlew.bat assembleDebug`
  first (it creates `~/.android/debug.keystore`), then re-run the signing report.
- When you ship a Play Store / release build later, add that keystore's SHA1 too.
