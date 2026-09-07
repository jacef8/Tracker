// Every identity, everywhere. Grouped by PERSON (account where known, name otherwise), so the
// question "how many rows does Laura have" has one answer instead of one per branch.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const gl = (await admin.database().ref('gl').get()).val() || {};
const rooms = Object.keys(gl).filter(k => k[0] !== '_');
const owner = gl._devOwner || {};
const now = Date.now();
const ago = t => !t ? 'never' : (d => d<60?d+'m':d<1440?(d/60).toFixed(1)+'h':(d/1440).toFixed(0)+'d')((now-t)/60000);

console.log('branches present per room:');
for (const r of rooms) console.log('  ' + r.padEnd(22) + Object.keys(gl[r]).join(', '));

// uid -> {name, rows:[{room,branch,ts}]}
const ids = {};
const note = (uid, name, room, branch, ts) => {
  const e = ids[uid] = ids[uid] || { name: null, rows: [] };
  if (name && !e.name) e.name = name;
  e.rows.push({ room, branch, ts: ts || 0 });
};
for (const r of rooms) {
  for (const b of ['users','pushSubs','favSubs']) {
    for (const [uid, rec] of Object.entries(gl[r][b] || {})) {
      if (!rec || typeof rec !== 'object') continue;
      note(uid, rec.name, r, b, rec.fixTs || rec.ts || 0);
    }
  }
}
// group by person
const people = {};
for (const [uid, e] of Object.entries(ids)) {
  const acct = owner[uid]?.acct;
  const key = acct || e.name || uid;
  (people[key] = people[key] || []).push({ uid, ...e, newest: Math.max(...e.rows.map(r => r.ts), 0) });
}
const nameOf = {};
for (const [a,u] of Object.entries(gl._users||{})) if (u?.name||u?.displayName) nameOf[a]=u.name||u.displayName;

console.log('\n\n══ DUPLICATE IDENTITIES (people holding more than one id) ══');
let dupes = 0;
for (const [key, list] of Object.entries(people)) {
  if (list.length < 2) continue;
  dupes++;
  list.sort((a,b) => b.newest - a.newest);
  console.log(`\n${nameOf[key] || list[0].name || key}   —   ${list.length} ids`);
  list.forEach((d, i) => {
    console.log(`  ${i === 0 ? 'KEEP  ' : 'stale '}${d.uid}  last activity ${ago(d.newest).padStart(6)}`);
    d.rows.sort((a,b)=>b.ts-a.ts).forEach(r => console.log(`          ${r.room}/${r.branch}  ${ago(r.ts)}`));
  });
}
console.log(`\n\n${dupes} people currently hold duplicate ids.`);
process.exit(0);
