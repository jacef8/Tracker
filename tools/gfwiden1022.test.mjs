// Build 1022: follow-group's zoom dead-band never holds back a zoom-out someone needs to stay on screen.
import { readFileSync } from 'node:fs';
const idx = readFileSync(((process.argv[2] || 'public').replace(/\/$/, '')) + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes('var _mustWiden = _dzT < 0 && !_allPointsVisible(pts, _pad);'), 'a needed zoom-out is detected');
ok(idx.includes('if (Math.abs(_dzT) < GF_ZOOM_DEADZONE && !_mustWiden) {'), 'and never held by the dead-band');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
