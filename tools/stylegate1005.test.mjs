// Build 1005: isStyleLoaded() answers "can the style take layers", not "has every tile landed" --
// one stuck background source kept it false for good and no trail line was ever added.
//
// Usage:  node tools/stylegate1005.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes("try { if (map.style && map.style._loaded) return true; } catch (e) {}\n      return _rawStyleLoaded();"), 'style gate no longer waits on every tile');
ok(idx.indexOf('var _rawStyleLoaded') > idx.indexOf('map = new mapboxgl.Map(') && idx.indexOf('var _rawStyleLoaded') < idx.indexOf('window._mapStarted = true;'), 'installed right after the map is made');
ok(idx.includes("if (_gmk && _gmk._mergedOval && _gmk._ll) { lng = _gmk._ll[0]; lat = _gmk._ll[1]; }"), 'trail tip ends at the person, not the bubble');
ok(idx.includes("let _tip = _mk && (_mk._mergedOval && _mk._ll ? _mk._ll : _mk._curLngLat);"), 'full render uses the same tip');
ok(idx.includes('trailDraw: (function () {'), 'diag reports trails');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
