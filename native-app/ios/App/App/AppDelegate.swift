import UIKit
import Capacitor
import CoreLocation
import WebKit
// Hard link-time reference for the sign-in plugin — see didFinishLaunching. Without any
// compile-time use, the static CapacitorFirebaseAuthentication framework can end up absent
// from the shipped binary even though `pod install` succeeds and the CI GoogleSignIn guard
// passes: Capacitor loads plugins reflectively (NSClassFromString from packageClassList),
// which gives the linker nothing to keep. Confirmed on a tester's v25 install 2026-07-30:
// runtime plugin fingerprint listed every plugin EXCEPT FirebaseAuthentication, so both
// sign-in buttons dead-ended at the "plugin missing" guard with only a transient toast.
import CapacitorFirebaseAuthentication

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, CLLocationManagerDelegate, WKNavigationDelegate {

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
        }
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

}
