// Build 1006: tapping a person in the people list zooms in to 68% (z 14.9); map taps keep the zoom.
//
// Usage:  node tools/listzoom1006.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes('var LIST_ZOOM = 14.9;'), '68% target');
ok(idx.includes("window._listZoomIn = Date.now();"), 'people row asks for the zoom');
ok(idx.includes("return map.getZoom() < LIST_ZOOM - 0.05 ? LIST_ZOOM : 0;"), 'only ever zooms in');
ok(idx.includes("if (initial) { try { var _lz = window._takeListZoom();"), 'live follow uses it');
ok(idx.includes("var _lz2 = window._takeListZoom();"), 'parked person uses it');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
