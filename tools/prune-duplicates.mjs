// Keep one identity per person, everywhere.
//
// The earlier prune-stale-devices.mjs only ever touched gl/our_crew/users, and only three
// hardcoded ids. This walks EVERY room and all three identity branches (users, pushSubs,
// favSubs), groups rows by PERSON, keeps the most recently active id, and removes the rest.
//
// Grouping: a device resolves to an account through gl/_devOwner. Where there is no mapping we
// fall back to name + device label, which is the same rule the app's own display dedupe uses.
// Two different devices of the same person (phone vs tablet vs watch) are DIFFERENT identities
// and are both kept — the device label is part of the key.
//
// Safety:
//   * dry run unless you pass --apply
//   * a full JSON backup of everything it would touch is written first, every time
//   * anything that reported within SKIP_RECENT_MIN is never touched
//   * the keeper's push subscription is never removed — that is how a person stays reachable
//
// Usage:
//   node tools/prune-duplicates.mjs            # report only, changes nothing
//   node tools/prune-duplicates.mjs --apply    # actually delete

import { readFileSync, writeFileSync } from 'node:fs';
import admin from 'firebase-admin';

const KEY = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
const SKIP_RECENT_MIN = 30;
// Rows that are not a real person and should go regardless of age.
const JUNK_NAMES = [/^test$/i, /^testing$/i, /^demo$/i];

const apply = process.argv.includes('--apply');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();
const ago = t => !t ? 'never' : (d => d < 60 ? Math.round(d) + 'm' : d < 1440 ? Math.round(d / 60) + 'h' : (d / 1440).toFixed(1) + 'd')((now - t) / 60000);

const gl = (await db.ref('gl').get()).val() || {};
const rooms = Object.keys(gl).filter(k => k[0] !== '_');
const owner = gl._devOwner || {};
const BRANCHES = ['users', 'pushSubs', 'favSubs'];

// ---- gather every identity and everywhere it appears -------------------------------------
const ids = {};   // uid -> { name, dev, newest, rows:[{room,branch,ts}] }
for (const room of rooms) {
  for (const branch of BRANCHES) {
    for (const [uid, rec] of Object.entries(gl[room][branch] || {})) {
      if (!rec || typeof rec !== 'object') continue;
      const ts = rec.fixTs || rec.ts || 0;
      const e = ids[uid] = ids[uid] || { name: '', dev: '', newest: 0, rows: [] };
      if (rec.name && !e.name) e.name = rec.name;
      if (rec.dev && !e.dev) e.dev = rec.dev;
      if (ts > e.newest) e.newest = ts;
      e.rows.push({ room, branch, ts });
    }
  }
}

// ---- group by person ----------------------------------------------------------------------
const groups = {};
for (const [uid, e] of Object.entries(ids)) {
  const acct = owner[uid]?.acct;
  const key = (acct ? 'a:' + acct : 'n:' + e.name) + '|' + (e.dev || '');
  (groups[key] = groups[key] || []).push({ uid, ...e });
}

const doomed = [];   // { uid, why, rows }

// duplicates: same person, same device label, more than one id
for (const [key, list] of Object.entries(groups)) {
  if (list.length < 2) continue;
  list.sort((a, b) => b.newest - a.newest);
  const keeper = list[0];
  for (const loser of list.slice(1)) {
    const mins = (now - loser.newest) / 60000;
    if (mins < SKIP_RECENT_MIN) continue;          // still reporting — leave it alone
    doomed.push({ uid: loser.uid, name: loser.name, dev: loser.dev, newest: loser.newest,
                  why: `duplicate of ${keeper.uid.slice(0, 10)} (${keeper.name}, ${ago(keeper.newest)})`,
                  rows: loser.rows });
  }
}

// junk rows: test accounts and the like, whatever their age
for (const [uid, e] of Object.entries(ids)) {
  if (doomed.some(d => d.uid === uid)) continue;
  if (!JUNK_NAMES.some(re => re.test((e.name || '').trim()))) continue;
  if ((now - e.newest) / 60000 < SKIP_RECENT_MIN) continue;
  doomed.push({ uid, name: e.name, dev: e.dev, newest: e.newest, why: 'test/demo account', rows: e.rows });
}

// ---- report --------------------------------------------------------------------------------
if (!doomed.length) { console.log('Nothing to prune — every person already has one identity.'); process.exit(0); }

console.log(`${apply ? 'DELETING' : 'WOULD DELETE'} ${doomed.length} identit${doomed.length === 1 ? 'y' : 'ies'}:\n`);
let rowCount = 0;
for (const d of doomed) {
  console.log(`  ${(d.name || '?').padEnd(12)} ${(d.dev || '-').padEnd(7)} ${d.uid.slice(0, 12)}  last active ${ago(d.newest).padStart(6)}`);
  console.log(`      ${d.why}`);
  for (const r of d.rows) { console.log(`      - gl/${r.room}/${r.branch}/${d.uid.slice(0, 10)}`); rowCount++; }
}
console.log(`\n${rowCount} database rows across ${new Set(doomed.flatMap(d => d.rows.map(r => r.room))).size} room(s).`);

// Survivors, so it is obvious nobody was orphaned. A doomed id is NOT a survivor even when it is
// the only member of its group — the test account was being printed in both lists.
const dead = new Set(doomed.map(d => d.uid));
console.log('\nKept:');
for (const list of Object.values(groups)) {
  const alive = list.filter(x => !dead.has(x.uid)).sort((a, b) => b.newest - a.newest);
  const k = alive[0];
  if (!k || !k.name) continue;
  // State plainly whether this person can still be reached by push afterwards. Removing the row
  // that carried someone's only token is the one way this tool could do real harm.
  const reach = k.rows.some(r => r.branch !== 'users') ? 'push ok' : 'NO PUSH RECORD';
  console.log(`  ${(k.name || '?').padEnd(16)} ${(k.dev || '-').padEnd(7)} ${k.uid.slice(0, 12)}  ${ago(k.newest).padStart(6)}  ${reach}`);
}

// ---- backup, then delete -------------------------------------------------------------------
const backup = {};
for (const d of doomed) for (const r of d.rows) {
  backup[`gl/${r.room}/${r.branch}/${d.uid}`] = gl[r.room][r.branch][d.uid];
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = `C:/Users/jford/Documents/GroundLink/tools/prune-backup-${stamp}.json`;
writeFileSync(file, JSON.stringify(backup, null, 2));
console.log(`\nbackup written: ${file}`);

if (!apply) { console.log('\n(dry run — nothing changed. Re-run with --apply to delete.)'); process.exit(0); }

let done = 0;
for (const d of doomed) {
  for (const r of d.rows) { await db.ref(`gl/${r.room}/${r.branch}/${d.uid}`).remove(); done++; }
}
console.log(`\n${done} rows removed.`);
process.exit(0);
