// Build 997: messages show at the top of the map, not over the bottom card.
//
// Usage:  node tools/toasttop997.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(/#toast \{\s*position: fixed;\s*top: 200px; bottom: auto;/.test(idx), 'toast anchored at the top');
ok(!/#toast \{\s*position: fixed;\s*bottom: calc/.test(idx), 'no longer at the bottom');
ok(idx.includes("el.style.top = Math.round(_mt + 12) + 'px'"), 'placed just under the toolbar');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
