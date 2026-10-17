import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(); const iso=t=>new Date(t).toISOString();
const PH='nydZQWbh2kOJ1XwBfjiMxoJTYjK2';
const d=(await db.ref('gl/_diag/devices/'+PH).get()).val();
console.log('== _diag/devices/phone ==\n', JSON.stringify(d,null,1).slice(0,3000));
// the phone's row in every room it fans out to: ts + key shape
const gl=(await db.ref('gl').get()).val()||{};
console.log('\n== phone row per room ==');
for(const [room,r] of Object.entries(gl)){ if(room[0]==='_') continue; const u=r&&r.users&&r.users[PH]; if(u) console.log(room.padEnd(22), iso(u.ts), 'fixTs', u.fixTs?iso(u.fixTs):'-', 'keys', Object.keys(u).sort().join(',')); }
// sessions node
const s=(await db.ref('gl/_users/'+PH+'/sessions').get()).val();
console.log('\n== _users/phone/sessions ==', JSON.stringify(s));
// uptime samples for the phone today
const up=(await db.ref('gl/_uptime/2026-10-17/'+PH).get()).val();
console.log('\n== _uptime today phone ==', JSON.stringify(up&&{name:up.name,samples:up.samples,fresh:up.fresh}));
// how many anon users created per day over the last 10 days, to see if the rate is abnormal
let token, byDay={};
do { const r=await admin.auth().listUsers(1000, token); token=r.pageToken; for(const u of r.users){ const anon=!u.providerData||u.providerData.length===0; const day=new Date(u.metadata.creationTime).toISOString().slice(0,10); if(day>='2026-10-01'){ byDay[day]=byDay[day]||{anon:0,acct:0}; byDay[day][anon?'anon':'acct']++; } } } while(token);
console.log('\n== auth users created per day since 10-01 ==');
Object.keys(byDay).sort().forEach(k=>console.log(k, JSON.stringify(byDay[k])));
process.exit(0);
