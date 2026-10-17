import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const iso=t=>t?new Date(t).toISOString().slice(5,23):'-';
const PHONE='nydZQWbh', TAB='qWI4JP';
const dayStart=Date.UTC(2026,9,17,0,0,0);
const dbg=(await db.ref('gl/our_crew/debug').limitToLast(3000).get()).val()||{};
const all=Object.entries(dbg).map(([k,r])=>({k,...r})).filter(r=>(r.ts||0)>=dayStart).sort((a,b)=>(a.ts||0)-(b.ts||0));
console.log('debug rows today:', all.length, 'sample keys:', all[0]?Object.keys(all[0]).join(','):'-');
const mine=all.filter(r=>JSON.stringify(r).includes(PHONE));
console.log('rows mentioning phone:', mine.length);
for (const r of mine) { const {k,ts,...rest}=r; console.log(' ', iso(ts), JSON.stringify(rest).slice(0,260)); }
console.log('\n== rows mentioning PERMISSION or anonymous or bridge or headless or swap (any device) today');
for (const r of all.filter(r=>/PERMISSION|anonym|bridge|headless|identity|signed|swap|refused/i.test(JSON.stringify(r)))) { const {k,ts,...rest}=r; console.log(' ', iso(ts), JSON.stringify(rest).slice(0,260)); }
// uptime + coverage + history counts
const up=(await db.ref('gl/_uptime/2026-10-17').get()).val()||{};
for (const [id,v] of Object.entries(up)) if (id.startsWith(PHONE)||id.startsWith(TAB)) console.log('\nuptime', id.slice(0,8), v.name, 'samples', v.samples, 'fresh', v.fresh);
const cov=(await db.ref('gl/our_crew/coverage').get()).val()||{};
for (const [id,v] of Object.entries(cov)) if (id.startsWith(PHONE)) console.log('coverage', id.slice(0,8), JSON.stringify(v).slice(0,400));
for (const p of ['gl/our_crew/history','gl/our_crew/trails','gl/our_crew/hist']) {
  const s=(await db.ref(p).get()); if(!s.exists()) { console.log(p,'(absent)'); continue; }
  const v=s.val(); console.log('\n'+p, 'children:', Object.keys(v).slice(0,10).join(','));
  for (const id of Object.keys(v)) if (id.startsWith(PHONE)||id.startsWith(TAB)) { const pts=Object.values(v[id]||{}).filter(x=>x&&(x.ts||x.t||0)>=dayStart); const tss=pts.map(x=>x.ts||x.t).sort((a,b)=>a-b); console.log(' ', id.slice(0,8), 'points today', pts.length, 'first', iso(tss[0]), 'last', iso(tss[tss.length-1])); }
}
process.exit(0);
