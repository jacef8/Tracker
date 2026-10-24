// Tell every open app to pick up the new build. Must be an OBJECT ({ts, by}) — a bare value
// does not match what the client listens for.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Documents/GroundLink/.keys/tracker-58b87-firebase-adminsdk-fbsvc-1f0441c5d4.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
await admin.database().ref('_forceReload').set({ ts: Date.now(), by: 'build-961' });
console.log('force reload sent');
process.exit(0);
