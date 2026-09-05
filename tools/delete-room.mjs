// Delete a room for good.
//
// Deleting gl/<key> alone does NOT stick. Firebase recreates parent nodes on write, so any
// device still holding the room rebuilds it with its very next position write -- that is what
// happened to my_girls, which came back within minutes on all four devices. The tombstone at
// gl/_deadRooms/<key> is what makes it permanent: clients read it and refuse to write to the
// room, and only the admin SDK can set it (the security rules grant clients no write there,
// which is also why the in-app "delete group" cannot actually delete anything).
//
// Usage:  node tools/delete-room.mjs test
//         node tools/delete-room.mjs test --dry

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const KEY = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const room = args.find((a) => !a.startsWith('--'));

if (!room) {
  console.error('Which room? e.g.  node tools/delete-room.mjs test');
  process.exit(1);
}
// Guard against a typo taking out a live crew.
const PROTECTED = ['our_crew', 'family_men', 'jace_devices', 'the_best_grandkids'];
if (PROTECTED.includes(room)) {
  console.error(`Refusing: "${room}" is a live crew. Remove it from PROTECTED in this file if you really mean it.`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();

const room_data = (await db.ref(`gl/${room}`).get()).val();
const hist = (await db.ref(`glh/${room}`).get()).val();
if (!room_data && !hist) {
  console.log(`Nothing at gl/${room} — already gone.`);
  process.exit(0);
}

// Always keep a copy. This is the only copy.
const backup = `C:/Users/jford/Documents/GroundLink/tools/deleted-room-${room}.json`;
writeFileSync(backup, JSON.stringify({ room, gl: room_data, glh: hist }, null, 2));
console.log(`backup written: ${backup}`);

const users = (room_data && room_data.users) || {};
const members = (room_data && room_data.members) || {};
console.log(`\ngl/${room}: ${Object.keys(users).length} device row(s), ${Object.keys(members).length} member(s), history for ${Object.keys(hist || {}).length} device(s)`);

if (dry) {
  console.log(`\nWOULD delete gl/${room} and glh/${room}, and tombstone gl/_deadRooms/${room}`);
  console.log('(dry run — nothing changed)');
  process.exit(0);
}

// Tombstone FIRST. If the delete lands first, a device can rebuild the room in the gap.
await db.ref(`gl/_deadRooms/${room}`).set(Date.now());
console.log(`tombstoned  gl/_deadRooms/${room}`);
await db.ref(`gl/${room}`).remove();
console.log(`deleted     gl/${room}`);
await db.ref(`glh/${room}`).remove();
console.log(`deleted     glh/${room}`);

const left = (await db.ref('gl').get()).val() || {};
console.log('\nrooms remaining:', Object.keys(left).filter((k) => k[0] !== '_').join(', '));
console.log('tombstones:', Object.keys((await db.ref('gl/_deadRooms').get()).val() || {}).join(', '));
process.exit(0);
