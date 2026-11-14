// Build 1018: an invite is also delivered to the account signed in on the invitee's phone.
import { readFileSync } from 'node:fs';
const idx = readFileSync(((process.argv[2] || 'public').replace(/\/$/, '')) + '/index.html', 'utf8');
const srv = readFileSync('server.js', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(srv.includes("for (const node of ['_pushTokens', '_locSubs'])"), 'signed-in account looked up from the phone push sign-ups');
ok(srv.includes("await adminDb.ref('gl/_invites/' + a).push(rec);"), 'invite copied to that inbox');
ok(srv.includes("if (crew) rec.circle = true;"), 'copy keeps the crew marker');
ok(idx.includes("crew: !!isCrew, key: roomKey || '', from: (typeof userId !== 'undefined' && userId) || ''"), 'sender passes who it is from');
ok(idx.includes("[uid, _au, inv._src].forEach(function (x) { if (x) { try { f.remove(f.ref(f.db, 'gl/' + inv.key + '/config/invited/' + x))"), '1019: accepting clears the pending entry under every id');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
