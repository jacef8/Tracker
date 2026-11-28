const express = require('express');
const path    = require('path');
const webpush = require('web-push');
const app     = express();
const PORT    = process.env.PORT || 3000;
const CURRENT_VERSION = '1.8';

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
async function _dbSet(path, value) {
  if (adminDb) { await adminDb.ref(path).set(value); return; }
  await fetch(DB_URL + '/' + path + '.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
}

// ─── APNs VoIP push (CallKit / PushKit) ───────────────────────────────────────────
// FCM CANNOT send VoIP pushes, so these go DIRECT to Apple over HTTP/2, signed with the SAME APNs
// auth key (.p8) already used for FCM. Set on the host: APNS_KEY_P8 (the full -----BEGIN PRIVATE
// KEY----- block), APNS_KEY_ID, APNS_TEAM_ID. Bundle defaults to com.groundlink.ios → VoIP topic
// com.groundlink.ios.voip. A VoIP push wakes a LOCKED iPhone; the app reports a CallKit call and,
// on answer, the web layer joins the channel (see AppDelegate + window._callkitJoin).
const http2 = require('http2');
const crypto = require('crypto');
const APNS_KEY_P8  = (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n');
const APNS_KEY_ID  = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_BUNDLE  = process.env.APNS_BUNDLE || 'com.groundlink.ios';
const APNS_HOST    = 'https://api.push.apple.com';   // production (TestFlight + App Store use prod APNs)
const apnsVoipReady = !!(APNS_KEY_P8 && APNS_KEY_ID && APNS_TEAM_ID);
// Kill switch for the CallKit VoIP push (see /voip). Ringless Push-to-Talk pushes are
// unaffected. Set VOIP_CALLKIT=1 on the host to turn CallKit back on.
const VOIP_CALLKIT_ENABLED = process.env.VOIP_CALLKIT === '1';
if (apnsVoipReady) console.log('APNs VoIP ready');
else console.warn('APNs VoIP not configured (APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID) — CallKit disabled');

let _apnsJwt = '', _apnsJwtAt = 0;
function _apnsToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_apnsJwt && (now - _apnsJwtAt) < 2400) return _apnsJwt;   // reuse < 40 min (Apple caps at 60)
  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: APNS_TEAM_ID, iat: now })).toString('base64url');
  const signingInput = header + '.' + payload;
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key: APNS_KEY_P8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  _apnsJwt = signingInput + '.' + sig; _apnsJwtAt = now;
  return _apnsJwt;
}
function _sendApns(deviceToken, data, pushType, topic) {
  return new Promise(function (resolve, reject) {
    let client;
    try { client = http2.connect(APNS_HOST); } catch (e) { return reject(e); }
    client.on('error', function (e) { try { client.close(); } catch (_) {} reject(e); });
    const body = Buffer.from(JSON.stringify(Object.assign({ aps: {} }, data)));
    const r = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + deviceToken,
      'authorization': 'bearer ' + _apnsToken(),
      'apns-push-type': pushType,
      'apns-topic': topic,
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': body.length
    });
    let status = 0, respData = '';
    r.on('response', function (h) { status = h[':status']; });
    r.on('data', function (c) { respData += c; });
    r.on('end', function () { try { client.close(); } catch (_) {} (status === 200) ? resolve(true) : reject(new Error('apns ' + status + ' ' + respData)); });
    r.on('error', function (e) { try { client.close(); } catch (_) {} reject(e); });
    r.write(body); r.end();
  });
}
// CallKit VoIP push (rings a locked phone). Topic <bundle>.voip, push-type voip.
function sendVoipPush(deviceToken, data) { return _sendApns(deviceToken, data, 'voip', APNS_BUNDLE + '.voip'); }
// Push to Talk push (iOS 16+, ringless). Topic <bundle>.voip-ptt, push-type pushtotalk.
function sendPttPush(deviceToken, data) { return _sendApns(deviceToken, data, 'pushtotalk', APNS_BUNDLE + '.voip-ptt'); }

// ─── Location push (iOS 15+, Apple's Location Push Service Extension) ───────────────────────
// Apple granted the entitlement in Nov 2026 (case 22674307). A push of type `location` to the
// topic <bundle>.location-query runs the app's LocationPushService extension even when the app
// itself is closed or has been killed in the background: it takes one fix and writes the row.
// The ordinary silent bump below only reaches an iPhone whose app iOS still keeps in memory,
// which is why Jax, Lexi and Vanesa went dark for hours on 2026-11-13 while sitting still.
// Tokens are filed by the app at gl/_locSubs/<uid> through /locpush/register.
// LOCPUSH_OFF=1 on the host turns the location push off without a redeploy.
const LOCPUSH_ENABLED = process.env.LOCPUSH_OFF !== '1';
function sendLocationPush(deviceToken) { return _sendApns(deviceToken, {}, 'location', APNS_BUNDLE + '.location-query'); }

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
app.post('/wake-device', rateLimit(20, 60000), requireUser, async function(req, res) {
  if (!fcmAdmin) return res.json({ ok: false, reason: 'fcm-not-configured' });
  const b = req.body || {};
  const device = String(b.device || '');
  const type = String(b.type || 'voice');
  if (!device) return res.json({ ok: false, reason: 'no-device' });
  // Owner, or someone the device has been shared with.
  let allowed = false;
  try {
    const d = await _dbGet('gl/_devices/' + device + '/owner');
    if (d && d === req.authUid) allowed = true;
    if (!allowed) {
      const mine = await _dbGet('gl/_deviceSharedWithMe/' + req.authUid);
      if (mine && (mine[device] || Object.values(mine).indexOf(device) !== -1)) allowed = true;
    }
    if (!allowed) {
      const own = await _cachedGet('gl/_devOwner', 60000);
      if (own && d && own[req.authUid] && own[req.authUid].acct === d) allowed = true;
    }
  } catch (e) {}
  if (!allowed) return res.status(403).json({ ok: false, reason: 'not-your-device' });
  // Always the device's own registered token — a caller-supplied one is ignored.
  const token = (await getDeviceToken(device)) || '';
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

// Find one uid's push identity (FCM token and/or web-push sub) by scanning every room's
// pushSubs and favSubs. Subscriptions are per-room with no global index, so this walks the
// room list — cheap at family scale, and both /bump and /nudge below need it.
// List the room names, and nothing else. `shallow=true` is the reason this is a raw REST call
// rather than adminDb — the Admin SDK has no shallow read, and .once('value') on gl/ would drag
// the entire database back on every push.
//
// It MUST be authenticated. This read was anonymous, and once the rules were tightened to
// require auth != null it started returning {"error":"Permission denied"} — an object, not a
// throw. Object.keys() of that is ["error"], so the scan below dutifully looked for
// subscriptions in a room named "error", found none, and reported "no-subscription". Every
// person-targeted push — Notify, Nudge, the silent Refresh, and invites — failed exactly that
// way, silently, for everyone. Confirmed 2026-09-07 against a device with a valid live token.
// ─── Who is calling ───────────────────────────────────────────────────────────────────────
// A Firebase ID token in "Authorization: Bearer ...", verified with the Admin SDK. Anonymous
// sessions are real sessions here (they are how a device without a Google account signs in),
// so membership — not merely being signed in — is what grants reach.
async function authUidFrom(req) {
  if (!fcmAdmin) return null;
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { return (await fcmAdmin.auth().verifyIdToken(m[1])).uid || null; } catch (e) { return null; }
}
function requireUser(req, res, next) {
  authUidFrom(req).then(function (u) {
    if (!u) return res.status(401).json({ ok: false, reason: 'sign-in-required' });
    req.authUid = u;
    next();
  }).catch(function () { res.status(401).json({ ok: false, reason: 'sign-in-required' }); });
}

// ── AUTH BRIDGE ─────────────────────────────────────────────────────────────────────────────
// The native app signs in through the Capacitor Firebase plugin, which completes a full
// sign-in in the NATIVE Firebase SDK. The WebView's JavaScript SDK -- the one the Realtime
// Database client actually authenticates with -- is never signed in, so every read and write
// from the page goes out as the ANONYMOUS device session while the UI says "Signed in as
// <email>". That mismatch was harmless only because profiles used to be readable by any
// signed-in user; once they were locked to their owner (2026-10-10) the app could no longer
// read its own account and crews stopped arriving on new installs.
//
// Re-exchanging the provider credential in the JS SDK is not an option: it is a one-time
// credential and Firebase rejects the second redemption (confirmed for Apple). So the page
// hands us the ID TOKEN the native SDK already holds, we verify it, and we mint a custom
// token for the SAME uid that the JS SDK can sign in with. Nothing is re-redeemed and no
// provider is involved.
//
// No privilege is created here. The caller must already present a valid, unexpired Firebase
// ID token, which only that signed-in user can obtain; we hand back a token for exactly the
// uid inside it and nothing else. An attacker who could call this successfully would already
// be the user.
app.post('/authbridge', rateLimit(30, 60000), requireUser, async function (req, res) {
  try {
    if (!fcmAdmin) return res.status(503).json({ ok: false, reason: 'auth-unavailable' });
    const token = await fcmAdmin.auth().createCustomToken(req.authUid);
    res.json({ ok: true, token: token, uid: req.authUid });
  } catch (e) {
    console.warn('[authbridge]', (e && e.message) || e);
    res.status(500).json({ ok: false, reason: 'mint-failed' });
  }
});

// Short-lived cache of the few nodes these checks read, so a burst of pushes costs one read.
const _accCache = new Map();
async function _cachedGet(path, ttl) {
  const hit = _accCache.get(path);
  if (hit && Date.now() - hit.at < (ttl || 30000)) return hit.v;
  const v = await _dbGet(path);
  _accCache.set(path, { v: v, at: Date.now() });
  return v;
}
// Is `a` (an auth uid) a member of `room`? Every id form counts: the access list, the roster, the
// owner/admins, a presence row under that id, or a device row whose owning account is `a`.
// Who counts as "in this room" for the purposes of the push/wake endpoints.
//
// This used to accept FOUR proofs, and three of them were self-writable. `members/$uid` and
// `users/$uid` can both be written by the person they name -- that is by design, it is how you
// join -- so presenting one of them proved only that the caller had asked to be a member, not
// that anyone had agreed. A stranger could PUT one row and then reach /push, /freshen, /bump,
// /nudge, /pushTo and /voip against a real family: arbitrary notification text to every member,
// and silent device wakes. The `_devOwner` fallback was worse, being a client-written index any
// signed-in user could forge for any uid (now locked in the rules, but it has no business being
// an authorization input regardless).
//
// Only two things represent a DECISION by someone who already had authority: the acl (an owner
// or admin approved you, or you presented the room's invite key) and config.owner/admins. That
// is the whole list now.
async function roomAccess(room, a) {
  if (!room || !a || room.charAt(0) === '_') return false;
  try {
    const acl = await _cachedGet('gl/' + room + '/acl');
    if (acl && acl[a]) return true;
    const cfg = await _cachedGet('gl/' + room + '/config');
    if (cfg && (cfg.owner === a || (cfg.admins && cfg.admins[a]))) return true;
  } catch (e) {}
  return false;
}
// Is `target` (any id form) present in `room`?
async function inRoom(room, target) {
  try {
    const own = await _cachedGet('gl/_devOwner', 60000);
    const acct = own && own[target] && own[target].acct;
    for (const br of ['users', 'members', 'acl']) {
      const v = await _cachedGet('gl/' + room + '/' + br);
      if (v && (v[target] || (acct && v[acct]))) return true;
    }
  } catch (e) {}
  return false;
}
// Does caller `a` share at least one room with `target`?
async function sharesRoom(a, target) {
  if (!a || !target) return false;
  let rooms = [];
  try { rooms = await _roomNames(); } catch (e) { return false; }
  for (const room of rooms) {
    if (await roomAccess(room, a) && await inRoom(room, target)) return true;
  }
  return false;
}

async function _roomNames() {
  let url = DB_URL + '/gl.json?shallow=true';
  if (fcmAdmin) {
    const cred = fcmAdmin.app().options.credential;
    const tok = await cred.getAccessToken();
    url += '&access_token=' + encodeURIComponent(tok.access_token);
  }
  const j = await (await fetch(url)).json();
  // Never treat an error payload as data again — that is the whole bug above.
  if (!j || typeof j !== 'object' || j.error) throw new Error('room list: ' + ((j && j.error) || 'empty'));
  return Object.keys(j).filter(k => k.charAt(0) !== '_');
}

async function findSubsForUid(uid) {
  let rooms = [];
  try {
    rooms = await _roomNames();
  } catch (e) {
    // Loud: with no room list there is nobody to find, and the caller can only report
    // "no-subscription", which reads as "they turned notifications off" and is a lie.
    console.error('findSubsForUid: cannot list rooms —', e.message);
    return null;
  }
  for (const room of rooms) {
    for (const branch of ['pushSubs', 'favSubs']) {
      try {
        const rec = await _dbGet('gl/' + room + '/' + branch + '/' + uid);
        if (rec && (rec.fcm || rec.sub)) return rec;
      } catch (e) {}
    }
  }
  // 1012: a phone that is in no room yet has no room subscription at all, so an invite to a
  // brand-new user never rang (Tyler, 2026-11-14: invited to Family Men, nothing on his phone).
  // The app now files its push address here whenever it opens (/push/register).
  try {
    const rec = await _dbGet('gl/_pushTokens/' + uid);
    if (rec && rec.fcm) return rec;
  } catch (e) {}
  return null;
}

// 1029: EVERY push address on file for a person, one per distinct phone/browser. A Talk call
// used the first record findSubsForUid met, so a stale token or a muted pref filed under one old
// room silenced the call even when the same person's current phone was registered elsewhere.
async function findAllSubsForUid(uid) {
  let rooms = [];
  try { rooms = await _roomNames(); } catch (e) { rooms = []; }
  const paths = [];
  rooms.forEach(function (room) { paths.push('gl/' + room + '/pushSubs/' + uid, 'gl/' + room + '/favSubs/' + uid); });
  paths.push('gl/_pushTokens/' + uid);
  const got = await Promise.all(paths.map(function (pth) { return _dbGet(pth).then(function (r) { return { path: pth, rec: r }; }).catch(function () { return null; }); }));
  const out = [], seen = new Set();
  got.forEach(function (g) {
    if (!g || !g.rec || !(g.rec.fcm || g.rec.sub)) return;
    const key = g.rec.fcm ? 'f:' + g.rec.fcm : 's:' + String(g.rec.sub).slice(0, 300);
    if (seen.has(key)) {
      // Same phone filed twice: a mute in ANY copy wins, so a muted type stays muted.
      const prev = out.find(function (o) { return o.key === key; });
      if (prev && g.rec.prefs) prev.prefsList.push(g.rec.prefs);
      return;
    }
    seen.add(key);
    out.push({ key: key, path: g.path, rec: g.rec, prefsList: g.rec.prefs ? [g.rec.prefs] : [] });
  });
  return out;
}
function _voiceExtra(b) {
  // Talk notifications carry what the receiving app needs to answer straight from the tap.
  const x = {};
  const vr = String(b.voiceRoom || '');
  if (/^gv_[A-Za-z0-9_~\-]{1,200}$/.test(vr)) x.voiceRoom = vr;
  const kind = String(b.kind || '');
  if (/^(call|missed|vm|channel)$/.test(kind)) x.kind = kind;
  const fn = String(b.fromName || '').slice(0, 40);
  if (fn) x.fromName = fn;
  return x;
}

// 1012: the app files its FCM address here on every open, room or no room. Signed-in callers
// only; an address on file can only be replaced by the account that filed it or by the
// device's owner account. Used only as the LAST resort by findSubsForUid, after the room
// subscriptions (which carry per-room notification preferences).
app.post('/push/register', rateLimit(20, 60000), requireUser, async function (req, res) {
  if (!adminDb) return res.json({ ok: false, reason: 'no-db' });
  const b = req.body || {};
  const uid = String(b.uid || '');
  const fcm = String(b.fcm || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return res.status(400).json({ ok: false, reason: 'bad-uid' });
  if (!/^[A-Za-z0-9_:\-]{20,4096}$/.test(fcm)) return res.status(400).json({ ok: false, reason: 'bad-token' });
  try {
    const cur = await _dbGet('gl/_pushTokens/' + uid);
    if (cur && cur.authUid && cur.authUid !== req.authUid) {
      const own = await _dbGet('gl/_devOwner/' + uid + '/acct');
      if (own !== req.authUid) return res.status(403).json({ ok: false, reason: 'not-your-device' });
    }
    await adminDb.ref('gl/_pushTokens/' + uid).update({
      fcm: fcm, authUid: req.authUid, name: String(b.name || '').slice(0, 60), ts: Date.now()
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

// Silent wake ("bump"): a content-available push that relaunches the target's app just long
// enough to report one fresh fix — the Life360 "member updates right when you look at them"
// mechanic. Invisible on the target's phone; wakes from suspension and from system
// termination, but nothing can wake a user force-quit (that's what /nudge is for).
async function sendBump(uid) {
  if (!uid) return { ok: false, reason: 'no-uid' };
  // An iPhone that filed a location-push token gets that FIRST: it is the one push that still
  // gets a position out of a phone whose app iOS has closed. The ordinary bump still goes too --
  // it costs nothing and wakes an app that is merely suspended.
  const lp = await _sendLocPushFor(uid);
  if (!fcmAdmin) return lp.sent ? { ok: true, reason: 'lp' } : { ok: false, reason: 'fcm-not-configured' + lp.note };
  const rec = await findSubsForUid(uid);
  if (!rec || !rec.fcm) return lp.sent ? { ok: true, reason: 'lp' } : { ok: false, reason: 'no-token' + lp.note };
  try {
    await fcmAdmin.messaging().send({
      token: rec.fcm,
      data: { type: 'bump', ts: String(Date.now()) },
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } }
      }
    });
    return { ok: true, reason: lp.sent ? 'sent+lp' : 'sent' };
  } catch (e) { return lp.sent ? { ok: true, reason: 'lp' } : { ok: false, reason: e.message + lp.note }; }
}

// The location push half of a bump. note is appended to a failure reason so gl/_wake shows why.
async function _sendLocPushFor(uid) {
  if (!LOCPUSH_ENABLED || !apnsVoipReady || !adminDb) return { sent: false, note: '' };
  let sub = null;
  try { sub = await _dbGet('gl/_locSubs/' + uid); } catch (e) {}
  if (!sub || !sub.t) return { sent: false, note: '' };
  try {
    await sendLocationPush(sub.t);
    try { await adminDb.ref('gl/_locSubs/' + uid).update({ lastPush: Date.now(), lastResult: 'sent' }); } catch (e) {}
    return { sent: true, note: '' };
  } catch (e) {
    const msg = String(e.message || e);
    // Apple's answer for a token that will never work again: the app was deleted, or the token
    // belongs to another build. Drop it; the app files a fresh one the next time it opens.
    if (/ 410 |BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(msg)) {
      try { await _dbDelete('gl/_locSubs/' + uid); } catch (e2) {}
    } else {
      try { await adminDb.ref('gl/_locSubs/' + uid).update({ lastPush: Date.now(), lastResult: msg.slice(0, 120) }); } catch (e2) {}
    }
    return { sent: false, note: ' (lp: ' + msg.slice(0, 60) + ')' };
  }
}

// The app files its location-push token here. Signed-in callers only. A token on file for a
// device can only be replaced by the account that filed it, or by that device's owner account.
// Nothing reported through a location push is taken from this record: the extension on the
// phone writes as the person signed in there, so a token filed under the wrong id could only
// ever wake a phone, never put a position on somebody else's row.
app.post('/locpush/register', rateLimit(20, 60000), requireUser, async function (req, res) {
  if (!adminDb) return res.json({ ok: false, reason: 'no-db' });
  const b = req.body || {};
  const uid = String(b.uid || '');
  const token = String(b.token || '').toLowerCase();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return res.status(400).json({ ok: false, reason: 'bad-uid' });
  if (!/^[0-9a-f]{32,256}$/.test(token)) return res.status(400).json({ ok: false, reason: 'bad-token' });
  try {
    const cur = await _dbGet('gl/_locSubs/' + uid);
    if (cur && cur.authUid && cur.authUid !== req.authUid) {
      const own = await _dbGet('gl/_devOwner/' + uid + '/acct');
      if (own !== req.authUid) return res.status(403).json({ ok: false, reason: 'not-your-device' });
    }
    await adminDb.ref('gl/_locSubs/' + uid).update({ t: token, authUid: req.authUid, ts: Date.now() });
    locSubIds.add(uid);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

// ─── DELETE A ROOM, FOR GOOD ─────────────────────────────────────────────────
// Deleting a room from the app never stuck. The client removed gl/<room> itself, but any
// device still in the room recreates the node with its very next position write -- Firebase
// re-creates parents on write -- so the room came back, and because it was back, every
// member's self-heal saw it as alive and kept it in their crew list. Reported 2026-10-11:
// "I deleted this room but back on the crew screen it's still listed." Confirmed in the data:
// gl/hunting had lost its config but still held diag, favSubs, members, trails and users, and
// four accounts still listed it.
//
// The client already reads gl/_deadRooms/<key> as the authoritative "this room is gone"
// tombstone and prunes its crews from it. Nothing could ever WRITE one: the rules grant no
// client write there (deliberately -- a tombstone another member could forge would delete a
// room out from under its owner). So it has to happen here, where the admin SDK runs.
//
// Ownership is checked against config, not asserted by the caller: window._isRoomOwner is a
// client-side flag and means nothing on this side of the wire.
// 1016: take someone off a Crew's roster. The database rule on gl/<room>/members/<uid> lets only
// that person (or their account) write their own entry, so the owner's "Remove from Crew" was
// refused by Firebase every time -- the app said "removed" and the roster never changed (Jace,
// 2026-11-14). The owner/admin check happens here instead, as /room/delete does, and the admin
// SDK makes the change. Also clears their row, diag and access-list entry, and leaves the
// config/removed marker that stops their own app from re-adding them.
app.post('/crew/remove', rateLimit(20, 60000), requireUser, async function (req, res) {
  if (!adminDb) return res.json({ ok: false, reason: 'no-db' });
  const b = req.body || {};
  const room = String(b.room || '').trim();
  if (!room || !/^[a-z0-9_-]{1,64}$/i.test(room) || room.charAt(0) === '_') return res.status(400).json({ ok: false, reason: 'bad-room' });
  const ids = (Array.isArray(b.uids) ? b.uids : []).map(function (u) { return String(u || ''); })
    .filter(function (u) { return /^[A-Za-z0-9_-]{6,64}$/.test(u); }).slice(0, 4);
  if (!ids.length) return res.status(400).json({ ok: false, reason: 'no-uid' });
  let cfg = null;
  try { cfg = (await adminDb.ref('gl/' + room + '/config').get()).val(); } catch (e) {}
  const me = req.authUid;
  let allowed = !!(cfg && (cfg.owner === me || (cfg.admins && cfg.admins[me])));
  // An owner recorded by DEVICE id (older rooms) is matched through that device's account.
  if (!allowed && cfg && cfg.owner) {
    try { const acct = (await adminDb.ref('gl/_devOwner/' + cfg.owner + '/acct').get()).val(); if (acct === me) allowed = true; } catch (e) {}
  }
  if (!allowed) return res.status(403).json({ ok: false, reason: 'not-owner' });
  try {
    const upd = {};
    for (const u of ids) {
      upd['members/' + u] = null;
      upd['users/' + u] = null;
      upd['diag/' + u] = null;
      upd['acl/' + u] = null;
      upd['config/removed/' + u] = Date.now();
    }
    await adminDb.ref('gl/' + room).update(upd);
    res.json({ ok: true, removed: ids.length });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

// 1094: fold an old or duplicate entry of a person into the one to keep (Jace, 2026-11-26: two
// Jareds, two Pages, two Allies). Two callers:
//  - the crew's owner/admin, from the "Same person?" card: any non-protected drop.
//  - the person themselves, signed in (self:1): only entries with EXACTLY their full name, not
//    seen for 14+ days, not tied to any other signed-in account. Everything is re-checked here.
// Every dropped entry is copied to gl/_mergeBackup/<room>/<ts> first. If a dropped entry was on
// the Crew list and the kept one is not, the kept one takes its place there.
function _nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
app.post('/crew/merge', rateLimit(20, 60000), requireUser, async function (req, res) {
  if (!adminDb) return res.json({ ok: false, reason: 'no-db' });
  const b = req.body || {};
  const room = String(b.room || '').trim();
  if (!room || !/^[a-z0-9_-]{1,64}$/i.test(room) || room.charAt(0) === '_') return res.status(400).json({ ok: false, reason: 'bad-room' });
  const idOk = function (u) { return /^[A-Za-z0-9_-]{6,64}$/.test(u); };
  const keep = String(b.keep || '');
  const drops = (Array.isArray(b.drop) ? b.drop : []).map(function (u) { return String(u || ''); }).filter(idOk).filter(function (u) { return u !== keep; }).slice(0, 4);
  if (!idOk(keep) || !drops.length) return res.status(400).json({ ok: false, reason: 'bad-ids' });
  const me = req.authUid;
  const R = 'gl/' + room;
  const val = async function (p) { try { return (await adminDb.ref(p).get()).val(); } catch (e) { return null; } };
  const cfg = (await val(R + '/config')) || {};
  let mgr = !!(cfg.owner === me || (cfg.admins && cfg.admins[me]));
  if (!mgr && cfg.owner) { const acct = await val('gl/_devOwner/' + cfg.owner + '/acct'); if (acct === me) mgr = true; }
  const acctOf = async function (u) { return (await val('gl/_devOwner/' + u + '/acct')) || ''; };
  const protectedId = async function (u) {
    const a = await acctOf(u);
    return [u, a].some(function (x) { return x && (x === cfg.owner || (cfg.admins && cfg.admins[x])); });
  };
  const rec = {};
  for (const u of [keep].concat(drops)) {
    rec[u] = { members: await val(R + '/members/' + u), users: await val(R + '/users/' + u), acl: await val(R + '/acl/' + u),
               invited: await val(R + '/config/invited/' + u), diag: await val(R + '/diag/' + u) };
  }
  for (const d of drops) if (await protectedId(d)) return res.status(403).json({ ok: false, reason: 'protected' });
  if (!mgr) {
    if (!b.self) return res.status(403).json({ ok: false, reason: 'not-owner' });
    const keepAcct = await acctOf(keep);
    if (!(keep === me || keepAcct === me)) return res.status(403).json({ ok: false, reason: 'not-yours' });
    let myName = _nameKey((rec[keep].users || {}).name || ((await val(R + '/members/' + me)) || {}).name);
    if (myName.split(' ').length < 2 || myName.length < 5) return res.status(403).json({ ok: false, reason: 'need-full-name' });
    for (const d of drops) {
      const r = rec[d];
      const nm = _nameKey((r.users || {}).name || (r.members || {}).name || (r.invited || {}).name);
      if (nm !== myName) return res.status(403).json({ ok: false, reason: 'name-differs' });
      const ts = (r.users && (r.users.fixTs || r.users.ts)) || 0;
      if (r.users && Date.now() - ts < 14 * 86400000) return res.status(403).json({ ok: false, reason: 'too-recent' });
      for (const x of [d, await acctOf(d)]) {
        if (!x || x === me) continue;
        try { const u = await fcmAdmin.auth().getUser(x); if (u.providerData && u.providerData.length) return res.status(403).json({ ok: false, reason: 'other-account' }); } catch (e) {}
      }
    }
  }
  try {
    const ts = Date.now();
    const bak = { by: me, self: !mgr, keep: keep, drops: {} };
    drops.forEach(function (d) { bak.drops[d] = rec[d]; });
    await adminDb.ref('gl/_mergeBackup/' + room + '/' + ts).set(JSON.parse(JSON.stringify(bak)));
    const upd = {}, rootUpd = {};
    let wasMember = null, hadAcl = null;
    for (const d of drops) {
      const r = rec[d];
      if (r.members) wasMember = wasMember || r.members;
      if (r.acl) hadAcl = hadAcl || r.acl;
      upd['members/' + d] = null; upd['users/' + d] = null; upd['diag/' + d] = null; upd['acl/' + d] = null; upd['config/invited/' + d] = null;
      ((r.invited && r.invited.inbox) || []).forEach(function (p) { if (/^[A-Za-z0-9_-]{6,64}\/[A-Za-z0-9_-]{6,40}$/.test(String(p))) rootUpd['gl/_invites/' + p] = null; });
    }
    const keepId = (await acctOf(keep)) || keep;
    const keepName = (rec[keep].users || {}).name || (wasMember && wasMember.name) || '';
    if (wasMember && !rec[keep].members && !(await val(R + '/members/' + keepId))) upd['members/' + keepId] = { name: keepName, addedAt: ts, addedBy: me, merged: 1 };
    if (hadAcl && !rec[keep].acl && !(await val(R + '/acl/' + keepId))) upd['acl/' + keepId] = { by: 'merge', glUid: keep, name: keepName, ts: ts };
    await adminDb.ref(R).update(upd);
    if (Object.keys(rootUpd).length) await adminDb.ref().update(rootUpd);
    res.json({ ok: true, removed: drops.length, backup: ts });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

// 1020: hand a phone from the ANONYMOUS guest session it started with to the account its owner
// then signed in with. The app opens as an anonymous guest, the phone is registered to that
// guest (gl/_devOwner), and the rule on _devOwner refuses any later change -- so a person who
// signs in with Google minutes after installing can never again write their own location, roster
// entry or anything else keyed to the phone (Tyler, 2026-11-14: installed 10:46, Google 10:48,
// invisible all day). The rule is right to stop one REAL account taking a phone from another;
// it was never meant to lock a phone to a throwaway guest. So: allowed only when the current
// owner is an anonymous account (no sign-in providers). Anything else is refused.
app.post('/device/claim', rateLimit(10, 60000), requireUser, async function (req, res) {
  if (!adminDb || !fcmAdmin) return res.json({ ok: false, reason: 'no-admin' });
  const uid = String((req.body || {}).uid || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return res.status(400).json({ ok: false, reason: 'bad-uid' });
  const me = req.authUid;
  try {
    const me0 = await fcmAdmin.auth().getUser(me);
    if (!me0.providerData || !me0.providerData.length) return res.status(403).json({ ok: false, reason: 'caller-anonymous' });
    const cur = (await adminDb.ref('gl/_devOwner/' + uid).get()).val();
    const was = cur && cur.acct;
    if (was && was !== me) {
      let prev = null;
      try { prev = await fcmAdmin.auth().getUser(was); } catch (e) { prev = null; }   // deleted account: free to claim
      if (prev && prev.providerData && prev.providerData.length) return res.status(403).json({ ok: false, reason: 'owned-by-real-account' });
    }
    await adminDb.ref('gl/_devOwner/' + uid).set({ acct: me, ts: Date.now(), from: was || null });
    res.json({ ok: true, from: was || null });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/room/delete', rateLimit(10, 60000), requireUser, async function (req, res) {
  const room = String(((req.body || {}).room) || '').trim();
  if (!room || !/^[a-z0-9_-]{1,64}$/i.test(room) || room.charAt(0) === '_') {
    return res.status(400).json({ ok: false, reason: 'bad-room' });
  }
  let cfg = null;
  try { cfg = (await adminDb.ref('gl/' + room + '/config').get()).val(); } catch (e) {}
  const uid = req.authUid;
  const allowed = !!(cfg && (cfg.owner === uid || (cfg.admins && cfg.admins[uid])));
  if (!allowed) return res.status(403).json({ ok: false, reason: 'not-owner' });
  try {
    // Tombstone FIRST. If anything below fails, or a straggler device rebuilds the node a
    // second later, the marker is already in place and every client still treats the room as
    // gone. The other order leaves a window where the room is back and nothing says otherwise.
    await adminDb.ref('gl/_deadRooms/' + room).set({ ts: Date.now(), by: uid });
    await adminDb.ref('gl/' + room).remove();
    await adminDb.ref('glh/' + room).remove();
    await adminDb.ref('gl/_roomIndex/' + room).remove();
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'delete-failed' });
  }
  res.json({ ok: true, room: room });
});

app.post('/bump', rateLimit(30, 60000), requireUser, async function(req, res) {
  const uid = String((req.body || {}).uid || '');
  if (!(await sharesRoom(req.authUid, uid))) return res.status(403).json({ ok: false, reason: 'not-in-your-rooms' });
  res.json(await sendBump(uid));
});

// ─── KEEP-ALIVE SWEEP ────────────────────────────────────────────────────────────
// The missing half of "everyone just stays on the map". Background location works well while
// the app is alive — measured at ~200 fixes a day with sub-minute gaps — but phones stop, and
// until this nothing ever restarted them. /bump could revive a phone, yet it only ever fired
// when somebody manually tapped Refresh on one person's card.
//
// So: poke anyone who has gone quiet, the way Life360 does. A content-available push relaunches
// the app in the background, it takes one fix, writes it, and sleeps again.
//
// The thresholds are the whole design, so they are named rather than buried:
const WAKE_SWEEP_MS    = 2 * 60 * 1000;       // how often we look for quiet phones (was 5)
const WAKE_STALE_MS    = 15 * 60 * 1000;      // iPhone: quiet this long and we start poking
// ANDROID GETS CHASED FAST. Measured 2026-10-17 on a Samsung at 66 mph: the moment the app went
// to the background the WebView went dormant -- fixes, writes and diag all stopped in the same
// second -- while the headless service sat in STANDBY, because MainActivity only promotes it
// when the Activity is finished or destroyed, never when it is merely hidden. Until that is
// fixed natively, the server's bump is the only thing that activates the background writer,
// and it was waiting fifteen minutes to send it. Three minutes of silence from a phone that was
// reporting every ten seconds is already a certainty, not a guess. No push budget applies to
// Android high-priority data messages, so the cost of being wrong is one ignored push.
const WAKE_STALE_ANDROID_MS = 3 * 60 * 1000;
const WAKE_COOLDOWN_MS = 10 * 60 * 1000;      // iPhone: a recently-quiet phone, poke at most this often
const WAKE_COOLDOWN_ANDROID_MS = 4 * 60 * 1000;
// Two speeds, because one threshold cannot serve both cases. A phone quiet for twenty minutes
// is asleep and very likely to answer, so chase it hard. A phone quiet for days has probably
// been force-quit or has Background App Refresh off, and will most likely ignore us -- but
// "most likely" is not "certainly", and giving up entirely is how somebody stays off the map
// for a week. So keep trying, just slowly: an unanswered silent push costs essentially nothing.
const WAKE_SLOW_AFTER_MS   = 24 * 60 * 60 * 1000;  // past a day, drop to the slow lane
const WAKE_SLOW_COOLDOWN_MS = 60 * 60 * 1000;      // ...and try once an hour
const WAKE_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;   // a week of silence is uninstalled. Stop.
// iPhones get a background push budget: Apple's guidance is two or three an hour, and a phone
// that is sent more gets throttled — its pushes are then held back or dropped, including the
// one that mattered. Every 10 minutes was 6 an hour. iPhones (they report oss.iosVer) are poked
// at most every 20 minutes; Android has no such budget for high-priority data messages.
const WAKE_IOS_COOLDOWN_MS = 20 * 60 * 1000;
// An iPhone that can take a location push is woken by that instead, which Apple meters on its
// own and does not count against the background-push budget above. Jace chose 15 minutes of
// silence and at most one location push per 15 minutes (2026-11-14). locSubIds is refreshed
// at the start of each sweep, so the cooldown follows a token being filed or dropped.
const WAKE_IOS_LP_COOLDOWN_MS = 15 * 60 * 1000;
let locSubIds = new Set();
function _isIos(u) { return !!(u && u.oss && u.oss.iosVer); }
function _wakeCooldown(u, age, uid) {
  if (age > WAKE_SLOW_AFTER_MS) return WAKE_SLOW_COOLDOWN_MS;
  if (_isIos(u) && uid && LOCPUSH_ENABLED && locSubIds.has(uid)) return WAKE_IOS_LP_COOLDOWN_MS;
  return _isIos(u) ? WAKE_IOS_COOLDOWN_MS : WAKE_COOLDOWN_ANDROID_MS;
}
function _wakeStale(u) { return _isIos(u) ? WAKE_STALE_MS : WAKE_STALE_ANDROID_MS; }
const wakeLastSent = new Map();               // uid -> ts

// ─── WAKE OUTCOMES ──────────────────────────────────────────────────────────────
// The sweep used to send a poke and forget it. From outside, "no token", "the token works but
// the phone ignores it" and "the phone woke and reported" all looked the same: a device that
// goes quiet. Three phones with working tokens kept going dark for days and nobody could say
// which case each one was. So every poke is now remembered (wakePending) and judged on a later
// sweep, once the row has had time to move: the phone's own clocks on the row (fixTs, ts, hbTs)
// advanced past where they were when we poked -> answered; nothing moved for a whole cooldown
// -> ignored. The verdicts land at gl/_wake/<uid> with a bounded log, admin-only like the other
// gl/_* nodes, and are read by hand when a phone is in question. Nothing is loaded at boot: the
// record is write-mostly, and the counters are server-side increments so a restart does not
// zero them.
//
// Two decisions a reviewer will look for. (1) Clock skew: a phone's fixTs/ts is ITS clock and
// our poke time is OURS, so the test is not "fix newer than the poke" but "the row's own clock
// advanced since we poked" -- the same clock on both sides, immune to a phone running fast or
// slow. The one false positive that leaves is a self-initiated write already in flight when we
// poked (a window of milliseconds after a quiet spell of minutes), and that phone is alive and
// reporting anyway, which is the question. (2) A heartbeat counts. iOS 1.0.13 answers a wake
// with a fresh ts/hbTs and the ORIGINAL fixTs when it has no new position; that phone heard the
// push and woke, which is exactly what the poke asked for. Treating it as ignored would demote
// every parked iPhone to the hourly lane and starve it of the very pokes that keep it heard
// from. The log entry says whether a fix came with the answer (fix: true/false), so "alive but
// no GPS" is still visible. (3) One phone, several crews. The web rest beat is written to the
// open crew only, while a fix fans out to every crew and iOS writes every room, so a phone's
// rows do not agree with each other. The judge therefore compares the phone with ITSELF: the
// newest clock across all of its rows now, against the newest across all of them when we poked.
// A sibling row that was merely ahead at poke time cannot be read as an answer, and a fix that
// landed in only one crew still counts as one.
const WAKE_IGNORED_STREAK = 3;                // this many unanswered pokes in a row: the hourly lane
const WAKE_LOG_KEEP = 60;                     // judged pokes kept per device at gl/_wake/<uid>/log
// A parked web/Android row writes a liveness beat (ts, rest) every 4 minutes and nothing else
// (build 961). The sweep ages a row by fixTs, so that phone looked quiet and was bumped every
// cooldown for a GPS fix it had no reason to take. The beat is slower than Android's 3-minute
// stale window, so "honestly resting" has to allow a little more than one beat.
const WAKE_REST_BEAT_MS = 5 * 60 * 1000;
const wakePending = new Map();                // uid -> { at, fixTs, heard, name, age, ios }: pokes awaiting a verdict (heard/fixTs: newest across the phone's rows)
const wakeStreaks = new Map();                // uid -> consecutive ignored pokes (0 after any answer)
const wakeLogKeys = new Map();                // uid -> [ts, ...] of log entries we know about, oldest first

// The last moment the phone's own writes say it was alive. ts is refreshed by rest beats and
// heartbeats, fixTs only by a real fix, hbTs by every native iOS write.
function _heardAt(u) { return Math.max(u.fixTs || 0, u.ts || 0, u.hbTs || 0); }
function _wakeLaneOf(uid, age) {
  if ((wakeStreaks.get(uid) || 0) >= WAKE_IGNORED_STREAK) return 'ignored';
  return age > WAKE_SLOW_AFTER_MS ? 'slow' : 'normal';
}
// The cooldown the sweep actually waits: a phone that has provably ignored three pokes gets one
// an hour whatever its age -- those pushes were going nowhere, and on iOS they count against
// the budget of the phones that DO answer. One answer puts it back on the normal cadence.
function _wakeCooldownFor(uid, u, age) {
  return _wakeLaneOf(uid, age) === 'ignored' ? WAKE_SLOW_COOLDOWN_MS : _wakeCooldown(u, age, uid);
}
// One update() per event: the record fields, the new log entry and the prune of anything past
// WAKE_LOG_KEEP, all in the same write. The existing log keys are read once per device per
// process (first sighting, as authWatchJudge does) so the bound holds across restarts.
async function _wakeRecord(uid, at, fields, entry) {
  if (!adminDb) return;
  const path = 'gl/_wake/' + uid;
  try {
    const patch = Object.assign({}, fields);
    if (entry) {
      let keys = wakeLogKeys.get(uid);
      if (!keys) {
        let log = null;
        try { log = await _dbGet(path + '/log'); } catch (e) {}
        keys = Object.keys(log || {}).map(Number).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
        wakeLogKeys.set(uid, keys);
      }
      while (keys.indexOf(at) >= 0) at++;     // never land on an existing key
      keys.push(at);
      patch['log/' + at] = entry;
      while (keys.length > WAKE_LOG_KEEP) patch['log/' + keys.shift()] = null;
    }
    await adminDb.ref(path).update(patch);
  } catch (e) { console.error('wake record:', e.message); }
}
// Judge one pending poke against everything the phone has written since, in any crew. Returns
// 'answered', 'ignored', or null while it is too soon to say. `a` is the sweep's per-device
// summary { heard, fixTs, u }: the newest row clocks across every room the phone is in, and one
// of its rows for the platform. `age` is how quiet the sweep counts the phone as being now, the
// same figure the poke loop takes its lane from. Called once per device after the room walk --
// never per room -- so a phone in two crews gets one verdict and one write.
async function _wakeJudge(uid, a, now, age) {
  const p = wakePending.get(uid);
  if (!p) return null;
  let result, entry;
  if (a.heard > p.heard) {
    result = 'answered';
    wakeStreaks.set(uid, 0);
    // latencySec is the phone's clock minus ours; a negative value is a phone running behind.
    entry = { result: result, latencySec: Math.round((a.heard - p.at) / 1000), ageSec: Math.round(p.age / 1000),
              fix: a.fixTs > p.fixTs };   // false: woke and heartbeat, no new position
    if (a.oss && a.oss.iosVer) { entry.auth = _authWord(a.oss); entry.ossAt = a.oss.at || 0; }
  } else if (now - p.at >= _wakeCooldown(a.u, p.age, uid)) {
    result = 'ignored';
    wakeStreaks.set(uid, (wakeStreaks.get(uid) || 0) + 1);
    entry = { result: result, ageSec: Math.round(p.age / 1000) };
  } else return null;
  wakePending.delete(uid);
  const fields = { streak: wakeStreaks.get(uid), lane: _wakeLaneOf(uid, age), lastJudgedAt: now };
  fields[result] = fcmAdmin.database.ServerValue.increment(1);
  if (result === 'answered') fields.lastAnsweredAt = now;
  await _wakeRecord(uid, now, fields, entry);
  return result;
}

// Tell the REST of the Crew when someone's background sharing breaks.
//
// The person it happens to is the one least able to notice. iOS asks, periodically, whether an
// app may keep using location in the background and offers "Keep Only While Using"; answering
// that silently downgrades the permission. From their side they dismissed a popup. They are not
// looking at the map, so they never see themselves go missing -- in the case that prompted this,
// two days passed before anyone worked out what had happened. The people who DO notice, and who
// actually go and fix it, are the others in the Crew.
//
// Server-side on purpose: a phone that has just lost background permission cannot be relied on
// to announce it, and may not run again for hours.
const SHARE_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// How current a settings snapshot has to be before it is worth waking the Crew over. A phone
// that has not spoken in days is dormant, not broken, and its last known settings say nothing
// about now -- a dormant row was about to send everyone an alert about a week-old reading.
const SHARE_STATE_FRESH_MS = 2 * 60 * 60 * 1000;

function _shareBroken(u) {
  const o = (u && u.oss) || {};
  if (!o.iosVer) return '';                                  // Android does not have this failure
  if (!o.at || (Date.now() - o.at) > SHARE_STATE_FRESH_MS) return '';
  if (o.locDenied) return 'turned location off for GroundLink';
  if (o.locWhenInUse && !o.locAlways) {
    return o.authDowns > 0
      ? 'iPhone set their location back to "While Using"'
      : 'location is set to "While Using" instead of "Always"';
  }
  return '';
}

// 1092: "Someone stops sharing" and "battery is low" are opt-in (Jace, 2026-11-25: people
// complained about the pop-ups). Send them only to a device whose prefs turned them ON;
// every other type stays opt-out as before.
const OPTIN_TYPES = { crew: 1, battlow: 1 };
function _prefBlocks(type, pf) {
  if (type === 'sos') return false;
  if (OPTIN_TYPES[type]) return !(pf && (pf[type] === 1 || pf[type] === true));
  return !!(pf && (pf[type] === 0 || pf[type] === false));
}
async function _alertCrew(room, aboutUid, aboutName, reason) {
  let subs = null;
  try { subs = await _dbGet('gl/' + room + '/pushSubs'); } catch (e) { return 0; }
  if (!subs) return 0;
  const title = aboutName + ' stopped sharing';
  // Say how to switch these off, in the alert itself. Someone who does not want them should not
  // have to go hunting through Settings to find out whether it is even possible, and an alert
  // with no off switch in sight is the kind people silence at the operating system level --
  // which would also silence the ones that matter.
  const body = aboutName + ' is off the map. ' + reason + '. They need to set location back to '
             + 'Always. You can turn these alerts off in GroundLink Settings, under Notifications.';
  let sent = 0;
  for (const [uid, rec] of Object.entries(subs)) {
    if (uid === aboutUid || !rec) continue;                  // never tell them about themselves
    // Same per-type preference every other notification obeys, under the key 'crew'.
    if (_prefBlocks('crew', rec.prefs)) continue;
    try {
      if (fcmAdmin && rec.fcm) {
        await fcmAdmin.messaging().send({
          token: rec.fcm,
          notification: { title: title, body: body },
          data: { type: 'info', url: '/' },
          android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink' } },
          apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } }
        });
        sent++;
      } else if (pushReady && rec.sub) {
        await webpush.sendNotification(JSON.parse(rec.sub),
          JSON.stringify({ title: title, body: body, url: '/' }), { TTL: 3600, urgency: 'high' });
        sent++;
      }
    } catch (e) {}
  }
  return sent;
}

// Fires on the TRANSITION into a broken state, not on the state itself, so a phone that stays
// wrong is reported once rather than every sweep. The cooldown covers a setting that flaps.
async function shareWatchPass(room, users) {
  for (const [uid, u] of Object.entries(users || {})) {
    if (!u || !u.name) continue;
    const reason = _shareBroken(u);
    const path = 'gl/_shareState/' + room + '/' + uid;
    let prev = null;
    try { prev = await _dbGet(path); } catch (e) { continue; }
    const wasBroken = !!(prev && prev.broken);
    if (!reason) {
      if (wasBroken) { try { await _dbSet(path, { broken: false, at: Date.now() }); } catch (e) {} }
      continue;
    }
    const lastAlert = (prev && prev.alertedAt) || 0;
    if (wasBroken || (Date.now() - lastAlert) < SHARE_ALERT_COOLDOWN_MS) {
      if (!wasBroken) { try { await _dbSet(path, { broken: true, at: Date.now(), alertedAt: lastAlert }); } catch (e) {} }
      continue;
    }
    const sent = await _alertCrew(room, uid, u.name, reason);
    try { await _dbSet(path, { broken: true, at: Date.now(), alertedAt: Date.now(), reason: reason }); } catch (e) {}
    if (sent) console.log('share-watch: ' + u.name + ' in ' + room + ' -- ' + reason + ' -- told ' + sent + ' crew member(s)');
  }
}

// uid -> last authorization string we saw, so a change is detected without re-reading.
const authSeen = new Map();

function _authWord(oss) {
  if (!oss || !oss.iosVer) return '';                 // Android/PC: no such setting
  if (oss.locDenied) return 'denied';
  if (oss.locAlways) return 'always';
  if (oss.locWhenInUse) return 'whenInUse';
  return 'none';
}

// Collected across the WHOLE sweep, then judged once per device -- see the note below.
const authSweep = new Map();   // uid -> { word, u, room, at }

function authWatchCollect(room, users) {
  for (const [uid, u] of Object.entries(users || {})) {
    const word = _authWord(u && u.oss);
    if (!word) continue;
    // The freshest row wins. oss.at is when the phone last reported its settings; a row in a
    // crew the person has not opened in a week says nothing about their settings today.
    const at = (u.oss && u.oss.at) || u.fixTs || u.ts || 0;
    const cur = authSweep.get(uid);
    if (!cur || at > cur.at) authSweep.set(uid, { word, u, room, at });
  }
}

async function authWatchJudge() {
  for (const [uid, rec] of authSweep) {
    const word = rec.word, u = rec.u, room = rec.room;
    const path = 'gl/_authLog/' + uid;
    let prev = authSeen.get(uid);
    if (prev === undefined) {
      // First sighting this process: read the stored value so a restart does not log a
      // phantom change (the exact failure mode of the in-app counter).
      try { const rec = await _dbGet(path + '/now'); prev = rec || null; } catch (e) { prev = null; }
    }
    if (prev === word) continue;
    authSeen.set(uid, word);
    const at = Date.now();
    try {
      await adminDb.ref(path).update({ now: word, at: at, name: (u.name || ''), ios: u.oss.iosVer || '' });
      // The history is what answers "how often, and when". Keyed by time so it sorts itself.
      await adminDb.ref(path + '/log/' + at).set({
        from: prev || '?', to: word, ios: u.oss.iosVer || '', bgRefresh: !!u.oss.bgRefresh,
        lowPower: !!u.oss.lowPower, precise: !!u.oss.precise, batt: (u.oss.batt ?? null), room: room,
        // WHEN the phone actually reported these settings, and how old that was when we read
        // it. Two writers share this row -- the native layer stamps a LIVE reading, the
        // WebView rides along a cached one it may have restored from localStorage up to seven
        // days old -- so a "change" that is really the stale copy landing on top is only
        // distinguishable by this. J-Rod's 277 logged flips on 2026-10-20..22 are that.
        ossAt: (u.oss.at || 0),
        ossAgeSec: (u.oss.at ? Math.round((Date.now() - u.oss.at) / 1000) : -1),
      });
      console.log('auth-watch: ' + (u.name || uid.slice(0, 8)) + ' ' + (prev || '?') + ' -> ' + word);
    } catch (e) {}
  }
  authSweep.clear();
}

async function keepAliveSweep() {
  if (!fcmAdmin || !adminDb) return;
  let rooms;
  try { rooms = await _roomNames(); } catch (e) { console.error('keep-alive: no room list —', e.message); return; }
  const now = Date.now();
  // Which iPhones can take a location push (their cooldown is 15 minutes, not 20).
  try { locSubIds = new Set(Object.keys((await _dbGet('gl/_locSubs')) || {})); } catch (e) {}
  // A phone is one thing however many crews it is in, so the walk only collects and the wake
  // decisions come after it, once per device. alive: the phone's newest clocks across EVERY row
  // it has, fresh or stale -- what the judge compares (WAKE OUTCOMES, point 3). targets: the
  // youngest row worth a poke per phone, which sets its cadence (see below). restSkipped:
  // devices alive-and-parked in some crew, left alone this sweep (see WAKE_REST_BEAT_MS).
  const alive = new Map();     // uid -> { heard, fixTs, u }
  const targets = new Map();   // uid -> { name, age, u }
  const restSkipped = new Set();
  let poked = 0, answered = 0, ignored = 0;
  // Uptime: one sample per person per sweep, "current" meaning a position under 15 minutes old.
  // Until this existed there was no honest answer to "is anyone actually on the map": the only
  // time series was trail history, which records movement and so misses everyone sitting still.
  const seen = new Map();      // uid -> { name, fresh }

  for (const room of rooms) {
    let cfg = null, users = null;
    try { cfg = await _dbGet('gl/' + room + '/config'); } catch (e) { continue; }
    // Crews only. A Crew is a standing relationship — "always show me these people" — which is
    // the only thing that justifies waking someone's phone on a timer. A quick-join room is not.
    if (!cfg || !cfg.circle) continue;
    try { users = await _dbGet('gl/' + room + '/users'); } catch (e) { continue; }
    try { await shareWatchPass(room, users); } catch (e) {}
    try { authWatchCollect(room, users); } catch (e) {}
    for (const [uid, u] of Object.entries(users || {})) {
      if (!u || !u.name) continue;
      if (typeof u.lat !== 'number' && typeof u.lng !== 'number') continue;  // never reported at all
      const age = now - (u.fixTs || u.ts || 0);
      const was = seen.get(uid);
      // Battery, as the phone last reported it (web/Android put it on the row, iPhones in oss).
      const batt = (typeof u.batt === 'number') ? u.batt : (u.oss && typeof u.oss.batt === 'number' ? u.oss.batt : null);
      const chg = (u.chg === 1) || !!(u.oss && u.oss.charging);
      if (!was || age < 15 * 60 * 1000) seen.set(uid, { name: u.name, fresh: (was && was.fresh) || age < 15 * 60 * 1000, batt: batt, chg: chg, battAt: (u.fixTs || u.ts || 0) });
      // Every row counts toward "when was this phone last heard from", stale ones included.
      const a = alive.get(uid) || { heard: 0, fixTs: 0, u: u };
      a.heard = Math.max(a.heard, _heardAt(u));
      a.fixTs = Math.max(a.fixTs, u.fixTs || u.ts || 0);
      // The freshest settings report across the phone's rows, so a wake verdict can say what the
      // location permission was when the phone answered (pins an Always -> While Using flip
      // between two wakes; Laura's phone, 2026-11-20).
      if (u.oss && (!a.oss || (u.oss.at || 0) > (a.oss.at || 0))) a.oss = u.oss;
      alive.set(uid, a);
      if (age < _wakeStale(u) || age > WAKE_GIVE_UP_MS) continue;
      // An honest rest beat inside its window: the phone is alive and parked, and a GPS fix would
      // change nothing on the map. Counted, not recorded -- there is nothing to learn about it.
      if (u.rest && (now - (u.ts || 0)) < Math.max(_wakeStale(u), WAKE_REST_BEAT_MS)) { restSkipped.add(uid); continue; }
      // The youngest row worth a poke speaks for the phone. A row left behind in a crew the phone
      // no longer opens can sit a day or more behind the one it still writes to, and before this
      // record existed the cooldown was tested row by row, so the live row's cadence always won.
      // It has to keep winning: first-room-wins would let a long-dead crew that happens to sort
      // first put a phone that is minutes quiet on the hourly lane.
      const t = targets.get(uid);
      if (!t || age < t.age) targets.set(uid, { name: u.name, age: age, u: u });
    }
  }

  // Every room has been walked; now decide, once per device, from its freshest row.
  try { await authWatchJudge(); } catch (e) {}

  // Resting in the open crew is resting. The beat is written to that one room, so the phone's
  // other rows still show the pre-rest fix and, on their own, would get it bumped anyway.
  for (const uid of restSkipped) targets.delete(uid);
  // The lane a record shows is the one the poke loop goes by: the age of the phone's youngest
  // row worth a poke while it has one, its newest fix once it does not. Measured any other way,
  // the verdict and the poke record could name different lanes for the same phone.
  const laneAge = function (uid, a) { const t = targets.get(uid); return t ? t.age : now - a.fixTs; };

  // Settle last sweep's pokes before this sweep's cooldowns are read, so a third ignored poke
  // puts the phone on the hourly lane now, not one poke late.
  for (const [uid] of wakePending) {
    const a = alive.get(uid);
    if (!a) continue;   // on no crew this sweep; the prune below drops it in time
    const verdict = await _wakeJudge(uid, a, now, laneAge(uid, a));
    if (verdict === 'answered') answered++; else if (verdict === 'ignored') ignored++;
  }
  // A phone heard from inside its stale window with no poke outstanding is alive, whatever it
  // ignored while it was dead or out of signal. Without this the 'ignored' lane outlived the
  // outage: the phone came back, was never poked (it was fresh), so nothing ever reset the
  // streak, and its NEXT quiet spell started on the hourly cadence -- a child's phone that dies
  // every evening would have been chased an hour late the following day.
  for (const [uid, a] of alive) {
    if (wakePending.has(uid) || !(wakeStreaks.get(uid) > 0) || now - a.heard >= _wakeStale(a.u)) continue;
    wakeStreaks.set(uid, 0);
    await _wakeRecord(uid, now, { streak: 0, lane: _wakeLaneOf(uid, laneAge(uid, a)) }, null);
  }

  for (const [uid, t] of targets) {
    if (now - (wakeLastSent.get(uid) || 0) < _wakeCooldownFor(uid, t.u, t.age)) continue;
    const a = alive.get(uid), ios = _isIos(t.u);
    poked++;
    wakeLastSent.set(uid, now);   // stamp before sending: a failure should still respect the cooldown
    const r = await sendBump(uid);
    const reason = r.ok ? 'sent' : String(r.reason || 'failed');
    const rec = { name: t.name, ios: ios, lane: _wakeLaneOf(uid, t.age), lastPokeAt: now, lastPokeFixTs: a.fixTs,
                  pokes: fcmAdmin.database.ServerValue.increment(1), lastResult: reason };
    if (r.ok) {
      wakePending.set(uid, { at: now, fixTs: a.fixTs, heard: a.heard, name: t.name, age: t.age, ios: ios });
      await _wakeRecord(uid, now, rec, null);
    } else {
      console.log('keep-alive: ' + t.name + ' (' + uid.slice(0, 8) + ') not woken — ' + reason);
      // Nothing to wait for: the push never left. Judged on the spot.
      rec.failed = fcmAdmin.database.ServerValue.increment(1);
      await _wakeRecord(uid, now, rec, { result: 'failed', reason: reason, ageSec: Math.round(t.age / 1000) });
    }
  }
  if (poked || answered || ignored || restSkipped.size) {
    console.log('keep-alive: poked ' + poked + ', answered ' + answered + ', ignored ' + ignored
                + ', resting-skipped ' + restSkipped.size);
  }

  // Clear out identities a reinstall left behind (see pruneSupersededDevices).
  try { await pruneSupersededDevices(); } catch (e) { console.error('prune:', e.message); }

  // Don't let the cooldown map grow forever.
  for (const [uid, t] of wakeLastSent) {
    if (now - t > WAKE_GIVE_UP_MS) { wakeLastSent.delete(uid); wakeStreaks.delete(uid); wakeLogKeys.delete(uid); }
  }
  for (const [uid, p] of wakePending) if (now - p.at > 2 * WAKE_SLOW_COOLDOWN_MS) wakePending.delete(uid);

  // Record the uptime samples: gl/_uptime/<day>/<uid> = { name, samples, fresh }.
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    for (const [uid, v] of seen) {
      await adminDb.ref('gl/_uptime/' + day + '/' + uid).transaction(function (cur) {
        cur = cur || { name: v.name, samples: 0, fresh: 0 };
        cur.name = v.name;
        cur.samples = (cur.samples || 0) + 1;
        if (v.fresh) cur.fresh = (cur.fresh || 0) + 1;
        // Battery series: one point per sweep when the phone has reported a level, so
        // "is GroundLink draining phones" is answered with a number (tools/battery-drain.mjs).
        if (v.batt != null) {
          const b = Array.isArray(cur.batt) ? cur.batt : [];
          const last = b[b.length - 1];
          if (!last || last.at !== v.battAt) b.push({ t: now, at: v.battAt, b: v.batt, c: v.chg ? 1 : 0 });
          cur.batt = b.slice(-300);
        }
        return cur;
      });
    }
  } catch (e) { console.error('uptime sample:', e.message); }
}
setInterval(function () { keepAliveSweep().catch(function (e) { console.error('keep-alive:', e.message); }); },
            WAKE_SWEEP_MS).unref();
// One pass shortly after boot, so a restart doesn't leave everyone stale for five minutes.
setTimeout(function () { keepAliveSweep().catch(function () {}); }, 30000).unref();

// ─── SUPERSEDED DEVICES ──────────────────────────────────────────────────────────
// Reinstalling gives a phone a brand-new device id, so its previous identity keeps its last
// position and sits on the map as a second, frozen copy of the same person. That happened on
// every reinstall this week and someone had to ask for each one to be cleared by hand.
//
// A row is superseded when the SAME account has another row with the SAME device label
// (phone / tablet / PC) that is live right now: one physical device cannot be in two places.
// Both halves of that test matter — without the device label a tablet that has been switched
// off for a day would be deleted because its owner's phone is active.
//
// Everything removed is copied to gl/_pruned/<day>/<uid> first, so a wrong call is recoverable.
const PRUNE_KEEPER_FRESH_MS = 30 * 60 * 1000;      // the survivor has to be genuinely active
const PRUNE_LOSER_STALE_MS = 2 * 60 * 60 * 1000;   // ...and the ghost quiet at least this long

async function pruneSupersededDevices() {
  if (!adminDb) return;
  const now = Date.now();
  let rooms;
  try { rooms = await _roomNames(); } catch (e) { return; }
  const own = (await _cachedGet('gl/_devOwner', 60000)) || {};

  // uid -> { name, dev, newest, rooms:Set }
  const seen = new Map();
  for (const room of rooms) {
    let users = null;
    try { users = await _dbGet('gl/' + room + '/users'); } catch (e) { continue; }
    for (const [uid, u] of Object.entries(users || {})) {
      if (!u || !u.name) continue;
      const ts = u.fixTs || u.ts || 0;
      const e = seen.get(uid) || { name: u.name, dev: u.dev || '', newest: 0, rooms: new Set() };
      if (u.dev && !e.dev) e.dev = u.dev;
      if (ts > e.newest) e.newest = ts;
      e.rooms.add(room);
      seen.set(uid, e);
    }
  }

  // Group by who owns it and what kind of device it is.
  const groups = new Map();
  for (const [uid, e] of seen) {
    const acct = own[uid] && own[uid].acct;
    const key = (acct ? 'a:' + acct : 'n:' + String(e.name).trim().toLowerCase()) + '|' + (e.dev || '');
    const g = groups.get(key) || [];
    g.push({ uid, ...e });
    groups.set(key, g);
  }

  const doomed = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.newest - a.newest);
    const keeper = list[0];
    if (now - keeper.newest > PRUNE_KEEPER_FRESH_MS) continue;      // nothing here is live; leave it alone
    for (const loser of list.slice(1)) {
      if (now - loser.newest < PRUNE_LOSER_STALE_MS) continue;      // still recently active — not a ghost
      doomed.push({ loser, keeper });
    }
  }
  if (!doomed.length) return;

  const day = new Date(now).toISOString().slice(0, 10);
  for (const { loser, keeper } of doomed) {
    for (const room of loser.rooms) {
      // Only where the keeper has a row of its own. Deleting the loser anywhere else removes
      // the person from that room entirely -- the one outcome a "duplicate" tidy must never
      // produce. Same guard the roster branch below has always had.
      if (!keeper.rooms.has(room)) {
        console.log('prune: keeping ' + loser.name + ' (' + loser.uid.slice(0, 8) + ') in ' + room +
                    ' -- keeper ' + keeper.uid.slice(0, 8) + ' has no row there');
        continue;
      }
      try {
        const row = await _dbGet('gl/' + room + '/users/' + loser.uid);
        if (!row) continue;
        await adminDb.ref('gl/_pruned/' + day + '/' + loser.uid + '/' + room).set({
          row: row, supersededBy: keeper.uid, at: now
        });
        await adminDb.ref('gl/' + room + '/users/' + loser.uid).remove();
        // The roster entry too, but only where the survivor is already on it — otherwise this
        // would quietly drop the person out of the Crew instead of tidying a duplicate.
        const roster = await _dbGet('gl/' + room + '/members');
        if (roster && roster[loser.uid] && roster[keeper.uid]) {
          await adminDb.ref('gl/_pruned/' + day + '/' + loser.uid + '/' + room + '/member').set(roster[loser.uid]);
          await adminDb.ref('gl/' + room + '/members/' + loser.uid).remove();
        }
      } catch (e) { console.error('prune: ' + loser.uid.slice(0, 8) + ' in ' + room + ' —', e.message); }
    }
    console.log('prune: removed ' + loser.name + ' (' + loser.dev + ', ' + loser.uid.slice(0, 8) +
                ', quiet ' + Math.round((now - loser.newest) / 3600000) + 'h) — superseded by ' + keeper.uid.slice(0, 8));
  }
}

// ─── RETENTION ───────────────────────────────────────────────────────────────────
// Logs grew forever; nothing trimmed them. Once a day, drop what is past its use:
const KEEP_ACTIVITY_DAYS = 60;   // gl/_activityLog/<day>   who opened the app
const KEEP_UPTIME_DAYS   = 90;   // gl/_uptime/<day>        keep-alive health samples
const KEEP_SESSION_DAYS  = 60;   // gl/_sessions/<sid>      by last activity (l)
// Trails: the app promises "kept 30 days" (Settings → Keep my trail), but nothing ever deleted
// glh/<crew>/<uid>/<date>. Report-only until PRUNE_TRAILS is switched on, because deleting
// location history cannot be undone.
const KEEP_TRAIL_DAYS = 30;
const PRUNE_TRAILS = process.env.GL_PRUNE_TRAILS === '1';

async function _shallowKeys(path) {
  const v = await adminDb.ref(path).once('value');   // small nodes only (day keys, ids)
  return Object.keys(v.val() || {});
}
async function retentionPass() {
  if (!adminDb) return;
  const now = Date.now();
  const dayCut = function (days) { return new Date(now - days * 86400000).toISOString().slice(0, 10); };
  let removed = 0;
  // Day-keyed logs: keys are yyyy-mm-dd, so a string compare is a date compare.
  for (const [path, days] of [['gl/_activityLog', KEEP_ACTIVITY_DAYS], ['gl/_uptime', KEEP_UPTIME_DAYS]]) {
    const cut = dayCut(days);
    const snap = await adminDb.ref(path).orderByKey().endAt(cut).once('value');
    for (const day of Object.keys(snap.val() || {})) {
      if (day < cut) { await adminDb.ref(path + '/' + day).remove(); removed++; }
    }
  }
  const sessCut = now - KEEP_SESSION_DAYS * 86400000;
  const sess = (await adminDb.ref('gl/_sessions').once('value')).val() || {};
  for (const [sid, s] of Object.entries(sess)) {
    const last = (s && (s.l || s.j)) || 0;
    if (last && last < sessCut) { await adminDb.ref('gl/_sessions/' + sid).remove(); removed++; }
  }
  // Trails — per-day keys under each member; read keys only, via the REST shallow listing,
  // since the full tree is tens of megabytes.
  const trailCut = dayCut(KEEP_TRAIL_DAYS);
  let trailDays = 0;
  try {
    const tok = (await fcmAdmin.app().options.credential.getAccessToken()).access_token;
    const shallow = async function (p) {
      const r = await fetch(DB_URL + '/' + p + '.json?shallow=true&access_token=' + tok);
      return Object.keys((await r.json()) || {});
    };
    for (const crew of await shallow('glh')) {
      for (const uid of await shallow('glh/' + crew)) {
        for (const day of await shallow('glh/' + crew + '/' + uid)) {
          if (day >= trailCut) continue;
          trailDays++;
          if (PRUNE_TRAILS) await adminDb.ref('glh/' + crew + '/' + uid + '/' + day).remove();
        }
      }
    }
  } catch (e) { console.error('retention: trail scan —', e.message); }
  console.log('retention: removed ' + removed + ' old log entries; ' + trailDays + ' trail day(s) older than ' +
              KEEP_TRAIL_DAYS + ' days ' + (PRUNE_TRAILS ? 'deleted' : 'found (report-only; set GL_PRUNE_TRAILS=1 to delete)'));
}
setInterval(function () { retentionPass().catch(function (e) { console.error('retention:', e.message); }); },
            24 * 60 * 60 * 1000).unref();
setTimeout(function () { retentionPass().catch(function (e) { console.error('retention:', e.message); }); }, 5 * 60 * 1000).unref();

// Freshen a whole Crew at once — what the app calls when you open a map and start looking at
// people. Life360's dots update "right when you look" because something exactly like this runs.
app.post('/freshen', rateLimit(20, 60000), requireUser, async function(req, res) {
  const room = String((req.body || {}).room || '');
  if (!room || room.charAt(0) === '_') return res.json({ ok: false, reason: 'no-room' });
  if (!(await roomAccess(room, req.authUid))) return res.status(403).json({ ok: false, reason: 'not-a-member' });
  let users = null;
  try { users = await _dbGet('gl/' + room + '/users'); } catch (e) { return res.json({ ok: false, reason: 'unreadable' }); }
  const now = Date.now();
  let poked = 0;
  for (const [uid, u] of Object.entries(users || {})) {
    if (!u || !u.name) continue;
    const age = now - (u.fixTs || u.ts || 0);
    if (age < WAKE_STALE_MS || age > WAKE_GIVE_UP_MS) continue;
    // You are looking at this map right now, so chase even the long-quiet ones at full speed —
    // except an iPhone's push budget still applies (see WAKE_IOS_COOLDOWN_MS).
    if (now - (wakeLastSent.get(uid) || 0) < ((u.oss && u.oss.iosVer) ? WAKE_IOS_COOLDOWN_MS : WAKE_COOLDOWN_MS)) continue;
    wakeLastSent.set(uid, now);
    const r = await sendBump(uid);
    if (r.ok) poked++;
  }
  res.json({ ok: true, poked: poked });
});

// Loud fallback: a VISIBLE notification asking the person to reopen the app — for the one
// state no push can silently recover, a user force-quit. Sent deliberately by a member from
// a stale dot's card, never automatically.
app.post('/nudge', rateLimit(10, 60000), requireUser, async function(req, res) {
  const uid = String((req.body || {}).uid || '');
  if (!(await sharesRoom(req.authUid, uid))) return res.status(403).json({ ok: false, reason: 'not-in-your-rooms' });
  const fromName = String((req.body || {}).fromName || 'Someone');
  if (!uid) return res.json({ ok: false, reason: 'no-uid' });
  const rec = await findSubsForUid(uid);
  if (!rec) return res.json({ ok: false, reason: 'no-subscription' });
  const title = 'GroundLink stopped sharing';
  const body = fromName + " can't see your location — open GroundLink to start sharing again.";
  let sent = false;
  if (fcmAdmin && rec.fcm) {
    try {
      await fcmAdmin.messaging().send({
        token: rec.fcm,
        notification: { title: title, body: body },
        android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink' } },
        apns: { payload: { aps: { sound: 'default' } } }
      });
      sent = true;
    } catch (e) {}
  }
  if (!sent && pushReady && rec.sub) {
    try {
      await webpush.sendNotification(JSON.parse(rec.sub), JSON.stringify({ title: title, body: body, url: '/' }), { TTL: 3600, urgency: 'high' });
      sent = true;
    } catch (e) {}
  }
  res.json({ ok: sent, reason: sent ? undefined : 'send-failed' });
});

// Tell someone they've been invited. In-app invites are written straight to Firebase, which
// is silent by design — if the recipient doesn't have the app open (or is inside a room, or
// never returns to the home screen where the invite card lives) they learn about it never.
// Reported 2026-08-01: invites landing correctly and going unseen for days.
//
// Best-effort by design: the invite itself is already committed to the DB before this is
// called, so a push failure costs a notification, not the invite.
app.post('/invitePush', rateLimit(20, 60000), requireUser, async function(req, res) {
  const b = req.body || {};
  { const _r = String(b.room || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/__+/g, '_');
    if (_r && !(await roomAccess(_r, req.authUid))) return res.status(403).json({ ok: false, reason: 'not-a-member' }); }
  const fromName = String(b.fromName || 'Someone').slice(0, 60);
  const room = String(b.room || '').slice(0, 60);
  const crew = !!b.crew;
  // 1013: the room key rides along so tapping the notification opens THIS invite's Accept prompt.
  const invKey = String(b.key || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  // Both the device uid and the account uid — the caller fans out to both inboxes, and we
  // don't know which of the two (if either) actually carries a push subscription.
  const uids = Array.isArray(b.uids) ? b.uids.slice(0, 4).map(u => String(u || '')).filter(Boolean) : [];
  if (!uids.length) return res.json({ ok: false, reason: 'no-uid' });

  const title = crew ? 'Invitation to join a Crew' : 'GroundLink invitation';
  const body = room
    ? fromName + ' invited you to ' + (crew ? 'the Crew "' + room + '"' : '"' + room + '"') + ' — open GroundLink to join.'
    : fromName + ' invited you to GroundLink — open the app to join.';

  // 1018: also deliver the invite to the account actually SIGNED IN on that phone. The sender
  // addresses the phone's device id and the device's registered owner account, but a phone can
  // be signed in to a different account (Tyler: device registered to one account, signed in as
  // another), and the inbox rule only lets you read inboxes of the account you are signed in as
  // -- so every invite was invisible to him: no card, and a notification tap found nothing.
  // The phone's own push sign-up (/push/register, /locpush/register) records that account.
  if (adminDb && invKey) {
    const rec = { key: invKey, room: room, fromName: fromName, ts: Date.now() };
    if (crew) rec.circle = true;
    if (b.from) rec.from = String(b.from).slice(0, 64);
    try { const ik = (await adminDb.ref('gl/' + invKey + '/config/inviteKey').get()).val(); if (typeof ik === 'string') rec.ik = ik; } catch (e) {}
    const extra = new Set();
    for (const uid of uids) {
      for (const node of ['_pushTokens', '_locSubs']) {
        try { const a = (await adminDb.ref('gl/' + node + '/' + uid + '/authUid').get()).val(); if (a && uids.indexOf(a) < 0) extra.add(a); } catch (e) {}
      }
    }
    for (const a of extra) { try { await adminDb.ref('gl/_invites/' + a).push(rec); } catch (e) {} }
  }

  let sent = false;
  const seen = new Set();
  for (const uid of uids) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    let rec = null;
    try { rec = await findSubsForUid(uid); } catch (e) {}
    if (!rec) continue;
    if (fcmAdmin && rec.fcm) {
      try {
        await fcmAdmin.messaging().send({
          token: rec.fcm,
          notification: { title: title, body: body },
          data: { type: 'invite', invKey: invKey, crew: crew ? '1' : '0' },
          android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink' } },
          apns: { payload: { aps: { sound: 'default' } } }
        });
        sent = true;
        continue;   // this identity is covered; don't double-notify the same handset via webpush
      } catch (e) {}
    }
    if (pushReady && rec.sub) {
      try {
        await webpush.sendNotification(JSON.parse(rec.sub), JSON.stringify({ title: title, body: body, url: '/' }), { TTL: 86400, urgency: 'high' });
        sent = true;
      } catch (e) {}
    }
  }
  // 1095: also ring every phone that is signed in to the invited ACCOUNT. The sender picks one
  // device id -- often an old phone (Gary, 2026-11-27: invited on his old phone's id while he was
  // setting up a new one, so nothing rang). A push address's authUid is written by the server from
  // a verified sign-in, so it can't be claimed for someone else's account; _devOwner can't be
  // trusted that way and is not used here. The notification carries no invite key.
  if (fcmAdmin) {
    try {
      const toks = (await _cachedGet('gl/_pushTokens', 60000)) || {};
      const fcmSeen = new Set();
      for (const [dev, t] of Object.entries(toks)) {
        if (!t || !t.fcm || seen.has(dev) || fcmSeen.has(t.fcm) || uids.indexOf(t.authUid) < 0) continue;
        if (Date.now() - (t.ts || 0) > 60 * 86400000) continue;
        fcmSeen.add(t.fcm);
        try {
          await fcmAdmin.messaging().send({
            token: t.fcm,
            notification: { title: title, body: body },
            data: { type: 'invite', invKey: invKey, crew: crew ? '1' : '0' },
            android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink' } },
            apns: { payload: { aps: { sound: 'default' } } }
          });
          sent = true;
        } catch (e) {}
      }
    } catch (e) {}
  }
  res.json({ ok: sent, reason: sent ? undefined : 'no-subscription' });
});

// Push to SPECIFIC people rather than fanning out to a whole group. /push broadcasts to
// everyone in the room, which is wrong for a one-to-one call: starting a private channel with
// one person shouldn't buzz the entire crew.
//
// Voice needed this because the invite itself is a Firebase listener scoped to
// gl/<room>/voice/<uid> — it only fires while the recipient's app is OPEN and in that room.
// Their dot stays live from the native background service either way, so a closed app looked
// identical to an ignored call: the caller sat on "waiting for others…" forever with no way to
// reach them. Reported 2026-08-05.
// Ask to join a crew you are not in yet (988). The app used to write the request itself and then
// push the owner through /pushTo -- but someone outside a crew cannot read who owns it, and
// /pushTo refuses anyone who does not share a room with the target, so the owner was never told.
// Reported 2026-11-01: Jax asked to join our_crew and nothing arrived. Here the server records
// the request (it is the caller's own uid, so it proves nothing beyond "this person asked") and
// notifies every device belonging to the owner and the admins.
app.post('/joinAsk', rateLimit(10, 60000), requireUser, async function (req, res) {
  try {
    const b = req.body || {};
    const room = String(b.room || '').toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(room)) return res.status(400).json({ ok: false, reason: 'bad-room' });
    const cfg = await _dbGet('gl/' + room + '/config');
    if (!cfg || !cfg.owner) return res.status(404).json({ ok: false, reason: 'no-room' });
    const acl = await _dbGet('gl/' + room + '/acl/' + req.authUid);
    if (acl) return res.json({ ok: true, already: true });
    const prev = await _dbGet('gl/' + room + '/joinReq/' + req.authUid);
    const name = String(b.name || 'Someone').slice(0, 40);
    await _dbSet('gl/' + room + '/joinReq/' + req.authUid, { name: name, ts: Date.now() });
    // One notification per person per two minutes, however many times they tap.
    if (prev && prev.ts && Date.now() - prev.ts < 120000) return res.json({ ok: true, notified: 0 });
    // Everyone who can approve, and every device they own.
    const managers = [cfg.owner].concat(Object.keys(cfg.admins || {}));
    const targets = new Set(managers);
    try {
      const own = await _cachedGet('gl/_devOwner', 60000) || {};
      for (const dev of Object.keys(own)) if (own[dev] && managers.indexOf(own[dev].acct) !== -1) targets.add(dev);
    } catch (e) {}
    const crew = String(cfg.name || room).replace(/_/g, ' ');
    const title = name + ' wants to join ' + crew;
    const body = 'Tap to let them in.';
    const url = '/?room=' + encodeURIComponent(room) + '&joinreq=1';
    let rooms = [];
    try { rooms = await _roomNames(); } catch (e) {}
    const seen = new Set();
    let sent = 0;
    for (const uid of targets) {
      for (const r of rooms) {
        for (const branch of ['pushSubs', 'favSubs']) {
          let rec = null;
          try { rec = await _dbGet('gl/' + r + '/' + branch + '/' + uid); } catch (e) {}
          if (!rec || !(rec.fcm || rec.sub)) continue;
          const k = rec.fcm || rec.sub;
          if (seen.has(k)) continue;
          seen.add(k);
          if (fcmAdmin && rec.fcm) {
            try {
              await fcmAdmin.messaging().send({
                token: rec.fcm,
                notification: { title: title, body: body },
                data: { type: 'join', url: url },
                android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink' } },
                apns: { payload: { aps: { sound: 'default' } } }
              });
              sent++; continue;
            } catch (e) {}
          }
          if (pushReady && rec.sub) {
            try { await webpush.sendNotification(JSON.parse(rec.sub), JSON.stringify({ title: title, body: body, url: url }), { TTL: 86400, urgency: 'high' }); sent++; } catch (e) {}
          }
        }
      }
    }
    console.log('[joinAsk]', room, req.authUid.slice(0, 8), 'notified', sent);
    res.json({ ok: true, notified: sent });
  } catch (e) {
    console.warn('[joinAsk]', (e && e.message) || e);
    res.status(500).json({ ok: false, reason: 'failed' });
  }
});

app.post('/pushTo', rateLimit(30, 60000), requireUser, async function(req, res) {
  const b = req.body || {};
  let uids = Array.isArray(b.uids) ? b.uids.slice(0, 8).map(u => String(u || '')).filter(Boolean) : [];
  // Only people the caller actually shares a room with.
  const _ok = [];
  for (const u of uids) if (await sharesRoom(req.authUid, u)) _ok.push(u);
  if (uids.length && !_ok.length) return res.status(403).json({ ok: false, reason: 'not-in-your-rooms' });
  uids = _ok;
  const title = String(b.title || 'GroundLink').slice(0, 80);
  const body = String(b.body || '').slice(0, 200);
  const type = String(b.type || 'info');
  if (!uids.length) return res.json({ ok: false, reason: 'no-uid' });
  // 1029: the crew the call was placed in, so a tap can route. Only a crew the caller is in.
  let group = String(b.group || '');
  if (group && !(await roomAccess(group, req.authUid))) group = '';
  const extra = _voiceExtra(b);
  const ts = String(Date.now());

  let sent = false;
  const seen = new Set();
  const decisions = [];
  for (const uid of uids) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    let recs = [];
    try { recs = await findAllSubsForUid(uid); } catch (e) {}
    if (!recs.length) { decisions.push(uid.slice(0, 10) + ':no-address'); continue; }
    for (const r of recs) {
      const rec = r.rec;
      // Same per-type preference check /push applies, so muting "Someone talking (voice)"
      // silences a direct call too. SOS always goes through.
      if (type !== 'sos' && (OPTIN_TYPES[type]
            ? !r.prefsList.some(function (pf) { return pf && (pf[type] === 1 || pf[type] === true); })
            : r.prefsList.some(function (pf) { return pf && (pf[type] === 0 || pf[type] === false); }))) { decisions.push(uid.slice(0, 10) + ':turned-off'); continue; }
      if (fcmAdmin && rec.fcm) {
        try {
          const data = Object.assign({ type: type, url: '/', group: group, ts: ts, fromUid: String(req.authUid || '') }, extra);
          await fcmAdmin.messaging().send({
            token: rec.fcm,
            notification: { title: title, body: body },
            data: data,
            android: { priority: 'high', ttl: 120000, notification: { sound: 'default', channelId: 'groundlink', tag: type + '-' + (extra.kind || 'x') + '-' + String(req.authUid || '').slice(0, 12) } },
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } }
          });
          sent = true;
          decisions.push(uid.slice(0, 10) + ':SENT-fcm');
          continue;
        } catch (err) {
          const code = (err && err.errorInfo && err.errorInfo.code) || (err && err.code) || '';
          decisions.push(uid.slice(0, 10) + ':FAILED-fcm ' + String(code).slice(0, 40));
        }
      }
      if (pushReady && rec.sub) {
        try {
          await webpush.sendNotification(JSON.parse(rec.sub), JSON.stringify(Object.assign({ title: title, body: body, url: '/', type: type, group: group, ts: ts }, extra)), { TTL: 3600, urgency: 'high' });
          sent = true;
          decisions.push(uid.slice(0, 10) + ':SENT-web');
        } catch (err) {
          decisions.push(uid.slice(0, 10) + ':FAILED-web ' + String((err && err.statusCode) || ''));
        }
      }
    }
  }
  // Talk only: one rolling record per call so "did my call reach them?" has an answer.
  if (type === 'voice') {
    try { await _dbSet('gl/_debug/voicePushes/' + (Date.now() % 10), { ts: Date.now(), kind: extra.kind || '', group: group, title: title.slice(0, 60), decisions: decisions.join(' ') }); } catch (e) {}
  }
  res.json({ ok: sent, reason: sent ? undefined : 'no-subscription' });
});

// VoIP wake (CallKit): ring a LOCKED / closed iPhone through as a call so live channel audio can
// play. The client passes the target uids + the channel room; we look up each one's registered
// VoIP token (gl/_voipSubs/<uid>) and send a direct APNs VoIP push. Uids with no token (Android,
// or an iPhone that never registered) are simply skipped.
app.post('/voip', rateLimit(60, 60000), requireUser, async function (req, res) {
  if (!apnsVoipReady) return res.json({ ok: false, reason: 'voip-not-configured' });
  const b = req.body || {};
  const _all = Array.isArray(b.uids) ? b.uids.slice(0, 20).map(u => String(u || '')).filter(Boolean) : [];
  const uids = [];
  for (const u of _all) if (await sharesRoom(req.authUid, u)) uids.push(u);
  const room = String(b.room || '').slice(0, 200);
  const fromName = String(b.fromName || 'GroundLink').slice(0, 60);
  if (!uids.length || !room) return res.json({ ok: false, reason: 'no-target' });
  let sent = 0;
  const seen = new Set();
  const results = [];   // diagnostic — what happened per target (written to gl/_debug/voipLog)
  for (const uid of uids) {
    if (seen.has(uid)) continue; seen.add(uid);
    // Prefer the RINGLESS Push-to-Talk token (iOS 16+); fall back to the CallKit VoIP token. An
    // iOS 16 device registers BOTH, so preferring PTT avoids double-notifying (a ring AND a PTT).
    let pttTok = null;
    try { const r0 = await _dbGet('gl/_pttSubs/' + uid); pttTok = r0 && r0.token; } catch (e) {}
    if (pttTok) {
      try { await sendPttPush(pttTok, { room: room, fromName: fromName }); sent++; results.push({ uid: uid.slice(0, 10), r: 'ptt-ok' }); }
      catch (e) { results.push({ uid: uid.slice(0, 10), r: 'ptt-' + String((e && e.message) || e).slice(0, 120) }); }
      continue;
    }
    // CallKit VoIP fallback DISABLED 2026-08-27. A CallKit push makes iOS report a real system
    // call; the shipped app never ends that call (no reportCall(endedAt:) / no timeout), so it
    // lingered in the phone's call stack and interfered with actual phone calls and the hang-up
    // button. Killing the push here stops that on every already-installed build with no app
    // update. Re-enable only once the native call lifecycle is fixed (end on voice-stop, answer
    // timeout, and skip when a real call is active).
    if (!VOIP_CALLKIT_ENABLED) { results.push({ uid: uid.slice(0, 10), r: 'callkit-disabled' }); continue; }
    let tok = null;
    try { const rec = await _dbGet('gl/_voipSubs/' + uid); tok = rec && rec.token; } catch (e) {}
    if (!tok) { results.push({ uid: uid.slice(0, 10), r: 'no-token' }); continue; }
    try { await sendVoipPush(tok, { room: room, fromName: fromName }); sent++; results.push({ uid: uid.slice(0, 10), r: 'voip-ok' }); }
    catch (e) { results.push({ uid: uid.slice(0, 10), r: 'voip-' + String((e && e.message) || e).slice(0, 120) }); }
  }
  // Diagnostic trail so we can see whether the push fired and what Apple said (BadDeviceToken,
  // TopicDisallowed, 200, etc.) without server-log access. Best-effort; capped implicitly by use.
  try { if (adminDb) adminDb.ref('gl/_debug/voipLog').push({ ts: Date.now(), room: room, from: fromName, targets: uids.length, sent: sent, results: results }); } catch (e) {}
  res.json({ ok: sent > 0, sent: sent, results: results });
});

// One alert per person per event, however many Crews they share with the sender.
//
// The client fans a notification out Crew by Crew, which is right -- each Crew has its own
// membership. But the same people are usually in several of them together, so a phone crossing
// 15% sent its low-battery alert once per Crew and arrived three times on the same laptop.
// Collapsing it at the recipient fixes it for every type at once rather than for battery alone.
//
// Keyed on who, what kind, and the exact words, so two genuinely different events inside the
// window still both arrive. In memory on purpose: this only has to span the few milliseconds
// between the client's back-to-back calls, and it is not worth a database write.
const PUSH_DEDUPE_MS = 90 * 1000;
const _pushSeen = new Map();
function _pushDuplicate(uid, type, body) {
  const key = uid + '|' + (type || '') + '|' + String(body || '').slice(0, 400);
  const now = Date.now();
  const prev = _pushSeen.get(key);
  if (prev && (now - prev) < PUSH_DEDUPE_MS) return true;
  _pushSeen.set(key, now);
  // Keep the map from growing without bound on a long-lived process.
  if (_pushSeen.size > 500) {
    for (const [k, t] of _pushSeen) { if (now - t > PUSH_DEDUPE_MS) _pushSeen.delete(k); }
  }
  return false;
}

// Fan-out a push to everyone in a group except the sender. The client calls
// this from pushNotify(); subscriptions live in Firebase at gl/<group>/pushSubs.
app.post('/push', rateLimit(30, 60000), requireUser, function (req, res) { return _pushHandler(req, res); });
async function _pushHandler(req, res) {
  if (!pushReady && !fcmAdmin) return res.json({ ok: false, reason: 'push-not-configured' });
  const b = req.body || {};
  const group = b.group, senderId = b.senderId;
  // _trusted: a call from inside this server (the car reply below), already checked by its key.
  if (!req._trusted && !(await roomAccess(String(group || ''), req.authUid))) return res.status(403).json({ ok: false, reason: 'not-a-member' });
  const senderFcm = b.senderFcm || '', senderEndpoint = b.senderEndpoint || '';
  if (!group) return res.status(400).json({ ok: false, reason: 'no-group' });
  // DB root namespace — sanitized + defaulted to production ('gl').
  const ns = (typeof b.ns === 'string' && /^[a-z0-9_]{1,20}$/i.test(b.ns)) ? b.ns : 'gl';
  // fromUid rides along so the RECEIVING device can drop a notification it caused itself.
  // The uid/token/endpoint matching below already tries to skip the sender, but it depends on
  // the sender's subscription being filed under the same uid it reports and on senderFcm being
  // populated — neither is guaranteed after a device-id change or when the native FCM token
  // hasn't reached the web layer. A stamp on the payload can't miss: the device knows its own
  // uid for certain.
  const _vx = _voiceExtra(b);
  const _skip = new Set(Array.isArray(b.skipUids) ? b.skipUids.slice(0, 50).map(function (u) { return String(u || ''); }) : []);
  const payload = JSON.stringify(Object.assign({
    title: b.title || 'GroundLink',
    body:  b.body  || '',
    type:  b.type  || 'info',
    group: group,
    url:   b.url   || '/',
    fromUid: senderId || ''
  }, _vx, { ts: Date.now() }));
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
    if (!Object.keys(targets).length) {
      // Nobody in this crew can be notified at all. For a pin that is the answer to "did they
      // get it?", so it is recorded like any other pin push.
      if (String(b.type || '') === 'pin') {
        console.log('/push pin group=' + String(group) + ' targets=0 sent=0 :: nobody in this crew has notifications set up');
        try { await _dbSet('gl/_debug/pinPushes/' + (Date.now() % 10), { ts: Date.now(), group: String(group), title: String(b.title || '').slice(0, 80), targets: 0, sent: 0, decisions: 'nobody in this crew has notifications set up' }); } catch (e) {}
      }
      return res.json({ ok: true, sent: 0 });
    }
    let sent = 0;
    // Why each recipient was kept or dropped. A user reported still being notified about his
    // OWN geofence transitions on the very phone that produced them, and every check below
    // looks correct against the live data — his uid matches senderId exactly and no duplicate
    // token is filed under another uid. Rather than guess at a fourth explanation, record the
    // decision and read it back after the next real event.
    const decisions = [];
    // A caller that omits all three identifiers cannot be skipped by ANY of the checks below,
    // so it will notify itself. That's a caller bug, not a delivery condition — say so loudly
    // rather than let it look like normal operation (headless.html did exactly this).
    if (!senderId && !senderFcm && !senderEndpoint) {
      console.warn('/push: no sender identity (type=' + String(b.type || '') + ', group=' + String(group) + ') — sender cannot be skipped');
    }
    await Promise.all(Object.entries(targets).map(async function(entry) {
      const uid = entry[0], rec = entry[1].rec, from = entry[1].from;
      if (uid === senderId || !rec) { decisions.push(uid.slice(0, 10) + ':self-or-empty'); return; }
      if (_skip.has(uid)) { decisions.push(uid.slice(0, 10) + ':already-listening'); return; }
      // Also skip THIS physical device even under a different/old uid: a stale subscription
      // carrying the sender's own FCM token or push endpoint must never notify the sender.
      if (senderFcm && rec.fcm && rec.fcm === senderFcm) { decisions.push(uid.slice(0, 10) + ':same-fcm'); return; }
      if (senderEndpoint && rec.sub) {
        try { if (JSON.parse(rec.sub).endpoint === senderEndpoint) { decisions.push(uid.slice(0, 10) + ':same-endpoint'); return; } } catch (e) {}
      }
      // Respect the recipient's per-type notification prefs (SOS always goes through).
      if (b.type && _prefBlocks(b.type, rec.prefs)) { decisions.push(uid.slice(0, 10) + ':turned-off'); return; }
      // Already told this person about this, via another Crew they share with the sender.
      // SOS is exempt: a repeat there is far cheaper than a miss.
      // A pin's body is the same for every pin in a crew ("Our Crew -- tap to see where") and two
      // pins of one type share a title, so the pin's own link (which carries its coordinates)
      // has to be part of what counts as "the same message". Reported 2026-10-30: a second pin
      // dropped 45 s after the first reached nobody, every recipient marked DUP.
      if (b.type !== 'sos' && _pushDuplicate(uid, b.type, (b.title || '') + '|' + (b.body || '') + (b.type === 'pin' ? '|' + (b.url || '') : ''))) { decisions.push(uid.slice(0, 10) + ':DUP'); return; }
      // Web Push — installed PWA (browser-backed)
      if (pushReady && rec.sub) {
        let subscription = null;
        try { subscription = JSON.parse(rec.sub); } catch (e) {}
        if (subscription) {
          try {
            await webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: b.type === 'sos' ? 'high' : 'normal' });
            sent++;
            decisions.push(uid.slice(0, 10) + ':SENT-web');
          } catch (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
              try { await _dbDelete(from + '/' + uid); } catch (e2) {}
            }
          }
        }
      }
      // FCM — native app
      // Android Auto (2026-11-24): an Android phone whose app can draw car conversations (rec.aa,
      // set by Android 1.4.9+) gets chat as data only. The app builds a conversation notification
      // with a Reply that works by voice, and the reply key below lets that reply post as this
      // person in this crew without the app being signed in to the database.
      if (fcmAdmin && rec.fcm && rec.aa && String(b.type || '') === 'chat') {
        decisions.push(uid.slice(0, 10) + ':SENT-fcm-car');
        try {
          const raw = String(b.body || ''), cut = raw.indexOf(': ');
          await fcmAdmin.messaging().send({
            token: rec.fcm,
            data: {
              type: 'chat', aa: '1', group: String(group), fromUid: String(senderId || ''),
              sender: cut > 0 ? raw.slice(0, cut).slice(0, 60) : 'Someone',
              text: (cut > 0 ? raw.slice(cut + 2) : raw).slice(0, 1000),
              title: String(b.title || 'GroundLink').replace(/\s+—\s+new message$/, '').slice(0, 80),
              me: uid, rtok: _aaReplyToken(String(group), uid), ts: String(Date.now())
            },
            android: { priority: 'high', ttl: 3600000 }
          });
          sent++;
        } catch (err) {
          const code = (err && err.errorInfo && err.errorInfo.code) || (err && err.code) || '';
          decisions.push(uid.slice(0, 10) + ':FAILED-fcm-car ' + String(code).slice(0, 40));
          if (/not-registered|invalid-registration-token/i.test(code)) {
            try { await _dbDelete(from + '/' + uid + '/fcm'); } catch (e2) {}
          }
        }
      } else if (fcmAdmin && rec.fcm) {
        decisions.push(uid.slice(0, 10) + ':SENT-fcm');
        try {
          await fcmAdmin.messaging().send({
            token: rec.fcm,
            notification: { title: b.title || 'GroundLink', body: b.body || '' },
            data: Object.assign({ type: String(b.type || 'info'), group: String(group), url: String(b.url || '/'), fromUid: String(senderId || ''), ts: String(Date.now()) }, _vx),
            android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink', tag: (b.type || 'gl') + '-' + group } },
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } }
          });
          sent++;
        } catch (err) {
          const code = (err && err.errorInfo && err.errorInfo.code) || (err && err.code) || '';
          decisions.push(uid.slice(0, 10) + ':FAILED-fcm ' + String(code).slice(0, 40));
          if (/not-registered|invalid-registration-token|invalid-argument/i.test(code)) {
            try { await _dbDelete(from + '/' + uid + '/fcm'); } catch (e2) {}
          }
        }
      }
    }));
    // Place alerts only — that's the reported case, and this keeps the node tiny rather than
    // logging every chat and voice ping. Overwrites a single key, so it never accumulates.
    // 975: pin drops too. "Did the crew get my pin?" had no answer: the server kept no record.
    // Logged as one line per pin, and the last ten kept under gl/_debug/pinPushes.
    if (String(b.type || '') === 'pin') {
      console.log('/push pin group=' + String(group) + ' targets=' + Object.keys(targets).length + ' sent=' + sent + ' :: ' + decisions.join(' | '));
      try {
        await _dbSet('gl/_debug/pinPushes/' + (Date.now() % 10), {
          ts: Date.now(), group: String(group), title: String(b.title || '').slice(0, 80),
          targets: Object.keys(targets).length, sent: sent, decisions: decisions.join(' | ')
        });
      } catch (e) {}
    }
    if (/^place_/.test(String(b.type || ''))) {
      try {
        await _dbSet('gl/_debug/lastPlacePush', {
          ts: Date.now(),
          type: String(b.type),
          group: String(group),
          senderId: String(senderId || '').slice(0, 10),
          senderFcm: senderFcm ? senderFcm.slice(0, 10) : '(empty)',
          senderEndpoint: senderEndpoint ? 'set' : '(empty)',
          targets: Object.keys(targets).map(function (u) { return u.slice(0, 10); }).join(','),
          decisions: decisions.join(' | '),
          sent: sent
        });
      } catch (e) {}
    }
    res.json({ ok: true, sent: sent });
  } catch (e) {
    console.warn('/push error:', e.message);
    res.json({ ok: false, reason: 'send-failed' });
  }
}

// ─── Android Auto replies ───────────────────────────────────────────────────────────────────
// A chat sent to a car-capable Android phone carries rtok: a key, good for 48 hours, that lets
// THAT person post into THAT crew's chat. Android Auto hands the spoken reply to the app with no
// screen and no database sign-in, so the app posts here with the key instead.
const AA_SECRET = crypto.createHash('sha256').update('gl-aa|' + String(process.env.AA_REPLY_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT || 'groundlink')).digest();
const AA_TTL_MS = 48 * 3600 * 1000;
function _aaReplyToken(group, uid) {
  const exp = Date.now() + AA_TTL_MS;
  const sig = crypto.createHmac('sha256', AA_SECRET).update(group + '|' + uid + '|' + exp).digest('base64url');
  return exp + '.' + sig;
}
function _aaReplyOk(group, uid, tok) {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,})$/.exec(String(tok || ''));
  if (!m || +m[1] < Date.now()) return false;
  const want = crypto.createHmac('sha256', AA_SECRET).update(group + '|' + uid + '|' + m[1]).digest('base64url');
  const a = Buffer.from(want), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.post('/api/aa-reply', rateLimit(20, 60000), async function (req, res) {
  try {
    const b = req.body || {};
    const group = String(b.group || ''), uid = String(b.uid || ''), text = String(b.text || '').trim().slice(0, 1000);
    if (!/^[a-z0-9_-]{1,80}$/.test(group) || !/^[A-Za-z0-9_-]{6,64}$/.test(uid) || !text) return res.status(400).json({ ok: false, reason: 'bad-request' });
    if (!_aaReplyOk(group, uid, b.tok)) return res.status(403).json({ ok: false, reason: 'bad-key' });
    if (!adminDb) return res.status(503).json({ ok: false, reason: 'no-admin' });
    let name = '';
    try { name = (await _dbGet('gl/' + group + '/users/' + uid + '/name')) || ''; } catch (e) {}
    if (!name) { try { name = (await _dbGet('gl/' + group + '/pushSubs/' + uid + '/name')) || ''; } catch (e) {} }
    name = String(name || 'Someone').slice(0, 60);
    await adminDb.ref('gl/' + group + '/chat').push({ uid: uid, name: name, text: text, ts: Date.now(), isPin: false, via: 'car' });
    console.log('/api/aa-reply group=' + group + ' uid=' + uid.slice(0, 10) + ' chars=' + text.length);
    // Tell the rest of the crew, exactly as a chat sent from the app would.
    await _pushHandler({ _trusted: true, body: { group: group, senderId: uid, type: 'chat', title: group + ' — new message', body: name + ': ' + text } },
                       { json: function () { return this; }, status: function () { return this; } });
    res.json({ ok: true });
  } catch (e) {
    console.warn('/api/aa-reply error:', e.message);
    res.status(500).json({ ok: false });
  }
});

// ─── Android Auto map (Android 1.5.0, 2026-11-25) ───────────────────────────────────────────
// The truck screen draws the crew map natively and has no database sign-in, so it reads the crew
// through here with a CAR KEY: an HMAC over (crew, this phone's uid, expiry), 60 days. The phone
// app asks for keys while signed in, and only gets one for a crew its account belongs to
// (roomAccess). A car key can only READ that crew's positions; it can't post (that is aa-reply's
// own key, a different secret).
const CAR_SECRET = crypto.createHash('sha256').update('gl-car|' + String(process.env.AA_REPLY_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT || 'groundlink')).digest();
const CAR_TTL_MS = 60 * 24 * 3600 * 1000;
function _carKey(group, uid) {
  const exp = Date.now() + CAR_TTL_MS;
  return exp + '.' + crypto.createHmac('sha256', CAR_SECRET).update(group + '|' + uid + '|' + exp).digest('base64url');
}
function _carKeyOk(group, uid, tok) {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,})$/.exec(String(tok || ''));
  if (!m || +m[1] < Date.now()) return false;
  const want = crypto.createHmac('sha256', CAR_SECRET).update(group + '|' + uid + '|' + m[1]).digest('base64url');
  const a = Buffer.from(want), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Truck-map diagnostics from Android 1.5.3+: start-up steps and crashes, written to the server log
// only ("[car-log]"). Carries no location or names. Read with Railway's log viewer.
app.post('/api/car-log', rateLimit(40, 60000), function (req, res) {
  try {
    const b = req.body || {};
    const clip = function (v, n) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' | ').slice(0, n); };
    console.warn('[car-log] ' + clip(b.kind, 10) + ' app=' + clip(b.app, 20) + ' sdk=' + clip(b.sdk, 4) + ' model=' + clip(b.model, 40) + ' :: ' + clip(b.msg, 3600));
  } catch (e) {}
  res.json({ ok: true });
});
app.post('/api/car-keys', rateLimit(20, 60000), requireUser, async function (req, res) {
  try {
    const b = req.body || {};
    const uid = String(b.uid || '');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return res.status(400).json({ ok: false, reason: 'bad-uid' });
    const groups = (Array.isArray(b.groups) ? b.groups : []).slice(0, 20).map(String).filter(function (g) { return /^[a-z0-9_-]{1,80}$/.test(g); });
    const keys = {};
    for (const g of groups) { if (await roomAccess(g, req.authUid)) keys[g] = _carKey(g, uid); }
    res.json({ ok: true, keys: keys });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});
// One crew's people for the truck map: position, speed, age, colour. Same filters as the phone
// map: hidden rows, private devices (other than this phone's own), owner-hidden ids, and rows
// with no real position are left out. Nothing older than 3 days.
app.post('/api/car/crew', rateLimit(60, 60000), async function (req, res) {
  try {
    const b = req.body || {};
    const group = String(b.group || ''), uid = String(b.uid || '');
    if (!/^[a-z0-9_-]{1,80}$/.test(group) || !/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return res.status(400).json({ ok: false, reason: 'bad-request' });
    if (!_carKeyOk(group, uid, b.tok)) return res.status(403).json({ ok: false, reason: 'bad-key' });
    if (!adminDb) return res.status(503).json({ ok: false, reason: 'no-admin' });
    const [users, cfg, own] = await Promise.all([
      _dbGet('gl/' + group + '/users'), _cachedGet('gl/' + group + '/config', 30000), _cachedGet('gl/_devOwner', 60000)]);
    const mh = (cfg && cfg.mapHidden) || {};
    const myAcct = own && own[uid] && own[uid].acct;
    const now = Date.now(), out = [];
    Object.keys(users || {}).forEach(function (k) {
      const u = users[k] || {};
      const lat = +u.lat, lng = +u.lng;
      if (!u.name || u.hidden || u.claiming || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
      const acct = own && own[k] && own[k].acct;
      if (mh[k] || (acct && mh[acct])) return;
      const mine = k === uid || (myAcct && acct === myAcct);
      if (u.priv && !mine) return;
      const ts = +(u.ts || u.fixTs || 0);
      if (!ts || now - ts > 3 * 24 * 3600 * 1000) return;
      out.push({ u: k, n: String(u.name).slice(0, 40), lat: lat, lng: lng, spd: +u.spd || 0, ts: ts, fx: +(u.fixTs || ts), c: String(u.color || ''), hs: +u.hereSince || 0, me: k === uid ? 1 : 0 });
    });
    // Stage 2 (Android 1.5.1): with extra=1, each shown person's last hour of trail (thinned to
    // at most 200 points) and the crew's dropped pins. Asked for every 30 s, not every 5.
    let trails = null, pins = null, roads = null, roadNames = null;
    if (b.extra) {
      trails = {};
      await Promise.all(out.map(async function (p) {
        try {
          const v = (await adminDb.ref('gl/' + group + '/trails/' + p.u).limitToLast(900).once('value')).val() || {};
          let pts = Object.keys(v).map(function (k) { return v[k] || {}; })
            .filter(function (q) { return +q.ts > now - 3600000 && isFinite(+q.lat) && isFinite(+q.lng) && (!q.acc || +q.acc <= 50); })
            .sort(function (a, c) { return a.ts - c.ts; });
          if (pts.length > 200) { const step = pts.length / 200; const th = []; for (let i = 0; i < 200; i++) th.push(pts[Math.floor(i * step)]); th.push(pts[pts.length - 1]); pts = th; }
          if (pts.length > 1) trails[p.u] = pts.map(function (q) { return [Math.round(+q.lat * 1e6) / 1e6, Math.round(+q.lng * 1e6) / 1e6]; });
        } catch (e) {}
      }));
      try {
        const pv = (await adminDb.ref('gl/' + group + '/pins').once('value')).val() || {};
        pins = [];
        Object.keys(pv).forEach(function (k) {
          const q = pv[k] || {};
          if (q.exp && +q.exp < now) return;
          if (!isFinite(+q.lat) || !isFinite(+q.lng)) return;
          if (pins.length < 400) pins.push({ lat: +q.lat, lng: +q.lng, n: String(q.label || q.cat || '').slice(0, 30) });
        });
      } catch (e) {}
      // 1086: the crew's own roads -- ones they drew, and names they gave existing stretches.
      try {
        const rv = (await adminDb.ref('gl/' + group + '/roads').once('value')).val() || {};
        roads = [];
        Object.keys(rv).forEach(function (k) {
          const r = rv[k] || {};
          const pts = (Array.isArray(r.pts) ? r.pts : []).filter(function (q) { return q && isFinite(+q[0]) && isFinite(+q[1]); }).slice(0, 400);
          if (pts.length >= 2 && roads.length < 200) roads.push({ n: String(r.n || '').slice(0, 40), pts: pts.map(function (q) { return [+q[0], +q[1]]; }) });
        });
        const nv = (await adminDb.ref('gl/' + group + '/roadNames').once('value')).val() || {};
        roadNames = [];
        Object.keys(nv).forEach(function (k) {
          const r = nv[k] || {};
          if (r.n && Array.isArray(r.mid) && roadNames.length < 300) roadNames.push({ n: String(r.n).slice(0, 40), mid: [+r.mid[0], +r.mid[1]] });
        });
      } catch (e) {}
    }
    // Android 1.5.8: with ava=1 (asked every 10 min), each shown person's profile photo from
    // gl/_avatars/<account> -- a small data: image or an https URL -- for the truck markers.
    let ava = null;
    if (b.ava) {
      ava = {};
      await Promise.all(out.map(async function (p) {
        try {
          const acct = (own && own[p.u] && own[p.u].acct) || p.u;
          let a = await _cachedGet('gl/_avatars/' + acct, 300000);
          if (!a && acct !== p.u) a = await _cachedGet('gl/_avatars/' + p.u, 300000);
          const src = a && String(a.img || a.url || '');
          if (src && src.length < 120000 && (src.indexOf('data:image/') === 0 || src.indexOf('https://') === 0)) ava[p.u] = src;
        } catch (e) {}
      }));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, group: group, name: String((cfg && cfg.name) || ''), now: now, people: out, trails: trails, pins: pins, roads: roads, roadNames: roadNames, ava: ava });
  } catch (e) {
    console.warn('/api/car/crew error:', e.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/version', function(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.send(CURRENT_VERSION);
});

// Is the server actually able to reach Firebase, and is push alive?
//
// FIREBASE_SERVICE_ACCOUNT is parsed inside a try/catch that only warns (see the FCM block
// above). A malformed value -- a mangled newline in the private key, a truncated paste, a
// rotation that did not survive the trip through a dashboard -- leaves the server running
// and silently kills EVERYTHING server-side: the keep-alive sweep, the wake pushes, the
// share-watch alerts, the auth log, the prune. Nothing outside the logs would say so, and
// the family would simply start going dark again with no explanation.
//
// Written during the 2026-10-21 Railway credential rotation, where the new key had to be
// pasted in blind (Railway returns variable values redacted) and there was no way to tell
// from outside whether it had taken. Public on purpose: it exposes no secret, only whether
// the pieces initialised, so it can be curled from anywhere right after a deploy.
app.get('/health', function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    version: CURRENT_VERSION,
    firebaseAdmin: !!fcmAdmin,            // service account parsed and initialised
    database: !!adminDb,                  // admin DB handle (server-side reads/writes)
    webPush: !!pushReady,                 // VAPID pair present and valid
    apns: !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID),
    keyId: (function () {                 // WHICH key, so a rotation can be confirmed
      try { return (JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}').private_key_id || '').slice(0, 8); }
      catch (e) { return 'UNPARSEABLE'; }
    })(),
    uptimeSec: Math.round(process.uptime()),
    wake: { pending: wakePending.size },  // pokes awaiting a verdict (WAKE OUTCOMES); present = this build is live
  });
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
// What version of GroundLink the App Store is serving right now, from Apple's public lookup.
// The phone app compares its own version to this and shows "needs an update" when it is
// behind. Proxied (and cached for 30 minutes) because Apple's lookup does not allow browser
// requests from our page.
var _storeVer = { at: 0, body: null };
app.get('/api/store-version', async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!_storeVer.body || Date.now() - _storeVer.at > 30 * 60000) {
      var r = await fetch('https://itunes.apple.com/lookup?id=6790179901&country=us&t=' + Date.now());
      var j = await r.json();
      var a = (j && j.results && j.results[0]) || {};
      if (a.version) _storeVer = { at: Date.now(), body: { ios: String(a.version) } };
    }
    res.json(_storeVer.body || {});
  } catch (e) { res.json(_storeVer.body || {}); }
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
      // C6:CD:AC:D2… is the RELEASE key every installed phone carries (build-release.bat). It was
      // missing, so Android never verified the links and every texted link opened the browser.
      "sha256_cert_fingerprints": ["C6:CD:AC:D2:57:51:2A:1C:7B:5D:C9:CD:F0:7E:C7:1F:FE:96:44:91:73:50:AC:27:3D:E9:8C:F3:2B:3E:D4:3E", "66:D4:5E:8A:57:E7:1E:75:92:B6:A5:EF:CC:C9:04:6D:B7:AA:CD:D7:E2:A9:14:45:B6:7E:5E:66:07:06:90:4C", "D5:BF:39:0E:56:EA:85:26:BD:DA:3D:77:CF:C7:1E:1C:C4:2A:E2:C3:50:68:DD:23:00:96:00:26:2D:96:9C:17", "10:09:BB:FE:B3:3B:9A:44:79:50:C8:07:88:23:25:D0:A5:AA:1A:53:75:84:29:34:5B:24:CA:0A:CD:A9:70:EB"]
    }
  }]));
});
// Apple App Site Association — the iOS half of what assetlinks.json does for Android.
// Without it, a texted invite ALWAYS opened in Safari on iPhone even with the app installed:
// this path fell through to the catch-all and returned index.html as text/html, which iOS
// rejects outright. Apple's requirements are strict and unforgiving:
//   - exact path /.well-known/apple-app-site-association, no file extension
//   - Content-Type application/json
//   - served over HTTPS with NO redirect (Apple's CDN will not follow one)
// appID is <TeamID>.<BundleID>. The bundle id is com.groundlink.ios — what the Xcode project
// actually builds — NOT com.groundlink.app, which is the Android package.
//
// Only the invite paths are claimed, deliberately. Claiming "/" would make every link to this
// site open the app and take away any way to reach the web version on a phone that has it.
app.get('/.well-known/apple-app-site-association', function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(JSON.stringify({
    applinks: {
      details: [{
        appIDs: ["XM3MLRA366.com.groundlink.ios"],
        components: [
          { "/": "/j/*", comment: "room invite" },
          { "/": "/d/*", comment: "device share" },
          { "/": "/", "?": { room: "?*" }, comment: "long-form room link" },
          { "/": "/", "?": { dshare: "?*" }, comment: "long-form device share" }
        ]
      }]
    }
  }));
});
// Short room-invite link: /j/<room>[?k=<passcode>] → the app's room-join URL. Keeps shared
// texts short. The App-Links intent-filter also claims this path, so installed apps open it
// natively (the web app routes it client-side); browsers follow this 302 into the web app.
app.get('/j/:room', function(req, res) {
  var room = String(req.params.room || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/__+/g, '_');
  var k = req.query.k ? '&k=' + encodeURIComponent(String(req.query.k)) : '';
  // The room's invite key — lets the person who opens the link onto the room's access list.
  var ik = req.query.ik ? '&ik=' + encodeURIComponent(String(req.query.ik).slice(0, 64)) : '';
  res.redirect(302, '/?room=' + encodeURIComponent(room) + k + ik);
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
    if (filePath.endsWith('version.json') || filePath.endsWith('native-latest.json')) {
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
