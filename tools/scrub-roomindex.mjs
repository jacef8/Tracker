// Strip member names (and, for private rooms, live counts) from the world-readable directory.
//
// gl/_roomIndex has ".read": "auth != null" — every signed-in GroundLink user can read all of
// it. It was publishing each room's name, occupancy and the first three MEMBER NAMES, for
// private Crews as well as public rooms. Build 781 stops writing that; this removes what is
// already sitting there, which no code change can do on its own.
//
//   node tools/scrub-roomindex.mjs           report only
//   node tools/scrub-roomindex.mjs --apply   scrub

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const apply = process.argv.includes('--apply');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const idx = (await db.ref('gl/_roomIndex').get()).val() || {};

const changes = [];
for (const [room, e] of Object.entries(idx)) {
  if (!e || typeof e !== 'object') continue;
  // Trust the ROOM's config, not the directory's copy of it. hunting was flagged "public" here
  // while its config said private — the entry was written before it became a Crew and nothing
  // ever corrected it. That stale flag is what exposed it, and a client filtering on the
  // directory's own value would have been fooled in exactly the same way.
  let trueVis = e.vis || 'public';
  try {
    const cfg = (await db.ref('gl/' + room + '/config/visibility').get()).val();
    if (cfg) trueVis = cfg;
  } catch (err) {}
  const isPrivate = trueVis !== 'public';
  const patch = {};
  if ((e.vis || 'public') !== trueVis) patch.vis = trueVis;
  if (Array.isArray(e.names) ? e.names.length : e.names) patch.names = [];
  if (isPrivate) {
    if (e.live)     patch.live = 0;
    if (e.resting)  patch.resting = 0;
    if (e.pins)     patch.pins = 0;
  }
  if (Object.keys(patch).length) changes.push({ room, isPrivate, wasVis: e.vis || 'public', was: { names: e.names, live: e.live, resting: e.resting, pins: e.pins }, patch });
}

if (!changes.length) { console.log('Directory is already clean.'); process.exit(0); }
console.log(`${apply ? 'SCRUBBING' : 'WOULD SCRUB'} ${changes.length} entr${changes.length === 1 ? 'y' : 'ies'}:\n`);
for (const c of changes) {
  console.log(`  ${c.room.padEnd(20)} ${c.isPrivate ? 'private' : 'public '}${c.patch.vis ? '  (directory said "' + (c.wasVis) + '")' : ''}`);
  console.log(`      exposed: names=${JSON.stringify(c.was.names || [])} live=${c.was.live || 0} resting=${c.was.resting || 0}`);
  console.log(`      -> ${JSON.stringify(c.patch)}`);
}

const file = `C:/Users/jford/Documents/GroundLink/tools/roomindex-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(file, JSON.stringify(idx, null, 2));
console.log(`\nbackup written: ${file}`);

if (!apply) { console.log('\n(dry run — nothing changed)'); process.exit(0); }
for (const c of changes) await db.ref('gl/_roomIndex/' + c.room).update(c.patch);
console.log(`\n${changes.length} entr${changes.length === 1 ? 'y' : 'ies'} scrubbed.`);
process.exit(0);
