// One-off, 2026-11-18: Jace's old phone (device TPwPaJUz...) was signed out of Jace's account and into
// Max's brand-new one. Sign-out kept Jace's local data and the first sign-in pushed it into Max's
// profile. This empties what was copied into Max's account and takes the old phone's rows out of
// Jace's crews. Backs everything up first.  Usage: node tools/fix-max-account-2026-11-18.mjs [--apply]
import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Documents/GroundLink/.keys/tracker-58b87-firebase-adminsdk-fbsvc-1f0441c5d4.json', 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const MAX = 'lnEUTQDna9POvNIy53RGeLc832Z2';
const DEV = 'TPwPaJUzByUr90rR0glyeJs0sls2';
const CREWS = ['family_men', 'jace_devices', 'our_crew', 'outkasts'];
const apply = process.argv.includes('--apply');

const backup = { profile: (await db.ref('gl/_users/' + MAX).get()).val(), directory: (await db.ref('gl/_directory/' + MAX).get()).val(), crews: {} };
for (const c of CREWS) {
  backup.crews[c] = {};
  for (const b of ['users', 'members', 'presence', 'pushSubs', 'favSubs']) {
    const v = (await db.ref(`gl/${c}/${b}/${DEV}`).get()).val();
    if (v !== null) backup.crews[c][b] = v;
  }
}
const file = `tools/max-fix-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(backup, null, 1));
console.log('backup ->', file);
const name = (await admin.auth().getUser(MAX)).displayName || '';
const upd = {};
for (const k of ['circles', 'friends', 'memberHidden', 'muted', 'pinMuted', 'favs', 'pins', 'pinsDel', 'tracks', 'tracksDel', 'mycolor']) upd[`gl/_users/${MAX}/${k}`] = null;
upd[`gl/_users/${MAX}/name`] = name;
upd[`gl/_users/${MAX}/nameCustom`] = false;
upd[`gl/_users/${MAX}/updated`] = Date.now();
if (backup.directory) upd[`gl/_directory/${MAX}/name`] = name;
for (const c of CREWS) for (const b of Object.keys(backup.crews[c])) upd[`gl/${c}/${b}/${DEV}`] = null;
console.log(Object.keys(upd).map(k => k + ' = ' + JSON.stringify(upd[k])).join('\n'));
if (!apply) { console.log('\n(dry run - add --apply)'); process.exit(0); }
await db.ref().update(upd);
console.log('\napplied');
process.exit(0);
