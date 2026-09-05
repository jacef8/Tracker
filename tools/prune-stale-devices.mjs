// Delete device rows that have genuinely stopped reporting.
//
// A stale row is a device that once shared its location and went quiet — a phone that was
// replaced, a reinstall that generated a new device id, a tablet with a dead battery. The app
// already hides duplicates on screen, so this is cleanup at the source, not a fix.
//
// Safety: anything that reported in the last 30 minutes is SKIPPED. Deleting a row that is
// still being written just recreates it seconds later, and would risk removing someone live.
//
// Usage:            node tools/prune-stale-devices.mjs
// Keep the tablet:  node tools/prune-stale-devices.mjs --keep-tablet
// Dry run first:    node tools/prune-stale-devices.mjs --dry

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const KEY  = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
const ROOM = 'our_crew';
const MIN_STALE_MIN = 30;

const dry        = process.argv.includes('--dry');
const keepTablet = process.argv.includes('--keep-tablet');

// The specific rows identified as dead, by device-id prefix.
const TARGETS = [
  { id: '5mRi0bHJDs', who: 'Laura Ford · phone (old device id)' },
  { id: 'EuVKju9G0v', who: 'Laura Ford · phone (duplicate writer)' },
  { id: 'qAPGsevk8U', who: 'Jace · tablet (dead battery)', tablet: true },
];

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();

const all = (await db.ref(`gl/${ROOM}/users`).get()).val() || {};

// Always keep a copy before removing anything — this is family location history.
const backup = `C:/Users/jford/Documents/GroundLink/tools/our_crew_users_backup.json`;
writeFileSync(backup, JSON.stringify(all, null, 2));
console.log(`backup written: ${backup}\n`);

let removed = 0;
for (const [key, row] of Object.entries(all)) {
  const t = TARGETS.find((x) => key.startsWith(x.id));
  if (!t) continue;
  if (t.tablet && keepTablet) { console.log(`KEEP  ${t.who}`); continue; }

  const ageMin = Math.round((now - (row.ts || row.fixTs || 0)) / 60000);
  if (ageMin < MIN_STALE_MIN) {
    console.log(`SKIP  ${t.who} — still reporting (${ageMin}m ago)`);
    continue;
  }
  if (dry) { console.log(`WOULD DELETE  ${t.who} — ${ageMin}m stale`); continue; }
  await db.ref(`gl/${ROOM}/users/${key}`).remove();
  removed++;
  console.log(`deleted  ${t.who} — ${ageMin}m stale`);
}

console.log(`\n--- remaining in ${ROOM} ---`);
const left = (await db.ref(`gl/${ROOM}/users`).get()).val() || {};
for (const [k, v] of Object.entries(left)) {
  const age = Math.round((now - (v.ts || v.fixTs || 0)) / 60000);
  console.log(`${k.slice(0, 10).padEnd(11)} ${(v.name || '?').padEnd(13)} ${('dev=' + (v.dev || '-')).padEnd(11)} ${(age + 'm').padStart(7)}`);
}
console.log(dry ? '\n(dry run — nothing changed)' : `\n${removed} row(s) removed`);
process.exit(0);
