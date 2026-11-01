// Build 988: asking to join a crew reaches the owner, the owner is asked on screen, and signing in
// with Google carries a guest's crews over to the account.
//
// Usage:  node tools/joinask988.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
const srv = readFileSync(dir + '/../server.js', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

// 1. The request goes through the server, which can see the owner; a direct write is the fallback.
ok(/_glFetch\('\/joinAsk'/.test(idx), 'Ask to join posts to /joinAsk');
ok(!/_pushToUid\(t, 'Someone wants to join/.test(idx), 'the outsider no longer tries /pushTo (always refused)');
ok(/app\.post\('\/joinAsk'/.test(srv) && /requireUser/.test(srv.slice(srv.indexOf("app.post('/joinAsk'"), srv.indexOf("app.post('/joinAsk'") + 120)), '/joinAsk exists and needs a signed-in caller');
const ja = srv.slice(srv.indexOf("app.post('/joinAsk'"), srv.indexOf("app.post('/pushTo'"));
ok(/_dbSet\('gl\/' \+ room \+ '\/joinReq\/' \+ req\.authUid/.test(ja), 'the server records the request under the caller\'s own id only');
ok(/managers\.indexOf\(own\[dev\]\.acct\)/.test(ja), 'every device of the owner and admins is notified');
ok(/120000/.test(ja), 'repeat taps do not re-notify within two minutes');

// 2. The owner is asked on screen, including the first request into an empty queue.
ok(!idx.includes('_canManageRoom() && was !== 0') && idx.includes('if (_jrFirst) { _jrFirst = false; was = now; }'), 'the first request is no longer swallowed');
ok(/window\._promptJoinReqs = function/.test(idx) && /yes: 'Let in'/.test(idx), 'a Let in / Not now prompt');

// 3. Sign-in carries crews from the guest id to the account, before the switch.
ok(/return window\._carryCrewAccess\(cur, j\.uid\)\.then\(function \(\) \{\s*return f\.authApi\.signInWithCustomToken/.test(idx), 'carry runs before the custom-token sign-in');
ok(/by: 'carry', from: cur\.uid/.test(idx), 'carried entries say where they came from');
ok(/setTimeout\(r, 4000\)/.test(idx), 'carrying never holds up sign-in more than 4 s');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
