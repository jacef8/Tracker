// Build 1004: pins the phone has (the list shows them) must also be DRAWN -- every pin update
// rebuilds a missing source/layer/icon and lifts the pin layers back to the top.
//
// Usage:  node tools/pindraw1004.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes('function _ensurePinLayers() {'), 'self-heal exists');
ok(idx.includes("try { _ensurePinLayers(); } catch (e) {}\n  if (!map.getSource('pins')) { window._queuedPins = pins; return; }"), 'a ready map rebuilds instead of queuing for ever');
ok(idx.includes("if (top !== 'pin-clusters,pin-cluster-count,pins-layer')"), 'pins are lifted above anything covering them');
ok(idx.includes("pinDraw: window._pinDraw || '',"), 'diag reports what is drawn');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
