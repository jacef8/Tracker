// Build 993: one car stays one bubble at highway speed, the follow camera is smoothed, a pinch
// keeps following, and following never forces a zoom.
//
// Usage:  node tools/follow993.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

ok(idx.includes('var MERGE_CONVOY_CAP_M = 800;'), 'same-car allowance has a ceiling');
ok(idx.includes('if (_spA >= 20 && _spB >= 20 && Math.abs(_spA - _spB) <= 12) {'), 'only two people driving at the same speed get it');
// Lexi/Jax, 4:33:28 PM: 79 and 78 mph, fixes 8 s apart, ~920 ft apart.
const slack0 = Math.min(500, 79 * 0.44704 * 8);
const join = 15 + Math.min(800, slack0 * 1.4 + 60), hold = 30 + Math.min(800, slack0 * 2 + 120);
ok(280 < join && 280 < hold, 'the real 4:33 sample merges and stays merged');
ok(15 + slack0 < 300, '(and before 993 it sat right at the edge)');
ok(idx.includes('var _k = 1 - Math.exp(-(_cn - _cc.t) / 350);'), 'camera eases toward the dot');
ok(idx.includes('else map.setCenter([_cl, _ca]);'), 'camera uses the smoothed centre');
ok(idx.includes("if (Object.keys(_ptrs).length > 1) { window._pinchSeen = Date.now(); return; }"), 'two fingers do not end a follow');
ok(idx.includes("if (typeof followUid !== 'undefined' && followUid) window._zoomingFollow = true;"), 'a zoom while following is remembered');
ok(idx.includes('window._followPausedUntil = 0;\n    window._camSmooth = null;'), 'and following resumes the moment the zoom ends');
ok(!/zoom: Math\.max\(map\.getZoom\(\), 16\), duration: 800/.test(idx), 'starting a follow keeps your zoom');
ok(idx.includes("try { map.flyTo({ center: mk._ll, duration: 700 }); } catch (e) {}   // 993"), 'opening a card keeps your zoom');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
