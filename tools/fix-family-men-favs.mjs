// Bring existing accounts in line with "only members can favorite a Crew".
//
//   Justin Ford   — already a Family Men member and on its map; his Crew list was missing it.
//   Jared Roberts — favorited Family Men, never a member, not on the map: favorite removed.
//   Adam Walker   — same as Jared Roberts.
//
// Nobody's visibility on any map changes.
//
//   node tools/fix-family-men-favs.mjs           report only
//   node tools/fix-family-men-favs.mjs --apply   write

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const apply = process.argv.includes('--apply');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const ROOM = 'family_men';
const JUSTIN = 'B07lT7c5nZRQ8QS9IEKmeh2rlXN2';
const DROP = { QYve0ZEHHs: 'Jared Roberts', hxaMQL1IPp: 'Adam Walker' };

const users = (await db.ref('gl/_users').get()).val() || {};
const parse = (v, d) => { if (typeof v !== 'string') return v == null ? d : v; try { return JSON.parse(v); } catch (e) { return d; } };
const keepShape = (orig, val) => (typeof orig === 'string') ? JSON.stringify(val) : val;

const writes = {}, backup = {};
const justinKey = Object.keys(users).find(k => k.startsWith(JUSTIN.slice(0, 10)));
if (justinKey) {
  const u = users[justinKey];
  const c = parse(u.circles, {});
  if (!c[ROOM]) {
    backup[justinKey] = { circles: u.circles };
    writes['gl/_users/' + justinKey + '/circles'] = keepShape(u.circles, Object.assign({}, c, { [ROOM]: 'Family Men' }));
  }
}
for (const [prefix, name] of Object.entries(DROP)) {
  const key = Object.keys(users).find(k => k.startsWith(prefix));
  if (!key) { console.log('  (' + name + ' not found)'); continue; }
  const u = users[key];
  const f = parse(u.favs, []);
  if (f.includes(ROOM)) {
    backup[key] = { favs: u.favs };
    writes['gl/_users/' + key + '/favs'] = keepShape(u.favs, f.filter(k => k !== ROOM));
  }
}

console.log(`${apply ? 'WRITING' : 'WOULD WRITE'}:`);
for (const [k, v] of Object.entries(writes)) console.log('  ' + k + ' = ' + JSON.stringify(v));
if (!Object.keys(writes).length) { console.log('  nothing to change'); process.exit(0); }

const file = `C:/Users/jford/Documents/GroundLink/tools/favs-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(file, JSON.stringify(backup, null, 2));
console.log('\nbackup written: ' + file);
if (!apply) { console.log('\n(dry run — nothing changed)'); process.exit(0); }
await db.ref().update(writes);
console.log('\ndone.');
process.exit(0);
