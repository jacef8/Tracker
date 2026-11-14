// Build 1013: an invite sent from inside a crew is a crew invite; tapping the invite
// notification opens its Accept prompt; the empty Crews screen shows no diagnostics.
//
// Usage:  node tools/crewinvite1013.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
const srv = readFileSync('server.js', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes('if (_isCrew) rec.circle = true;'), 'crew invite marked as crew');
ok(idx.includes('_pushInvite([uid, _acct], label, _isCrew, groupName);') && idx.includes('_pushInvite([uid, _acct2], t.name, true, t.key);'), 'both senders pass the crew flag and room key');
ok(idx.includes("if (data.type === 'invite') {") && idx.includes('_syncInviteBanner(list);'), 'tap opens the Accept prompt');
ok(srv.includes("data: { type: 'invite', invKey: invKey, crew: crew ? '1' : '0' },"), 'push carries the invite key');
ok(!idx.includes("L.push('signed in : '"), 'no diagnostics on the Crews screen');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
