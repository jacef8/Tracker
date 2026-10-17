import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const ago=t=>!t?'never':(x=>x<90?Math.round(x)+'s':x<5400?Math.round(x/60)+'m':x<172800?Math.round(x/3600)+'h':(x/86400).toFixed(1)+'d')((now-t)/1000);
const u=(await db.ref('gl/our_crew/users').get()).val()||{};
const d=(await db.ref('gl/our_crew/diag').get()).val()||{};
for(const [k,v] of Object.entries(u)){const g=d[k]||{};
  if(!g.build) continue;
  console.log((v.name||'?').padEnd(12),(v.dev||'-').padEnd(7),'pos '+ago(v.fixTs||v.ts||0).padStart(6),
   '| web '+String(g.build).padEnd(4),'diag '+ago(g.ts).padStart(6),
   'wrOk='+(g.wrOk??'-'),'wrAck='+(g.wrAck??'-'),'wrErr='+(g.wrErr??'-'),
   'ackAgo='+(g.ackAgo??'-'),'conn='+(g.connOk===undefined?'-':g.connOk),
   'down='+(g.connDown??'-')+'/'+(g.connDownMax??'-'),
   'meMk='+(g.meMk||'-'),(g.wrErrMsg?'ERR:'+g.wrErrMsg:''));}
process.exit(0);
