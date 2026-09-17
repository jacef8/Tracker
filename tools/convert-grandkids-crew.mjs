// Turn the_best_grandkids from a plain room into a Crew, matching how existing Crews are stored.
//
//   config:  circle, persistent, private, a real name (owner is already Jace)
//   members: Jace (owner) and Allie Roberts, the one person actually on it
//   Allie's account circles gain the room, so her phone keeps reporting there once favorites
//   stop sharing location. She already reports there via her favorite, so who can see her does
//   not change.
//
// Jace is added to the roster as owner but NOT to his own account's circles: that would start
// sending his location to this map, which is a separate decision.
//
//   node tools/convert-grandkids-crew.mjs           report only
//   node tools/convert-grandkids-crew.mjs --apply   convert

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const apply = process.argv.includes('--apply');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const ROOM = 'the_best_grandkids';
const NAME = 'The Best Grandkids';
const JACE = '1RwPgdSdOEgp3lhlGly5I71EkY73';
const ALLIE = 'KF7EaRAsQgVzzjn2Yw7jsG5JuMz2';
const now = Date.now();

const room = (await db.ref('gl/' + ROOM).get()).val() || {};
const allie = (await db.ref('gl/_users/' + ALLIE).get()).val() || {};
let circles = allie.circles || {};
if (typeof circles === 'string') { try { circles = JSON.parse(circles); } catch (e) { circles = {}; } }

const writes = {
  ['gl/' + ROOM + '/config/circle']: true,
  ['gl/' + ROOM + '/config/persistent']: true,
  ['gl/' + ROOM + '/config/visibility']: 'private',
  ['gl/' + ROOM + '/config/name']: (room.config && room.config.name) || NAME,
  ['gl/' + ROOM + '/members/' + JACE]: { name: 'Jace', addedAt: now, addedBy: 'convert' },
  ['gl/' + ROOM + '/members/' + ALLIE]: { name: 'Allie Roberts', addedAt: now, addedBy: 'convert' },
};
const newCircles = Object.assign({}, circles, { [ROOM]: NAME });
// Preserve the storage shape the app already used for this field.
writes['gl/_users/' + ALLIE + '/circles'] = (typeof allie.circles === 'string') ? JSON.stringify(newCircles) : newCircles;

console.log('before:');
console.log('  config ', JSON.stringify(room.config || {}));
console.log('  members', JSON.stringify(room.members || {}));
console.log('  Allie circles', JSON.stringify(allie.circles));
console.log(`\n${apply ? 'WRITING' : 'WOULD WRITE'}:`);
for (const [k, v] of Object.entries(writes)) console.log('  ' + k + ' = ' + JSON.stringify(v));

const file = `C:/Users/jford/Documents/GroundLink/tools/grandkids-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(file, JSON.stringify({ room, allieAccount: allie }, null, 2));
console.log('\nbackup written: ' + file);

if (!apply) { console.log('\n(dry run — nothing changed)'); process.exit(0); }
await db.ref().update(writes);
console.log('\nconverted.');
process.exit(0);
