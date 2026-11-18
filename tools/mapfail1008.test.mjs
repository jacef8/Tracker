// Build 1008: if the phone will not let the map draw, the failure is caught (the room screen
// still builds), a message explains the fix, and diag reports mapErr.
//
// Usage:  node tools/mapfail1008.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(/try \{\s*map = new mapboxgl\.Map\(\{/.test(idx), 'map creation wrapped');
ok(idx.includes('} catch (e) { window._mapFail(e); return; }'), 'failure caught and reported');
ok(idx.includes("map.on('webglcontextlost'"), 'mid-use loss reported');
ok(idx.includes("mapErr: window._mapErr || '',"), 'diag carries mapErr');
ok(idx.indexOf('window._mapFail = function') < idx.indexOf('function initMap()'), 'helper defined before initMap');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
