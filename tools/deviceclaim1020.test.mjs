// Build 1020: a phone still registered to the anonymous guest it started as is handed to the
// account its owner signed in with; a phone owned by a real account is never taken.
import { readFileSync } from 'node:fs';
const idx = readFileSync(((process.argv[2] || 'public').replace(/\/$/, '')) + '/index.html', 'utf8');
const srv = readFileSync('server.js', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(srv.includes("app.post('/device/claim', rateLimit(10, 60000), requireUser,"), 'endpoint needs a sign-in');
ok(srv.includes("return res.status(403).json({ ok: false, reason: 'caller-anonymous' });"), 'a guest cannot claim');
ok(srv.includes("return res.status(403).json({ ok: false, reason: 'owned-by-real-account' });"), 'a real owner is never displaced');
ok(idx.includes("return fetch('/device/claim', {"), 'app asks when its own claim is refused');
ok(idx.includes("fb.set(fb.ref(fb.db, 'gl/_devOwner/' + current), { acct: u.uid, ts: Date.now() }).catch(function () {"), 'only after the normal write fails');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
