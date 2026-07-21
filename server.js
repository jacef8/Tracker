const express = require('express');
const path    = require('path');
const webpush = require('web-push');
const app     = express();
const PORT    = process.env.PORT || 3000;
const CURRENT_VERSION = '1.7';

// Railway sits in front of this app as a proxy — without this, req.ip is the proxy's own
// address for every request, making per-IP rate limiting useless (everyone looks like the
// same "client").
app.set('trust proxy', true);

app.use(express.json({ limit: '64kb' }));

// ─── Rate limiting ───────────────────────────────────────────────────
// Lightweight in-memory limiter (no new dependency) -- fine for a single Railway instance.
// /wake-device and /push had NO abuse protection at all: anyone who knew a device id or
// group name could spam FCM wake-pushes or notifications at it indefinitely, draining FCM
// quota or harassing real users. Fixed-window per-IP counter, generous enough for normal
// use (a family actively tapping Talk/Locate) but caps abusive spamming.
const rateLimitBuckets = new Map(); // ip -> { count, resetAt }
function rateLimit(maxRequests, windowMs) {
  return function(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let bucket = rateLimitBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      return res.status(429).json({ ok: false, reason: 'rate-limited' });
    }
    next();
  };
}
// Sweep stale buckets periodically so the Map doesn't grow unbounded over time.
setInterval(function() {
  const now = Date.now();
  for (const [ip, b] of rateLimitBuckets) { if (now > b.resetAt) rateLimitBuckets.delete(ip); }
}, 5 * 60 * 1000).unref();

// ─── Web Push (VAPID) ──────────────────────────────────────────────
// Only VAPID_PRIVATE must be set as an env var on the host; the public key
// here must match the one in public/index.html (VAPID_PUBLIC).
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BG3E3CXQWRCSBjy4lOwL7CKNNqdeC3ImC5yN2EQT3KgrKorczjiSGQyY7y97cWRGy-q1ZAA4iW4ES9PeMW5i7CE';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@groundlink.app';
const DB_URL = (process.env.FIREBASE_DB_URL || 'https://tracker-58b87-default-rtdb.firebaseio.com').replace(/\/$/, '');
let pushReady = false;
if (VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); pushReady = true; console.log('Web Push ready'); }
  catch (e) { console.warn('VAPID setup failed:', e.message); }
} else {
  console.warn('VAPID_PRIVATE not set — Web Push disabled');
}

// ─── FCM (native app push) via Firebase Admin ──────────────────────
// Set FIREBASE_SERVICE_ACCOUNT (the whole service-account JSON) on the host.
let fcmAdmin = null;
let adminDb = null;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svc) {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)), databaseURL: DB_URL });
    fcmAdmin = admin;
    adminDb = admin.database(); // superuser access — bypasses security rules, used for all
                                 // server-side gl/ reads below now that the DB requires auth != null
    console.log('FCM (Firebase Admin) ready');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set — native FCM push disabled');
  }
} catch (e) { console.warn('FCM init failed:', e.message); }

// Server-side gl/ read/delete helper — uses the Admin SDK (bypasses rules) when available,
// falling back to a raw unauthenticated REST call otherwise (only works if the database still
// permits unauthenticated reads; since rules now require auth != null, that fallback is really
// just "fail the same way an anonymous client would" for a deployment with no service account).
async function _dbGet(path) {
  if (adminDb) { const snap = await adminDb.ref(path).once('value'); return snap.val(); }
  const r = await fetch(DB_URL + '/' + path + '.json');
  return await r.json();
}
async function _dbDelete(path) {
  if (adminDb) { await adminDb.ref(path).remove(); return; }
  await fetch(DB_URL + '/' + path + '.json', { method: 'DELETE' });
}

// ─── Push-to-wake: silently wake a sleeping watch (or any device) on demand ─────────
// The phone calls this when the owner taps Talk or Locate. We send a HIGH-PRIORITY DATA
// FCM (no notification UI) to the device's token, which the watch's WakeMessagingService
// handles — connecting voice or grabbing a GPS fix — so the watch can sleep when idle.
async function getDeviceToken(device) {
  try {
    const t = await _dbGet('gl/_devices/' + encodeURIComponent(device) + '/fcmToken');
    return (typeof t === 'string' && t) ? t : null;
  } catch (e) { return null; }
}
app.post('/wake-device', rateLimit(20, 60000), async function(req, res) {
  if (!fcmAdmin) return res.json({ ok: false, reason: 'fcm-not-configured' });
  const b = req.body || {};
  const device = String(b.device || '');
  const type = String(b.type || 'voice');
  let token = String(b.token || '');           // caller may pass it directly; else we look it up
  if (!token && device) token = (await getDeviceToken(device)) || '';
  if (!token) return res.json({ ok: false, reason: 'no-token' });
  try {
    await fcmAdmin.messaging().send({
      token: token,
      data: { type: type, ts: String(Date.now()) },
      android: { priority: 'high' }
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

// Fan-out a push to everyone in a group except the sender. The client calls
// this from pushNotify(); subscriptions live in Firebase at gl/<group>/pushSubs.
app.post('/push', rateLimit(30, 60000), async function(req, res) {
  if (!pushReady && !fcmAdmin) return res.json({ ok: false, reason: 'push-not-configured' });
  const b = req.body || {};
  const group = b.group, senderId = b.senderId;
  const senderFcm = b.senderFcm || '', senderEndpoint = b.senderEndpoint || '';
  if (!group) return res.status(400).json({ ok: false, reason: 'no-group' });
  // DB root namespace — sanitized + defaulted to production ('gl').
  const ns = (typeof b.ns === 'string' && /^[a-z0-9_]{1,20}$/i.test(b.ns)) ? b.ns : 'gl';
  const payload = JSON.stringify({
    title: b.title || 'GroundLink',
    body:  b.body  || '',
    type:  b.type  || 'info',
    group: group,
    url:   b.url   || '/'
  });
  const groupBase = ns + '/' + group;
  const base = groupBase + '/pushSubs';
  try {
    // Members currently in the room.
    const subs = (await _dbGet(base)) || {};
    // For join/leave activity, ALSO notify people who favorited this group but aren't
    // in the room right now (their subscriptions live at gl/<group>/favSubs).
    let favs = {};
    if (b.toFavs) {
      try { favs = (await _dbGet(groupBase + '/favSubs')) || {}; } catch (e) { favs = {}; }
    }
    // Merge by uid so someone who's both a member and a favoriter is notified once.
    const targets = {};
    Object.entries(subs).forEach(function(e) { targets[e[0]] = { rec: e[1], from: base }; });
    Object.entries(favs).forEach(function(e) { if (!targets[e[0]]) targets[e[0]] = { rec: e[1], from: groupBase + '/favSubs' }; });
    if (!Object.keys(targets).length) return res.json({ ok: true, sent: 0 });
    let sent = 0;
    await Promise.all(Object.entries(targets).map(async function(entry) {
      const uid = entry[0], rec = entry[1].rec, from = entry[1].from;
      if (uid === senderId || !rec) return;
      // Also skip THIS physical device even under a different/old uid: a stale subscription
      // carrying the sender's own FCM token or push endpoint must never notify the sender.
      if (senderFcm && rec.fcm && rec.fcm === senderFcm) return;
      if (senderEndpoint && rec.sub) {
        try { if (JSON.parse(rec.sub).endpoint === senderEndpoint) return; } catch (e) {}
      }
      // Respect the recipient's per-type notification prefs (SOS always goes through).
      if (b.type && b.type !== 'sos' && rec.prefs && (rec.prefs[b.type] === 0 || rec.prefs[b.type] === false)) return;
      // Web Push — installed PWA (browser-backed)
      if (pushReady && rec.sub) {
        let subscription = null;
        try { subscription = JSON.parse(rec.sub); } catch (e) {}
        if (subscription) {
          try {
            await webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: b.type === 'sos' ? 'high' : 'normal' });
            sent++;
          } catch (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
              try { await _dbDelete(from + '/' + uid); } catch (e2) {}
            }
          }
        }
      }
      // FCM — native app
      if (fcmAdmin && rec.fcm) {
        try {
          await fcmAdmin.messaging().send({
            token: rec.fcm,
            notification: { title: b.title || 'GroundLink', body: b.body || '' },
            data: { type: String(b.type || 'info'), group: String(group), url: String(b.url || '/') },
            android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink', tag: (b.type || 'gl') + '-' + group } }
          });
          sent++;
        } catch (err) {
          const code = (err && err.errorInfo && err.errorInfo.code) || (err && err.code) || '';
          if (/not-registered|invalid-registration-token|invalid-argument/i.test(code)) {
            try { await _dbDelete(from + '/' + uid + '/fcm'); } catch (e2) {}
          }
        }
      }
    }));
    res.json({ ok: true, sent: sent });
  } catch (e) {
    console.warn('/push error:', e.message);
    res.json({ ok: false, reason: 'send-failed' });
  }
});

app.get('/version', function(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.send(CURRENT_VERSION);
});
// /join — always shows join screen regardless of saved session
// Parcel lookup proxy — avoids CORS block on ArcGIS from browser
// Parcel lookup — returns a URL to Liberty County's public property search
// The ArcGIS FeatureServer requires auth tokens and cannot be queried publicly
// Instead we return a deep link to qPublic which IS public
app.get('/api/parcel', function(req, res) {
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  console.log('Parcel lookup:', lat, lng);
  // Return the qPublic map URL centered on these coordinates
  // Liberty County FL qPublic application
  var qpublicUrl = 'https://qpublic.schneidercorp.com/Application.aspx?App=LibertyCountyFL&Layer=Parcels&PageType=Map&Q=' + lat + '%2C' + lng;
  res.json({ qpublicUrl: qpublicUrl, lat: lat, lng: lng });
});
app.get('/join', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.redirect('/?fresh=1');
});

// ─── Admin gate ─────────────────────────────────────────────────
// This used to be "secret URL" only — no real check, and express.static below
// serves every file in public/ by its literal name, so /admin.html was ALSO
// directly reachable, completely bypassing the /777 alias even if that had a
// check. Both the alias AND the raw filename now go through the same auth
// gate, registered before express.static so this explicit route wins.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_COOKIE = 'gl_admin_session';
// In-memory only — resets on server restart (a re-login via ?key= is a trivial ask for the
// one admin using this). No need for persistence for a single-operator convenience mechanism.
const validAdminSessions = new Set();

function checkAdminCreds(user, pass) {
  return !!ADMIN_PASS && user === ADMIN_USER && pass === ADMIN_PASS;
}
function parseCookieHeader(str) {
  const out = {};
  String(str || '').split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
// HTTP Basic Auth requires the CLIENT to natively support a 401/WWW-Authenticate
// challenge-response. A Capacitor WebView does NOT do this out of the box (no
// onReceivedHttpAuthRequest handling in the native app) — every request from the native app was
// silently failing this challenge forever, which looked exactly like a stuck cache bug (the app
// just kept showing whatever page last loaded successfully, before this auth gate existed) rather
// than an auth failure. Cookie-based login works transparently in ANY client with zero special
// handling, since it's just an ordinary query param + Set-Cookie response.
function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASS) {
    // Fail CLOSED: an unset password must never silently mean "wide open."
    return res.status(503).send('Admin/test access is not configured. Set ADMIN_PASS on the server.');
  }
  // 1) Already-established cookie session.
  const cookies = parseCookieHeader(req.headers.cookie);
  if (cookies[ADMIN_COOKIE] && validAdminSessions.has(cookies[ADMIN_COOKIE])) return next();
  // 2) One-time login via query param (?key=PASSWORD or ?key=USER:PASSWORD) — sets the cookie for
  // all future requests, from any client including the native app.
  if (req.query.key) {
    const raw = String(req.query.key);
    const sep = raw.indexOf(':');
    const user = sep >= 0 ? raw.slice(0, sep) : ADMIN_USER;
    const pass = sep >= 0 ? raw.slice(sep + 1) : raw;
    if (checkAdminCreds(user, pass)) {
      const token = require('crypto').randomBytes(24).toString('hex');
      validAdminSessions.add(token);
      res.setHeader('Set-Cookie', ADMIN_COOKIE + '=' + token + '; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax');
      return next();
    }
  }
  // 3) Still support classic HTTP Basic Auth too (e.g. direct curl access) — no regression there.
  const hdr = req.headers.authorization || '';
  const m = /^Basic (.+)$/.exec(hdr);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    if (checkAdminCreds(user, pass)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="GroundLink Admin"');
  return res.status(401).send('Authentication required.');
}

// Admin route
app.get(['/777', '/admin.html'], requireAdminAuth, function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// Public APK install page — share this link with friends: /download
app.get('/download', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});
// Digital Asset Links — required for TWA/Play Store verification
app.get('/.well-known/assetlinks.json', function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify([{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.groundlink.app",
      "sha256_cert_fingerprints": ["66:D4:5E:8A:57:E7:1E:75:92:B6:A5:EF:CC:C9:04:6D:B7:AA:CD:D7:E2:A9:14:45:B6:7E:5E:66:07:06:90:4C", "D5:BF:39:0E:56:EA:85:26:BD:DA:3D:77:CF:C7:1E:1C:C4:2A:E2:C3:50:68:DD:23:00:96:00:26:2D:96:9C:17", "10:09:BB:FE:B3:3B:9A:44:79:50:C8:07:88:23:25:D0:A5:AA:1A:53:75:84:29:34:5B:24:CA:0A:CD:A9:70:EB"]
    }
  }]));
});
// Short room-invite link: /j/<room>[?k=<passcode>] → the app's room-join URL. Keeps shared
// texts short. The App-Links intent-filter also claims this path, so installed apps open it
// natively (the web app routes it client-side); browsers follow this 302 into the web app.
app.get('/j/:room', function(req, res) {
  var room = String(req.params.room || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/__+/g, '_');
  var k = req.query.k ? '&k=' + encodeURIComponent(String(req.query.k)) : '';
  res.redirect(302, '/?room=' + encodeURIComponent(room) + k);
});
// Short device-share link: /d/<code> → the app's accept-device URL. Same idea as /j/ — keeps
// the texted link short + clean, App-Links opens it natively, browsers 302 into the web app.
app.get('/d/:code', function(req, res) {
  var code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  res.redirect(302, '/?dshare=' + encodeURIComponent(code));
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
    if (filePath.endsWith('index.html') || filePath.endsWith('headless.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    if (filePath.endsWith('version.json')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    if (filePath.endsWith('admin.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    if (filePath.endsWith('.apk')) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="GroundLink.apk"');
    }
  }
}));
app.get('*', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(PORT, function() {
  console.log('GroundLink on port ' + PORT);
});
