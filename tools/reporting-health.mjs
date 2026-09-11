// Is anyone actually reporting in the BACKGROUND, or only while the app is open?
//
// ts/fixTs are written by the native background service. fgTs is stamped only by a visible
// page (_fgBeat). If a person's last fix and their last foreground beat are always the same
// moment, their phone is only ever reporting while they are looking at it — which is exactly
// the "everyone has to turn the app on" complaint.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();
const ago = t => !t ? '   never' : (d => d < 60 ? Math.round(d) + 'm' : d < 1440 ? Math.round(d/60) + 'h' : (d/1440).toFixed(1) + 'd')((now - t) / 60000).padStart(8);

const gl = (await db.ref('gl').get()).val() || {};
const rooms = Object.keys(gl).filter(k => k[0] !== '_');

console.log('person          dev      last fix   last foreground   gap        verdict');
const seen = new Set();
for (const room of rooms) {
  for (const [uid, u] of Object.entries(gl[room].users || {})) {
    if (!u || !u.name || seen.has(uid)) continue;
    seen.add(uid);
    const fix = u.fixTs || u.ts || 0;
    const fg  = u.fgTs || 0;
    // A fix meaningfully newer than the last foreground beat proves the background service ran.
    const gapMin = (fix && fg) ? (fix - fg) / 60000 : null;
    let verdict;
    if (!fix) verdict = 'never reported';
    else if (!fg) verdict = 'no foreground beat recorded';
    else if (gapMin > 10) verdict = 'BACKGROUND REPORTING WORKS (+' + Math.round(gapMin) + 'm after app closed)';
    else if (gapMin > -10) verdict = 'fix only while app was open';
    else verdict = 'foreground newer than fix — app open, GPS not reporting';
    console.log(
      (u.name || '?').slice(0,14).padEnd(15),
      (u.dev || '-').padEnd(7),
      ago(fix), '  ', ago(fg), '  ',
      (gapMin === null ? '   -' : (gapMin >= 0 ? '+' : '') + Math.round(gapMin) + 'm').padStart(7),
      ' ', verdict
    );
  }
}

// How often does a fix actually land? The trail is the only per-person time series we keep.
console.log('\n\nfix cadence from trails (last 24h):');
for (const room of rooms) {
  const trails = gl[room].trails || {};
  for (const [uid, t] of Object.entries(trails)) {
    const pts = Object.values(t || {}).filter(p => p && p.ts && (now - p.ts) < 86400000).map(p => p.ts).sort((a,b)=>a-b);
    if (pts.length < 2) continue;
    const name = (gl[room].users?.[uid]?.name) || uid.slice(0,8);
    const spans = [];
    for (let i = 1; i < pts.length; i++) spans.push((pts[i] - pts[i-1]) / 60000);
    spans.sort((a,b)=>a-b);
    const med = spans[Math.floor(spans.length/2)];
    console.log(`  ${room.padEnd(14)} ${name.slice(0,14).padEnd(15)} ${String(pts.length).padStart(4)} fixes  median gap ${med.toFixed(1)}m  longest ${Math.max(...spans).toFixed(0)}m`);
  }
}
process.exit(0);
