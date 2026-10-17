// READ-ONLY: dump everything relevant to one person's reporting state. Deleted after use.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();
const ago = t => !t ? 'never' : (d => d<60?Math.round(d)+'m':d<1440?(d/60).toFixed(1)+'h':(d/1440).toFixed(1)+'d')((now-t)/60000);
const iso = t => t ? new Date(t).toISOString() : '-';
const NAMES = /vanesa|lexi|laura/i;

const roomIndex = (await db.ref('gl/_roomIndex').get()).val() || {};
const rooms = Object.keys(roomIndex);
console.log('rooms in index:', rooms.length);
const found = {}; // uid -> [{room,row}]
for (const room of rooms) {
  const users = (await db.ref(`gl/${room}/users`).get()).val() || {};
  for (const [uid, u] of Object.entries(users)) {
    if (!u || !NAMES.test(u.name || '')) continue;
    (found[uid] ||= []).push({ room, u });
  }
}
const devOwner = (await db.ref('gl/_devOwner').get()).val() || {};
const aclMiss = (await db.ref('gl/_aclMiss').get()).val() || {};
for (const [uid, list] of Object.entries(found)) {
  console.log('\n==================', uid, '==================');
  console.log('_devOwner:', JSON.stringify(devOwner[uid] || null));
  for (const { room, u } of list) {
    const cfg = (await db.ref(`gl/${room}/config`).get()).val() || {};
    const acl = (await db.ref(`gl/${room}/acl`).get()).val() || {};
    const acct = devOwner[uid]?.acct;
    console.log(`\n-- room ${room} circle=${cfg.circle} owner=${cfg.owner}`);
    console.log(`   acl has device uid? ${!!acl[uid]}  acl has acct(${acct})? ${acct ? !!acl[acct] : 'n/a'}  acl keys=${Object.keys(acl).length}`);
    const { oss, path, ...rest } = u;
    console.log('   row (minus oss/path):', JSON.stringify(rest));
    console.log(`   ts=${iso(u.ts)} (${ago(u.ts)})  fixTs=${iso(u.fixTs)} (${ago(u.fixTs)})  fgTs=${iso(u.fgTs)} (${ago(u.fgTs)})`);
    console.log('   oss:', JSON.stringify(oss || null));
    if (oss && (oss.ts || oss.at)) console.log(`   oss stamp: ${iso(oss.ts || oss.at)} (${ago(oss.ts || oss.at)})`);
    console.log('   aclMiss for this room/uid:', JSON.stringify((aclMiss[room] || {})[uid] || null));
  }
  // diag + coverage
  for (const { room } of list.slice(0, 1)) {
    const diag = (await db.ref(`gl/${room}/diag/${uid}`).get()).val();
    console.log('\n   diag (first room):', JSON.stringify(diag));
  }
  // push subs
  const voip = (await db.ref(`gl/_voipSubs/${uid}`).get()).val();
  console.log('   _voipSubs:', voip ? Object.keys(voip).length + ' entries' : 'none', voip ? JSON.stringify(Object.values(voip)[0]).slice(0, 200) : '');
  for (const { room } of list) {
    const ps = (await db.ref(`gl/${room}/pushSubs/${uid}`).get()).val();
    if (ps) { console.log(`   pushSubs in ${room}:`, JSON.stringify(ps).slice(0, 300)); break; }
  }
}
// All aclMiss records for these uids
console.log('\n== _aclMiss records for these uids ==');
for (const [room, byUid] of Object.entries(aclMiss)) {
  for (const uid of Object.keys(found)) {
    if (byUid[uid]) console.log(room, uid, JSON.stringify(byUid[uid]));
  }
}
// _debug beacons mentioning these uids
const dbg = (await db.ref('gl/_debug').limitToLast(400).get()).val() || {};
console.log('\n== _debug entries mentioning these uids (last 400) ==');
for (const [k, v] of Object.entries(dbg)) {
  const s = JSON.stringify(v);
  for (const uid of Object.keys(found)) if (s.includes(uid)) console.log(k, s.slice(0, 400));
}
process.exit(0);
