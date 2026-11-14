import CoreLocation
import UIKit

/// Answers a location push (iOS 15+, Location Push Service Extension, iOS app 1.0.17).
///
/// The server's quiet-phone sweep sends a push of type `location` to an iPhone that has not
/// reported for 15 minutes. iOS runs THIS extension for it -- even when the GroundLink app has
/// been closed or killed in the background, which is exactly when the ordinary silent push
/// cannot reach it (Jax, Lexi and Vanesa sat dark for hours on 2026-11-13). It takes one fix,
/// writes it to every crew row the app writes to, and exits. Nothing is shown on the phone.
///
/// The write mirrors AppDelegate.writeFixNatively: same fields, same PATCH, same rules about
/// clearing claims about the present (path, noGps, claiming, bgf; hereSince and rest only when
/// the phone has really moved). It authenticates as the person signed in to the app, from the
/// config the app mirrors into the shared keychain (GLShared).
final class LocationPushService: NSObject, CLLocationPushServiceExtension, CLLocationManagerDelegate {
    private var completion: (() -> Void)?
    private var manager: CLLocationManager?
    private var done = false

    func didReceiveLocationPushPayload(_ payload: [String: Any], completion: @escaping () -> Void) {
        self.completion = completion
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager = m
        m.requestLocation()
    }

    func serviceExtensionWillTerminate() { finish() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { finish(); return }
        report(loc)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish() }

    private func finish() {
        DispatchQueue.main.async {
            if self.done { return }
            self.done = true
            self.manager?.stopUpdatingLocation()
            self.completion?()
        }
    }

    private func report(_ loc: CLLocation) {
        guard let cfg = GLShared.loadConfig(),
              let dbUrl = cfg["dbUrl"] as? String,
              let apiKey = cfg["apiKey"] as? String,
              let uid = cfg["uid"] as? String,
              let name = cfg["name"] as? String,
              let rooms = cfg["rooms"] as? [String],
              let rt = cfg["rt"] as? String, !rt.isEmpty
        else { finish(); return }
        // Sharing paused in the app: say nothing.
        if ((cfg["off"] as? NSNumber)?.intValue ?? 0) == 1 { finish(); return }

        token(apiKey: apiKey, rt: rt) { [weak self] tok in
            guard let self = self, let tok = tok else { self?.finish(); return }
            // Has the phone really moved since the row's last position? Read from the first room
            // the phone writes to; every room carries the same position.
            self.lastRowPosition(dbUrl: dbUrl, room: rooms[0], uid: uid, tok: tok) { prev in
                let moved = prev.map { $0.distance(from: loc) > 60 } ?? false
                let ts = Int(Date().timeIntervalSince1970 * 1000)
                let fixTs = min(Int(loc.timestamp.timeIntervalSince1970 * 1000), ts)
                var body: [String: Any] = [
                    "lat": loc.coordinate.latitude,
                    "lng": loc.coordinate.longitude,
                    "accuracy": Int((loc.horizontalAccuracy * 3.28084).rounded()),
                    "name": name,
                    "dev": (cfg["dev"] as? String) ?? "phone",
                    "ts": ts,
                    "hbTs": ts,
                    "fixTs": fixTs,
                    "lpTs": ts,            // this write answered a location push
                    "trail": true,
                    "priv": (cfg["priv"] as? Int) ?? 0,
                    "spdH": (cfg["spdH"] as? Int) ?? 0,
                    "path": NSNull(),
                    "noGps": NSNull(),
                    "claiming": NSNull(),
                    "bgf": NSNull()
                ]
                if loc.speed >= 0 { body["spd"] = Int((loc.speed * 2.23694).rounded()) } else { body["spd"] = NSNull() }
                if moved { body["hereSince"] = NSNull(); body["rest"] = NSNull() }
                UIDevice.current.isBatteryMonitoringEnabled = true
                let lvl = UIDevice.current.batteryLevel
                if lvl >= 0 {
                    body["batt"] = Int((lvl * 100).rounded())
                    let st = UIDevice.current.batteryState
                    body["chg"] = (st == .charging || st == .full) ? 1 : 0
                }
                guard let payload = try? JSONSerialization.data(withJSONObject: body) else { self.finish(); return }
                let group = DispatchGroup()
                for room in rooms {
                    guard let u = URL(string: "\(dbUrl)/gl/\(room)/users/\(uid).json?auth=\(tok)") else { continue }
                    var r = URLRequest(url: u)
                    r.httpMethod = "PATCH"
                    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    r.httpBody = payload
                    r.timeoutInterval = 15
                    group.enter()
                    URLSession.shared.dataTask(with: r) { _, _, _ in group.leave() }.resume()
                }
                group.notify(queue: .main) { self.finish() }
            }
        }
    }

    /// Exchange the app's refresh token for an ID token, as AppDelegate.withAuthToken does.
    private func token(apiKey: String, rt: String, _ done: @escaping (String?) -> Void) {
        guard let url = URL(string: "https://securetoken.googleapis.com/v1/token?key=\(apiKey)") else { done(nil); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let enc = rt.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? rt
        req.httpBody = "grant_type=refresh_token&refresh_token=\(enc)".data(using: .utf8)
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tok = o["id_token"] as? String else { done(nil); return }
            done(tok)
        }.resume()
    }

    private func lastRowPosition(dbUrl: String, room: String, uid: String, tok: String,
                                 _ done: @escaping (CLLocation?) -> Void) {
        guard let u = URL(string: "\(dbUrl)/gl/\(room)/users/\(uid).json?auth=\(tok)") else { done(nil); return }
        var r = URLRequest(url: u)
        r.timeoutInterval = 10
        URLSession.shared.dataTask(with: r) { data, _, _ in
            guard let data = data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let lat = o["lat"] as? Double, let lng = o["lng"] as? Double else { done(nil); return }
            done(CLLocation(latitude: lat, longitude: lng))
        }.resume()
    }
}
