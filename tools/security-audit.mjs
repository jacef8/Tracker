// Read-only audit of the Firebase project, written for the Railway security notice of
// 2026-10-21 (Railway reset platform credentials; GroundLink's server holds a FIREBASE_SERVICE_
// ACCOUNT env var there, which is unscoped admin access to the whole database).
//
// What this can and cannot tell you, honestly:
//  - It CAN show things that were created or changed: accounts, rooms, devices, admins,
//    membership, security rules, deletions.
//  - It CANNOT show reads. A stolen admin key that only read data leaves no trace in the
//    database at all; only Google Cloud audit logging would show that, and it is not enabled.
//    So a clean result here means "nothing was altered", not "nothing was seen".
//
// Usage:  node tools/security-audit.mjs
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const KEY = 'C:/Users/jford/Documents/GroundLink/.keys/tracker-58b87-firebase-adminsdk-fbsvc-1f0441c5d4.json';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();
const DAYS = (ms) => (ms > 0 ? (ms / 86400000).toFixed(1) + 'd ago' : '?');
const et = (ts) => new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' });
const findings = [];
const flag = (sev, what) => { findings.push({ sev, what }); console.log(`  ${sev === 'HIGH' ? '!!' : sev === 'MED' ? '! ' : '. '} ${what}`); };

// The people who are supposed to be here. Anything outside this is worth a look, which is the
// point -- not an accusation, a shortlist.
const KNOWN_EMAIL = /@(gtcom\.net|libertyclerk\.com)$|^(jaceford08|lgford113|lexiford713|jaredroberts10|rennergaderoberts|alliecatroberts10|stepheniefroberts|tyler\.stoutamire|dalynnsmith1|presleyford6|kelleyf0530|justinfordei|tessabyler9|pagewahlquist|adamonealwalker|rudddeee|jared)@/i;

console.log('GroundLink security audit —', et(now));
console.log('Project: tracker-58b87\n');

// ── 1. Accounts ─────────────────────────────────────────────────────────────────────────
console.log('AUTH ACCOUNTS');
let users = [], tok;
do { const r = await admin.auth().listUsers(1000, tok); users = users.concat(r.users); tok = r.pageToken; } while (tok);
const anon = users.filter((u) => u.providerData.length === 0);
const named = users.filter((u) => u.providerData.length > 0);
console.log(`  ${users.length} total — ${named.length} signed-in accounts, ${anon.length} anonymous device sessions`);
for (const u of named.sort((a, b) => new Date(b.metadata.creationTime) - new Date(a.metadata.creationTime))) {
  const email = u.email || u.providerData[0]?.email || '(no email)';
  const age = now - new Date(u.metadata.creationTime).getTime();
  const line = `${email}  via ${u.providerData.map((p) => p.providerId).join(',')}  created ${DAYS(age)}  last sign-in ${u.metadata.lastSignInTime ? DAYS(now - new Date(u.metadata.lastSignInTime).getTime()) : 'never'}`;
  if (!KNOWN_EMAIL.test(email)) flag('HIGH', 'UNRECOGNISED ACCOUNT: ' + line);
  else if (age < 7 * 86400000) flag('LOW', 'recently created (expected? ) ' + line);
  else console.log('    ok  ' + line);
}
// A burst of anonymous users is normal here (headless.html used to mint them); a burst since
// the incident window is still worth seeing.
const anonRecent = anon.filter((u) => now - new Date(u.metadata.creationTime).getTime() < 3 * 86400000);
console.log(`    anonymous created in last 3 days: ${anonRecent.length}`);

// ── 2. Security rules ───────────────────────────────────────────────────────────────────
console.log('\nSECURITY RULES');
try {
  const live = await (await fetch(
    'https://tracker-58b87-default-rtdb.firebaseio.com/.settings/rules.json?access_token=' +
    (await admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))).getAccessToken()).access_token
  )).text();
  const strip = (t) => JSON.stringify(JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')));
  const local = readFileSync('database.rules.json', 'utf8');
  if (strip(live) === strip(local)) console.log('    ok  live rules match database.rules.json in the repo');
  else flag('HIGH', 'LIVE RULES DIFFER from the repo copy — someone or something changed them');
  const j = JSON.parse(live.replace(/^\s*\/\/.*$/gm, ''));
  const open = JSON.stringify(j).match(/"\.(read|write)"\s*:\s*true/g);
  if (open) flag('MED', `rules contain ${open.length} unconditional true (expected: the known few) — review`);
} catch (e) { flag('MED', 'could not compare rules: ' + e.message); }

// ── 3. Rooms, admins, membership ────────────────────────────────────────────────────────
console.log('\nROOMS AND WHO CONTROLS THEM');
const rooms = (await db.ref('gl').get({ shallow: true })).val() || {};
const roomNames = Object.keys(rooms).filter((k) => !k.startsWith('_'));
console.log(`  ${roomNames.length} rooms`);
const acctName = {};
for (const u of named) acctName[u.uid] = u.email || u.uid.slice(0, 8);
for (const r of roomNames) {
  const cfg = (await db.ref(`gl/${r}/config`).get()).val() || {};
  const members = (await db.ref(`gl/${r}/members`).get()).val() || {};
  const admins = Object.keys(cfg.admins || {});
  const owner = cfg.owner || '';
  const created = cfg.createdAt ? DAYS(now - cfg.createdAt) : '?';
  const unknownAdmins = admins.filter((a) => !acctName[a]);
  const line = `${r.padEnd(22)} owner=${(acctName[owner] || owner.slice(0, 8) || 'none').padEnd(26)} admins=${admins.length} members=${Object.keys(members).length} created ${created}`;
  if (unknownAdmins.length) flag('HIGH', `ROOM ADMIN NOT A KNOWN ACCOUNT: ${r} — ${unknownAdmins.join(', ')}`);
  else console.log('    ' + line);
  if (cfg.createdAt && now - cfg.createdAt < 3 * 86400000) flag('LOW', `room created in the last 3 days: ${r} (${et(cfg.createdAt)})`);
}

// ── 4. Devices ──────────────────────────────────────────────────────────────────────────
console.log('\nDEVICES');
const devOwner = (await db.ref('gl/_devOwner').get()).val() || {};
const byAcct = {};
for (const [dev, rec] of Object.entries(devOwner)) {
  const a = rec && rec.acct;
  if (!a) continue;
  (byAcct[a] = byAcct[a] || []).push({ dev, ts: rec.ts || 0 });
}
console.log(`  ${Object.keys(devOwner).length} devices mapped to ${Object.keys(byAcct).length} accounts`);
for (const [a, list] of Object.entries(byAcct)) {
  const who = acctName[a];
  if (!who) { flag('HIGH', `DEVICES OWNED BY AN UNKNOWN ACCOUNT ${a.slice(0, 10)} — ${list.length} device(s)`); continue; }
  const recent = list.filter((d) => now - d.ts < 3 * 86400000);
  if (recent.length) flag('LOW', `${who}: ${recent.length} device link(s) created in the last 3 days (${recent.map((d) => et(d.ts)).join('; ')})`);
}

// ── 5. Deletions and refusals ───────────────────────────────────────────────────────────
console.log('\nDELETIONS AND REFUSED WRITES');
const dead = (await db.ref('gl/_deadRooms').get()).val() || {};
console.log(`  tombstoned rooms: ${Object.keys(dead).length}${Object.keys(dead).length ? ' — ' + Object.keys(dead).join(', ') : ''}`);
const pruned = (await db.ref('gl/_pruned').get()).val() || {};
for (const day of Object.keys(pruned).sort().slice(-3)) {
  console.log(`  pruned ${day}: ${Object.keys(pruned[day]).length} device row(s)`);
}
const denied = (await db.ref('gl/_diag/devices').get()).val() || {};
let deniedN = 0;
for (const [uid, rec] of Object.entries(denied)) {
  if (!rec || !rec.denied) continue;
  for (const [path, d] of Object.entries(rec.denied)) {
    const at = d && (d.last || d.ts);
    if (at && now - at < 3 * 86400000) { deniedN++; flag('LOW', `refused write: ${(acctName[uid] || uid.slice(0, 8))} -> ${path} (${et(at)})`); }
  }
}
if (!deniedN) console.log('    none in the last 3 days');

// ── 6. Verdict ──────────────────────────────────────────────────────────────────────────
const high = findings.filter((f) => f.sev === 'HIGH');
console.log('\n' + '='.repeat(72));
if (high.length) {
  console.log(`${high.length} HIGH finding(s) — look at these:`);
  for (const f of high) console.log('  !! ' + f.what);
} else {
  console.log('No signs that anything was created, altered or deleted by an outsider.');
}
console.log('\nREMEMBER: this cannot detect READS. A stolen admin key used only to read the');
console.log('family\'s locations would leave no trace here. Rotating the key is still the');
console.log('right move once Railway can deploy again.');
process.exit(0);
