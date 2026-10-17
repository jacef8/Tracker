import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const ids = { acct: 'tKIKEVpi8USMXzzoShozTSsNHmz1', device: 'EovOlR1xzxVGDU0rVR1nJbfRQGA3' };
for (const [k, id] of Object.entries(ids)) {
  try {
    const u = await admin.auth().getUser(id);
    console.log(k, id, JSON.stringify({ disabled: u.disabled, providers: u.providerData.map(p => p.providerId), email: u.email ? 'yes' : 'no',
      creation: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime, lastRefresh: u.metadata.lastRefreshTime, tokensValidAfter: u.tokensValidAfterTime }, null, 1));
  } catch (e) { console.log(k, id, 'getUser error:', e.code || e.message); }
}
// any fcm token for her anywhere?
const db = admin.database();
const gl = (await db.ref('gl').get()).val() || {};
for (const [room, r] of Object.entries(gl)) {
  if (room[0] === '_') continue;
  const ps = (r.pushSubs || {})[ids.device]; if (ps) console.log('pushSubs', room, JSON.stringify(ps).slice(0, 200));
  const fs = (r.favSubs || {})[ids.device]; if (fs) console.log('favSubs', room, JSON.stringify(fs).slice(0, 200));
}
for (const k of Object.keys(gl).filter(k => k[0] === '_')) {
  const v = gl[k]; if (v && typeof v === 'object' && v[ids.device] && /fcm|token/i.test(JSON.stringify(v[ids.device]))) console.log(k, JSON.stringify(v[ids.device]).slice(0, 200));
}
process.exit(0);
