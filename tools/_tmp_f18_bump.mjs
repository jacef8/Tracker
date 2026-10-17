// READ-ONLY: can the server even reach Vanesa's phone with a bump? And when did her WebView disconnect?
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const V = 'EovOlR1xzxVGDU0rVR1nJbfRQGA3', L = '9UoUKc2K0bOzSE5szKv2wuYCXcC3';
const iso = t => t ? new Date(t).toISOString() : '-';
const g = async p => (await db.ref(p).get()).val();
for (const [who, uid] of [['Vanesa', V], ['Lexi', L]]) {
  console.log('\n=====', who, uid);
  const row = await g('gl/our_crew/users/' + uid);
  console.log(' discTs=', iso(row && row.discTs), ' ts=', iso(row && row.ts), ' hunt=', JSON.stringify(row && row.hunt), ' nb=', JSON.stringify(row && row.nb), ' path=', row && row.path ? row.path.length + ' pts' : row && row.path);
  const voip = await g('gl/_voipSubs/' + uid); console.log(' _voipSubs:', voip ? Object.keys(voip).join(',') + ' ts=' + iso(voip.ts) + ' plat=' + voip.plat : null);
  const ptt = await g('gl/_pttSubs/' + uid); console.log(' _pttSubs:', ptt ? Object.keys(ptt).join(',') + ' ts=' + iso(ptt.ts) : null);
  const ps = await g('gl/our_crew/pushSubs/' + uid); console.log(' our_crew/pushSubs:', ps ? Object.keys(ps).join(',') + ' ts=' + iso(ps.ts) : null);
  const fs_ = await g('gl/our_crew/favSubs/' + uid); console.log(' our_crew/favSubs:', fs_ ? JSON.stringify(fs_).slice(0, 300) : null);
  const ss = await g('gl/_shareState/our_crew/' + uid); console.log(' _shareState:', JSON.stringify(ss));
  const dbg = await g('gl/_debug/lastBump'); if (who === 'Vanesa') console.log(' _debug/lastBump:', JSON.stringify(dbg).slice(0, 400));
}
// any _debug nodes mentioning bumps / wake
const dbgAll = await g('gl/_debug') || {};
console.log('\n_debug keys:', Object.keys(dbgAll).join(', '));
for (const k of Object.keys(dbgAll)) if (/bump|wake|keep/i.test(k)) console.log(' ', k, JSON.stringify(dbgAll[k]).slice(0, 600));
// trail history for Vanesa in our_crew around Oct 9 (glh/our_crew/<uid>/<date>)
for (const d of ['2026-10-08', '2026-10-09', '2026-10-10']) {
  const h = await g('glh/our_crew/' + V + '/' + d) || {};
  const pts = Object.values(h).sort((a, b) => a.ts - b.ts);
  console.log(`\nglh our_crew Vanesa ${d}: ${pts.length} pts`, pts.length ? `first ${iso(pts[0].ts)} last ${iso(pts[pts.length-1].ts)} src=${[...new Set(pts.map(p=>p.src||'web'))].join('/')}` : '');
}
process.exit(0);
