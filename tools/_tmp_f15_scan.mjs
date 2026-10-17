import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const iso=t=>t?new Date(t).toISOString().slice(5,19):'-';
const ago=t=>!t?'never':(x=>x<90?Math.round(x)+'s':x<5400?Math.round(x/60)+'m':x<172800?Math.round(x/3600)+'h':(x/86400).toFixed(1)+'d')((now-t)/1000);
const devs=(await db.ref('gl/_diag/devices').get()).val()||{};
const users=(await db.ref('gl/our_crew/users').get()).val()||{};
const diag=(await db.ref('gl/our_crew/diag').get()).val()||{};
const devOwner=(await db.ref('gl/_devOwner').get()).val()||{};
const MAIN=['fixTs','fgTs','nb'];
console.log('device   name          plat     web  native   row-age  shape        devOwner  denied(users|<me>)');
for (const [id,u] of Object.entries(users)) {
  const d=devs[id]||{}, g=diag[id]||{};
  const keys=Object.keys(u);
  const shape = keys.some(k=>MAIN.includes(k)) ? 'main/ios' : (keys.includes('oss')?'ios-native':'headless?');
  const den=(d.denied||{}); const ud=Object.entries(den).filter(([k])=>/users\|<me>/.test(k)).map(([k,v])=>iso(v.last)+' n='+v.n).join(' ');
  console.log((id.slice(0,8)).padEnd(9),(u.name||'?').padEnd(13),(String(d.plat||'-')).padEnd(8),String(d.web||g.build||'-').padEnd(4),String(d.native||g.nativeVer||'-').padEnd(8),ago(u.ts).padStart(7),' ',shape.padEnd(12),(devOwner[id]?'acct':'-').padEnd(9),ud||'-');
}
process.exit(0);
