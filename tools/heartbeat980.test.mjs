// Build 980: the Android background heartbeat must never write a position, and the history
// view drops a point nobody could have driven to and away from.
//
// The bug, 2026-10-31 08:16:55: with the app open, the main page reported and the background
// page got no fixes, so its cached fix was from 08:12:59. Its 3-minute "still alive" heartbeat
// re-sent that cache as a fresh row AND a fresh history point, dropping the dot back in Bristol
// and drawing a 3-mile line across the Apalachicola.
//
// Usage:  node tools/heartbeat980.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
const hl = readFileSync(dir + '/headless.html', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

function cut(src, head) {
  const a = src.indexOf(head); if (a < 0) throw new Error('missing ' + head);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && nx === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(a, i + 1);
  }
}

// 1. The spike filter, on the real points from that morning.
const metersApart = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const fn = new Function('metersApart', 'var window = {};\n' + cut(idx, 'window._dropTrailSpikes = function (pts) {') + '\nreturn window._dropTrailSpikes;')(metersApart);
const T = (hms) => Date.parse('2026-10-31T' + hms + '-04:00');
const pts = [
  ['08:16:28', 30.44097, -85.00370], ['08:16:38', 30.44245, -85.00626], ['08:16:48', 30.44312, -85.00957],
  ['08:16:55', 30.43177, -84.98172],   // the replayed 08:12:59 position
  ['08:18:17', 30.44320, -85.03387], ['08:18:24', 30.44320, -85.03560], ['08:18:28', 30.44321, -85.03645],
].map(([h, lat, lng]) => ({ t: T(h), lat, lng }));
const kept = fn(pts);
ok(kept.length === pts.length - 1, `exactly one point dropped (kept ${kept.length} of ${pts.length})`);
ok(!kept.some((p) => p.lng === -84.98172), 'the replayed Bristol point is gone');
ok(kept.some((p) => p.lng === -85.03387), 'the real point after the 82 s river gap is kept (59 mph is driveable)');
// A real fast stretch is not touched: 80 mph steady.
const fast = Array.from({ length: 6 }, (_, i) => ({ t: T('09:00:00') + i * 10000, lat: 30.4, lng: -85 + i * 0.0036 }));
ok(fn(fast).length === fast.length, 'a steady 80 mph drive keeps every point');
ok(fn([]).length === 0 && fn(pts.slice(0, 2)).length === 2, 'short inputs pass through');
ok(/pts = window\._dropTrailSpikes\(pts\)/.test(idx), 'the history loader runs the filter');

// 2. The heartbeat: a light patch, no position, no history.
const onFix = cut(hl, 'function onFix(pos) {');
const hbBlock = onFix.slice(onFix.indexOf('if (pos._heartbeat) {'), onFix.indexOf('var c = pos.coords;'));
ok(hbBlock.length > 0, 'onFix handles the heartbeat before reading coords');
ok(/hbTs: _hbNow/.test(hbBlock) && /ts: _hbNow/.test(hbBlock), 'heartbeat writes ts and hbTs');
ok(!/lat|lng|fixTs/.test(hbBlock.replace(/\/\/.*$/gm, '')), 'heartbeat writes no lat, lng or fixTs');
ok(/update\(ref\(db, 'gl\/' \+ k \+ '\/users\/' \+ uid\), _hbPatch\)/.test(hbBlock), 'heartbeat PATCHes the row, never set()s it');
ok(/return;\s*\}\s*$/.test(hbBlock.trim() + '\n') || /_lastWriteTs = _hbNow;\s*return;/.test(hbBlock), 'heartbeat returns before the history and geofence writes');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
