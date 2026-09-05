// Remove stale duplicate PEOPLE from the search directory (gl/_directory).
//
// The directory is what the invite / people search reads. When someone signed in again under a
// new account -- a reinstall, switching from anonymous to Google, a second Google account --
// their old entry stayed behind, so they appear twice under slightly different names.
//
// SCOPE, deliberately narrow: this touches gl/_directory and NOTHING else. It does not delete
// accounts, devices, rooms, pins or location history. Removing a directory entry only stops a
// stale name showing up in people search; it cannot break anyone's tracking.
//
// The trap this avoids: an old ACCOUNT id often lives on as a DEVICE id under the new account.
// Lexi's old account 9UoUKc2K0b is the device id her current account UoHSbvxVVD reports from.
// Deleting the directory row is safe; deleting that id from _devOwner or the room would stop
// her phone being recognised. This script never goes near those.
//
// Usage:  node tools/dedupe-directory.mjs --dry
//         node tools/dedupe-directory.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const KEY = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
const dry = process.argv.includes('--dry');

// Confirmed duplicates: the same person under more than one account. Keep the most recently
// used login; drop the older directory rows. Anything ambiguous is left alone on purpose --
// "Jared" and "Jared Roberts" may well be two different people, and this cannot tell.
const DROP = [
  { acct: 'aT1tK4tApBZi3XxSJlVpKQdVwUt2', was: 'Justin',  keep: 'Justin Ford (31 Jul, newer)' },
  { acct: '9UoUKc2K0bOzSE5szKv2wuYCXcH3', was: 'Lexi',    keep: 'Lexi Ford (29 Aug, newer)' },
  { acct: 'enUDyoXn01S5xwvxpJoTSRz9tvC2', was: 'Lexi',    keep: 'Lexi Ford (29 Aug, newer)' },

  // Test logins from building the app. They are real accounts, but nobody is behind them, and
  // they surface in every people search the family runs.
  { acct: 'nyLRG0aMqr', was: 'ClaudeTester', keep: 'test account, no person behind it' },
  { acct: 'mYvTkdva2n', was: 'DebugTester',  keep: 'test account, no person behind it' },
  { acct: 'kfcWMyvcn3', was: 'Jace-PC',      keep: 'test login; the real PC reports under the Jace account' },
  { acct: 'KGuX8C9vTk', was: 'I',            keep: 'a stray one-letter name, not a person' },
  { acct: 'bV8MiTqtMV', was: 'Explorer',     keep: 'judgement call — a default-looking name, never renamed' },
];

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();

const dir = (await db.ref('gl/_directory').get()).val() || {};
const backup = 'C:/Users/jford/Documents/GroundLink/tools/directory-backup.json';
writeFileSync(backup, JSON.stringify(dir, null, 2));
console.log(`backup written: ${backup}  (${Object.keys(dir).length} entries)\n`);

let n = 0;
for (const d of DROP) {
  // Match on the prefix actually present, since ids were listed truncated.
  const key = Object.keys(dir).find((k) => k.startsWith(d.acct.slice(0, 10)));
  if (!key) { console.log(`SKIP  ${d.was}: no directory entry found`); continue; }
  const cur = dir[key];
  if ((cur.name || '') !== d.was) {
    console.log(`SKIP  ${key.slice(0, 10)}: name is now "${cur.name}", expected "${d.was}" — leaving it alone`);
    continue;
  }
  if (dry) { console.log(`WOULD REMOVE  "${cur.name}"  ${key.slice(0, 12)}   (keeping ${d.keep})`); continue; }
  await db.ref('gl/_directory/' + key).remove();
  n++;
  console.log(`removed  "${cur.name}"  ${key.slice(0, 12)}   (keeping ${d.keep})`);
}

const after = (await db.ref('gl/_directory').get()).val() || {};
console.log(`\ndirectory: ${Object.keys(after).length} entries`);
console.log(dry ? '(dry run — nothing changed)' : `${n} removed`);
process.exit(0);
