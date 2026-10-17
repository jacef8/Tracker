import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database();
const iso=t=>t?new Date(t).toISOString().slice(5,23):'-';
const PHONE='nydZQWbh2kOJ1XwBfjiMxoJTYjK2', TAB='qWI4JP172CXXhdX08uMPX2H9xht1', OLD='TPwPaJUzByUr90rR0glyeJs0sls2';
for (const id of [PHONE,TAB,OLD]) {
  const d=(await db.ref('gl/_diag/devices/'+id).get()).val()||{};
  console.log('\n== _diag/devices/'+id.slice(0,8), 'keys:', Object.keys(d).join(','));
  const den=d.denied||{};
  for (const [k,v] of Object.entries(den).sort((a,b)=>(a[1].last||0)-(b[1].last||0))) console.log('  ', iso(v.last), 'n='+v.n, k, v.code||'');
}
const dayStart=Date.UTC(2026,9,17,0,0,0);
const dbg=(await db.ref('gl/our_crew/debug').limitToLast(3000).get()).val()||{};
const all=Object.values(dbg).filter(r=>(r.ts||0)>=dayStart).sort((a,b)=>(a.ts||0)-(b.ts||0));
console.log('\n== ALL debug rows today (Jace Ford only):');
for (const r of all.filter(r=>/^Jace Ford/.test(r.msg||''))) console.log(' ', iso(r.ts), String(r.msg).slice(0,230));
console.log('\n== glh history points today');
for (const id of [PHONE,TAB]) {
  const h=(await db.ref('glh/our_crew/'+id+'/2026-10-17').get()).val()||{};
  const pts=Object.values(h).sort((a,b)=>a.ts-b.ts);
  let gaps=[]; for(let i=1;i<pts.length;i++){const g=pts[i].ts-pts[i-1].ts; if(g>5*60000) gaps.push(iso(pts[i-1].ts)+'->'+iso(pts[i].ts)+' ('+Math.round(g/60000)+'m)');}
  console.log(' ', id.slice(0,8), 'points', pts.length, 'first', iso(pts[0]?.ts), 'last', iso(pts[pts.length-1]?.ts), 'srcs', [...new Set(pts.map(p=>p.src||'web'))].join(','), '\n    gaps>5m:', gaps.join('; ')||'none');
}
process.exit(0);
