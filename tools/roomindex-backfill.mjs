#!/usr/bin/env node
// Populate gl/_roomIndex/<key> from the current gl tree, so the home directory and
// join-by-name search have entries to show before clients have re-written them
// through normal use. Runs on the service account (gl has no .read since the
// enumeration lockdown, so this can't be done from a browser).
//
// Entry shape matches _writeRoomIndex in index.html:
//   { name, vis, pin, expires, persistent, owner, lastSeen, live, resting, names[], pins }
//
//   node tools/roomindex-backfill.mjs --key <service-account.json> [--apply]

import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes('--apply');

const cred = JSON.parse(readFileSync(val('--key'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com' });
const db = admin.database();

const gl = (await db.ref('gl').once('value')).val() || {};
const now = Date.now();
const LIVE = 4 * 60 * 1000, REST_MAX = 3 * 24 * 60 * 60 * 1000, EMPTY_GRACE = 5 * 60 * 1000;

const prettyName = (key, cfg) => cfg.name || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const entries = {};
let skipped = 0;
for (const [key, room] of Object.entries(gl)) {
  if (key.charAt(0) === '_' || key.startsWith('test_')) continue;
  if (!room || typeof room !== 'object') continue;
  const cfg = room.config || {};
  const users = room.users || {};
  let live = 0, resting = 0; const names = [];
  for (const d of Object.values(users)) {
    if (!d || !d.name || d.claiming) continue;
    const age = now - (d.ts || 0);
    if (age < LIVE) { live++; if (names.length < 3) names.push(d.name); }
    else if ((d.rest || d.lat || d.lng) && !d.noGps && !d.hidden && age < REST_MAX) resting++;
  }
  // most-recent activity across users/pins/chat, for lastSeen
  let lastSeen = 0;
  for (const d of Object.values(users)) if ((d.ts || 0) > lastSeen) lastSeen = d.ts || 0;
  for (const p of Object.values(room.pins || {})) if ((p.ts || 0) > lastSeen) lastSeen = p.ts || 0;
  for (const c of Object.values(room.chat || {})) if ((c.ts || 0) > lastSeen) lastSeen = c.ts || 0;

  const persistent = !!cfg.persistent;
  // Skip long-dead, non-persistent, empty rooms — they'd be hidden by the directory anyway and
  // the client GC will not resurrect them. Keeps the index from carrying tombstones.
  const empty = !live && !resting && !Object.keys(room.pins || {}).length;
  if (!persistent && cfg.expires && now > cfg.expires) { skipped++; continue; }
  if (!persistent && empty && (!lastSeen || (now - lastSeen) > EMPTY_GRACE)) { skipped++; continue; }

  entries[key] = {
    name: prettyName(key, cfg),
    vis: cfg.visibility || 'public',
    pin: cfg.pin ? 1 : 0,
    expires: cfg.expires || 0,
    persistent: persistent ? 1 : 0,
    owner: cfg.owner || '',
    lastSeen: lastSeen || now,
    live, resting, names,
    pins: Object.keys(room.pins || {}).length,
  };
}

console.log(`rooms indexed: ${Object.keys(entries).length}  (skipped ${skipped} dead/expired)`);
for (const [k, e] of Object.entries(entries)) {
  console.log(`  ${k.padEnd(22)} ${e.vis.padEnd(8)} live=${e.live} rest=${e.resting} pins=${e.pins}${e.persistent ? ' persistent' : ''}  "${e.name}"`);
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply.'); process.exit(0); }

const updates = {};
for (const [k, e] of Object.entries(entries)) updates['gl/_roomIndex/' + k] = e;
await db.ref().update(updates);
const back = (await db.ref('gl/_roomIndex').once('value')).val() || {};
let missing = 0;
for (const k of Object.keys(entries)) if (!back[k]) { missing++; console.log('  MISSING', k); }
console.log(`\nwrote ${Object.keys(updates).length}; index now has ${Object.keys(back).length} — ${missing ? missing + ' MISSING' : 'all present'}`);
process.exit(missing ? 1 : 0);
