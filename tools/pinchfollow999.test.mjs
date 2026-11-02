// Build 999: you can pinch-zoom while following someone; the follow camera stands aside mid-gesture.
//
// Usage:  node tools/pinchfollow999.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(/&& Date\.now\(\) >= \(window\._followPausedUntil \|\| 0\)\s*&& !window\._gfPointerDown && !window\._zoomingFollow[\s\S]{0,80}?&& document\.visibilityState === 'visible'\) \{/.test(idx), 'per-frame follow camera yields to fingers and zooms');
ok(idx.includes("if (!initial && (window._gfPointerDown || window._zoomingFollow)) return;"), '3 s follow tick yields too');
ok(idx.includes("if (Object.keys(_ptrs).length > 1) return;\n      sx = ev.clientX;"), 'second finger does not re-arm the pan test');
ok(idx.includes("if (Date.now() - downAt < 150) return;"), 'a pinch lead-in is not a pan');
ok(idx.includes("var up = function () { if (Object.keys(_ptrs).length) return; window._gfPointerDown = false;"), 'lifting one of two fingers keeps the hold');
ok(idx.includes("cv.addEventListener('pointerleave', _ptrUp, { passive: true, capture: true });"), 'no stuck fingers');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
