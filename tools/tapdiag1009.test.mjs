// Build 1009: the app's style gates use its own _styleReady() and Mapbox's isStyleLoaded is no
// longer replaced; diag reports whether touches arrive and what is on top of the screen.
//
// Usage:  node tools/tapdiag1009.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(!idx.includes('map.isStyleLoaded = function'), 'no override of the Mapbox method');
ok((idx.match(/map\.isStyleLoaded\(\)/g) || []).length === 1, 'only _styleReady calls the real method');
ok(idx.includes('function _styleReady() {'), 'app gate defined');
ok(idx.includes("document.addEventListener('pointerdown', function (ev) {"), 'touches counted');
for (const k of ['tapN:', 'tapAgo:', 'tapTgt:', 'topMid:', 'topBar:', 'mapLoaded:']) ok(idx.includes('        ' + k), 'diag ' + k);
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
