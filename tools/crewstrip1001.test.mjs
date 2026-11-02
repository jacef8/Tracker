// Build 1001: the top strip lists people inside a group bubble, and leaves out your own devices.
//
// Usage:  node tools/crewstrip1001.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes("if (el && el.style.display === 'none' && !_inBubble[uid]) return;"), 'a pin hidden inside a bubble keeps its chip');
ok(idx.includes("(_gm[p] || []).forEach(function (u) { _inBubble[u] = 1; });"), 'bubble members come from the grouping pass');
ok(idx.includes("if (mine || (_myName && String(mk._name || '').trim().toLowerCase() === _myName)) return;"), 'no chip for yourself on any device');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
