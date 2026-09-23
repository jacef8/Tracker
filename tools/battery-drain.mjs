// Battery drain per person per day, from the keep-alive sweep's samples (gl/_uptime/<day>/<uid>.batt).
//   node tools/battery-drain.mjs            -> today and yesterday
//   node tools/battery-drain.mjs 2026-09-23 -> one day
// Only discharge stretches count: a segment between two samples is skipped when the phone was
// charging at either end or the level went UP. What's left is %/hour while running on battery —
// the whole phone's drain, not GroundLink's alone, but the before/after comparison across the
// battery changes (build 794, Android 1.4.4, iOS 1.0.6) is the number that matters.
import admin from 'firebase-admin';
import fs from 'fs';

const SA = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(SA, 'utf8'))), databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com' });
const db = admin.database();

const day = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const days = process.argv[2] ? [process.argv[2]] : [day(1), day(0)];

for (const d of days) {
  const all = (await db.ref('gl/_uptime/' + d).get()).val() || {};
  console.log('\n' + d);
  console.log('  ' + 'person'.padEnd(14) + 'on battery'.padStart(11) + '  drop'.padStart(7) + '  per hour'.padStart(10) + '  samples'.padStart(9) + '  range');
  const rows = [];
  for (const [uid, v] of Object.entries(all)) {
    const b = Array.isArray(v.batt) ? v.batt : [];
    if (b.length < 2) { rows.push({ name: v.name || uid.slice(0, 8), none: true, n: b.length }); continue; }
    let hours = 0, drop = 0;
    for (let i = 1; i < b.length; i++) {
      const a = b[i - 1], z = b[i];
      if (a.c || z.c) continue;                 // charging — not a drain measurement
      if (z.b > a.b) continue;                  // went up: was charging in between
      const h = (z.at - a.at) / 36e5;
      if (h <= 0 || h > 3) continue;            // a gap: the phone was off the map, unknown what happened
      hours += h; drop += (a.b - z.b);
    }
    rows.push({ name: v.name || uid.slice(0, 8), hours, drop, n: b.length, lo: Math.min(...b.map(x => x.b)), hi: Math.max(...b.map(x => x.b)) });
  }
  rows.sort((x, y) => (y.hours || 0) - (x.hours || 0));
  for (const r of rows) {
    if (r.none) { console.log('  ' + r.name.padEnd(14) + '(no battery data yet — ' + r.n + ' sample' + (r.n === 1 ? '' : 's') + ')'); continue; }
    const rate = r.hours > 0.5 ? (r.drop / r.hours).toFixed(1) + ' %/h' : 'n/a';
    console.log('  ' + r.name.padEnd(14) + (r.hours.toFixed(1) + ' h').padStart(11) + (r.drop + ' %').padStart(7) + rate.padStart(10) + String(r.n).padStart(9) + '  ' + r.lo + '–' + r.hi + '%');
  }
}
process.exit(0);
