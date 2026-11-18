// Build 1015: Cancel on a pending invite takes it back out of the invitee's inbox and off the list.
//
// Usage:  node tools/cancelinvite1015.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes("fbSet(fbRef(db, 'gl/' + groupName + '/config/invited/' + uid + '/inbox'), _inbox);"), 'room sender records inbox entries');
ok(idx.includes("fb.set(fb.ref(fb.db, 'gl/' + t.key + '/config/invited/' + uid + '/inbox'), _inbox2);"), 'crew sender records inbox entries');
ok(idx.includes("(rec.inbox || []).forEach(function (pth) { fbRemove(fbRef(db, 'gl/_invites/' + pth)); });"), 'cancel removes them from the inbox');
ok(idx.includes('var box = irow.parentNode; irow.remove();'), 'cancel drops the row right away');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
