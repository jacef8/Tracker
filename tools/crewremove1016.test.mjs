// Build 1016: "Remove from Crew" goes through the server, which checks owner/admin and clears the
// roster entry the database rules would not let the owner's phone delete.
//
// Usage:  node tools/crewremove1016.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
const srv = readFileSync('server.js', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes("window._glFetch('/crew/remove', {"), 'app asks the server');
ok(!/fbRemove\(fbRef\(db, 'gl\/' \+ groupName \+ '\/members\/' \+ uid\)\)/.test(idx), 'no refused client-side roster delete left');
ok(idx.includes("toast('Couldn’t remove ' + nm"), 'a failure is reported, not shown as success');
ok(srv.includes("app.post('/crew/remove', rateLimit(20, 60000), requireUser,"), 'server endpoint needs a sign-in');
ok(srv.includes("let allowed = !!(cfg && (cfg.owner === me || (cfg.admins && cfg.admins[me])));"), 'owner or admin only');
for (const k of ["upd['members/' + u] = null;", "upd['acl/' + u] = null;", "upd['config/removed/' + u] = Date.now();"]) ok(srv.includes(k), 'server clears ' + k);
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
