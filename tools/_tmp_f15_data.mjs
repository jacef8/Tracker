import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),databaseURL:'https://tracker-58b87-default-rtdb.firebaseio.com'});
const db=admin.database(); const now=Date.now();
const iso=t=>new Date(t).toISOString();
const users=(await db.ref('gl/our_crew/users').get()).val()||{};
console.log('== our_crew users ==');
for(const [k,v] of Object.entries(users)){ console.log(k, '|', v.name, v.dev, 'ts', v.ts?iso(v.ts):'-', 'fixTs', v.fixTs?iso(v.fixTs):'-', 'fgTs', v.fgTs?iso(v.fgTs):'-', 'keys:', Object.keys(v).sort().join(',')); }
const jace=Object.keys(users).find(k=>k.startsWith('nydZQWbh')); const tab=Object.keys(users).find(k=>k.startsWith('qWI4JP'));
console.log('\njace phone uid', jace, 'tablet uid', tab);
console.log('\n== _devOwner for phone ==', JSON.stringify((await db.ref('gl/_devOwner/'+jace).get()).val()), (await db.ref('gl/_devOwner/'+jace+'/ts').get()).val() ? iso((await db.ref('gl/_devOwner/'+jace+'/ts').get()).val()) : '');
console.log('== _devOwner for tablet ==', JSON.stringify((await db.ref('gl/_devOwner/'+tab).get()).val()));
console.log('\n== diag phone ==', JSON.stringify((await db.ref('gl/our_crew/diag/'+jace).get()).val()));
console.log('\n== diag tablet ==', JSON.stringify((await db.ref('gl/our_crew/diag/'+tab).get()).val()));
const since=Date.parse('2026-10-17T11:30:00Z');
const dbg=(await db.ref('gl/our_crew/debug').orderByChild('ts').startAt(since).get()).val()||{};
console.log('\n== our_crew/debug since 11:30Z ('+Object.keys(dbg).length+') ==');
Object.values(dbg).sort((a,b)=>a.ts-b.ts).forEach(e=>console.log(iso(e.ts), e.msg));
process.exit(0);
