// READ-ONLY verification helper for finding F15. Deleted when done.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const iso=t=>t?new Date(t).toISOString().slice(0,23):'-';
const ago=t=>!t?'never':(x=>x<90?Math.round(x)+'s':x<5400?Math.round(x/60)+'m':x<172800?Math.round(x/3600)+'h':(x/86400).toFixed(1)+'d')((now-t)/1000);
const PHONE='nydZQWbh2kOJ1XwBfjiMxoJTYjK2', TAB='qWI4JP172CXXhdX08uMPX2H9xht1', OLD='TPwPaJUz';

console.log('now', iso(now));
// 1) refusal tally
for (const id of [PHONE, TAB]) {
  const den=(await db.ref('gl/_diag/devices/'+id+'/denied').get()).val()||{};
  console.log('\n== denied tally', id.slice(0,8));
  for (const [k,v] of Object.entries(den)) console.log('  ', k, 'n=',v.n, 'last=',iso(v.last), ago(v.last), 'code=',v.code);
  const dg=(await db.ref('gl/_diag/devices/'+id).get()).val()||{};
  console.log('  other _diag keys:', Object.keys(dg).filter(k=>k!=='denied').join(','));
  for (const k of Object.keys(dg).filter(k=>k!=='denied')) { const v=dg[k]; if (v && typeof v==='object') console.log('   ', k, JSON.stringify(v).slice(0,400)); else console.log('   ', k, v); }
}
// 2) rooms the phone appears in
const idx=(await db.ref('gl/_roomIndex').get()).val()||{};
const rooms=Object.keys(idx);
console.log('\n== roomIndex rooms:', rooms.length);
for (const r of rooms) {
  const u=(await db.ref('gl/'+r+'/users/'+PHONE).get()).val();
  if (u) console.log('  ', r, 'ts', iso(u.ts), ago(u.ts), 'lat', u.lat, 'lng', u.lng, 'spd', u.spd, 'keys', Object.keys(u).sort().join(','));
}
// 3) history counts today (UTC day and local day)
for (const d of ['2026-10-16','2026-10-17']) for (const id of [PHONE, TAB]) {
  const h=(await db.ref('glh/our_crew/'+id+'/'+d).get()).val()||{};
  const pts=Object.values(h).sort((a,b)=>a.ts-b.ts);
  let gaps=[]; for (let i=1;i<pts.length;i++){ const g=pts[i].ts-pts[i-1].ts; if (g>5*60000) gaps.push(iso(pts[i-1].ts).slice(11,19)+'->'+iso(pts[i].ts).slice(11,19)+' ('+Math.round(g/60000)+'m)'); }
  console.log('\n== glh', d, id.slice(0,8), 'points', pts.length, pts.length?('first '+iso(pts[0].ts)+' last '+iso(pts[pts.length-1].ts)):'', 'srcs', [...new Set(pts.map(p=>p.src))].join('/'));
  if (gaps.length) console.log('   gaps>5m:', gaps.join('; '));
}
// 4) debug log: last 4000 by key (push keys are chronological), filter to today 11:30Z-14:00Z
const dbg=(await db.ref('gl/our_crew/debug').orderByKey().limitToLast(4000).get()).val()||{};
const rows=Object.values(dbg).filter(r=>r&&r.ts).sort((a,b)=>a.ts-b.ts);
console.log('\n== debug rows fetched', rows.length, rows.length?('span '+iso(rows[0].ts)+' .. '+iso(rows[rows.length-1].ts)):'');
const from=Date.UTC(2026,9,17,11,30), to=Date.UTC(2026,9,17,14,0);
const win=rows.filter(r=>r.ts>=from&&r.ts<=to);
console.log('   rows in 11:30Z-14:00Z window:', win.length);
for (const r of win) { const m=String(r.msg||''); if (/Jace Ford|identity|anonym|sign|refus|bridge|background|tracker|headless|no room|writes/i.test(m)) console.log('  ', iso(r.ts).slice(11,23), m.slice(0,200)); }
// any rows all day mentioning refused / identity / anonymous
const day=rows.filter(r=>r.ts>=Date.UTC(2026,9,16,0,0)&&/refused|identity|anonym|not signed|gave up|swap/i.test(String(r.msg||'')));
console.log('\n== since 10-16Z: rows mentioning refused/identity/anonymous/swap:', day.length);
for (const r of day) console.log('  ', iso(r.ts).slice(0,23), String(r.msg||'').slice(0,200));
process.exit(0);
