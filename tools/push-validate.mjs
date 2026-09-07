// Which of these FCM tokens would actually deliver? validate_only:true asks Google to run the
// full send path and report the verdict WITHOUT delivering anything — nobody's phone buzzes.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
const KEY = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const gl = (await db.ref('gl').get()).val() || {};
const nameOf = {};
for (const [rk, r] of Object.entries(gl)) {
  if (rk.startsWith('_')) continue;
  for (const [uid, u] of Object.entries(r.users || {})) if (u && u.name) nameOf[uid] = u.name;
}
for (const [a, u] of Object.entries(gl._users || {})) if (u && (u.name || u.displayName)) nameOf[a] = u.name || u.displayName;

// Exactly what findSubsForUid does: first room, pushSubs before favSubs, first hit wins.
const rooms = Object.keys(gl).filter(k => k[0] !== '_');
function findSubs(uid) {
  for (const room of rooms) for (const branch of ['pushSubs', 'favSubs']) {
    const rec = gl[room]?.[branch]?.[uid];
    if (rec && (rec.fcm || rec.sub)) return { ...rec, _at: room + '/' + branch };
  }
  return null;
}
const uids = new Set();
for (const room of rooms) for (const branch of ['pushSubs', 'favSubs'])
  for (const u of Object.keys(gl[room]?.[branch] || {})) uids.add(u);

console.log('id                                who              found at                    verdict');
for (const uid of uids) {
  const rec = findSubs(uid);
  const who = (nameOf[uid] || (gl._devOwner?.[uid] && nameOf[gl._devOwner[uid].acct]) || '?').padEnd(15);
  if (!rec?.fcm) { console.log(`${uid}  ${who}  ${(rec?._at||'—').padEnd(26)}  no FCM token${rec?.sub ? ' (webpush only)' : ''}`); continue; }
  let verdict;
  try {
    await admin.messaging().send({ token: rec.fcm, notification: { title: 't', body: 'b' } }, true);
    verdict = 'LIVE — would deliver';
  } catch (e) { verdict = 'DEAD — ' + (e.errorInfo?.code || e.code || e.message); }
  console.log(`${uid}  ${who}  ${rec._at.padEnd(26)}  ${verdict}`);
}
process.exit(0);
