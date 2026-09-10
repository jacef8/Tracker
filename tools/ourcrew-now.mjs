import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const users = (await admin.database().ref('gl/our_crew/users').get()).val() || {};
const now = Date.now();
const ago = t => !t ? 'never' : (d => d<60?Math.round(d)+'m':d<1440?Math.round(d/60)+'h':(d/1440).toFixed(1)+'d')((now-t)/60000);
const rows = Object.entries(users).map(([uid, u]) => ({
  uid, name: u.name, dev: u.dev, lat: u.lat, lng: u.lng,
  age: ago(u.fixTs || u.ts), spd: u.spd || 0, ts: u.fixTs || u.ts || 0,
})).sort((a,b) => b.ts - a.ts);
for (const r of rows) {
  console.log(`${(r.name||'?').padEnd(12)} ${(r.dev||'-').padEnd(7)} ${r.age.padStart(6)}  spd=${String(r.spd).padStart(3)}  ${r.lat},${r.lng}   ${r.uid.slice(0,10)}`);
}
// How far apart is every pair? The merge threshold is what decides whether two dots become one
// oval, so this is the number that matters.
const R = 6371000, rad = d => d*Math.PI/180;
function metres(a, b) {
  const dLat = rad(b.lat-a.lat), dLng = rad(b.lng-a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
console.log('\npairwise distance:');
const withPos = rows.filter(r => typeof r.lat === 'number');
for (let i=0;i<withPos.length;i++) for (let j=i+1;j<withPos.length;j++) {
  console.log(`  ${withPos[i].name} <-> ${withPos[j].name}: ${metres(withPos[i], withPos[j]).toFixed(1)} m`);
}
process.exit(0);
