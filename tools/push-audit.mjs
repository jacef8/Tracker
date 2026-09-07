// Who can actually be reached by a push, and under which id.
// The People list pushes to a uid; findSubsForUid scans gl/<room>/pushSubs and favSubs for
// that exact key. If nobody registered under the id the row carries, the push silently no-ops.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
const KEY = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const gl = (await db.ref('gl').get()).val() || {};
const owner = gl._devOwner || {};
const users = gl._users || {};

// name lookup for any id we meet
const nameOf = {};
for (const [rk, r] of Object.entries(gl)) {
  if (rk.startsWith('_')) continue;
  for (const [uid, u] of Object.entries(r.users || {})) if (u && u.name) nameOf[uid] = u.name;
}
for (const [acct, u] of Object.entries(users)) if (u && (u.name || u.displayName)) nameOf[acct] = u.name || u.displayName;

const subs = {};   // uid -> [{room, branch, fcm?, sub?, prefs}]
for (const [rk, r] of Object.entries(gl)) {
  if (rk.startsWith('_')) continue;
  for (const branch of ['pushSubs', 'favSubs']) {
    for (const [uid, rec] of Object.entries(r[branch] || {})) {
      if (!rec) continue;
      (subs[uid] = subs[uid] || []).push({
        room: rk, branch,
        fcm: rec.fcm ? rec.fcm.slice(0, 14) + '…' : null,
        web: rec.sub ? 'yes' : null,
        prefs: rec.prefs || null,
        ts: rec.ts || rec.updated || null,
      });
    }
  }
}

console.log('══ EVERY REGISTERED PUSH IDENTITY ══');
for (const [uid, recs] of Object.entries(subs)) {
  const nm = nameOf[uid] || (owner[uid] && nameOf[owner[uid].acct]) || '(unknown)';
  const kind = uid.startsWith('acct_') || users[uid] ? 'ACCOUNT' : 'device';
  console.log(`\n${nm}  [${kind}]  ${uid}`);
  for (const r of recs) console.log(`   ${r.room}/${r.branch}  fcm=${r.fcm || '—'}  webpush=${r.web || '—'}  prefs=${JSON.stringify(r.prefs)}`);
}

console.log('\n\n══ LAURA: EVERY ID SHE APPEARS UNDER ══');
const laura = [];
for (const [uid, nm] of Object.entries(nameOf)) if (/laura/i.test(nm)) laura.push(uid);
for (const [dev, o] of Object.entries(owner)) {
  if (laura.includes(o.acct) && !laura.includes(dev)) laura.push(dev);
}
for (const uid of laura) {
  const has = subs[uid];
  console.log(`  ${uid}  "${nameOf[uid] || '(via _devOwner)'}"  → push: ${has ? has.map(h => h.room + '/' + h.branch).join(', ') : 'NONE  ← cannot be notified under this id'}`);
}

console.log('\n\n══ WHAT THE PEOPLE LIST WOULD SEND TO ══');
// _talkIndex builds from every room's users; the row carries that room-level uid.
for (const [rk, r] of Object.entries(gl)) {
  if (rk.startsWith('_')) continue;
  for (const [uid, u] of Object.entries(r.users || {})) {
    if (!u || !/laura/i.test(u.name || '')) continue;
    const acct = owner[uid] && owner[uid].acct;
    const reach = (subs[uid] ? 'uid✓' : 'uid✗') + ' / ' + (acct ? (subs[acct] ? 'acct✓' : 'acct✗') : 'acct—');
    console.log(`  room=${rk} uid=${uid} acct=${acct || '—'}  reachable: ${reach}`);
  }
}
process.exit(0);
