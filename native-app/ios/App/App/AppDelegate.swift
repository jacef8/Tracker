import UIKit
import Capacitor
import CoreLocation
import CoreMotion
import UserNotifications
import WebKit
import AVFoundation
import PushKit
import CallKit
import BackgroundTasks   // BGAppRefreshTask (iOS 13+, no guard needed) -- see registerBgRefresh
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
    /// Authorization as the DELEGATE last reported it. authorizationStatus is only meaningful on
    /// a manager the app keeps and whose delegate has fired; a freshly built one has not been
    /// told anything yet. settingsDict() used to construct one on the spot, so the "While Using"
    /// the Crew saw was never trustworthy evidence about the real setting.
    private var lastAuth: CLAuthorizationStatus?
    /// lastAuth lives only as long as the process, and iOS suspends or kills the app the moment
    /// the user changes its location permission in Settings. So the one case that matters most --
    /// Always being turned back to While Using from Settings, between launches -- produced a nil
    /// `prev` on the next launch's first callback and could never be counted. Persist the last
    /// status seen so the comparison survives relaunch and that downgrade is actually detected.
    private static let kLastAuthKey = "gl_last_auth_status"
    private var persistedAuth: CLAuthorizationStatus? {
        get {
            let d = UserDefaults.standard
            guard d.object(forKey: AppDelegate.kLastAuthKey) != nil else { return nil }
            return CLAuthorizationStatus(rawValue: Int32(d.integer(forKey: AppDelegate.kLastAuthKey)))
        }
        set {
            if let v = newValue { UserDefaults.standard.set(Int(v.rawValue), forKey: AppDelegate.kLastAuthKey) }
            else { UserDefaults.standard.removeObject(forKey: AppDelegate.kLastAuthKey) }
        }
    }
    /// Background-location health, so "why is this phone off the map" is a measurement rather
    /// than a guess. Counts only fixes delivered while the app was NOT in the foreground —
    /// foreground fixes prove nothing about whether background sharing works.
    private var bgFixCount: Int = 0
    private var lastBgFixAt: TimeInterval = 0
    private var fgBridgeSent: Int = 0
    /// Where this phone was when it last reported, so a write can tell whether it has moved.
    /// An anchor: advanced only when a fix is a real distance from it (see writeFixNatively).
    private var lastReportedLoc: CLLocation?
    /// What the phone's motion chip says this person is doing: still, walking, running, cycling
    /// or driving. This is the step-counter coprocessor, not GPS -- it costs almost nothing and
    /// answers a question GPS is bad at. Three miles an hour is a walk or an idling truck, and
    /// the dot moves identically either way; the chip knows which.
    private let activityManager = CMMotionActivityManager()
    private var currentActivity = ""
    private var activityStartedAt: TimeInterval = 0
    /// iOS asks, every so often, whether an app may keep using location in the background --
    /// showing a map of recent positions and offering to "Keep Only While Using". Answering that
    /// silently downgrades Always to While Using, and nothing in the app is told. From the user's
    /// side they dismissed a popup; from ours they vanish off the map for days. Count it and say
    /// so, because the setting reverting on its own is the single hardest thing to explain here.
    private var authDowngrades: Int = 0
    private var lastAuthDowngradeAt: TimeInterval = 0
    // The "you are here" region — deliberately NOT prefixed "GL-", so syncMonitoredRegions()
    // (which clears and rebuilds every GL- region from the saved-places cache) cannot delete it.
    private let hereRegionId = "GLHERE"
    private let hereRegionRadius: CLLocationDistance = 120   // tight enough that leaving is a real departure
    private var hereRegionCenter: CLLocationCoordinate2D?

    // Kept alive for the ENTIRE process lifetime, not recreated per fix (see reportFixInBackground
    // for why this changed 2026-07-22).
    private var headlessWebView: WKWebView?
    private var headlessPageReady = false
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private var pendingFix: CLLocation?
    private var lastReportedAt: Date?
    // When this process started receiving locations. CoreLocation keeps `location` from before a
    // relaunch — possibly hours old and somewhere else entirely. Once updates are running, a
    // cached fix newer than this is trustworthy even if old (no update = hasn't moved 50 m);
    // one older than this is a leftover and must not be reported as current.
    private let sessionStart = Date()
    private func isLeftover(_ loc: CLLocation) -> Bool { return loc.timestamp < sessionStart }
    private var staleFixTimer: Timer?

    // ── Wake path (2026-10-17) ─────────────────────────────────────────────────────────
    // Measured on the family's phones: a drive produces fixes, then the parked phone goes dark
    // for hours, and every iPhone is dark 9-13 h overnight. Once iOS suspends or ends the process
    // nothing above runs, so the row simply stops -- indistinguishable from the app being dead.
    // Every way back into this process (location relaunch, region crossing, visit, push, system
    // refresh, timer) now funnels through wakeHeartbeat(), which writes an HONEST row (fresh ts,
    // the ORIGINAL fixTs), retries a fix that never landed, and records what woke us so the
    // result can be read off the phones instead of guessed.
    private static let kWakesKey   = "gl_wakes"
    private static let kLastFixKey = "gl_last_fix"
    private static let bgRefreshId = "com.groundlink.ios.refresh"   // must match Info.plist
    private var lastWakeReason = ""
    private var lastWakeAt: TimeInterval = 0
    /// "ui" | "location" | "push" | "bg" -- how THIS process was started (oss.launch).
    private var launchKind = "ui"
    private let procStartMs = Int(Date().timeIntervalSince1970 * 1000)
    private var slcCounted = false
    /// Native writes currently in flight; the shared background task ends when this hits 0.
    private var inflightWrites = 0
    /// Foreground fixes arrive several times a second; the persisted record needs one now and then.
    private var lastFgSaveAt: Date = .distantPast

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
        // How this process was started, decided first so every `oss` written during this launch
        // (the authorization callback's status write included) names it. launchOptions[.location]
        // means iOS relaunched us purely for a location event: no UI will ever be shown for this
        // launch and the Capacitor bridge/live web app won't load. Acted on at the bottom.
        if launchOptions?[.location] != nil { launchKind = "location" }
        else if launchOptions?[.remoteNotification] != nil { launchKind = "push" }
        else if UIApplication.shared.applicationState == .background { launchKind = "bg" }
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
        mgr.activityType = .other
        // From 1.0.6 this manager is the ONLY background location session. The plugin's
        // navigation-grade watcher, which ran alongside it around the clock, is no longer started
        // by the web app on this shell — so the permission prompts it used to trigger are asked
        // for here: When In Use first (iOS insists), then the Always upgrade.
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) { status = mgr.authorizationStatus } else { status = CLLocationManager.authorizationStatus() }
        if status == .notDetermined { mgr.requestWhenInUseAuthorization() }
        else if status == .authorizedWhenInUse { mgr.requestAlwaysAuthorization() }
        mgr.startUpdatingLocation()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            mgr.startMonitoringSignificantLocationChanges()
        }
        // Visits: iOS's own arrive/depart detector. It fires minutes after the phone settles
        // somewhere and again when it leaves, relaunches a terminated app, and costs nothing --
        // exactly the two moments a parked phone has been silent at. Needs Always; with While
        // Using it simply delivers nothing. Handled in locationManager(_:didVisit:).
        mgr.startMonitoringVisits()
        bgLocationManager = mgr
        startActivityUpdates()
        syncMonitoredRegions()   // from the UserDefaults cache — works on UI-less relaunches too
        restoreHereRegion()      // and the anchor on the last known position, before any fix lands
        setupVoip()              // PushKit VoIP registration + CallKit provider (locked-phone PTT)
        setupPushToTalk()        // iOS 16+ Push to Talk framework (ringless walkie-talkie)
        registerBgRefresh()      // BGTaskScheduler.register MUST happen before this method returns
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
            // A heartbeat, not a re-report: fresh ts/hbTs, ORIGINAL fixTs, nothing cleared. It
            // works from the persisted last fix, so a relaunched process is no longer mute until
            // CoreLocation happens to hand over a new position. This timer only lives while the
            // process does -- the wake path (launch/visit/region/push/bgr) carries the real load.
            let last = max(self.lastNativeReportAt, self.lastHeartbeatAt)
            if Date().timeIntervalSince(last) > 170 { self.wakeHeartbeat(reason: "timer") }
        }
        // A UI-less relaunch (launchKind decided at the top) has NOTHING else that will touch the
        // row until a new fix arrives -- which a parked phone may never produce -- so say "alive,
        // here is my last honest fix" right now, and schedule the next system refresh.
        if launchKind == "location" || launchKind == "bg" {
            wakeHeartbeat(reason: "launch")   // "push" launches are reported by didReceiveRemoteNotification
        }
        if launchKind != "ui" { scheduleBgRefresh() }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Back to the coarse, cheap setting the battery budget is built around.
        setLocationFidelity(foreground: false)
        // Ask iOS for a background refresh later on; it decides when (see scheduleBgRefresh).
        scheduleBgRefresh()
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
    // AND from system termination, though never from a user force-quit. (That is true of this
    // path and of Background App Refresh; the LOCATION paths -- significant change, regions,
    // visits -- are documented to relaunch even a force-quit app, which is why they carry the
    // load.) The server's /bump endpoint sends one when someone taps Refresh on a stale member
    // or a phone has gone quiet; this handler reports through the wake path, which is exactly
    // the Life360 "member refreshes right when you look at them" behaviour.
    // The remote-notification background mode is already declared in Info.plist.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        var finished = false
        let finish: (UIBackgroundFetchResult) -> Void = { r in if !finished { finished = true; completionHandler(r) } }
        if let loc = bgLocationManager?.location, !isLeftover(loc) {
            // Alive with a position from this process: a real report, settings riding along.
            wakeHeartbeat(reason: "push", fix: loc) { ok in finish(ok ? .newData : .noData) }
        } else {
            // Relaunched by this push. requestLocation() does nothing while the continuous session
            // started in didFinishLaunching is running (Apple's documented behaviour), so it is not
            // called: that session delivers its first fix on its own and didUpdateLocations reports
            // it. Meanwhile say "alive" now with the last honest fix, so the row refreshes even if
            // no new position ever arrives on this wake.
            wakeHeartbeat(reason: "push") { ok in finish(ok ? .newData : .noData) }
        }
        // iOS allows ~30 s here; never leave the handler un-completed.
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { finish(.noData) }
    }

    // ── Native geofences (Places) ────────────────────────────────────────────────────────
    // The web layer evaluates geofences only when fixes happen to flow. CLCircularRegion
    // monitoring is OS-level: crossings wake this app (even system-terminated) at ~zero
    // battery cost. The regions act purely as WAKE triggers — the actual arrive/leave logic,
    // hysteresis and pushes stay in headless.html's checkPlaceGeofences, which runs on the fix
    // this report generates. Place list arrives via __nativeSync (see below), cached in
    // UserDefaults so region monitoring survives relaunches where the web app never loads.

    /// Keep a small monitored region anchored on the device's current position, so that LEAVING
    /// wakes the app even when it has been terminated (battery death, a reboot, an OS eviction).
    /// Regions persist across launches at the system level; re-registering is cheap insurance for
    /// the cases where they did not.
    private func updateHereRegion(_ loc: CLLocation) {
        guard let mgr = bgLocationManager,
              CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        // Still comfortably inside the current one — moving the anchor on every fix would churn
        // system state and could miss the exit we are waiting for.
        if let c = hereRegionCenter {
            let moved = CLLocation(latitude: c.latitude, longitude: c.longitude).distance(from: loc)
            if moved < hereRegionRadius * 0.6 { return }
        }
        for r in mgr.monitoredRegions where r.identifier == hereRegionId { mgr.stopMonitoring(for: r) }
        let region = CLCircularRegion(center: loc.coordinate, radius: hereRegionRadius, identifier: hereRegionId)
        region.notifyOnEntry = false     // arriving here is not news; leaving is
        region.notifyOnExit = true
        mgr.startMonitoring(for: region)
        hereRegionCenter = loc.coordinate
        UserDefaults.standard.set([loc.coordinate.latitude, loc.coordinate.longitude], forKey: "gl_here_region")
    }

    /// Re-arm the anchor from the last known position at launch, before any fix has arrived --
    /// the case that matters most, since a relaunch after a reboot may not get a fix for a while.
    private func restoreHereRegion() {
        guard let arr = UserDefaults.standard.array(forKey: "gl_here_region") as? [Double], arr.count == 2 else { return }
        updateHereRegion(CLLocation(latitude: arr[0], longitude: arr[1]))
    }

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

    /// The position a region event itself vouches for: the boundary just crossed. On a relaunch
    /// the manager's cached fix predates this process and may be miles away (isLeftover), while
    /// the region says where we are to within its radius -- carried as horizontalAccuracy.
    private func regionLocation(_ region: CLRegion, exiting: Bool) -> CLLocation? {
        guard let cr = region as? CLCircularRegion else { return nil }
        return CLLocation(coordinate: cr.center, altitude: 0,
                          horizontalAccuracy: exiting ? cr.radius * 1.5 : cr.radius, verticalAccuracy: -1,
                          course: -1, speed: -1, timestamp: Date())
    }
    /// A fix from THIS process if there is one, else whatever the event itself can vouch for.
    private func bestFix(_ manager: CLLocationManager, or fallback: CLLocation?) -> CLLocation? {
        if let cur = manager.location, !isLeftover(cur) { return cur }
        return fallback
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        wakeHeartbeat(reason: "region", fix: bestFix(manager, or: regionLocation(region, exiting: false)))
    }
    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        let fix = bestFix(manager, or: regionLocation(region, exiting: true))
        wakeHeartbeat(reason: "region", fix: fix)
        // Leaving the anchor is exactly when a new one is needed: re-anchor here so the next
        // departure wakes us too. Without this the phone gets one relaunch and no more.
        if region.identifier == hereRegionId, let f = fix { updateHereRegion(f) }
    }

    /// iOS decided this phone ARRIVED somewhere or LEFT it (startMonitoringVisits, above). Slow by
    /// design -- minutes after the fact -- but it fires for a parked phone that nothing else wakes,
    /// and it relaunches a terminated app. Pure wake trigger plus an honest position; the web
    /// layer keeps its own arrive/leave logic.
    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        // departureDate == distantFuture means "still here" (an arrival); otherwise a departure.
        let arrived = visit.departureDate == Date.distantFuture
        var when = arrived ? visit.arrivalDate : visit.departureDate
        // arrivalDate is distantPast when the visit began before we were allowed to watch.
        if when == Date.distantPast || when == Date.distantFuture { when = Date() }
        // The visit's own coordinate IS a position fix: honest timestamp = when they got there
        // (or left), honest accuracy = what iOS reports, speed 0 on arrival (they are parked).
        let vloc = CLLocation(coordinate: visit.coordinate, altitude: 0,
                              horizontalAccuracy: max(10, visit.horizontalAccuracy), verticalAccuracy: -1,
                              course: -1, speed: arrived ? 0 : -1, timestamp: when)
        var fix = vloc
        if let cur = manager.location, !isLeftover(cur), cur.timestamp > vloc.timestamp { fix = cur }
        wakeHeartbeat(reason: arrived ? "visit" : "depart", fix: fix)
        updateHereRegion(fix)
    }

    // Pull identity + places out of the LIVE web app whenever it comes to the foreground —
    // native code can't read the WebView's localStorage directly, so the web side exposes
    // __nativeSync() returning a JSON snapshot. Cached in UserDefaults for launches where the
    // UI (and thus the web app) never starts, e.g. a location-triggered background relaunch.
    func applicationDidBecomeActive(_ application: UIApplication) {
        setLocationFidelity(foreground: true)
        // Once the page exists, and again shortly after, so the map has a position in hand well
        // inside the window where it would otherwise fall back to asking the WebView itself.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.bridgeLastKnownFix() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.bridgeLastKnownFix() }
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
            // booting a WebView at all (see writeFixNatively). Never let a half-ready snapshot
            // (rooms: [] before the version is known, or no refresh token before sign-in finishes)
            // replace a working one: that disabled the native writer until the next foreground.
            // Taken now and again at +12 s, when the page has had time to finish signing in.
            let takeWriteConfig: () -> Void = { [weak self] in
                guard let self = self,
                      let bridgeVC = self.window?.rootViewController as? CAPBridgeViewController,
                      let wv = bridgeVC.webView else { return }
                wv.evaluateJavaScript("window.__nativeWriteConfig ? window.__nativeWriteConfig() : ''") { result, _ in
                    guard let json = result as? String, !json.isEmpty,
                          let d = json.data(using: .utf8),
                          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                          let rooms = o["rooms"] as? [String], !rooms.isEmpty else { return }
                    let rt = (o["rt"] as? String) ?? ""
                    if rt.isEmpty, let old = self.nativeWriteConfig(), !(((old["rt"] as? String) ?? "").isEmpty) { return }
                    UserDefaults.standard.set(json, forKey: "gl_native_write_cfg")
                }
            }
            takeWriteConfig()
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { takeWriteConfig() }
            // Push the OS settings that decide whether background location survives. These are
            // read-only — we can't change any of them — but "why does this phone keep going
            // offline" can't be answered without them: Low Power Mode, While-Using instead of
            // Always, reduced accuracy and Background App Refresh each silently stop background
            // reporting while the app looks perfectly healthy in the foreground.
            let js = "window.__nativeSettings && window.__nativeSettings(\(self.settingsJSON()))"
            wv.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// Ask the motion coprocessor what this person is doing, and keep the answer current.
    /// Low-confidence readings are ignored rather than published: a wrong label is worse than
    /// none, and the chip says "maybe walking" fairly often when someone shifts in a seat.
    private func startActivityUpdates() {
        guard CMMotionActivityManager.isActivityAvailable() else { return }
        activityManager.startActivityUpdates(to: .main) { [weak self] act in
            guard let self = self, let a = act else { return }
            if a.confidence == .low { return }
            var label = ""
            if a.stationary { label = "still" }
            if a.walking    { label = "walking" }
            if a.running    { label = "running" }
            if a.cycling    { label = "cycling" }
            if a.automotive { label = "driving" }
            if label.isEmpty || label == self.currentActivity { return }
            self.currentActivity = label
            self.activityStartedAt = Date().timeIntervalSince1970
        }
    }

    /// Read-only snapshot of the iOS settings that govern background location. Written with every
    /// background fix (and on its own when there is no fix) so the Crew can see WHY a phone has
    /// gone quiet: Low Power Mode, "While Using" instead of "Always", Precise Location off,
    /// Background App Refresh off, or Location Services off.
    private func settingsDict() -> [String: Any] {
        var d: [String: Any] = [:]
        d["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        // The RETAINED manager, never a fresh one: see lastAuth. Preference order is the value
        // the delegate handed us, then the live manager, then (only if neither exists yet) the
        // class-level call, which is the one API that is valid without an instance.
        let mgr = bgLocationManager
        let auth: CLAuthorizationStatus
        if let a = lastAuth {
            auth = a
        } else if #available(iOS 14.0, *), let m = mgr {
            auth = m.authorizationStatus
        } else {
            auth = CLLocationManager.authorizationStatus()
        }
        // "Always" is the only setting that keeps fixes coming once the app is backgrounded;
        // "While Using" looks identical in the foreground and is the usual culprit.
        d["locAlways"] = (auth == .authorizedAlways)
        d["locWhenInUse"] = (auth == .authorizedWhenInUse)
        d["locDenied"] = (auth == .denied || auth == .restricted)
        if #available(iOS 14.0, *), let m = mgr {
            // Precise Location off gives ~1-3 km fixes — the dot still moves, just uselessly.
            d["precise"] = (m.accuracyAuthorization == .fullAccuracy)
        }
        // Is the background session actually running, and has it ever produced a fix with the app
        // closed? "Always" in Settings and a working background session are different claims, and
        // only the second one puts anyone on the map.
        d["locRunning"] = (bgLocationManager != nil)
        d["authDowns"] = authDowngrades
        if lastAuthDowngradeAt > 0 { d["authDownAt"] = Int(lastAuthDowngradeAt * 1000) }
        d["bgFixes"] = bgFixCount
        d["bgMoving"] = bgMoving      // tightened fidelity while driving (see setLocationFidelity)
        if lastBgFixAt > 0 { d["bgFixAt"] = Int(lastBgFixAt * 1000) }
        d["fgBridge"] = fgBridgeSent
        if !currentActivity.isEmpty {
            d["act"] = currentActivity
            d["actAt"] = Int(activityStartedAt * 1000)
        }
        // What woke this process and how often each wake source has fired, so the family can
        // see which of iOS's doors actually open on their phones (persisted across relaunches).
        let wakeReason = lastWakeReason.isEmpty ? (UserDefaults.standard.string(forKey: "gl_wake_last") ?? "") : lastWakeReason
        if !wakeReason.isEmpty { d["wake"] = wakeReason }
        let wakeAt = lastWakeAt > 0 ? lastWakeAt : UserDefaults.standard.double(forKey: "gl_wake_at")
        if wakeAt > 0 { d["wakeAt"] = Int(wakeAt * 1000) }
        if let w = UserDefaults.standard.dictionary(forKey: AppDelegate.kWakesKey) as? [String: Int], !w.isEmpty { d["wakes"] = w }
        d["launch"] = launchKind
        d["procAt"] = procStartMs
        d["locServices"] = CLLocationManager.locationServicesEnabled()
        let refresh = UIApplication.shared.backgroundRefreshStatus
        d["bgRefresh"] = (refresh == .available)
        d["bgRefreshDenied"] = (refresh == .denied)
        let dev = UIDevice.current
        dev.isBatteryMonitoringEnabled = true
        if dev.batteryLevel >= 0 { d["batt"] = Int(dev.batteryLevel * 100) }
        d["charging"] = (dev.batteryState == .charging || dev.batteryState == .full)
        d["iosVer"] = dev.systemVersion
        d["at"] = Int(Date().timeIntervalSince1970 * 1000)
        return d
    }

    private func settingsJSON() -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: settingsDict()),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
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
        // Move the anchor with the device even while foregrounded: the point is to have a live
        // region in place BEFORE the app is terminated, and termination can happen at any time.
        updateHereRegion(loc)
        if UIApplication.shared.applicationState == .active {
            pathBuf.removeAll()
            // Hand the fix to the page instead of letting it run a SECOND location session of its
            // own. navigator.geolocation inside a WKWebView is a separate web-origin permission
            // that iOS does not remember between launches, so the page asking for it produced the
            // "allow location" prompt on every single open — and a declined prompt left the dot
            // dead even with the app in front. One session, asked for once, natively.
            // The page writes this one, but the native record must still hold the newest
            // position so a later UI-less relaunch heartbeats from it, not from hours ago.
            if Date().timeIntervalSince(lastFgSaveAt) > 15 {
                lastFgSaveAt = Date()
                saveLastFix(loc, sent: true, clearHere: false)
            }
            bridgeFixToWeb(loc)
            return
        }
        bgFixCount += 1
        lastBgFixAt = Date().timeIntervalSince1970
        updateBgMotion(loc)
        for l in locations { pathPush(l) }
        if launchKind == "location" && !slcCounted {
            // The first background fix of a process iOS relaunched for location is the event it
            // relaunched us for (significant change, or a region crossing that beat the region
            // callback). Count it and force it out; the rest of the session is ordinary tracking.
            slcCounted = true
            wakeHeartbeat(reason: "slc", fix: loc)
        } else {
            reportFixInBackground(loc)
        }
    }

    // Granted While Using → ask for Always, once, so background sharing works without a trip
    // to Settings. iOS shows this as its own prompt (or defers it to a later moment it chooses).
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard #available(iOS 14.0, *), manager === bgLocationManager else { return }
        // This callback is the ONLY place the status is authoritative. Record it here and let
        // everything else read the recording.
        // In-memory first (this launch), falling back to the stored value (previous launch).
        let prev = lastAuth ?? persistedAuth
        let now = manager.authorizationStatus
        lastAuth = now
        persistedAuth = now
        if prev == .authorizedAlways && now == .authorizedWhenInUse {
            authDowngrades += 1
            lastAuthDowngradeAt = Date().timeIntervalSince1970
            notifyBackgroundSharingStopped()
            pushSettingsNow()
        }
        if now == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
    }

    /// Push a fix into the page as window.__nativeFix({...}). Foreground only — the WebView is
    /// not reliably executing JS otherwise, which is the whole reason background fixes are
    /// written natively instead.
    private func bridgeFixToWeb(_ loc: CLLocation) {
        guard let bridgeVC = window?.rootViewController as? CAPBridgeViewController,
              let wv = bridgeVC.webView else { return }
        let c = loc.coordinate
        let acc = max(0, loc.horizontalAccuracy)
        let spd = loc.speed >= 0 ? loc.speed : -1
        let crs = loc.course >= 0 ? loc.course : -1
        let alt = loc.verticalAccuracy >= 0 ? loc.altitude : Double.nan
        let altJS = alt.isNaN ? "null" : String(alt)
        let js = "window.__nativeFix && window.__nativeFix({lat:\(c.latitude),lng:\(c.longitude),"
               + "acc:\(acc),spd:\(spd),hdg:\(crs),alt:\(altJS),ts:\(Int(loc.timestamp.timeIntervalSince1970 * 1000))})"
        fgBridgeSent += 1
        wv.evaluateJavaScript(js, completionHandler: nil)
    }

    /// One session, two jobs. In the foreground it draws someone's own dot as they walk, so it
    /// needs to be sharp; in the background it only has to notice the phone moving, and sharp
    /// costs battery around the clock. Same manager either way — a second session is what this
    /// shell exists to avoid.
    /// Backgrounded and moving: tighten up so iOS actually delivers a route.
    ///
    /// Measured on a real drive (2026-10-08): at HundredMeters/50 m, iOS handed over about three
    /// fixes per minute, roughly 500 ft apart, while the phone covered 1,556 ft in 68 s. The
    /// breadcrumb buffer shipped in 1.0.8 works, but three near-collinear points simplify to a
    /// straight line, so the map drew one -- straight across several blocks of houses. The limit
    /// was never the buffer; it was how rarely iOS delivers at that accuracy.
    ///
    /// Coarse while still is the right default and stays: a parked phone asking for ten-metre
    /// fixes is pure battery burn for no information. Only a phone that is actually moving pays
    /// the higher rate, and it drops back as soon as it stops.
    private var bgMoving = false
    private func setLocationFidelity(foreground: Bool) {
        guard let mgr = bgLocationManager else { return }
        if foreground {
            mgr.desiredAccuracy = kCLLocationAccuracyBest
            // No distance filter while the app is open. A filter only lets a fix through once the
            // phone has MOVED that far, so a phone sitting on a table delivers nothing at all --
            // which is why opening the app while standing still looked like the bridge was dead and
            // sent the page back to asking the WebView for location (the prompt on every launch).
            mgr.distanceFilter = kCLDistanceFilterNone
            return
        }
        mgr.desiredAccuracy = bgMoving ? kCLLocationAccuracyNearestTenMeters : kCLLocationAccuracyHundredMeters
        mgr.distanceFilter  = bgMoving ? 25 : 50
    }

    /// Flip the background fidelity from the phone's own speed. Hysteresis (above 8 mph to start,
    /// below 3 mph to stop) so a GPS wobble at a traffic light cannot oscillate the setting, and
    /// a negative speed -- iOS for "unknown" -- is not treated as stopped.
    private func updateBgMotion(_ loc: CLLocation) {
        let mph = loc.speed >= 0 ? loc.speed * 2.2369363 : -1
        if mph < 0 { return }
        let was = bgMoving
        if !bgMoving && mph > 8 { bgMoving = true }
        else if bgMoving && mph < 3 { bgMoving = false }
        if was != bgMoving && UIApplication.shared.applicationState != .active {
            setLocationFidelity(foreground: false)
        }
    }

    /// Hand the page the fix we already have, immediately. CoreLocation keeps the last known
    /// location on the manager, so there is no reason to make the map wait for the device to
    /// move before it can draw someone's own dot.
    private func bridgeLastKnownFix() {
        guard let loc = bgLocationManager?.location, !isLeftover(loc) else { return }
        bridgeFixToWeb(loc)
    }

    /// Tell them at the moment it happens. Waiting for someone to notice they have been missing
    /// from the map, and then to go hunting through Settings, is how this went unexplained for a
    /// fortnight.
    private func notifyBackgroundSharingStopped() {
        let c = UNMutableNotificationContent()
        c.title = "GroundLink stopped sharing in the background"
        c.body = "iPhone set your location to \"While Using\". Open GroundLink and tap the warning to put it back to Always."
        c.sound = .default
        let req = UNNotificationRequest(identifier: "gl-loc-downgrade-\(Int(Date().timeIntervalSince1970))",
                                        content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    /// Write the settings snapshot straight away rather than waiting for the next fix -- a phone
    /// that has just lost background permission may not produce another one for a long time.
    private func pushSettingsNow() {
        // Past the five-minute throttle on purpose: losing background permission is exactly the
        // moment the Crew needs to know, and this phone may not produce another fix for hours.
        lastStatusAt = .distantPast
        writeStatusNatively()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Best-effort feature — a failed fix here should never crash or otherwise affect the app.
        // But it is exactly the moment to tell the Crew why there is no position (denied,
        // services off). Throttled inside.
        writeStatusNatively()
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
    // Sign in as the SAME person the web app is signed in as, using that session's refresh token
    // (handed over in the write config). This used to call accounts:signUp — a brand-new anonymous
    // account every time — and the database rules only let a device, or its owner's account, write
    // that device's row. Every background write came back 401 Permission denied, and nothing
    // checked, so no iPhone recorded a position with the app closed. With no refresh token we
    // return nil, which sends the fix through the hidden WebView — signed in properly — instead.
    private func withAuthToken(apiKey: String, rt: String, _ done: @escaping (String?) -> Void) {
        if let t = cachedAuthToken, cachedAuthExpiry > Date().addingTimeInterval(300) { done(t); return }
        guard !rt.isEmpty,
              let url = URL(string: "https://securetoken.googleapis.com/v1/token?key=\(apiKey)") else { done(nil); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let enc = rt.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? rt
        req.httpBody = "grant_type=refresh_token&refresh_token=\(enc)".data(using: .utf8)
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let data = data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tok = o["id_token"] as? String else { done(nil); return }
            let life = Double((o["expires_in"] as? String) ?? "") ?? 3600
            self?.cachedAuthToken = tok
            self?.cachedAuthExpiry = Date().addingTimeInterval(life)
            done(tok)
        }.resume()
    }

    // Why this phone has no position, written on its own when it wakes without a usable fix.
    // Only the `oss` field, merged (PATCH) — it never claims a position or a fresh timestamp.
    private var lastStatusAt: Date = .distantPast
    private func writeStatusNatively() {
        if Date().timeIntervalSince(lastStatusAt) < 300 { return }
        guard let cfg = nativeWriteConfig(),
              let dbUrl = cfg["dbUrl"] as? String,
              let apiKey = cfg["apiKey"] as? String,
              let uid = cfg["uid"] as? String,
              let rooms = cfg["rooms"] as? [String] else { return }
        lastStatusAt = Date()
        guard let payload = try? JSONSerialization.data(withJSONObject: ["oss": settingsDict()]) else { return }
        withAuthToken(apiKey: apiKey, rt: (cfg["rt"] as? String) ?? "") { token in
            guard let token = token else { return }
            for room in rooms {
                guard let u = URL(string: "\(dbUrl)/gl/\(room)/users/\(uid).json?auth=\(token)") else { continue }
                var r = URLRequest(url: u)
                r.httpMethod = "PATCH"
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = payload
                r.timeoutInterval = 20
                URLSession.shared.dataTask(with: r).resume()
            }
        }
    }

    // MARK: - Wake heartbeat (the ONE path every background entry goes through)

    /// Record what woke us. Persisted, because every relaunch is a fresh process and an
    /// in-memory counter would read 1 forever.
    private func noteWake(_ reason: String) {
        lastWakeReason = reason
        lastWakeAt = Date().timeIntervalSince1970
        let d = UserDefaults.standard
        var w = (d.dictionary(forKey: AppDelegate.kWakesKey) as? [String: Int]) ?? [:]
        w[reason] = (w[reason] ?? 0) + 1
        d.set(w, forKey: AppDelegate.kWakesKey)
        d.set(reason, forKey: "gl_wake_last")
        d.set(lastWakeAt, forKey: "gl_wake_at")
    }

    /// The newest position this phone has produced, kept across relaunches. `sent` stays false
    /// until a native write of it got HTTP 2xx, so the next wake can re-send a fix that never
    /// landed. `fixTs` lets writeFixNatively store the exact value it put on the row.
    private func saveLastFix(_ loc: CLLocation, sent: Bool, clearHere: Bool, fixTs: Int? = nil) {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        var r: [String: Any] = [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "acc": Int((max(0, loc.horizontalAccuracy) * 3.28084).rounded()),   // feet, like the row
            "fixTs": fixTs ?? min(Int(loc.timestamp.timeIntervalSince1970 * 1000), nowMs),
            "sent": sent,
            "clearHere": clearHere,
            "savedAt": nowMs
        ]
        if loc.speed >= 0 { r["spd"] = Int((loc.speed * 2.23694).rounded()) }
        UserDefaults.standard.set(r, forKey: AppDelegate.kLastFixKey)
    }

    private func markLastFixSent(fixTs: Int) {
        let d = UserDefaults.standard
        guard var r = d.dictionary(forKey: AppDelegate.kLastFixKey),
              (r["fixTs"] as? NSNumber)?.intValue == fixTs else { return }   // a newer fix replaced it
        r["sent"] = true
        d.set(r, forKey: AppDelegate.kLastFixKey)
    }

    /// The persisted last fix as a position, so a relaunched process knows where it last reported
    /// from (lastReportedLoc is empty in a fresh process).
    private func persistedLastFixLocation() -> CLLocation? {
        guard let r = UserDefaults.standard.dictionary(forKey: AppDelegate.kLastFixKey),
              let lat = (r["lat"] as? NSNumber)?.doubleValue,
              let lng = (r["lng"] as? NSNumber)?.doubleValue else { return nil }
        return CLLocation(latitude: lat, longitude: lng)
    }

    /// Called from EVERY background entry point. With `fix` (a genuinely new position) it goes
    /// out as a full report. Without one it re-writes the last known fix with a fresh `ts`/`hbTs`
    /// and the ORIGINAL `fixTs`, so viewers can tell "parked and alive" from "dead" without ever
    /// being told the position is newer than it is. `oss` rides along naming the wake reason.
    /// Nothing the web layer claims (rest, path, hereSince) is touched by a heartbeat.
    /// `done` fires once, on the main queue. Main queue only.
    private func wakeHeartbeat(reason: String, fix: CLLocation? = nil, done: ((Bool) -> Void)? = nil) {
        // The timer is the one caller that is NOT a wake -- it only runs while the process is
        // already alive -- so it stays out of the tally that exists to measure real wakes.
        if reason != "timer" { noteWake(reason) }
        if let f = fix { reportFixInBackground(f, force: true, done: done); return }
        guard let cfg = nativeWriteConfig(),
              let dbUrl = cfg["dbUrl"] as? String,
              let apiKey = cfg["apiKey"] as? String,
              let uid = cfg["uid"] as? String,
              let rooms = cfg["rooms"] as? [String]
        else { done?(false); return }
        // NOT lastNativeReportAt. That is the 10-second report throttle, and a heartbeat is not a
        // report: stamping it here meant the real fix CoreLocation delivers a second or two after
        // a relaunch was thrown away as "too soon", and a parked phone never gets another. The
        // timer below keys off this instead.
        lastHeartbeatAt = Date()

        let now = Int(Date().timeIntervalSince1970 * 1000)
        // `ts` is only refreshed when an honest `fixTs` goes with it (the web reads fixTs || ts).
        var body: [String: Any] = ["hbTs": now, "oss": settingsDict()]
        var rec = UserDefaults.standard.dictionary(forKey: AppDelegate.kLastFixKey)
        if let cur = bgLocationManager?.location, !isLeftover(cur) {
            // A fix this process produced but never wrote (throttled, or its write failed) is
            // newer than the record: adopt it, unsent, so this heartbeat becomes its retry.
            let curTs = min(Int(cur.timestamp.timeIntervalSince1970 * 1000), now)
            if ((rec?["fixTs"] as? NSNumber)?.intValue ?? 0) < curTs {
                saveLastFix(cur, sent: false, clearHere: false, fixTs: curTs)
                rec = UserDefaults.standard.dictionary(forKey: AppDelegate.kLastFixKey)
            }
        }
        let recFixTs = (rec?["fixTs"] as? NSNumber)?.intValue ?? 0
        if let saved = rec, recFixTs > 0,
           let lat = (saved["lat"] as? NSNumber)?.doubleValue,
           let lng = (saved["lng"] as? NSNumber)?.doubleValue {
            body["ts"] = now
            body["lat"] = lat
            body["lng"] = lng
            body["fixTs"] = min(recFixTs, now)
            if let acc = (saved["acc"] as? NSNumber)?.intValue { body["accuracy"] = acc }
            if (saved["sent"] as? Bool) != true {
                // This fix never landed: the heartbeat is its retry, so carry the claims it owned.
                if let spd = (saved["spd"] as? NSNumber)?.intValue { body["spd"] = spd }
                if (saved["clearHere"] as? Bool) == true { body["hereSince"] = NSNull() }
                body["noGps"] = NSNull()
            }
        }
        let lvl = UIDevice.current.batteryLevel
        if lvl >= 0 {
            body["batt"] = Int((lvl * 100).rounded())
            let st = UIDevice.current.batteryState
            body["chg"] = (st == .charging || st == .full) ? 1 : 0
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else { done?(false); return }

        beginWriteTask()
        withAuthToken(apiKey: apiKey, rt: (cfg["rt"] as? String) ?? "") { [weak self] token in
            guard let token = token else {
                // No sign-in to write with. The heartbeat has no WebView fallback (a page load is
                // too much for a ~10-second wake); the next wake simply tries again.
                DispatchQueue.main.async { self?.writeDone(); self?.endBackgroundTaskIfNeeded(); done?(false) }
                return
            }
            let group = DispatchGroup()
            var failed = false
            let lock = NSLock()
            for room in rooms {
                guard let u = URL(string: "\(dbUrl)/gl/\(room)/users/\(uid).json?auth=\(token)") else { continue }
                var r = URLRequest(url: u)
                r.httpMethod = "PATCH"
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = payload
                r.timeoutInterval = 20
                group.enter()
                URLSession.shared.dataTask(with: r) { _, resp, _ in
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    if code < 200 || code >= 300 { lock.lock(); failed = true; lock.unlock() }
                    if code == 401 || code == 403 { self?.cachedAuthToken = nil }   // re-mint next time
                    group.leave()
                }.resume()
            }
            group.notify(queue: .main) {
                if !failed {
                    self?.lastReportedAt = Date()
                    if recFixTs > 0 { self?.markLastFixSent(fixTs: recFixTs) }
                }
                self?.writeDone()
                self?.endBackgroundTaskIfNeeded()
                done?(!failed)
            }
        }
    }

    // Returns true if it handled the write, false to fall through to the WebView path. `done`
    // fires once, on the main queue, with whether every room took the PATCH.
    private func writeFixNatively(_ loc: CLLocation, done: ((Bool) -> Void)? = nil) -> Bool {
        guard let cfg = nativeWriteConfig(),
              let dbUrl = cfg["dbUrl"] as? String,
              let apiKey = cfg["apiKey"] as? String,
              let uid = cfg["uid"] as? String,
              let name = cfg["name"] as? String,
              let rooms = cfg["rooms"] as? [String]
        else { return false }

        let ts = Int(Date().timeIntervalSince1970 * 1000)
        // The moment CoreLocation took THIS position -- never now. Clamped for clock skew.
        let fixTs = min(Int(loc.timestamp.timeIntervalSince1970 * 1000), ts)
        var body: [String: Any] = [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracy": Int((loc.horizontalAccuracy * 3.28084).rounded()),
            "name": name,
            "dev": (cfg["dev"] as? String) ?? "phone",
            "ts": ts,
            "hbTs": ts,   // "the app said something at" -- every native write is also a heartbeat
            // fixTs is WHEN CoreLocation took this position -- the web layer uses it to tell
            // "app alive" (ts) from "position current" (fixTs). Never stamped with now: the old
            // heartbeat re-sent an hours-old fix as fixTs = now, so a parked phone read LIVE
            // until the process died and then dropped straight to stale.
            "fixTs": fixTs,
            "trail": true,
            "priv": (cfg["priv"] as? Int) ?? 0,
            "spdH": (cfg["spdH"] as? Int) ?? 0
        ]
        // This is a PATCH: an unknown speed must CLEAR the field, or the last moving speed outlives
        // the car stopping and a quiet row reads "signal lost while moving" for a parked phone.
        if loc.speed >= 0 { body["spd"] = Int((loc.speed * 2.23694).rounded()) } else { body["spd"] = NSNull() }
        // The settings ride along, so a viewer can tell "fine" from "about to go quiet".
        body["oss"] = settingsDict()
        // The route since the last report, so viewers animate the corners instead of cutting them.
        // Always write the key. This is a PATCH, so omitting it leaves the LAST route in the
        // row, and the map replays that stale route against every later position -- the dot
        // flies out to where you were an hour ago and back on every fix. null clears it.
        if let route = pathTake() { body["path"] = route } else { body["path"] = NSNull() }
        // Same reason as path: this is a PATCH. A noGps set during a launch where the web layer
        // could not get a fix stays on the row forever otherwise, and the map hides anyone
        // carrying it -- while this very write is proof the phone knows where it is.
        body["noGps"] = NSNull()
        // hereSince is the web layer's "sitting at this spot since" anchor. This PATCH was
        // written to preserve fields it does not manage, which is right for a colour and wrong
        // for a claim about the present: the anchor survived while the phone drove six miles and
        // the card read "Here 2h 40m". If this fix is a real distance from the last one we
        // reported, that claim is false, so clear it and let the web layer set it again.
        // "Where we last reported from" is an ANCHOR: it only advances once the phone has really
        // moved, so a slow walk of 50-metre fixes still counts as leaving instead of every fix
        // being "only 50 m from the last one" forever. A fresh process starts from the persisted
        // record rather than from an empty memory.
        if lastReportedLoc == nil { lastReportedLoc = persistedLastFixLocation() }
        let moved = lastReportedLoc.map { $0.distance(from: loc) > 60 } ?? false
        if moved { body["hereSince"] = NSNull() }
        if moved || lastReportedLoc == nil { lastReportedLoc = loc }
        // Everything else the web layer writes that is a CLAIM ABOUT THE PRESENT rather than a
        // setting. This is a PATCH, so anything not named here survives untouched -- which is
        // right for a chosen colour or a privacy flag, and wrong for an assertion that this
        // phone is parked, still starting up, or failing to get background fixes. The web layer
        // cannot correct them while it is not running, and this write is proof they are out of
        // date, so they go. It sets them again the moment it has something true to say.
        //
        // Audited 2026-10-05 after three separate bugs of exactly this shape: a route two miles
        // from the position carrying it, a noGps flag hiding a phone that was reporting, and a
        // "Here 2h 40m" that outlived a six mile drive.
        if moved { body["rest"] = NSNull() }   // parked flag: only false once we have actually moved
        body["claiming"] = NSNull()      // startup placeholder
        body["bgf"] = NSNull()           // background-failure tally
        // Deliberately NOT cleared, because they are settings and not claims:
        //   color, priv, hidden, spdH  -- chosen by the user, must outlive any single report
        //   hunt                       -- a future expiry, which times out on its own
        //   fgTs                       -- a timestamp that can only age, never read too fresh
        let lvl = UIDevice.current.batteryLevel
        if lvl >= 0 {
            body["batt"] = Int((lvl * 100).rounded())
            let st = UIDevice.current.batteryState
            body["chg"] = (st == .charging || st == .full) ? 1 : 0
        }
        // Remember this fix as unsent; the next wake re-sends it if nothing below gets a 2xx.
        saveLastFix(loc, sent: false, clearHere: body["hereSince"] != nil, fixTs: fixTs)
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

        withAuthToken(apiKey: apiKey, rt: (cfg["rt"] as? String) ?? "") { [weak self] token in
            guard let token = token else {
                // Couldn't authenticate — hand the fix to the WebView path instead of dropping it.
                DispatchQueue.main.async { self?.writeDone(); self?.reportFixViaWebView(loc); done?(false) }
                return
            }
            let group = DispatchGroup()
            // Checked this time. A refused write used to vanish without a trace -- and so did a
            // timeout or a 5xx, while the fix had already been counted as reported.
            var denied = false
            var failed = false
            let deniedLock = NSLock()
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
                URLSession.shared.dataTask(with: r) { _, resp, _ in
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    deniedLock.lock()
                    if code == 401 || code == 403 { denied = true }
                    if code < 200 || code >= 300 { failed = true }   // transport error => code 0 => failed
                    deniedLock.unlock()
                    group.leave()
                }.resume()
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
            group.notify(queue: .main) {
                if denied {
                    // The database refused this sign-in. Drop it and let the WebView path, which
                    // is signed in as the app itself, deliver the fix rather than losing it.
                    self?.cachedAuthToken = nil
                    self?.writeDone()
                    self?.reportFixViaWebView(loc)
                    done?(false)
                    return
                }
                if !failed {
                    // Only now is this fix "reported": every room took it. A failed one stays in
                    // the persisted record as unsent and the next wakeHeartbeat re-sends it.
                    self?.lastReportedAt = Date()
                    self?.markLastFixSent(fixTs: fixTs)
                }
                self?.writeDone()
                self?.endBackgroundTaskIfNeeded()
                done?(!failed)
            }
        }
        return true
    }

    /// Report rate. CoreLocation delivers a fix every 50 m, which at driving speed is one every
    /// ~2 seconds — and this native path writes the live row AND a history point each time,
    /// bypassing the web layer's own 10-second throttle (build 796). Measured on 2026-09-25: an
    /// iPhone on 1.0.4 wrote 2,308 history points in a day while an Android phone on the throttled
    /// path wrote 416. One write per 10 seconds while moving; `force` is for the wake push and the
    /// stationary heartbeat, which are already rate-limited by their own timers.
    // ── The route between reports ────────────────────────────────────────────────────────
    // CoreLocation keeps delivering while the report rate above holds writes back, so a report
    // carries the shape of the ground covered since the last one rather than just its endpoint.
    // Without it a 10-second gap draws as a straight line and a turn taken in between shows the
    // dot cutting the corner. Mirrors _pathPush/_pathTake in index.html: same simplification,
    // same tolerance, same 14-point ceiling, same [lat, lng, ts] triples.
    private var pathBuf: [CLLocation] = []
    private func pathPush(_ loc: CLLocation) {
        if let last = pathBuf.last, last.distance(from: loc) < 2 { return }
        pathBuf.append(loc)
        if pathBuf.count > 400 { pathBuf.removeFirst(pathBuf.count - 400) }
    }
    /// Perpendicular distance in metres, flat-earth over the tens of metres this spans.
    private func pathPerpM(_ p: CLLocation, _ a: CLLocation, _ b: CLLocation) -> Double {
        let mx = 111320.0 * cos(a.coordinate.latitude * .pi / 180), my = 110540.0
        let px = (p.coordinate.longitude - a.coordinate.longitude) * mx
        let py = (p.coordinate.latitude - a.coordinate.latitude) * my
        let bx = (b.coordinate.longitude - a.coordinate.longitude) * mx
        let by = (b.coordinate.latitude - a.coordinate.latitude) * my
        let len2 = bx * bx + by * by
        if len2 == 0 { return (px * px + py * py).squareRoot() }
        var t = (px * bx + py * by) / len2
        t = Swift.max(0, Swift.min(1, t))
        let dx = px - bx * t, dy = py - by * t
        return (dx * dx + dy * dy).squareRoot()
    }
    /// Ramer-Douglas-Peucker: keep the points that give the line its shape.
    private func pathSimplify(_ pts: [CLLocation], _ tolM: Double) -> [CLLocation] {
        if pts.count < 3 { return pts }
        var keep = [Bool](repeating: false, count: pts.count)
        keep[0] = true; keep[pts.count - 1] = true
        var stack: [(Int, Int)] = [(0, pts.count - 1)]
        while let seg = stack.popLast() {
            let (i, j) = seg
            if j <= i + 1 { continue }
            var maxD = -1.0, idx = -1
            for k in (i + 1)..<j {
                let d = pathPerpM(pts[k], pts[i], pts[j])
                if d > maxD { maxD = d; idx = k }
            }
            if maxD > tolM && idx > 0 { keep[idx] = true; stack.append((i, idx)); stack.append((idx, j)) }
        }
        var out: [CLLocation] = []
        for n in 0..<pts.count where keep[n] { out.append(pts[n]) }
        return out
    }
    private func pathTake() -> [[Any]]? {
        let raw = pathBuf
        pathBuf = []
        if raw.count < 3 { return nil }                       // two points IS a straight line
        var sp = pathSimplify(raw, 6)
        if sp.count < 3 { return nil }
        if sp.count > 14 {                                    // thin the middle, always keep both ends
            var out = [sp[0]]
            let step = Double(sp.count - 2) / 12.0
            for i in 1...12 {
                let idx = Swift.min(sp.count - 2, Swift.max(1, Int((Double(i) * step).rounded())))
                out.append(sp[idx])
            }
            out.append(sp[sp.count - 1])
            sp = out
        }
        return sp.map { l in
            [(l.coordinate.latitude * 1e6).rounded() / 1e6,
             (l.coordinate.longitude * 1e6).rounded() / 1e6,
             Int(l.timestamp.timeIntervalSince1970 * 1000)]
        }
    }

    private var lastNativeReportAt: Date = .distantPast
    /// When the last no-fix heartbeat went out. Kept apart from lastNativeReportAt on purpose:
    /// a heartbeat must never make a real fix look "too soon" to report.
    private var lastHeartbeatAt: Date = .distantPast
    private static let nativeReportMinInterval: TimeInterval = 10
    private func reportFixInBackground(_ loc: CLLocation, force: Bool = false, done: ((Bool) -> Void)? = nil) {
        if !force && Date().timeIntervalSince(lastNativeReportAt) < Self.nativeReportMinInterval { done?(false); return }
        lastNativeReportAt = Date()
        // lastReportedAt is NOT stamped here any more: it now means "a write was confirmed" and
        // is set on HTTP success in writeFixNatively / wakeHeartbeat. Stamping it before a byte
        // went out is how a lost fix passed for a delivered one.
        beginWriteTask()
        // Native REST first — no page load, no SDK, nothing to time out.
        if writeFixNatively(loc, done: done) { return }
        writeDone()
        reportFixViaWebView(loc)
        done?(false)
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

    /// One background-task assertion shared by every write in flight. The old code began a NEW
    /// task on every report and overwrote the identifier, so an overlapping report (a region exit
    /// landing while a PATCH was still out) leaked the earlier task unended -- the kind of
    /// assertion iOS kills an app for. Balanced: every beginWriteTask() has exactly one writeDone().
    /// Main queue only.
    private func beginWriteTask() {
        inflightWrites += 1
        guard bgTask == .invalid else { return }
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "GLLocationFix") { [weak self] in
            // iOS is about to end it for us: end it cleanly now. Writes still in flight finish or
            // time out on their own and drain the counter; the next one begins a fresh task.
            self?.endWriteTaskNow()
        }
        let id = bgTask
        // Hard ceiling inside the ~30 s iOS grants: never hold the assertion on a hung request.
        DispatchQueue.main.asyncAfter(deadline: .now() + 28) { [weak self] in
            guard let self = self, self.bgTask == id else { return }
            self.endWriteTaskNow()
        }
    }

    /// One write finished (success or failure). Main queue only.
    private func writeDone() { inflightWrites = max(0, inflightWrites - 1) }

    /// End the shared assertion once nothing is in flight. The WebView fallback path calls this
    /// from its own timers; while a native write is still out it is a no-op and the native
    /// completion ends the task instead.
    private func endBackgroundTaskIfNeeded() {
        guard inflightWrites == 0 else { return }
        endWriteTaskNow()
    }

    /// End the assertion regardless of the counter: iOS is expiring it, or the ceiling was hit.
    private func endWriteTaskNow() {
        guard bgTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bgTask)
        bgTask = .invalid
    }

    // MARK: - Background App Refresh (BGTaskScheduler)
    // Info.plist has declared the `fetch` background mode for years with nothing behind it: no
    // register, no request, no permitted identifier. This is what the mode is for. The identifier
    // must be listed under BGTaskSchedulerPermittedIdentifiers or submit() throws .notPermitted.
    // `processing` is only for BGProcessingTask and is NOT required.
    private func registerBgRefresh() {
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: AppDelegate.bgRefreshId, using: DispatchQueue.main) { [weak self] task in
            guard let self = self, let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            self.handleBgRefresh(refresh)
        }
    }

    /// One-shot by design: re-armed on every background entry and inside the handler itself.
    /// iOS decides the real cadence (Background App Refresh on, not Low Power Mode, app usage) --
    /// expect a few runs a day at best, clustered before the phone's usual pickup time, none
    /// after a force-quit. Cheap insurance, never a schedule.
    private func scheduleBgRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: AppDelegate.bgRefreshId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(req) } catch { /* not permitted / refresh off: nothing to do */ }
    }

    private func handleBgRefresh(_ task: BGAppRefreshTask) {
        scheduleBgRefresh()
        var finished = false
        let complete: (Bool) -> Void = { ok in if !finished { finished = true; task.setTaskCompleted(success: ok) } }
        task.expirationHandler = { complete(false) }
        // A position from THIS process is a real fix; otherwise a heartbeat from the persisted one.
        if let loc = bgLocationManager?.location, !isLeftover(loc) {
            wakeHeartbeat(reason: "bgr", fix: loc, done: complete)
        } else {
            wakeHeartbeat(reason: "bgr", done: complete)
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
            // Opening iOS Settings needs native code. Without it the app can only print a path
            // and hope; Android has had a button for this all along.
            ucc.add(self, name: "glOpenSettings")
            ucc.addUserScript(WKUserScript(source: AppDelegate.glSettingsShim,
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
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

    static let glSettingsShim = """
    window.GLOpenSettings = function () {
      try { window.webkit.messageHandlers.glOpenSettings.postMessage(''); return true; } catch (e) { return false; }
    };
    """

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == "glOpenSettings" {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            return
        }
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
