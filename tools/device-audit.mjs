import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const devices = (await db.ref('gl/_devices').get()).val() || {};
const owners  = (await db.ref('gl/_deviceOwners').get()).val() || {};
const ago = t => !t ? 'never' : (d => d<60?Math.round(d)+'m':d<1440?(d/60).toFixed(1)+'h':(d/1440).toFixed(1)+'d')((Date.now()-t)/60000);

console.log('== gl/_devices ==');
for (const [id, d] of Object.entries(devices)) {
  const live = d.live || {};
  console.log(`\n  ${id}`);
  console.log(`    name=${live.name || d.ownerName || '?'}  owner=${d.owner || '(unclaimed)'}  ownerName=${d.ownerName || '-'}`);
  console.log(`    live: lat=${live.lat} lng=${live.lng} ts=${ago(live.ts)} acc=${live.accuracy}`);
  console.log(`    fields on record: [${Object.keys(d).join(', ')}]`);
  console.log(`    fields on live:   [${Object.keys(live).join(', ')}]`);
  // The exact gate the map uses before drawing a marker.
  const drawable = live && typeof live.lat === 'number' && typeof live.lng === 'number';
  console.log(`    would draw a marker? ${drawable ? 'yes' : 'NO — lat/lng missing or not numbers'}`);
}
console.log('\n== gl/_deviceOwners ==');
console.log(JSON.stringify(owners, null, 2));
process.exit(0);
