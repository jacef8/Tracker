import UIKit
import Capacitor
import CoreLocation
import WebKit
import AVFoundation
import PushKit
import CallKit
import PushToTalk   // iOS 16+ walkie-talkie framework (used only under @available guards below)
// Hard link-time reference for the sign-in plugin — see didFinishLaunching. Without any
// compile-time use, the static CapacitorFirebaseAuthentication framework can end up absent
// from the shipped binary even though `pod install` succeeds and the CI GoogleSignIn guard
// passes: Capacitor loads plugins reflectively (NSClassFromString from packageClassList),
// which gives the linker nothing to keep. Confirmed on a tester's v25 install 2026-07-30:
// runtime plugin fingerprint listed every plugin EXCEPT FirebaseAuthentication, so both
// sign-in buttons dead-ended at the "plugin missing" guard with only a transient toast.
import CapacitorFirebaseAuthentication

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, CLLocationManagerDelegate, WKNavigationDelegate, WKScriptMessageHandler, PKPushRegistryDelegate, CXProviderDelegate {

    var window: UIWindow?

    // ── Background location relaunch (2026-07-21) ──────────────────────────────────────
    // The vendored @capacitor-community/background-geolocation plugin only ever calls
    // CLLocationManager.startUpdatingLocation() with allowsBackgroundLocationUpdates=true —
    // fine while the app process stays alive in the background, but that's it. If iOS
    // terminates the process (routine under memory pressure, or the user swipes the app away),
    // NOTHING brings it back: there's no significant-location-change monitoring, so no way for
    // iOS to relaunch the app on movement. "Always" location permission is meaningless once the
    // process is gone. This is the exact same class of gap already found and fixed on Android
    // (HeadlessTrackerService/BootReceiver) — confirmed missing here 2026-07-21 after a real
    // family member's Crew location silently went stale despite Always-location being granted.
    //
    // startMonitoringSignificantLocationChanges() is the iOS API that survives termination: once
    // started, the OS itself keeps watching (independent of this process) and relaunches the app
    // in the background — with launchOptions[.location] set — whenever the device moves far
    // enough. This CLLocationManager instance must be created unconditionally on every launch
    // (including that relaunch) for the delegate callback below to actually fire.
    private var bgLocationManager: CLLocationManager?

    // Kept alive for the ENTIRE process lifetime, not recreated per fix (see reportFixInBackground
    // for why this changed 2026-07-22).
    private var headlessWebView: WKWebView?
    private var headlessPageReady = false
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private var pendingFix: CLLocation?
    private var lastReportedAt: Date?
    private var staleFixTimer: Timer?

    // ── Voice audio session bridge (2026-08-15) ────────────────────────────────────────
    // The web voice layer (voice.js) already calls window.GLAudioRouter.startVoiceService() /
    // stopVoiceService() the moment a LiveKit room connects/disconnects, plus start/stopMediaMode
    // around active speech. On Android those are wired to a native audio router. On iOS the object
    // never existed, so EVERY call was a silent no-op — no AVAudioSession was ever configured or
    // activated. Consequence: WebRTC (live PTT) and <audio> (recorded-clip playback) obeyed the
    // ring/silent switch, defaulted to the earpiece, and couldn't play with the screen off. This
    // installs a window.GLAudioRouter shim that posts those same calls to the handler below, which
    // drives a real AVAudioSession. Reason-sets so overlapping start/stop calls can't deactivate a
    // session another consumer still needs (e.g. mediaMode toggling mid-call must not kill the
    // whole-room session held by voiceService).
    private var glAudioBridgeInstalled = false
    private var uiDelegateProxy: GLWebUIDelegateProxy?
    private var audioRecordReasons = Set<String>()   // live voice (mic + playback) consumers
    private var audioPlayReasons = Set<String>()      // playback-only consumers (recorded clips)
    private var glAudioSessionActive = false

    // ── CallKit + PushKit VoIP (2026-08-15) ────────────────────────────────────────────
    // The ONLY iOS-sanctioned way to get live audio to a LOCKED / fully-backgrounded iPhone: a
    // PushKit VoIP push wakes the app even when killed, we report a CallKit call (mandatory —
    // iOS 13+ terminates the app if a VoIP push doesn't report one), and when CallKit activates
    // the audio session we tell the web layer to join the LiveKit room so its WebRTC audio plays
    // through the call. The VoIP token is handed to the web (window._onVoipToken) which registers
    // it in Firebase so the server's /voip endpoint can target this device.
    private var voipRegistry: PKPushRegistry?
    private var cxProvider: CXProvider?
    private var callController = CXCallController()
    private var currentCallUUID: UUID?
    private var pendingCallRoom: String = ""
    private var voipToken: String = ""
    private var callEndTimer: Timer?
    private var pttBox: Any?   // holds GLPushToTalk on iOS 16+ (Any so the class still builds < iOS 16)

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Forces the linker to keep the sign-in plugin's class (see the import note above).
        _ = FirebaseAuthenticationPlugin.self
        // Battery for the fix payload. iOS forbids the WEB battery API entirely, but the native
        // one is unrestricted (it's how Life360 reports iPhone battery). Read here, injected
        // into headless.html alongside each fix — see sendPendingFix.
        UIDevice.current.isBatteryMonitoringEnabled = true
        let mgr = CLLocationManager()
        mgr.delegate = self
        mgr.allowsBackgroundLocationUpdates = true
        mgr.pausesLocationUpdatesAutomatically = false
        // Confirmed on-device 2026-07-21: tracking stopped the instant the screen locked — well
        // before any real app termination, so significant-location-change alone (rare, ~500m+
        // jumps) can't be the whole story. The vendored plugin's OWN startUpdatingLocation() call
        // presumably keeps CoreLocation itself receiving updates fine in that state, but relaying
        // them from native code into the WebView's JS (Capacitor's plugin bridge) to actually
        // write to Firebase apparently doesn't survive the screen turning off — WKWebView JS
        // execution is known to get throttled once the app isn't foregrounded, independent of
        // whether the process itself is still alive. Running a SECOND, parallel continuous
        // location session here — reported via the same native → hidden-WKWebView →
        // headless.html path already built for the relaunch-after-termination case — means every
        // regular update also goes through a path that never depends on the main app's WebView/
        // bridge being active at all, not just the rare significant-change event.
        mgr.desiredAccuracy = kCLLocationAccuracyHundredMeters
        mgr.distanceFilter = 50 // meters — family-location-sharing granularity, not turn-by-turn
        mgr.startUpdatingLocation()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            mgr.startMonitoringSignificantLocationChanges()
        }
        bgLocationManager = mgr
        syncMonitoredRegions()   // from the UserDefaults cache — works on UI-less relaunches too
        setupVoip()              // PushKit VoIP registration + CallKit provider (locked-phone PTT)
        setupPushToTalk()        // iOS 16+ Push to Talk framework (ringless walkie-talkie)
        // A stationary device (moved less than distanceFilter) never gets another
        // didUpdateLocations callback at all, so its last-known fix would otherwise go stale in
        // Firebase after a few minutes and look exactly like tracking had silently stopped, even
        // though it's working correctly — just nothing to report. Periodically re-report the last
        // known location so "still here, unmoved" reads the same as "actively tracked" elsewhere
        // in the app (see _isRecentlyActiveInAnyCircle's 5-minute freshness window).
        staleFixTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            // Same foreground guard as locationManager(_:didUpdateLocations:) below — while
            // active, the main WebView's own path is already keeping this fresh continuously.
            if UIApplication.shared.applicationState == .active { return }
            let sinceLast = self.lastReportedAt.map { Date().timeIntervalSince($0) } ?? .infinity
            if sinceLast > 170, let loc = self.bgLocationManager?.location {
                self.reportFixInBackground(loc)
            }
        }
        // launchOptions[.location] != nil means iOS relaunched us purely for this — no UI will
        // ever be shown for this launch, and the Capacitor bridge/live web app won't load. That's
        // fine: the actual fix report happens from locationManager(_:didUpdateLocations:) below,
        // independent of whether the normal app UI ever starts up during this process lifetime.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // Silent-push wake ("bump"). A content-available push relaunches this app from suspension
    // AND from system termination (though never from a user force-quit — nothing does, for any
    // app). The server's /bump endpoint sends one when someone taps Refresh on a stale member;
    // this handler grabs the current location and reports it through the proven headless path,
    // which is exactly the Life360 "member refreshes right when you look at them" behaviour.
    // The remote-notification background mode is already declared in Info.plist.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        if let loc = bgLocationManager?.location {
            reportFixInBackground(loc)
            // Give the headless write a moment before iOS suspends us again.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { completionHandler(.newData) }
        } else {
            completionHandler(.noData)
        }
    }

    // ── Native geofences (Places) ────────────────────────────────────────────────────────
    // The web layer evaluates geofences only when fixes happen to flow. CLCircularRegion
    // monitoring is OS-level: crossings wake this app (even system-terminated) at ~zero
    // battery cost. The regions act purely as WAKE triggers — the actual arrive/leave logic,
    // hysteresis and pushes stay in headless.html's checkPlaceGeofences, which runs on the fix
    // this report generates. Place list arrives via __nativeSync (see below), cached in
    // UserDefaults so region monitoring survives relaunches where the web app never loads.
    private func syncMonitoredRegions() {
        guard let mgr = bgLocationManager else { return }
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        for r in mgr.monitoredRegions where r.identifier.hasPrefix("GL-") {
            mgr.stopMonitoring(for: r)
        }
        guard let json = UserDefaults.standard.string(forKey: "gl_native_places"),
              let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        // iOS caps monitored regions at 20 per app; leave headroom for the OS.
        for pl in arr.prefix(18) {
            guard let id = pl["id"] as? String,
                  let lat = pl["lat"] as? Double,
                  let lng = pl["lng"] as? Double else { continue }
            let radius = min(max((pl["r"] as? Double) ?? 100, 50), 400)
            let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng),
                                          radius: radius, identifier: "GL-" + id)
            region.notifyOnEntry = true
            region.notifyOnExit = true
            mgr.startMonitoring(for: region)
        }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        if let loc = manager.location { reportFixInBackground(loc) }
    }
    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        if let loc = manager.location { reportFixInBackground(loc) }
    }

    // Pull identity + places out of the LIVE web app whenever it comes to the foreground —
    // native code can't read the WebView's localStorage directly, so the web side exposes
    // __nativeSync() returning a JSON snapshot. Cached in UserDefaults for launches where the
    // UI (and thus the web app) never starts, e.g. a location-triggered background relaunch.
    func applicationDidBecomeActive(_ application: UIApplication) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self = self,
                  let bridgeVC = self.window?.rootViewController as? CAPBridgeViewController,
                  let wv = bridgeVC.webView else { return }
            self.installAudioBridge(wv)
            self.installUIDelegateProxy(wv)
            // Re-hand the VoIP token to the web now that the page is definitely loaded — the
            // didUpdate handoff can fire before window._onVoipToken exists (early launch), losing
            // it before it reaches Firebase. Idempotent; the web just re-files it. Falls back to
            // the persisted token if a fresh one hasn't arrived this session.
            let vt = self.voipToken.isEmpty ? (UserDefaults.standard.string(forKey: "gl_voip_token") ?? "") : self.voipToken
            if !vt.isEmpty {
                wv.evaluateJavaScript("window._onVoipToken && window._onVoipToken('\(vt)')", completionHandler: nil)
            }
            wv.evaluateJavaScript("window.__nativeSync ? window.__nativeSync() : ''") { result, _ in
                guard let json = result as? String, !json.isEmpty else { return }
                UserDefaults.standard.set(json, forKey: "gl_native_places")
                self.syncMonitoredRegions()
            }
            // Identity + fan-out targets, so background fixes can be written natively without
            // booting a WebView at all (see writeFixNatively).
            wv.evaluateJavaScript("window.__nativeWriteConfig ? window.__nativeWriteConfig() : ''") { result, _ in
                guard let json = result as? String, !json.isEmpty else { return }
                UserDefaults.standard.set(json, forKey: "gl_native_write_cfg")
            }
            // Push the OS settings that decide whether background location survives. These are
            // read-only — we can't change any of them — but "why does this phone keep going
            // offline" can't be answered without them: Low Power Mode, While-Using instead of
            // Always, reduced accuracy and Background App Refresh each silently stop background
            // reporting while the app looks perfectly healthy in the foreground.
            let js = "window.__nativeSettings && window.__nativeSettings(\(self.settingsJSON()))"
            wv.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// Read-only snapshot of the iOS settings that govern background location.
    private func settingsJSON() -> String {
        var parts: [String] = []
        parts.append("\"lowPower\":\(ProcessInfo.processInfo.isLowPowerModeEnabled)")

        let mgr = CLLocationManager()
        let auth: CLAuthorizationStatus
        if #available(iOS 14.0, *) { auth = mgr.authorizationStatus } else { auth = CLLocationManager.authorizationStatus() }
        // "Always" is the only setting that keeps fixes coming once the app is backgrounded;
        // "While Using" looks identical in the foreground and is the usual culprit.
        parts.append("\"locAlways\":\(auth == .authorizedAlways)")
        parts.append("\"locWhenInUse\":\(auth == .authorizedWhenInUse)")
        parts.append("\"locDenied\":\(auth == .denied || auth == .restricted)")
        if #available(iOS 14.0, *) {
            // Precise Location off gives ~1-3 km fixes — the dot still moves, just uselessly.
            parts.append("\"precise\":\(mgr.accuracyAuthorization == .fullAccuracy)")
        }
        parts.append("\"locServices\":\(CLLocationManager.locationServicesEnabled())")

        let refresh = UIApplication.shared.backgroundRefreshStatus
        parts.append("\"bgRefresh\":\(refresh == .available)")
        parts.append("\"bgRefreshDenied\":\(refresh == .denied)")

        let dev = UIDevice.current
        dev.isBatteryMonitoringEnabled = true
        if dev.batteryLevel >= 0 { parts.append("\"batt\":\(Int(dev.batteryLevel * 100))") }
        parts.append("\"charging\":\(dev.batteryState == .charging || dev.batteryState == .full)")
        parts.append("\"iosVer\":\"\(UIDevice.current.systemVersion)\"")

        return "{" + parts.joined(separator: ",") + "}"
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        // This manager runs unconditionally for the whole process lifetime (it has to, to survive
        // relaunch-after-termination) — but while the app is actually foregrounded, the main
        // Capacitor WebView's own GPS path is already reporting fixes at a much tighter cadence
        // for smooth marker movement (see _animateMarker in index.html, which glides over a fixed
        // 1.4s and assumes fixes arrive that often). This manager's distanceFilter/accuracy are
        // tuned coarse for battery, not smoothness. Reporting from both while foregrounded meant
        // this coarser, sparser source was competing with the smooth one for the same Firebase
        // write — confirmed 2026-07-22 as the cause of choppy/jumpy movement on iOS specifically
        // (Android has no equivalent competing native path). Only report from here when actually
        // backgrounded; the foreground path already has this covered.
        if UIApplication.shared.applicationState == .active { return }
        reportFixInBackground(loc)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Best-effort feature — a failed fix here should never crash or otherwise affect the app.
    }

    // Writes one location fix to Firebase via a hidden WebView loading the SAME headless.html
    // already built and proven for Android's HeadlessTrackerService — reuses its existing
    // identity/fan-out/auth logic entirely as-is (reads gl_uid/gl_favs/gl_circles/gl_joined from
    // the SAME localStorage the main app's WebView already writes to, since both share the
    // default WKWebsiteDataStore and load the exact same origin). Only the fix itself is
    // native-sourced here (CoreLocation, reliable in the background) rather than asking the
    // WebView to acquire its own — a WKWebView's own internal geolocation bridge is not
    // guaranteed the same background execution reliability as a native CLLocationManager
    // delegate callback, which is the entire reason this exists.
    //
    // 2026-07-22: this used to create a BRAND NEW WKWebView for every single fix — a full page
    // load, ES module import, and fresh Firebase SDK initialization, every ~50m of movement or
    // every 3 minutes while stationary, for hours on end. That's real, compounding memory/CPU
    // pressure with nothing ever torn down cleanly in between (a background-killed process can't
    // run deinit logic), and is a very plausible reason tracking could work for a while and then
    // go silently missing again — exactly what was reported on-device. Now the WebView is created
    // ONCE and reused for the lifetime of the process; every fix after the first is just a
    // evaluateJavaScript call against an already-warm page, no reload, no re-init.
    // MARK: - Native direct write (no WebView)

    // A background fix used to require: boot a hidden WKWebView, load headless.html over the
    // network, import an ES module, initialise the Firebase SDK, then run JS. Every one of those
    // steps can fail or simply run out of time inside the background execution budget iOS hands
    // out — and when it does, the fix is silently lost. That chain is the last place the WebView
    // sits between a location and the database.
    //
    // This writes the fix with a single URLSession request to Firebase's REST API instead. No
    // page, no runtime, no SDK. It runs FIRST on every background fix; the WebView path stays as
    // the fallback for the cases native can't cover yet (no cached config — e.g. a relaunch
    // before the web app has ever run on this install).
    private var cachedAuthToken: String?
    private var cachedAuthExpiry: Date = .distantPast

    private func nativeWriteConfig() -> [String: Any]? {
        guard let s = UserDefaults.standard.string(forKey: "gl_native_write_cfg"),
              let d = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let rooms = o["rooms"] as? [String], !rooms.isEmpty
        else { return nil }
        return o
    }

    // Firebase rules require auth != null — nothing stronger — so an anonymous token is enough.
    // Minted natively and cached; refreshed a few minutes before the hour-long expiry so a fix
    // never fails on a token that went stale mid-flight.
    private func withAuthToken(apiKey: String, _ done: @escaping (String?) -> Void) {
        if let t = cachedAuthToken, cachedAuthExpiry > Date().addingTimeInterval(300) { done(t); return }
        guard let url = URL(string: "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=\(apiKey)") else { done(nil); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = "{\"returnSecureToken\":true}".data(using: .utf8)
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let data = data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tok = o["idToken"] as? String else { done(nil); return }
            self?.cachedAuthToken = tok
            self?.cachedAuthExpiry = Date().addingTimeInterval(3600)
            done(tok)
        }.resume()
    }

    // Returns true if it handled the write, false to fall through to the WebView path.
    private func writeFixNatively(_ loc: CLLocation) -> Bool {
        guard let cfg = nativeWriteConfig(),
              let dbUrl = cfg["dbUrl"] as? String,
              let apiKey = cfg["apiKey"] as? String,
              let uid = cfg["uid"] as? String,
              let name = cfg["name"] as? String,
              let rooms = cfg["rooms"] as? [String]
        else { return false }

        let ts = Int(Date().timeIntervalSince1970 * 1000)
        var body: [String: Any] = [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracy": Int((loc.horizontalAccuracy * 3.28084).rounded()),
            "name": name,
            "dev": (cfg["dev"] as? String) ?? "phone",
            "ts": ts,
            // fixTs marks a position confirmed by a REAL fix — the web layer uses it to tell
            // "app alive" from "position current". This is always a genuine CLLocation.
            "fixTs": ts,
            "trail": true,
            "priv": (cfg["priv"] as? Int) ?? 0,
            "spdH": (cfg["spdH"] as? Int) ?? 0
        ]
        if loc.speed >= 0 { body["spd"] = Int((loc.speed * 2.23694).rounded()) }
        let lvl = UIDevice.current.batteryLevel
        if lvl >= 0 {
            body["batt"] = Int((lvl * 100).rounded())
            let st = UIDevice.current.batteryState
            body["chg"] = (st == .charging || st == .full) ? 1 : 0
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return false }

        // ── Trail history (2026-08-22) ────────────────────────────────────────────────────
        // This native path only ever PATCHed the LIVE row; trail points (glh/<crew>/<uid>/<date>)
        // came from the web layer, which iOS freezes in the background and wakes only every ~5 min
        // — so a backgrounded iPhone's trail had one breadcrumb per 5 minutes and short stops were
        // invisible. Mirror the web writer's rules here: Crews only, history on, accuracy <= 50 m,
        // moved > 50 m since the last point we wrote, and no > 150 mph jump. Our own last point is
        // persisted (UserDefaults) so the rule survives relaunches. Point shape matches the web's.
        var histRooms: [String] = []
        var histBody: Data? = nil
        var histDate = ""
        let histOn = ((cfg["hist"] as? NSNumber)?.intValue ?? 0) == 1
        let circles = (cfg["circles"] as? [String]) ?? []
        if histOn, !circles.isEmpty, loc.horizontalAccuracy > 0, loc.horizontalAccuracy <= 50 {
            let d = UserDefaults.standard
            let lastTs = d.double(forKey: "gl_hist_ts")
            var ok = true
            if lastTs > 0 {
                let last = CLLocation(latitude: d.double(forKey: "gl_hist_lat"), longitude: d.double(forKey: "gl_hist_lng"))
                let dist = loc.distance(from: last)
                if dist <= 50 { ok = false }
                let dt = max(1.0, (Double(ts) - lastTs) / 1000.0)
                if (dist / dt) * 2.23694 > 150 { ok = false }
            }
            if ok {
                d.set(loc.coordinate.latitude, forKey: "gl_hist_lat")
                d.set(loc.coordinate.longitude, forKey: "gl_hist_lng")
                d.set(Double(ts), forKey: "gl_hist_ts")
                let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd"; df.timeZone = .current
                histDate = df.string(from: Date())
                let pt: [String: Any] = ["lat": loc.coordinate.latitude, "lng": loc.coordinate.longitude,
                                         "ts": ts, "acc": Int(loc.horizontalAccuracy.rounded()), "src": "native"]
                histBody = try? JSONSerialization.data(withJSONObject: pt)
                histRooms = circles
            }
        }

        withAuthToken(apiKey: apiKey) { [weak self] token in
            guard let token = token else {
                // Couldn't authenticate — let the WebView path try instead of dropping the fix.
                DispatchQueue.main.async { self?.reportFixViaWebView(loc) }
                return
            }
            let group = DispatchGroup()
            for room in rooms {
                // PATCH, not PUT: merge into the existing row so fields this native path doesn't
                // know about (colour, hereSince, conn) survive. A PUT would wipe them.
                guard let u = URL(string: "\(dbUrl)/gl/\(room)/users/\(uid).json?auth=\(token)") else { continue }
                var r = URLRequest(url: u)
                r.httpMethod = "PATCH"
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = payload
                r.timeoutInterval = 20
                group.enter()
                URLSession.shared.dataTask(with: r) { _, _, _ in group.leave() }.resume()
            }
            // Trail point: POST (Firebase REST push → auto key) into each Crew's history for today.
            if let hb = histBody, !histDate.isEmpty {
                for room in histRooms {
                    guard let hu = URL(string: "\(dbUrl)/glh/\(room)/\(uid)/\(histDate).json?auth=\(token)") else { continue }
                    var hr = URLRequest(url: hu)
                    hr.httpMethod = "POST"
                    hr.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    hr.httpBody = hb
                    hr.timeoutInterval = 20
                    group.enter()
                    URLSession.shared.dataTask(with: hr) { _, _, _ in group.leave() }.resume()
                }
            }
            group.notify(queue: .main) { self?.endBackgroundTaskIfNeeded() }
        }
        return true
    }

    private func reportFixInBackground(_ loc: CLLocation) {
        lastReportedAt = Date()
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "GLLocationFix") { [weak self] in
            self?.endBackgroundTaskIfNeeded()
        }
        // Native REST first — no page load, no SDK, nothing to time out.
        if writeFixNatively(loc) { return }
        reportFixViaWebView(loc)
    }

    private func reportFixViaWebView(_ loc: CLLocation) {
        pendingFix = loc
        if let wv = headlessWebView, headlessPageReady {
            sendPendingFix(to: wv)
            return
        }
        if headlessWebView != nil {
            // Already loading from an earlier call — the fix just landed in pendingFix above,
            // and didFinish will pick up whatever's newest once the page is ready. Nothing more
            // to do; don't start a second load.
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.endBackgroundTaskIfNeeded() }
            return
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        // Tells headless.html to skip its own navigator.geolocation.watchPosition auto-start
        // (built for Android's HeadlessTrackerService) — this page now stays loaded for the
        // whole process lifetime on iOS too, so that would otherwise run continuously alongside
        // this native CLLocationManager as a redundant, competing GPS source. Injected at
        // document start so it's set before headless.html's own module script ever runs.
        let flagScript = WKUserScript(source: "window._nativeDriven = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        let controller = WKUserContentController()
        controller.addUserScript(flagScript)
        config.userContentController = controller
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        headlessWebView = wv
        guard let url = URL(string: "https://tracker-production-3b03.up.railway.app/headless.html") else {
            endBackgroundTaskIfNeeded()
            return
        }
        wv.load(URLRequest(url: url))
        // Safety net: never hold the background task open indefinitely if the page never
        // finishes loading (offline, slow network) or the injected call never resolves — that
        // would just drain the app's remaining background execution budget for nothing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.endBackgroundTaskIfNeeded() }
    }

    private func sendPendingFix(to webView: WKWebView) {
        guard let loc = pendingFix else { endBackgroundTaskIfNeeded(); return }
        pendingFix = nil
        let lat = loc.coordinate.latitude
        let lng = loc.coordinate.longitude
        let acc = loc.horizontalAccuracy
        let spd = loc.speed
        // Battery rides along. batteryLevel is -1 when unknown (simulator, monitoring off) —
        // skip the injection then, so the web layer's "absent means unknown" convention holds.
        var battJS = ""
        let lvl = UIDevice.current.batteryLevel
        if lvl >= 0 {
            let pct = Int((lvl * 100).rounded())
            let st = UIDevice.current.batteryState
            let chg = (st == .charging || st == .full) ? "true" : "false"
            battJS = "window._batt={pct:\(pct),chg:\(chg)};"
        }
        let js = battJS + "window._writeIOSFix && window._writeIOSFix(\(lat), \(lng), \(acc), \(spd));"
        webView.evaluateJavaScript(js) { [weak self] _, _ in
            // Give the Firebase write itself a moment to actually reach the network before
            // ending the background task — evaluateJavaScript's completion only means the
            // synchronous call returned, not that the async `set()` write completed.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.endBackgroundTaskIfNeeded() }
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Only fires once, the first time the persistent WebView loads. headless.html's Firebase
        // SDK is loaded as an ES module (deferred, async) — the document's own load event (this
        // callback) can fire before that module has actually finished executing and defined
        // window._writeIOSFix. A short additional wait gives it room; the module itself does
        // negligible work (no heavy imports beyond Firebase's own lazy-loaded pieces), so this
        // margin is generous rather than tight.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            self.headlessPageReady = true
            self.sendPendingFix(to: webView)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // The page failed to load at all — drop it so the next fix tries a fresh load instead of
        // being stuck waiting on a WebView that will never call didFinish.
        headlessWebView = nil
        headlessPageReady = false
        endBackgroundTaskIfNeeded()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        headlessWebView = nil
        headlessPageReady = false
        endBackgroundTaskIfNeeded()
    }

    private func endBackgroundTaskIfNeeded() {
        if bgTask != .invalid {
            UIApplication.shared.endBackgroundTask(bgTask)
            bgTask = .invalid
        }
    }

    // MARK: - Voice audio session bridge

    // JS shim defining window.GLAudioRouter with the SAME method names Android's native router
    // exposes, so voice.js needs zero platform branching. Each method posts to the handler below.
    // Guarded so it only defines the object once and never clobbers a real (Android) router.
    private static let glAudioShim = """
    (function(){
      if (window.GLAudioRouter) return;
      function post(op, reason){
        try { window.webkit.messageHandlers.glAudioRouter.postMessage({ op: op, reason: reason || 'default' }); } catch (e) {}
      }
      window.GLAudioRouter = {
        startVoiceService: function(){ post('rec+', 'service'); },
        stopVoiceService:  function(){ post('rec-', 'service'); },
        startMediaMode:    function(){ post('rec+', 'media'); },
        stopMediaMode:     function(){ post('rec-', 'media'); },
        startClipPlayback: function(){ post('play+', 'clip'); },
        stopClipPlayback:  function(){ post('play-', 'clip'); },
        setVoiceNotificationVisible: function(){ /* iOS has no persistent voice notification */ }
      };
    })();
    """

    private func installAudioBridge(_ wv: WKWebView) {
        if !glAudioBridgeInstalled {
            let ucc = wv.configuration.userContentController
            ucc.add(self, name: "glAudioRouter")
            // Document-start user script so the shim is re-defined on EVERY page load — including a
            // force-reload or web update — before voice.js ever looks for window.GLAudioRouter.
            ucc.addUserScript(WKUserScript(source: AppDelegate.glAudioShim,
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
            // Push to Talk bridge — ONLY on iOS 16+, so the web can feature-detect
            // `window.GLPushToTalk` to know the ringless framework is available here.
            if #available(iOS 16.0, *) {
                ucc.add(self, name: "glPtt")
                ucc.addUserScript(WKUserScript(source: AppDelegate.glPttShim,
                                               injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
            glAudioBridgeInstalled = true
        }
        // Inject once now for the ALREADY-loaded page (the user script only affects future loads).
        // The shim is idempotent (it early-returns if the object already exists).
        wv.evaluateJavaScript(AppDelegate.glAudioShim, completionHandler: nil)
        if #available(iOS 16.0, *) { wv.evaluateJavaScript(AppDelegate.glPttShim, completionHandler: nil) }
    }

    private static let glPttShim = """
    (function(){
      if (window.GLPushToTalk) return;
      function post(fn, arg){ try { window.webkit.messageHandlers.glPtt.postMessage({ fn: fn, arg: arg || '' }); } catch (e) {} }
      window.GLPushToTalk = {
        available: true,                                     // presence = iOS 16+ native PTT
        joinChannel:   function(name){ post('join', name); },
        leave:         function(){ post('leave'); },
        beginTransmit: function(){ post('beginTx'); },
        endTransmit:   function(){ post('endTx'); }
      };
    })();
    """

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // Push to Talk control from the web (iOS 16+).
        if message.name == "glPtt" {
            guard let body = message.body as? [String: Any], let fn = body["fn"] as? String else { return }
            let arg = (body["arg"] as? String) ?? ""
            switch fn {
            case "join":    pttJoin(arg)
            case "leave":   pttLeave()
            case "beginTx": pttBeginTransmit()
            case "endTx":   pttEndTransmit()
            default: break
            }
            return
        }
        guard message.name == "glAudioRouter",
              let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }
        let reason = (body["reason"] as? String) ?? "default"
        switch op {
        case "rec+":  audioRecordReasons.insert(reason)
        case "rec-":
            audioRecordReasons.remove(reason)
            // Voice session finished (room disconnected) — tear the CallKit call down with it,
            // instead of leaving it active in the phone's call stack forever.
            if reason == "service" { endActiveCall(reason: .remoteEnded) }
        case "play+": audioPlayReasons.insert(reason)
        case "play-": audioPlayReasons.remove(reason)
        default: return
        }
        applyAudioSession()
    }

    // Drives the shared AVAudioSession from the reason-sets. .playAndRecord / .playback both play
    // OVER the ring/silent switch (the whole point) and keep audio alive with the screen off while
    // active; .defaultToSpeaker keeps a phone-in-hand call on the loudspeaker, not the earpiece.
    private func applyAudioSession() {
        // During a CallKit call, CallKit OWNS the audio session — don't set/activate/deactivate it
        // underneath, or the call audio breaks. The web's GLAudioRouter calls become no-ops here.
        if currentCallUUID != nil { return }
        let sess = AVAudioSession.sharedInstance()
        if !audioRecordReasons.isEmpty {
            do {
                try sess.setCategory(.playAndRecord,
                                     options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers])
                try sess.setActive(true)
                glAudioSessionActive = true
            } catch { /* best-effort — never crash a call over audio routing */ }
        } else if !audioPlayReasons.isEmpty {
            do {
                try sess.setCategory(.playback, options: [.mixWithOthers])
                try sess.setActive(true)
                glAudioSessionActive = true
            } catch { }
        } else if glAudioSessionActive {
            do { try sess.setActive(false, options: [.notifyOthersOnDeactivation]) } catch { }
            glAudioSessionActive = false
        }
    }

    // Auto-answer the WKWebView per-site geolocation prompt. iOS shows "tracker-….railway.app
    // would like to use your current location" INSIDE the app even though the app itself already
    // holds Always/precise location — and unlike Safari, the WebView doesn't durably remember the
    // grant across app restarts/updates, so family members were re-prompted over and over. The
    // proxy wraps Capacitor's own WKUIDelegate (forwarding everything else — JS alerts etc.) and
    // grants geolocation for any frame, which tells WebKit to use the app's existing CoreLocation
    // permission with no dialog.
    private func installUIDelegateProxy(_ wv: WKWebView) {
        guard #available(iOS 15.0, *) else { return }
        if let p = uiDelegateProxy, wv.uiDelegate === p { return }
        let proxy = GLWebUIDelegateProxy()
        proxy.wrapped = wv.uiDelegate
        uiDelegateProxy = proxy      // WKWebView holds uiDelegate weakly — we must retain it
        wv.uiDelegate = proxy
    }

    // MARK: - PushKit (VoIP) + CallKit

    private func setupVoip() {
        // CallKit provider — the native call UI that lets audio ring through a locked phone.
        // Use the localizedName initializer, not CXProviderConfiguration() — the empty init is
        // iOS 14+, but this app deploys to iOS 13.
        let cfg = CXProviderConfiguration(localizedName: "GroundLink")
        cfg.supportsVideo = false
        cfg.maximumCallsPerCallGroup = 1
        cfg.maximumCallGroups = 1
        cfg.supportedHandleTypes = [.generic]
        let provider = CXProvider(configuration: cfg)
        provider.setDelegate(self, queue: nil)
        cxProvider = provider
        // PushKit — register for VoIP pushes; the token arrives in didUpdate below.
        let reg = PKPushRegistry(queue: .main)
        reg.delegate = self
        reg.desiredPushTypes = [.voIP]
        voipRegistry = reg
    }

    // The live Capacitor WebView, fetched on demand (it may not have existed when a background
    // wake began). Nil if the UI hasn't loaded yet — e.g. a cold VoIP launch mid-page-load.
    private func mainWebView() -> WKWebView? {
        return (window?.rootViewController as? CAPBridgeViewController)?.webView
    }

    // MARK: PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        voipToken = token
        UserDefaults.standard.set(token, forKey: "gl_voip_token")
        // Hand to the web so it registers the token in Firebase (the server /voip endpoint targets it).
        DispatchQueue.main.async { [weak self] in
            self?.mainWebView()?.evaluateJavaScript("window._onVoipToken && window._onVoipToken('\(token)')", completionHandler: nil)
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        voipToken = ""
        UserDefaults.standard.removeObject(forKey: "gl_voip_token")
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        // iOS 13+ REQUIRES reporting a CallKit call synchronously here or it terminates the app and
        // throttles future VoIP pushes. Parse room + caller from the payload, report the call.
        let dict = payload.dictionaryPayload
        let room = (dict["room"] as? String) ?? ""
        let fromName = (dict["fromName"] as? String) ?? "GroundLink"
        // NEVER stack our call on top of a real phone call. CallKit puts every reported call in
        // the SAME system call stack, so a GroundLink call raised during a cellular call fought
        // with it — the hang-up button acted on the wrong call (reported 2026-08-27). If any call
        // already exists, take the push as a no-op.
        if !CXCallObserver().calls.isEmpty { completion(); return }
        pendingCallRoom = room
        let uuid = UUID()
        currentCallUUID = uuid
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: fromName)
        update.hasVideo = false
        update.localizedCallerName = fromName
        cxProvider?.reportNewIncomingCall(with: uuid, update: update) { _ in completion() }
        // Hard stop: an unanswered call must not linger in the system call stack. Nothing ended
        // it before, so a missed transmission left the phone believing a call was still up.
        DispatchQueue.main.async { [weak self] in
            self?.callEndTimer?.invalidate()
            self?.callEndTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                self?.endActiveCall(reason: .unanswered)
            }
        }
    }

    /// End whatever CallKit call we currently have, and stop the timeout. Safe to call repeatedly.
    private func endActiveCall(reason: CXCallEndedReason) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.callEndTimer?.invalidate(); self.callEndTimer = nil
            guard let uuid = self.currentCallUUID else { return }
            self.currentCallUUID = nil
            self.pendingCallRoom = ""
            self.cxProvider?.reportCall(with: uuid, endedAt: nil, reason: reason)
            self.applyAudioSession()   // CallKit no longer owns the session
        }
    }

    // MARK: CXProviderDelegate

    func providerDidReset(_ provider: CXProvider) {
        currentCallUUID = nil
        pendingCallRoom = ""
    }

    // CallKit activated the audio session — NOW the web layer can join and its WebRTC audio plays
    // through the call, even on a locked phone. This is the entire point of the VoIP path.
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        glAudioSessionActive = true
        let room = pendingCallRoom
        DispatchQueue.main.async { [weak self] in
            self?.mainWebView()?.evaluateJavaScript("window._callkitJoin && window._callkitJoin('\(room)')", completionHandler: nil)
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { }

    // Answered (user swiped, or an auto-answer) — audio starts on didActivate above.
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        callEndTimer?.invalidate(); callEndTimer = nil
        action.fulfill()
    }

    // Ended/declined — tell the web to leave the channel.
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        callEndTimer?.invalidate(); callEndTimer = nil
        currentCallUUID = nil
        pendingCallRoom = ""
        DispatchQueue.main.async { [weak self] in
            self?.mainWebView()?.evaluateJavaScript("window._callkitEnd && window._callkitEnd()", completionHandler: nil)
        }
        action.fulfill()
    }

    // MARK: - Push to Talk (iOS 16+, ringless walkie-talkie)

    private func setupPushToTalk() {
        guard #available(iOS 16.0, *) else { return }   // older iPhones keep the CallKit path
        let ptt = GLPushToTalk()
        // Ephemeral push token → hand to the web, which files it in Firebase (gl/_pttSubs/<uid>)
        // so the server can send Push-to-Talk pushes to this channel.
        ptt.onEphemeralToken = { [weak self] tok in
            DispatchQueue.main.async {
                self?.mainWebView()?.evaluateJavaScript("window._onPttToken && window._onPttToken('\(tok)')", completionHandler: nil)
            }
        }
        // RX: framework activated audio for an incoming transmission — tell the web to join LiveKit.
        ptt.onJoinRoom = { [weak self] room in
            DispatchQueue.main.async {
                self?.mainWebView()?.evaluateJavaScript("window._pttJoin && window._pttJoin('\(room)')", completionHandler: nil)
            }
        }
        // TX: user pressed the system PTT — tell the web to publish the mic; release → stop.
        ptt.onBeginTx = { [weak self] in
            DispatchQueue.main.async { self?.mainWebView()?.evaluateJavaScript("window._pttBeginTx && window._pttBeginTx()", completionHandler: nil) }
        }
        ptt.onEndTx = { [weak self] in
            DispatchQueue.main.async { self?.mainWebView()?.evaluateJavaScript("window._pttEndTx && window._pttEndTx()", completionHandler: nil) }
        }
        ptt.start()
        pttBox = ptt
    }

    // Called from the web (glPtt message handler) to drive the framework.
    private func pttJoin(_ name: String) { if #available(iOS 16.0, *) { (pttBox as? GLPushToTalk)?.joinChannel(name: name) } }
    private func pttLeave() { if #available(iOS 16.0, *) { (pttBox as? GLPushToTalk)?.leaveChannel() } }
    private func pttBeginTransmit() { if #available(iOS 16.0, *) { (pttBox as? GLPushToTalk)?.beginTransmit() } }
    private func pttEndTransmit() { if #available(iOS 16.0, *) { (pttBox as? GLPushToTalk)?.endTransmit() } }

}

// WKUIDelegate proxy: implements ONLY the geolocation-permission callback (auto-grant, so the
// app's existing CoreLocation permission is used without the per-site dialog) and forwards every
// other delegate method to Capacitor's real WKUIDelegate via the responder machinery.
final class GLWebUIDelegateProxy: NSObject, WKUIDelegate {
    weak var wrapped: WKUIDelegate?

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return wrapped?.responds(to: aSelector) ?? false
    }
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if super.responds(to: aSelector) { return nil }
        return wrapped
    }

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestGeolocationPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

// Self-contained Push to Talk manager — kept in its own @available class so AppDelegate still
// compiles for iOS 13+. Bridges Apple's PTChannelManager to the web LiveKit layer: the framework
// owns the ringless UI + audio session; the web still transports the actual audio.
@available(iOS 16.0, *)
final class GLPushToTalk: NSObject, PTChannelManagerDelegate, PTChannelRestorationDelegate {
    private var manager: PTChannelManager?
    private var channelUUID: UUID?
    private var channelName = "GroundLink"
    private var pendingRoom = ""
    var onEphemeralToken: ((String) -> Void)?
    var onJoinRoom: ((String) -> Void)?
    var onBeginTx: (() -> Void)?
    var onEndTx: (() -> Void)?

    func start() {
        guard manager == nil else { return }
        Task {
            do { self.manager = try await PTChannelManager.channelManager(delegate: self, restorationDelegate: self) }
            catch { }
        }
    }

    func joinChannel(name: String) {
        if !name.isEmpty { channelName = name }
        let uuid = channelUUID ?? UUID(); channelUUID = uuid
        let descriptor = PTChannelDescriptor(name: channelName, image: nil)
        manager?.requestJoinChannel(channelUUID: uuid, descriptor: descriptor)
    }
    func leaveChannel() { if let uuid = channelUUID { manager?.leaveChannel(channelUUID: uuid) } }
    func beginTransmit() { if let uuid = channelUUID { manager?.requestBeginTransmitting(channelUUID: uuid) } }
    func endTransmit() { if let uuid = channelUUID { manager?.stopTransmitting(channelUUID: uuid) } }

    // MARK: PTChannelManagerDelegate
    func channelManager(_ channelManager: PTChannelManager, didJoinChannel channelUUID: UUID, reason: PTChannelJoinReason) {}
    func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {}
    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) { onBeginTx?() }
    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) { onEndTx?() }
    func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
        onEphemeralToken?(pushToken.map { String(format: "%02x", $0) }.joined())
    }
    func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
        pendingRoom = (pushPayload["room"] as? String) ?? ""
        let who = (pushPayload["fromName"] as? String) ?? "GroundLink"
        return .activeRemoteParticipant(PTParticipant(name: who, image: nil))
    }
    func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) { onJoinRoom?(pendingRoom) }
    func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {}

    // MARK: PTChannelRestorationDelegate
    func channelDescriptor(restoredChannelUUID: UUID) -> PTChannelDescriptor {
        return PTChannelDescriptor(name: channelName, image: nil)
    }
}
