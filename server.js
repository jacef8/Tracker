const express = require('express');
const path    = require('path');
const webpush = require('web-push');
const app     = express();
const PORT    = process.env.PORT || 3000;
const CURRENT_VERSION = '1.7';

app.use(express.json({ limit: '64kb' }));

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
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svc) {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
    fcmAdmin = admin;
    console.log('FCM (Firebase Admin) ready');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set — native FCM push disabled');
  }
} catch (e) { console.warn('FCM init failed:', e.message); }

// Fan-out a push to everyone in a group except the sender. The client calls
// this from pushNotify(); subscriptions live in Firebase at gl/<group>/pushSubs.
app.post('/push', async function(req, res) {
  if (!pushReady && !fcmAdmin) return res.json({ ok: false, reason: 'push-not-configured' });
  const b = req.body || {};
  const group = b.group, senderId = b.senderId;
  const senderFcm = b.senderFcm || '', senderEndpoint = b.senderEndpoint || '';
  if (!group) return res.status(400).json({ ok: false, reason: 'no-group' });
  // DB root namespace — the test page sends ns:'gltest' to isolate its data from
  // production ('gl'). Sanitized + defaulted so existing prod callers are unchanged.
  const ns = (typeof b.ns === 'string' && /^[a-z0-9_]{1,20}$/i.test(b.ns)) ? b.ns : 'gl';
  const payload = JSON.stringify({
    title: b.title || 'GroundLink',
    body:  b.body  || '',
    type:  b.type  || 'info',
    group: group,
    url:   b.url   || '/'
  });
  const groupBase = DB_URL + '/' + ns + '/' + encodeURIComponent(group);
  const base = groupBase + '/pushSubs';
  try {
    // Members currently in the room.
    const subs = (await (await fetch(base + '.json')).json()) || {};
    // For join/leave activity, ALSO notify people who favorited this group but aren't
    // in the room right now (their subscriptions live at gl/<group>/favSubs).
    let favs = {};
    if (b.toFavs) {
      try { favs = (await (await fetch(groupBase + '/favSubs.json')).json()) || {}; } catch (e) { favs = {}; }
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
              try { await fetch(from + '/' + uid + '.json', { method: 'DELETE' }); } catch (e2) {}
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
            try { await fetch(from + '/' + uid + '/fcm.json', { method: 'DELETE' }); } catch (e2) {}
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
// Admin route
app.get('/777', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// Test environment — secret path (same style as the /777 admin route)
// Access: /test888
app.get('/test888', function(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index-test.html'));
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
      "sha256_cert_fingerprints": ["D5:BF:39:0E:56:EA:85:26:BD:DA:3D:77:CF:C7:1E:1C:C4:2A:E2:C3:50:68:DD:23:00:96:00:26:2D:96:9C:17", "10:09:BB:FE:B3:3B:9A:44:79:50:C8:07:88:23:25:D0:A5:AA:1A:53:75:84:29:34:5B:24:CA:0A:CD:A9:70:EB"]
    }
  }]));
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
    if (filePath.endsWith('index.html') || filePath.endsWith('index-test.html')) {
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
