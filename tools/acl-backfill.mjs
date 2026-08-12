#!/usr/bin/env node
// ── ACL backfill ──────────────────────────────────────────────────────────────
// Populates gl/<room>/acl/<uid> = {ts, by} for everyone who already belongs to a
// room, so that turning on the read gate ($room .read requires
// acl.child(auth.uid).exists()) locks nobody out.
//
// Runs with ADMIN credentials (service account) and therefore bypasses the
// database rules. That is deliberate: gl itself has no .read since the
// enumeration lockdown, so no client — not even the owner's — can walk the room
// list to do this from the browser.
//
//   node tools/acl-backfill.mjs                 # dry run, prints the plan
//   node tools/acl-backfill.mjs --apply         # actually writes
//   node tools/acl-backfill.mjs --room the_best_grandkids   # one room only
//
// Credentials, in order of preference:
//   FIREBASE_SERVICE_ACCOUNT   the whole service-account JSON (same var server.js uses)
//   --key <path>               path to a service-account .json
//
// ── WHY BOTH IDS GET AN ACL ENTRY ────────────────────────────────────────────
// The rule tests auth.uid, and auth.uid is NOT one single thing in this app:
//
//   • Google-signed-in      auth.uid === gl_account_uid (index.html sets it from
//                           user.uid at sign-in), so the ACCOUNT id is the key.
//   • Anonymous, modern     _reconcileAuthIdentity adopts the anonymous auth.uid
//                           into gl_uid when the device has no id yet, so the
//                           DEVICE id in gl/<room>/users IS the auth.uid.
//   • Anonymous, legacy     gl_uid is a pre-auth Date.now()+Math.random() id and
//                           auth.uid is an unrelated anonymous uid that appears
//                           NOWHERE in the database.
//
// The first two are covered by writing an ACL entry under the account id AND
// under every device id that resolves to that person — which is what this does.
// The third cannot be fixed from the server, because the value the rule will
// test does not exist in any record. That population is only observable from the
// device, which is what the shadow-mode miss reporter in index.html is for
// (gl/_aclMiss). Do not flip the read rule on the strength of this script alone:
// run it, then let the fleet report misses for a few days.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

const APPLY = has('--apply');
const ONLY_ROOM = val('--room');
const DB_URL = (process.env.FIREBASE_DB_URL || 'https://tracker-58b87-default-rtdb.firebaseio.com').replace(/\/$/, '');

// ── credentials ───────────────────────────────────────────────────────────────
let cred;
const keyPath = val('--key');
if (keyPath) {
  cred = JSON.parse(readFileSync(keyPath, 'utf8'));
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  console.error(
    'No credentials. Set FIREBASE_SERVICE_ACCOUNT to the service-account JSON,\n' +
    'or pass --key <path-to-service-account.json>.\n\n' +
    'Railway already has FIREBASE_SERVICE_ACCOUNT set for the push sender — the\n' +
    'same key works here. Firebase console → Project settings → Service accounts\n' +
    '→ Generate new private key, if you need a fresh one.'
  );
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(cred), databaseURL: DB_URL });
const db = admin.database();

// ── load ──────────────────────────────────────────────────────────────────────
console.log(`Reading ${DB_URL} …`);
const [glSnap, devOwnerSnap, dirSnap] = await Promise.all([
  db.ref('gl').once('value'),
  db.ref('gl/_devOwner').once('value'),
  db.ref('gl/_directory').once('value'),
]);

const gl = glSnap.val() || {};
const devOwner = devOwnerSnap.val() || {};
const dir = dirSnap.val() || {};

// device id -> account id, or the id itself when it belongs to no account.
const acctOf = (uid) => (devOwner[uid] && devOwner[uid].acct) || null;

// Best-effort human name, for the report only.
const nameOf = (uid, room) => {
  if (dir[uid] && dir[uid].name) return dir[uid].name;
  const acct = acctOf(uid);
  if (acct && dir[acct] && dir[acct].name) return dir[acct].name;
  const r = gl[room] || {};
  if (r.users && r.users[uid] && r.users[uid].name) return r.users[uid].name;
  if (r.members && r.members[uid] && r.members[uid].name) return r.members[uid].name;
  return '(unnamed)';
};

// ── plan ──────────────────────────────────────────────────────────────────────
const STALE_MS = 90 * 24 * 60 * 60 * 1000;   // presence older than this is not a person, it's a husk
const now = Date.now();

const roomKeys = Object.keys(gl)
  .filter((k) => k.charAt(0) !== '_')
  .filter((k) => !k.startsWith('test_'))
  .filter((k) => !ONLY_ROOM || k === ONLY_ROOM)
  .sort();

if (ONLY_ROOM && !roomKeys.length) {
  console.error(`Room "${ONLY_ROOM}" not found.`);
  process.exit(1);
}

const plan = [];          // [{room, entries: {uid: {ts, by, why, name}}, people: [...]}]
let totalEntries = 0;
let anonymousRisk = 0;

for (const room of roomKeys) {
  const r = gl[room] || {};
  const sources = new Map();   // uid -> reason it belongs

  // ROSTER — a Crew's permanent membership. Account-keyed since _myRosterId.
  Object.keys(r.members || {}).forEach((uid) => sources.set(uid, 'roster'));

  // PRESENCE — device-keyed, and the ONLY record of a visitor who was never put
  // on the roster. This is the case that locks people out if you skip it: four
  // real people are in the_best_grandkids on presence alone.
  Object.entries(r.users || {}).forEach(([uid, u]) => {
    if (!u || typeof u !== 'object') return;
    if (u.claiming) return;                                  // half-finished join slot, not a person
    if (!u.name) return;                                     // nameless onDisconnect husk
    if ((now - (u.ts || 0)) > STALE_MS) return;              // long dead
    if (!sources.has(uid)) sources.set(uid, 'presence');
  });

  // The owner and any co-admins, whether or not they are currently standing in
  // the room. Locking the owner out of their own room is the worst possible
  // failure here and costs one line to prevent.
  const owner = r.config && r.config.owner;
  if (owner) sources.set(owner, sources.get(owner) || 'owner');
  Object.keys((r.config && r.config.admins) || {}).forEach((uid) => {
    if (!sources.has(uid)) sources.set(uid, 'admin');
  });

  if (!sources.size) continue;

  // Expand each id into every form auth.uid could take for that person.
  const entries = {};
  const people = new Map();   // personId -> {name, ids:[], reasons:Set}

  for (const [uid, why] of sources) {
    const acct = acctOf(uid);
    const person = acct || uid;
    if (!people.has(person)) people.set(person, { name: nameOf(uid, room), ids: [], reasons: new Set() });
    const p = people.get(person);
    p.reasons.add(why);
    if (p.ids.indexOf(uid) === -1) p.ids.push(uid);
    if (p.name === '(unnamed)') p.name = nameOf(uid, room);

    // The device id itself: this IS auth.uid for anyone whose session was created
    // after anonymous auth landed.
    entries[uid] = { ts: now, by: 'backfill', why };
    // The account id: this IS auth.uid for anyone signed in with Google.
    if (acct && !entries[acct]) entries[acct] = { ts: now, by: 'backfill', why: why + ':acct' };
  }

  // Every OTHER device known to belong to these accounts, even if that device has
  // never been in this room. A tablet that has never opened the room still needs
  // read access the first time its owner taps in from it, and its auth.uid is a
  // different value from the phone's.
  for (const [person] of people) {
    Object.entries(devOwner).forEach(([devId, rec]) => {
      if (rec && rec.acct === person && !entries[devId]) {
        entries[devId] = { ts: now, by: 'backfill', why: 'sibling-device' };
      }
    });
  }

  // Anyone with no account AND no _devOwner record is a bare device id. If that
  // id was adopted from anonymous auth it will match auth.uid and this works; if
  // it is a legacy Math.random id it will not, and nothing here can tell which.
  const risky = [...people.entries()].filter(([person]) => !devOwner[person] && !dir[person]);
  anonymousRisk += risky.length;

  totalEntries += Object.keys(entries).length;
  plan.push({ room, entries, people, risky: new Set(risky.map(([p]) => p)) });
}

// ── report ────────────────────────────────────────────────────────────────────
console.log('');
for (const { room, entries, people, risky } of plan) {
  console.log(`── ${room}  (${people.size} people → ${Object.keys(entries).length} acl keys)`);
  for (const [person, p] of people) {
    const flag = risky.has(person) ? '  ⚠ no account — auth.uid unverifiable' : '';
    console.log(`     ${p.name.padEnd(20)} ${[...p.reasons].join('+').padEnd(16)} ${p.ids.join(', ')}${flag}`);
  }
}

console.log('');
console.log(`${plan.length} rooms, ${totalEntries} acl keys.`);
if (anonymousRisk) {
  console.log('');
  console.log(`⚠  ${anonymousRisk} of those people have no account and no _devOwner record.`);
  console.log('   Their ACL entry is their device id, which matches auth.uid only if that id');
  console.log('   was adopted from anonymous auth. A pre-auth Math.random id will NOT match');
  console.log('   and the read rule would lock them out. This is not detectable from here —');
  console.log('   watch gl/_aclMiss (shadow mode, build 614+) before flipping the rule.');
}

// ── write ─────────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log('');
  console.log('Dry run — nothing written. Re-run with --apply to write.');
  process.exit(0);
}

const updates = {};
for (const { room, entries } of plan) {
  for (const [uid, rec] of Object.entries(entries)) {
    updates[`gl/${room}/acl/${uid}`] = { ts: rec.ts, by: rec.by };
  }
}
await db.ref().update(updates);
console.log('');
console.log(`Wrote ${Object.keys(updates).length} acl entries.`);

// Read back and confirm every planned key is really there, rather than trusting
// that update() resolving means the tree looks the way we think it does.
let missing = 0;
for (const { room, entries } of plan) {
  const back = (await db.ref(`gl/${room}/acl`).once('value')).val() || {};
  for (const uid of Object.keys(entries)) if (!back[uid]) { missing++; console.log(`  MISSING ${room}/${uid}`); }
}
console.log(missing ? `⚠ ${missing} entries did not stick.` : 'Verified: every entry read back.');
process.exit(missing ? 1 : 0);
