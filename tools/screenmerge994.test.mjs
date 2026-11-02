// Build 994: dots that only touch on screen stay separate; only dots buried in each other merge.
//
// Usage:  node tools/screenmerge994.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

const join = +(idx.match(/var MERGE_SCREEN_JOIN_PX = (\d+);/) || [])[1];
const split = +(idx.match(/var MERGE_SCREEN_SPLIT_PX = (\d+);/) || [])[1];
const hit = +(idx.match(/var SPREAD_HIT_PX = (\d+);/) || [])[1];
ok(join === 22 && split === 30, 'merge only when dots are more than half on top of each other');
ok(split > join, 'split threshold still wider than join (no flicker on the line)');
ok(split < hit, 'between merge and touch, the spread pass separates them instead');
// Vic at Crystral River vs Lexi/Jax at Ocala, state zoom: ~39px apart on a phone.
ok(!(39 < join), 'the 2026-11-01 case (39px apart, 26 miles) is not merged');
ok(/if \(_spx < \(wasTogether \? MERGE_SCREEN_SPLIT_PX : MERGE_SCREEN_JOIN_PX\)\)/.test(idx), 'screen rule still in the grouping pass');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
