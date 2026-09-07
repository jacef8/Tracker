// The People list is built from your FAVORITES, keyed by whatever uid you starred.
// Notify pushes to that exact key. So: is the key you starred a key anyone registered under?
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const gl = (await admin.database().ref('gl').get()).val() || {};
const rooms = Object.keys(gl).filter(k => k[0] !== '_');
const owner = gl._devOwner || {};

const subKeys = new Set(), rosterKeys = new Set();
for (const r of rooms) {
  for (const b of ['pushSubs','favSubs']) for (const [u,rec] of Object.entries(gl[r][b]||{})) if (rec&&(rec.fcm||rec.sub)) subKeys.add(u);
  for (const u of Object.keys(gl[r].users||{})) rosterKeys.add(u);
}
const nameOf = {};
for (const r of rooms) for (const [u,x] of Object.entries(gl[r].users||{})) if (x?.name) nameOf[u]=x.name;
for (const [a,u] of Object.entries(gl._users||{})) if (u?.name||u?.displayName) nameOf[a]=u.name||u.displayName;

for (const [acct, u] of Object.entries(gl._users || {})) {
  let fr = u?.profile?.friends ?? u?.friends;
  if (typeof fr === 'string') { try { fr = JSON.parse(fr); } catch { fr = null; } }
  if (!fr || !Object.keys(fr).length) continue;
  console.log(`\n══ favorites of ${nameOf[acct]||acct} (${u.email||'?'}) ══`);
  for (const [uid, label] of Object.entries(fr)) {
    const acctOf = owner[uid]?.acct;
    console.log(
      `  "${label}"  ${uid}\n` +
      `      in a room roster? ${rosterKeys.has(uid) ? 'yes' : 'NO  → row reads "Not in a Crew"'}\n` +
      `      push registered under this id? ${subKeys.has(uid) ? 'yes' : 'NO  → Notify silently fails'}\n` +
      `      _devOwner account fallback: ${acctOf ? acctOf + (subKeys.has(acctOf) ? ' (has push)' : ' (no push either)') : 'none — this id IS an account, and there is no account→devices lookup'}`
    );
  }
}
process.exit(0);
