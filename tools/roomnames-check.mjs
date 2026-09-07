// Exercise the exact _roomNames() logic from server.js against the real database, so the fix
// is proven before it ships rather than after Jared's family stops getting notifications again.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const DB_URL = 'https://tracker-58b87-default-rtdb.firebaseio.com';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: DB_URL,
});

console.log('BEFORE (anonymous, what production does today):');
const bad = await (await fetch(DB_URL + '/gl.json?shallow=true')).json();
console.log('  payload:', JSON.stringify(bad));
console.log('  Object.keys():', JSON.stringify(Object.keys(bad || {}).filter(k => k[0] !== '_')));

console.log('\nAFTER (authenticated, the fix):');
const cred = admin.app().options.credential;
const tok = await cred.getAccessToken();
let url = DB_URL + '/gl.json?shallow=true&access_token=' + encodeURIComponent(tok.access_token);
const j = await (await fetch(url)).json();
if (!j || typeof j !== 'object' || j.error) throw new Error('room list: ' + ((j && j.error) || 'empty'));
const rooms = Object.keys(j).filter(k => k[0] !== '_');
console.log('  rooms:', JSON.stringify(rooms));

// And the whole point: can we now find Laura?
const UID = 'z1gGJRKAf2bwymun9EW13dhaDxq1';
let found = null;
for (const room of rooms) {
  for (const branch of ['pushSubs', 'favSubs']) {
    const rec = (await admin.database().ref(`gl/${room}/${branch}/${UID}`).get()).val();
    if (rec && (rec.fcm || rec.sub)) { found = { room, branch, rec }; break; }
  }
  if (found) break;
}
console.log('\n  findSubsForUid(Laura):', found ? `FOUND in ${found.room}/${found.branch} (${found.rec.name})` : 'not found');
process.exit(0);
