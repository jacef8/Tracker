// Build 1011 / iOS 1.0.17: iPhone location push. Static checks across the four places it lives:
// the page files the token, the server sends the push from the quiet-phone sweep, the app asks
// for the token and shares its write config, and the extension writes like the native writer.
//
// Usage:  node tools/locpush1011.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const srv = readFileSync('server.js', 'utf8');
const app = readFileSync('native-app/ios/App/App/AppDelegate.swift', 'utf8');
const ent = readFileSync('native-app/ios/App/App/App.entitlements', 'utf8');
const ext = readFileSync('native-app/ios/App/LocationPush/LocationPushService.swift', 'utf8');
const extPlist = readFileSync('native-app/ios/App/LocationPush/Info.plist', 'utf8');
const extEnt = readFileSync('native-app/ios/App/LocationPush/LocationPush.entitlements', 'utf8');
const shared = readFileSync('native-app/ios/App/App/GLShared.swift', 'utf8');
const fast = readFileSync('native-app/ios/App/fastlane/Fastfile', 'utf8');
const wf = readFileSync('.github/workflows/ios-release.yml', 'utf8');
const pbx = readFileSync('native-app/ios/App/App.xcodeproj/project.pbxproj', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

// page
ok(idx.includes("window._glFetch('/locpush/register'"), 'page files the token with the server');
ok(idx.includes("try { if (window._registerLocPush) window._registerLocPush(); } catch (e) {}"), 're-filed on room entry');
ok(idx.includes("off: (typeof locationHidden !== 'undefined' && locationHidden) ? 1 : 0,"), 'paused sharing reaches the extension');
ok(idx.includes("        locPush: window._locPushToken ?"), 'diag reports the token state');

// server
ok(srv.includes("function sendLocationPush(deviceToken) { return _sendApns(deviceToken, {}, 'location', APNS_BUNDLE + '.location-query'); }"), 'location push topic and type');
ok(srv.includes("const lp = await _sendLocPushFor(uid);"), 'the quiet-phone bump sends it');
ok(srv.includes("app.post('/locpush/register', rateLimit(20, 60000), requireUser,"), 'register needs a sign-in');
ok(srv.includes("if (cur && cur.authUid && cur.authUid !== req.authUid) {"), 'another account cannot replace a token');
ok(srv.includes("const WAKE_IOS_LP_COOLDOWN_MS = 15 * 60 * 1000;"), '15-minute cooldown');
ok(srv.includes('_wakeCooldown(a.u, p.age, uid)') && srv.includes("=== 'ignored' ? WAKE_SLOW_COOLDOWN_MS : _wakeCooldown(u, age, uid);"), 'both cooldown callers pass the uid');
ok(srv.includes("if (/ 410 |BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(msg))"), 'dead tokens dropped');

// app
ok(app.includes('mgr.startMonitoringLocationPushes'), 'app asks for the token');
ok(app.includes('GLShared.saveConfig(json)   // 1.0.17'), 'write config mirrored for the extension');
ok(ent.includes('<key>com.apple.developer.location.push</key>'), 'location push entitlement');
ok(/<key>keychain-access-groups<\/key>\s*<array>\s*<string>\$\(AppIdentifierPrefix\)com\.groundlink\.ios<\/string>/.test(ent), "app's own keychain group stays first (default)");
ok(extEnt.includes('$(AppIdentifierPrefix)com.groundlink.shared') && ent.includes('$(AppIdentifierPrefix)com.groundlink.shared') && shared.includes('"XM3MLRA366.com.groundlink.shared"'), 'one shared keychain group, spelled the same in all three');
ok(shared.includes('kSecAttrAccessibleAfterFirstUnlock'), 'config readable while the phone is locked');

// extension
ok(extPlist.includes('<string>com.apple.location.push.service</string>') && extPlist.includes('$(PRODUCT_MODULE_NAME).LocationPushService'), 'extension point and class');
ok(ext.includes('final class LocationPushService: NSObject, CLLocationPushServiceExtension'), 'extension class');
for (const k of ['"path": NSNull()', '"noGps": NSNull()', '"claiming": NSNull()', '"bgf": NSNull()', '"hbTs": ts', '"fixTs": fixTs', '"lpTs": ts'])
  ok(ext.includes(k), 'extension writes ' + k);
ok(ext.includes('if moved { body["hereSince"] = NSNull(); body["rest"] = NSNull() }'), 'here/rest only cleared after a real move');
ok(ext.includes('if ((cfg["off"] as? NSNumber)?.intValue ?? 0) == 1 { finish(); return }'), 'silent while sharing is paused');
ok(ext.includes('r.httpMethod = "PATCH"'), 'PATCH, never PUT');

// build
ok(fast.includes('LocPushTarget.ensure!(') && fast.includes('LOCPUSH_IDENTIFIER => locpush_profile'), 'Fastfile adds and signs the extension');
ok(wf.includes('node tools/asc-ensure-extension-id.mjs com.groundlink.ios com.groundlink.ios.locpush'), 'workflow registers the extension App ID');
ok((pbx.match(/MARKETING_VERSION = 1.0.(1[7-9]|[2-9][0-9]);/g) || []).length === 2, 'iOS version 1.0.17 or later');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
