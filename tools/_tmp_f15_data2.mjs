import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(); const iso=t=>new Date(t).toISOString();
const PH='nydZQWbh2kOJ1XwBfjiMxoJTYjK2', TAB='qWI4JP172CXXhdX08uMPX2H9xht1', LAURA='2n6kLQu5LpPzzoi5fdVOvvNfQKW2', LEXI='9UoUKc2K0bOzSE5szKv2wuYCXcC3', OLD='TPwPaJUz';
const pr=(label,o)=>{console.log('\n== '+label+' =='); if(!o){console.log('(none)');return;} for(const [k,v] of Object.entries(o)) console.log(k.padEnd(40), JSON.stringify(v), v&&v.last?iso(v.last):'');};
pr('denied phone', (await db.ref('gl/_diag/devices/'+PH+'/denied').get()).val());
pr('denied tablet', (await db.ref('gl/_diag/devices/'+TAB+'/denied').get()).val());
pr('denied Laura', (await db.ref('gl/_diag/devices/'+LAURA+'/denied').get()).val());
pr('denied Lexi', (await db.ref('gl/_diag/devices/'+LEXI+'/denied').get()).val());
const allDiag=(await db.ref('gl/_diag/devices').get()).val()||{};
console.log('\n== all devices with any denied record (last 7d) ==');
for(const [uid,d] of Object.entries(allDiag)){ const den=d&&d.denied; if(!den) continue; const recent=Object.entries(den).filter(([k,v])=>v.last>Date.now()-7*864e5); if(recent.length) console.log(uid.slice(0,10), recent.map(([k,v])=>k+' n='+v.n+' last='+iso(v.last)).join(' ; ')); }
// history points today
for (const [who,uid] of [['phone',PH],['tablet',TAB]]) {
  const h=(await db.ref('glh/our_crew/'+uid+'/2026-10-17').get()).val()||{};
  const pts=Object.values(h).map(p=>p.ts||p.t).filter(Boolean).sort((a,b)=>a-b);
  console.log('\n== glh/our_crew/'+who+' 2026-10-17: '+pts.length+' pts ==');
  let prev=null; const gaps=[]; for(const t of pts){ if(prev) gaps.push([t-prev,prev,t]); prev=t; }
  gaps.sort((a,b)=>b[0]-a[0]).slice(0,6).forEach(g=>console.log('  gap '+Math.round(g[0]/60000)+'m  '+iso(g[1])+' -> '+iso(g[2])));
  if(pts.length) console.log('  first '+iso(pts[0])+' last '+iso(pts[pts.length-1]));
  const tr=(await db.ref('gl/our_crew/trails/'+uid).get()).val()||{};
  const tts=Object.values(tr).map(p=>p.ts||p.t).filter(Boolean).sort((a,b)=>a-b);
  console.log('  trails: '+tts.length+' pts'+(tts.length?' first '+iso(tts[0])+' last '+iso(tts[tts.length-1]):''));
}
// debug log: all, filter client side
const dbgAll=(await db.ref('gl/our_crew/debug').limitToLast(3000).get()).val()||{};
const since=Date.parse('2026-10-17T11:45:00Z');
const rows=Object.values(dbgAll).filter(e=>e&&e.ts>=since).sort((a,b)=>a.ts-b.ts);
console.log('\n== our_crew/debug since 11:45Z ('+rows.length+' rows) ==');
rows.forEach(e=>console.log(iso(e.ts), String(e.msg).slice(0,220)));
// Anonymous auth users created recently
console.log('\n== Firebase Auth: users created since 2026-10-14 ==');
let token=undefined, count=0, anon=0; const recent=[];
do { const r=await admin.auth().listUsers(1000, token); token=r.pageToken; count+=r.users.length;
  for(const u of r.users){ const isAnon=!u.providerData||u.providerData.length===0; if(isAnon) anon++; const c=Date.parse(u.metadata.creationTime); if(c>=Date.parse('2026-10-14T00:00:00Z')) recent.push({uid:u.uid.slice(0,10), anon:isAnon, created:new Date(c).toISOString(), lastSignIn:u.metadata.lastSignInTime, lastRefresh:u.metadata.lastRefreshTime}); }
} while(token);
console.log('total users', count, 'anonymous', anon);
recent.sort((a,b)=>a.created.localeCompare(b.created)).forEach(r=>console.log(r.created, r.anon?'ANON':'acct', r.uid, 'lastSignIn', r.lastSignIn, 'lastRefresh', r.lastRefresh));
process.exit(0);
