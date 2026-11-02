// Build 996: turning a trail on draws a line at once, from where the person was to their dot.
//
// Usage:  node tools/trailanchor996.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

ok(/else \{ m\[uid\] = Date\.now\(\); _setTrailAnchor\(uid, m\[uid\]\); \}/.test(idx), 'member trail on records the starting spot');
ok(/if \(breadcrumbsOn\) _setTrailAnchor\(userId, window\._myTrailSince\);/.test(idx), 'my trail on records the starting spot');
ok(/window\._seenFixes\[uid\] \|\| \[\], _anc\)/.test(idx), 'the starting spot is part of the line');
ok(/if \(allPts\.length < 1\) \{ clearTrailLayer\(uid\); return; \}/.test(idx), 'one point is enough to start');
ok(/coords\.length < 2 \? coords\.concat\(\[_tip\]\) : _weldToTip\(coords, _tip\)/.test(idx), 'start spot -> dot is drawn');
ok(/base\.length < 2 \? base\.concat\(\[\[lng, lat\]\]\) : _weldToTip\(base, \[lng, lat\]\)/.test(idx), 'and follows the gliding dot frame by frame');

// The anchor helper itself, against a fake marker.
const src = idx.slice(idx.indexOf('function _setTrailAnchor'), idx.indexOf('function _trailSinceFor'));
const f = new Function('window', 'userMarkers', 'userId', src + '\nreturn _setTrailAnchor;');
const w = { _trailAnchor: {} };
f(w, { a: { _curLngLat: [-82.1, 29.0] } }, 'me')('a', 123);
ok(w._trailAnchor.a && w._trailAnchor.a.lng === -82.1 && w._trailAnchor.a.ts === 123, 'anchor taken from the drawn dot');
f(w, {}, 'me')('a', 456);
ok(!w._trailAnchor.a, 'no dot, no stale anchor');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
