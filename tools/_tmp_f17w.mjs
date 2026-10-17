import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(), now=Date.now();
const ago=t=>((now-t)/3600000).toFixed(2)+'h';
const lexi='9UoUKc2K0bOzSE5szKv2wuYCXcC3';
const h=(await db.ref('glh/our_crew/'+lexi+'/2026-10-16').get()).val()||{};
const pts=Object.values(h).sort((a,b)=>a.ts-b.ts);
// gaps > 10 min and points around the diag/disconnect time (18h ago)
const disc=1792178406096, diag=1792178363137;
console.log('diag written '+ago(diag)+', discTs '+ago(disc));
let prev=null; for(const p of pts){ if(prev && p.ts-prev.ts>600000) console.log('gap '+Math.round((p.ts-prev.ts)/60000)+'m from '+ago(prev.ts)+' to '+ago(p.ts)); prev=p; }
const near=pts.filter(p=>Math.abs(p.ts-disc)<2*3600000);
console.log('points within 2h of disconnect: '+near.length+(near.length?' ('+ago(near[0].ts)+' .. '+ago(near[near.length-1].ts)+')':''));
const before=pts.filter(p=>p.ts<disc).slice(-3), after=pts.filter(p=>p.ts>disc).slice(0,3);
console.log('last 3 before disc:', before.map(p=>ago(p.ts)+'/'+p.src).join(' '), '| first 3 after:', after.map(p=>ago(p.ts)+'/'+p.src).join(' '));
console.log('last point overall '+ago(pts[pts.length-1].ts)+' src='+pts[pts.length-1].src);
process.exit(0);
