import UIKit
import Capacitor
import CoreLocation
import WebKit

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

    // Kept alive only for the duration of a single background fix report, then released.
    private var headlessWebView: WKWebView?
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private var pendingFix: CLLocation?
    private var lastReportedAt: Date?
    private var staleFixTimer: Timer?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
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
        // A stationary device (moved less than distanceFilter) never gets another
        // didUpdateLocations callback at all, so its last-known fix would otherwise go stale in
        // Firebase after a few minutes and look exactly like tracking had silently stopped, even
        // though it's working correctly — just nothing to report. Periodically re-report the last
        // known location so "still here, unmoved" reads the same as "actively tracked" elsewhere
        // in the app (see _isRecentlyActiveInAnyCircle's 5-minute freshness window).
        staleFixTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { [weak self] _ in
            guard let self = self else { return }
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

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
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
    private func reportFixInBackground(_ loc: CLLocation) {
        // Continuous updates (every distanceFilter meters) plus the periodic stale-fix timer
        // could otherwise both fire close together and overlap two in-flight WKWebView reports,
        // each silently overwriting the other's pendingFix/bgTask handle. Simplest safe guard:
        // drop this update if one's already in flight rather than risk corrupted overlapping
        // state — an occasional skipped fix is harmless; a leaked background task token isn't.
        guard headlessWebView == nil else { return }
        pendingFix = loc
        lastReportedAt = Date()
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "GLLocationFix") { [weak self] in
            self?.endBackgroundTaskIfNeeded()
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
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

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // headless.html's Firebase SDK is loaded as an ES module (deferred, async) — the
        // document's own load event (this callback) can fire before that module has actually
        // finished executing and defined window._writeIOSFix. A short additional wait gives it
        // room; the module itself does negligible work (no heavy imports beyond Firebase's own
        // lazy-loaded pieces), so this margin is generous rather than tight.
        guard let loc = pendingFix else { endBackgroundTaskIfNeeded(); return }
        let lat = loc.coordinate.latitude
        let lng = loc.coordinate.longitude
        let acc = loc.horizontalAccuracy
        let spd = loc.speed
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            let js = "window._writeIOSFix && window._writeIOSFix(\(lat), \(lng), \(acc), \(spd));"
            webView.evaluateJavaScript(js) { _, _ in
                // Give the Firebase write itself a moment to actually reach the network before
                // tearing the WebView down — evaluateJavaScript's completion only means the
                // synchronous call returned, not that the async `set()` write completed.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.endBackgroundTaskIfNeeded() }
            }
            self?.pendingFix = nil
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        endBackgroundTaskIfNeeded()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        endBackgroundTaskIfNeeded()
    }

    private func endBackgroundTaskIfNeeded() {
        if bgTask != .invalid {
            UIApplication.shared.endBackgroundTask(bgTask)
            bgTask = .invalid
        }
        headlessWebView = nil
        pendingFix = nil
    }

}
