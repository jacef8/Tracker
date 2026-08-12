#!/usr/bin/env node
// Rebuild the_best_grandkids ACL after the 2026-08-12 deletion, WITHOUT waiting on
// the four members' presence to self-heal. Deterministic: same _devOwner expansion
// tools/acl-backfill.mjs uses, but the person list is the four known members from
// the backfill --apply log (17 keys) rather than the now-deleted presence rows.
//
// For each known primary id: add the id, its account (via _devOwner), and every
// sibling device pointing at that account. Idempotent — re-running is a no-op.
//
//   node tools/restore-grandkids-acl.mjs --key <service-account.json> [--apply]

import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const ROOM = 'the_best_grandkids';

// Primary ids seen in the room before deletion (backfill --apply log, 2026-08-12).
const MEMBERS = {
  'Allie Roberts': ['95ksnMvgVJTMAmqGzlvp7En6om62', 'KF7EaRAsQgVzzjn2Yw7jsG5JuMz2'],
  'Jace':          ['J2rhhBZd7YMHKBT5WkNvOCtor713', '1RwPgdSdOEgp3lhlGly5I71EkY73'],
  'Presley Ford':  ['o7ZORAXqzodXKLqUCIYSjv7gYBn1'],
  'Curry Eikeland':['tzbT3bs4ALdodGfln5HYGAxPYru2'],
};

const cred = JSON.parse(readFileSync(val('--key'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com' });
const db = admin.database();

const devOwner = (await db.ref('gl/_devOwner').once('value')).val() || {};
const acctOf = (u) => (devOwner[u] && devOwner[u].acct) || null;

const keys = new Set();
const accts = new Set();
for (const ids of Object.values(MEMBERS)) {
  for (const id of ids) { keys.add(id); accts.add(id); const a = acctOf(id); if (a) { keys.add(a); accts.add(a); } }
}
for (const [dev, rec] of Object.entries(devOwner)) if (rec && accts.has(rec.acct)) keys.add(dev);

console.log('rebuilding', keys.size, 'acl keys for', ROOM);
const existing = (await db.ref('gl/' + ROOM + '/acl').once('value')).val() || {};
console.log('existing acl keys:', Object.keys(existing).length);

if (!APPLY) { console.log('\nkeys:\n  ' + [...keys].join('\n  ') + '\n\nDry run. Re-run with --apply.'); process.exit(0); }

const updates = {};
for (const k of keys) if (!existing[k]) updates['gl/' + ROOM + '/acl/' + k] = { ts: Date.now(), by: 'restore' };
await db.ref().update(updates);

const back = (await db.ref('gl/' + ROOM + '/acl').once('value')).val() || {};
let missing = 0;
for (const k of keys) if (!back[k]) { missing++; console.log('  MISSING', k); }
console.log('wrote', Object.keys(updates).length, 'new keys; acl now has', Object.keys(back).length, '—', missing ? missing + ' MISSING' : 'all present');
process.exit(missing ? 1 : 0);
