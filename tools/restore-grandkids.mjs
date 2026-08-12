#!/usr/bin/env node
// One-off RESTORE for the_best_grandkids after a destructive security test on
// 2026-08-12 deleted the room node and wiped its acl. Run by request of the owner.
//
// Not touched (self-heals): presence rewrites from the four members' live devices
// on their next GPS fix; the acl is rebuilt by re-running tools/acl-backfill.mjs
// once presence returns (the read gate is off, so an absent acl locks nobody out).
//
// Fixes, all certain rather than reconstructed: removes the attacker's forged
// joinReq and _aclMiss pollution, and restores config/owner to Jace's ACCOUNT id
// (1RwPgd…, the id that appears as Jace across family_men / our_crew / jace_devices,
// not the device J2rhhBZd that only ever appeared inside this room). Owner is only
// written if the node is still ownerless, so it can never clobber a value the app's
// own owner self-heal may have restored first.
//
//   node tools/restore-grandkids.mjs --key <service-account.json> [--apply]

import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const ROOM = 'the_best_grandkids';
const OWNER = '1RwPgdSdOEgp3lhlGly5I71EkY73';
const ATTACKER = 'Ye6jsFBoMlQf8Q3HhE9l3BKOr2t2';

const cred = JSON.parse(readFileSync(val('--key'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com' });
const db = admin.database();

const cur = (await db.ref('gl/' + ROOM).once('value')).val() || {};
console.log('current room node:', JSON.stringify(cur));

const plan = [];
if (cur.joinReq && cur.joinReq[ATTACKER]) plan.push(['remove forged joinReq', 'gl/' + ROOM + '/joinReq/' + ATTACKER, null]);
if (!cur.config || !cur.config.owner) plan.push(['restore owner (ownerless)', 'gl/' + ROOM + '/config/owner', OWNER]);
const miss = (await db.ref('gl/_aclMiss/' + ROOM + '/' + ATTACKER).once('value')).val();
if (miss) plan.push(['remove _aclMiss pollution', 'gl/_aclMiss/' + ROOM + '/' + ATTACKER, null]);

console.log('\nplan:');
plan.forEach(([what, path, v]) => console.log('  ' + what + '  ->  ' + path + ' = ' + JSON.stringify(v)));
if (!plan.length) console.log('  (nothing to do — already clean)');

if (!APPLY) { console.log('\nDry run. Re-run with --apply.'); process.exit(0); }

for (const [, path, v] of plan) await db.ref(path).set(v);
const back = (await db.ref('gl/' + ROOM).once('value')).val() || {};
console.log('\nafter: owner =', (back.config && back.config.owner) || '(still none)',
            ' forged-joinReq gone =', !(back.joinReq && back.joinReq[ATTACKER]));
process.exit(0);
