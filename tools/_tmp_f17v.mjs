import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const ago=t=>!t?'-':(x=>x<90?Math.round(x)+'s':x<5400?Math.round(x/60)+'m':x<172800?Math.round(x/3600)+'h':(x/86400).toFixed(1)+'d')((now-t)/1000);
const g=async p=>(await db.ref(p).get()).val();
const lexi='9UoUKc2K', van='EovOlR1x', laura='2n6kLQu5';
const users=await g('gl/our_crew/users')||{};
const full=Object.keys(users).filter(k=>k.startsWith(lexi)||k.startsWith(van)||k.startsWith(laura));
for(const k of full){
  console.log('\n== users/'+k+' ('+users[k].name+') ==');
  const u=users[k]; for(const f of Object.keys(u).sort()) console.log('  '+f+' = '+(typeof u[f]==='object'?JSON.stringify(u[f]).slice(0,200):u[f])+((/Ts|^ts$|Since|^at$/.test(f)&&typeof u[f]==='number')?'   ['+ago(u[f])+']':''));
  const d=await g('gl/_diag/devices/'+k); console.log('  _diag/devices settings='+JSON.stringify(d&&d.settings)+' keys='+(d?Object.keys(d).join(','):'none'));
  const dg=await g('gl/our_crew/diag/'+k); if(dg) console.log('  room diag: build='+dg.build+' nativeVer='+dg.nativeVer+' nativeBuild='+dg.nativeBuild+' fixSrc='+dg.fixSrc+' gotNative='+dg.gotNative+' lastFixAgo='+dg.lastFixAgo+' lastWriteAgo='+dg.lastWriteAgo+' vis='+dg.vis+' ts='+ago(dg.ts)+' wrOk='+dg.wrOk+' wrSkip='+dg.wrSkip+' wrSkipWhy='+dg.wrSkipWhy+' meAt='+JSON.stringify(dg.meAt));
  const cov=await g('gl/our_crew/coverage/'+k); if(cov) console.log('  coverage='+JSON.stringify(cov).slice(0,300));
}
console.log('\n_shareState/our_crew='+JSON.stringify(await g('gl/_shareState/our_crew')));
// trail history for Lexi last 3 days to see when native wrote
for(const day of ['2026-10-14','2026-10-15','2026-10-16','2026-10-17']){
  const h=await g('glh/our_crew/'+full.find(k=>k.startsWith(lexi))+'/'+day)||{};
  const pts=Object.values(h).sort((a,b)=>a.ts-b.ts);
  if(pts.length) console.log('lexi glh '+day+': '+pts.length+' pts, first '+ago(pts[0].ts)+' last '+ago(pts[pts.length-1].ts)+' src='+[...new Set(pts.map(p=>p.src))].join('/'));
}
process.exit(0);
