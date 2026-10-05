import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database();
const root=(await db.ref('gl').get()).val()||{};
const targets=[];
for (const [room,r] of Object.entries(root)) { if(room.startsWith('_')||!r.users) continue;
  for (const [uid,u] of Object.entries(r.users)) {
    const o=u.oss||{}; if(!o.iosVer) continue;
    if (!/jared|j-\s*rod|j rod/i.test(u.name||'')) continue;
    targets.push({ref:`gl/${room}/users/${uid}`, label:`${u.name} (${room})`});
  }}
console.log('watching ' + targets.map(t=>t.label).join(' + ') + ' — ' + new Date().toLocaleTimeString() + '\n');
const last={};
const sample=async()=>{
  let done=false;
  for (const t of targets) {
    const u=(await db.ref(t.ref).get()).val()||{}; const o=u.oss||{};
    const sig=[o.locAlways,o.locWhenInUse,o.authDowns,o.at].join('|');
    if (sig===last[t.ref]) continue;
    last[t.ref]=sig;
    const ver = o.authDowns!==undefined?'1.0.10':(o.bgFixes!==undefined?'1.0.9':'older');
    console.log(`[${new Date().toLocaleTimeString()}] ${t.label.padEnd(26)} always=${String(o.locAlways).padEnd(5)} shell=${ver.padEnd(7)} downgrades=${o.authDowns ?? '-'} settingsAge=${o.at?((Date.now()-o.at)/1000).toFixed(0)+'s':'?'}`);
    if (o.locAlways===true) done=true;
  }
  return done;
};
await sample();
const started=Date.now();
await new Promise(res=>{ const iv=setInterval(async()=>{
  try { if (await sample()) { console.log('\n>>> ALWAYS in effect.'); clearInterval(iv); return res(); } } catch(e){}
  if (Date.now()-started>420000){ clearInterval(iv); res(); }
}, 12000); });
console.log('\nwatch ended ' + new Date().toLocaleTimeString());
process.exit(0);
