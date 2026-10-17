import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const iso=t=>t?new Date(t).toISOString().slice(11,23):'-';
const ago=t=>!t?'never':(x=>x<90?Math.round(x)+'s':x<5400?Math.round(x/60)+'m':x<172800?Math.round(x/3600)+'h':(x/86400).toFixed(1)+'d')((now-t)/1000);
const PHONE='nydZQWbh', TAB='qWI4JP';
const users=(await db.ref('gl/our_crew/users').get()).val()||{};
const diag=(await db.ref('gl/our_crew/diag').get()).val()||{};
const devOwner=(await db.ref('gl/_devOwner').get()).val()||{};
const ids=Object.keys(users);
const phoneId=ids.find(k=>k.startsWith(PHONE)), tabId=ids.find(k=>k.startsWith(TAB));
console.log('phone id', phoneId, 'tab id', tabId);
for (const id of [phoneId, tabId]) {
  if(!id) continue;
  const u=users[id]||{}, d=diag[id]||{};
  console.log('\n==', id, u.name, u.dev);
  console.log(' users row keys:', Object.keys(u).sort().join(','));
  console.log(' ts', iso(u.ts), ago(u.ts), 'fixTs', iso(u.fixTs), 'fgTs', iso(u.fgTs), 'lat/lng', u.lat, u.lng, 'spd', u.spd, 'noGps', u.noGps, 'nb', u.nb);
  console.log(' diag ts', iso(d.ts), ago(d.ts), 'build', d.build, 'wrOk', d.wrOk, 'wrAck', d.wrAck, 'wrErr', d.wrErr, 'wrErrMsg', d.wrErrMsg, 'wrSkip', d.wrSkip, 'wrSkipWhy', d.wrSkipWhy, 'connOk', d.connOk, 'authUid', d.authUid, 'auth', d.auth, 'anon', d.anon, 'bridged', d.bridged);
  console.log(' diag keys:', Object.keys(d).sort().join(','));
  console.log(' _devOwner:', JSON.stringify(devOwner[id]));
}
// debug log today for the phone
const dayStart=Date.UTC(2026,9,17,0,0,0);
const dbg=(await db.ref('gl/our_crew/debug').orderByChild('ts').startAt(dayStart).get()).val()||{};
const rows=Object.values(dbg).filter(r=>r && (String(r.uid||r.who||'').startsWith(PHONE) || String(r.msg||r.m||'').includes(PHONE))).sort((a,b)=>(a.ts||0)-(b.ts||0));
console.log('\n== debug rows today mentioning phone:', rows.length, 'of', Object.keys(dbg).length);
const sample=rows[0]; if(sample) console.log(' sample keys', Object.keys(sample).join(','));
for (const r of rows) console.log(' ', iso(r.ts), String(r.uid||r.who||'').slice(0,8), String(r.msg||r.m||r.text||JSON.stringify(r)).slice(0,220));
process.exit(0);
