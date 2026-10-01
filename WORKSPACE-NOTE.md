# Workspace note — GroundLink

**This folder is the GroundLink app source & deploy repo.**

- It was previously named `Tracker`. The folder was renamed to `GroundLink` on 2026-07-07
  during a workspace cleanup so the folder name matches the product.
- The **GitHub remote is still named `Tracker`** (`https://github.com/jacef8/Tracker.git`).
  That is intentional — only the local folder was renamed; the remote/CI were left untouched.
- `store-assets/` holds Play Store marketing graphics (feature image, icon, screenshots,
  source art). These moved here from the old loose `Documents\GroundLink` assets folder.

## ⚠️ Release signing key — do NOT lose, do NOT commit

The **Play Store release signing keystore** is kept OUTSIDE this repo (this repo is public):

    C:\Users\jford\Documents\GroundLink-release-signing\
        internal_cert.der
        play-package\  (GroundLink.aab, GroundLink.apk, signing.keystore, signing-key-info.txt, assetlinks.json)

Losing `signing.keystore` means you can never publish an update to the existing Play Store
listing again. Back this folder up somewhere safe (it is not in git by design — `.gitignore`
excludes `*.keystore` / `*.aab`).

The committed `native-app/android/app/groundlink.keystore` is only the low-value **debug**
sideload key — that one is fine in the repo.
