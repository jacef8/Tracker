// Build 1007: the trail tip updates at most four times a second, and fix-driven trail rebuilds
// are coalesced to one a second -- per-frame full re-uploads froze Jace's phone.
//
// Usage:  node tools/trailtip1007.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes('var TRAIL_TIP_MS = 250;'), 'tip throttle');
ok(idx.includes("if (_tn - (window._trailTipAt[uid] || 0) < TRAIL_TIP_MS) return;"), 'tip throttled per person');
ok(idx.includes("window._trailRenderT = setTimeout(function () { window._trailRenderT = null; try { _renderTrailLines(); } catch (e) {} }, 1000);"), 'fix-driven rebuilds coalesced');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
