// Rows that are not a person in a place.
//
// The duplicate prune keeps one identity per person. This removes rows that should never have
// been on a map at all: null island (0,0), the iOS simulator's default (Apple Park / Mountain
// View), and anything absurdly far from where this family actually is. One of these — a row
// called "Me" sitting in Beijing — was forcing the All Crews camera to fit a 19,000 km box,
// which is why that map looked empty.
//
//   node tools/prune-ghosts.mjs           report only
//   node tools/prune-ghosts.mjs --apply   delete

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const apply = process.argv.includes('--apply');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();
const ago = t => !t ? 'never' : (d => d < 60 ? Math.round(d)+'m' : d < 1440 ? Math.round(d/60)+'h' : (d/1440).toFixed(1)+'d')((now-t)/60000);

// Where this family actually lives — the yardstick for "absurdly far".
const HOME = { lat: 30.42, lng: -84.96 };
const FAR_MI = 500;
const miles = (a, b) => {
  const R = 3958.8, rad = d => d*Math.PI/180;
  const dLat = rad(b.lat-a.lat), dLng = rad(b.lng-a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
};

const gl = (await db.ref('gl').get()).val() || {};
const doomed = [];
for (const room of Object.keys(gl).filter(k => k[0] !== '_')) {
  for (const [uid, u] of Object.entries(gl[room].users || {})) {
    if (!u) continue;
    const lat = u.lat, lng = u.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    let why = null;
    if (lat === 0 && lng === 0) why = 'null island (0,0)';
    else if (Math.abs(lat - 37.3349) < 0.2 && Math.abs(lng + 122.009) < 0.2) why = 'iOS simulator default (Apple Park)';
    else if (Math.abs(lat - 37.4220) < 0.2 && Math.abs(lng + 122.084) < 0.2) why = 'Android emulator default (Mountain View)';
    else { const d = miles(HOME, { lat, lng }); if (d > FAR_MI) why = Math.round(d) + " miles from home"; }
    if (why) doomed.push({ room, uid, name: u.name || '?', ts: u.ts || 0, lat, lng, why });
  }
}

if (!doomed.length) { console.log('No ghost rows found.'); process.exit(0); }
console.log(`${apply ? 'DELETING' : 'WOULD DELETE'} ${doomed.length} row(s):\n`);
for (const d of doomed) {
  console.log(`  ${d.name.padEnd(16)} ${ago(d.ts).padStart(7)}  ${String(d.lat).slice(0,9)}, ${String(d.lng).slice(0,10)}`);
  console.log(`      ${d.why}  —  gl/${d.room}/users/${d.uid.slice(0,10)}`);
}

const backup = {};
for (const d of doomed) backup[`gl/${d.room}/users/${d.uid}`] = gl[d.room].users[d.uid];
const file = `C:/Users/jford/Documents/GroundLink/tools/ghost-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(file, JSON.stringify(backup, null, 2));
console.log(`\nbackup written: ${file}`);

if (!apply) { console.log('\n(dry run — nothing changed)'); process.exit(0); }
for (const d of doomed) await db.ref(`gl/${d.room}/users/${d.uid}`).remove();
console.log(`\n${doomed.length} row(s) removed.`);
process.exit(0);
