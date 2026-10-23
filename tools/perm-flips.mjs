// Watches every device's PUBLISHED location permission and counts how often it changes.
//
// This is the regression test for the two-writer bug fixed in build 960. Position writes are
// whole-row fbSet calls, and two writers each attached a permission reading to the same row:
// the native layer (live, from CLLocationManager) and the web page (window._iosSettings,
// refreshed only on foreground but restored from localStorage up to seven days old). They took
// turns, so the published permission was whichever wrote last -- 277 phantom always/whileUsing
// flips on one phone across three days, while that phone's actual setting never changed.
//
// A real permission change is a person going into Settings, which happens rarely and once.
// So on a healthy fleet this should report ZERO flips over any short watch. Any flip inside a
// ten-minute window means two writers are still disagreeing about one row.
//
// Usage:  node tools/perm-flips.mjs [minutes] [secondsBetweenPasses]
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

const MINUTES = Number(process.argv[2]) || 10;
const EVERY_S = Number(process.argv[3]) || 20;
const PASSES = Math.max(2, Math.round((MINUTES * 60) / EVERY_S));

const KEY = 'C:/Users/jford/Documents/GroundLink/.keys/tracker-58b87-firebase-adminsdk-fbsvc-1f0441c5d4.json';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(KEY, 'utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();

// The row's field names are locAlways / locWhenInUse (NOT always / whenInUse -- reading the
// wrong names scores every device 'none' and makes the flip count zero by construction, which
// is how the first run of this tool fooled itself).
const permOf = (oss) => {
  if (oss.locDenied) return 'denied';
  if (oss.locAlways) return 'always';
  if (oss.locWhenInUse) return 'whileUsing';
  if (oss.locServices === false) return 'servicesOff';
  return '?';
};
const seen = new Map();

for (let p = 0; p < PASSES; p++) {
  const rooms = (await db.ref('gl').get({ shallow: true })).val() || {};
  for (const room of Object.keys(rooms).filter((k) => !k.startsWith('_'))) {
    const users = (await db.ref(`gl/${room}/users`).get()).val() || {};
    for (const [uid, u] of Object.entries(users)) {
      if (!u || typeof u !== 'object') continue;
      const who = (u.name || uid.slice(0, 6)) + (u.dev ? ' / ' + u.dev : '');
      let s = seen.get(who);
      if (!s) seen.set(who, (s = { perms: new Set(), flips: [], last: null, unreadable: false, maxAge: 0, with: 0, without: 0 }));
      if (!u.oss) { s.without++; continue; }
      s.with++;
      const perm = permOf(u.oss);
      // If the permission keys are absent entirely the watch proves nothing, so say so rather
      // than quietly reporting zero flips.
      if (!('locAlways' in u.oss) && !('locWhenInUse' in u.oss) && !('locDenied' in u.oss)) s.unreadable = true;
      s.perms.add(perm);
      // A change seen between two passes minutes apart is the signature of the bug, not of a
      // person visiting Settings twice in ten minutes.
      if (s.last && s.last !== perm) s.flips.push(`${s.last}->${perm}`);
      s.last = perm;
      if (u.oss.at) s.maxAge = Math.max(s.maxAge, Math.round((Date.now() - u.oss.at) / 60000));
    }
  }
  if (p % 6 === 0) process.stderr.write(`  pass ${p + 1}/${PASSES}\n`);
  if (p < PASSES - 1) await new Promise((r) => setTimeout(r, EVERY_S * 1000));
}

console.log(`\nwatched ${MINUTES} min in ${PASSES} passes\n`);
console.log('person / device'.padEnd(32) + 'permission'.padEnd(14) + 'FLIPS'.padEnd(7) + 'oss rows'.padEnd(11) + 'oldest reading');
console.log('-'.repeat(104));
let total = 0;
for (const [who, s] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) {
  total += s.flips.length;
  console.log(
    who.slice(0, 31).padEnd(32) +
    ([...s.perms].join('/') || '-').padEnd(14) +
    String(s.flips.length).padEnd(7) +
    `${s.with}/${s.with + s.without}`.padEnd(11) +
    (s.maxAge ? s.maxAge + ' min' : '-')
  );
  if (s.flips.length) console.log('    ' + s.flips.slice(0, 6).join(', ') + (s.flips.length > 6 ? ' …' : ''));
  if (s.unreadable) console.log('    !! no permission keys on this row — nothing was actually compared');
}
console.log(`\ntotal flips: ${total}`);
const blind = [...seen.values()].filter((s) => s.unreadable).length;
if (blind) console.log(`${blind} device(s) had no readable permission keys — the watch says nothing about those.`);
console.log(total === 0
  ? 'no device changed its published permission. The writers agree.'
  : 'STILL FLIPPING — two writers are disagreeing about these rows.');
process.exit(0);
