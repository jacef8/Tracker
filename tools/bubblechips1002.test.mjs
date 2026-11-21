// Build 1002: a group bubble shows no parked-time or speed chip -- those describe one member.
//
// Usage:  node tools/bubblechips1002.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes(".mk-merged .mk-age, .mk-merged:not(.mk-same-speed) .mk-speed { display: none !important; }"), 'bubble hides the chips, except a shared speed');
ok(idx.includes("el.classList.toggle('mk-same-speed', _same || _now < (el.__spdUntil || 0));"), '1047: same-car speed stays on, held 10 s');
ok(idx.includes("return Math.abs((+m._spd || 0) - _pS) <= 15;") && idx.includes("var _same = !!mk._isLive && members.every("), '1047: anchor live; fresh live members within 15 mph');
ok(idx.includes("el.classList.add('mk-merged');"), 'merging marks the bubble');
ok(idx.includes("el.classList.remove('mk-merged');"), 'splitting brings the chips back');
ok(idx.includes("if (mk._mergedOval && !el.classList.contains('mk-same-speed')) return;"), 'a bubble without a shared speed takes no chip slot');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
