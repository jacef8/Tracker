// Build 1002: a group bubble shows no parked-time or speed chip -- those describe one member.
//
// Usage:  node tools/bubblechips1002.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes(".mk-merged .mk-age, .mk-merged:not(.mk-same-speed) .mk-speed { display: none !important; }"), 'bubble hides the chips, except a shared speed');
ok(idx.includes("el.classList.toggle('mk-same-speed', _same);"), '1003: same-car speed stays on');
ok(/_same = _spds\.every\(function \(v\) \{ return v !== null; \}\) &&\s*\(Math\.max\.apply\(null, _spds\) - Math\.min\.apply\(null, _spds\)\) <= 10;/.test(idx), '1003: all live, within 10 mph');
ok(idx.includes("el.classList.add('mk-merged');"), 'merging marks the bubble');
ok(idx.includes("el.classList.remove('mk-merged');"), 'splitting brings the chips back');
ok(idx.includes("if (mk._mergedOval && !el.classList.contains('mk-same-speed')) return;"), 'a bubble without a shared speed takes no chip slot');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
