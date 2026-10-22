// Write health for a crew, read-only.
//
//   node tools/write-health.mjs
//
// Per device: how old its position row is, and the counters that say whether its writes are
// reaching the server at all -- wrOk (issued) vs wrAck (acknowledged), wrErr with the error
// text, and connDown. wrOk minus wrAck is the number of positions a phone believes it sent
// that never landed; that gap is invisible from inside the app, which is how it hid for
// weeks. meMk is how far that device's own dot is drawn from its own fix.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Documents/GroundLink/.keys/tracker-58b87-firebase-adminsdk-fbsvc-1f0441c5d4.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
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
