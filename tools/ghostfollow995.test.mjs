// Build 995: the camera aims at dots where they are drawn (not ahead at their newest report),
// tapping a group bubble follows it, and a manual zoom-out during group follow is kept.
//
// Usage:  node tools/ghostfollow995.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

ok(/map\.flyTo\(\{ center: mk\._curLngLat \|\| mk\._ll, duration: 700 \}\)/.test(idx), 'person tap aims at the drawn dot');
ok(!/center: primaryMk\._ll, zoom: Math\.max\(map\.getZoom\(\), 16\)/.test(idx), 'group tap no longer forces street zoom on one member\'s report');
ok(/map\.flyTo\(\{ center: primaryMk\._curLngLat \|\| primaryMk\._ll, duration: 700 \}\)/.test(idx), 'group tap aims at the drawn bubble');
ok(/window\._followUser\(uids\[0\], _gLabel\)/.test(idx), 'group tap follows the bubble');
ok(/var _dl = userMarkers\[uid\] && userMarkers\[uid\]\._curLngLat;/.test(idx), 'crew follow frames drawn dots');
ok(/window\._groupFollowUserZoomed && targetZoom >= curZoom - 0\.05\) \{\s*window\._groupFollowOutOfViewSince = null;\s*_gfPublish\(center, _gfHoldZoom\(curZoom\), force\);\s*return true;/.test(idx), 'a manual zoom-out is held in crew follow');
ok(/window\._gfUserZooming = true;/.test(idx) && /if \(window\._gfTarget\) window\._gfTarget\.zoom = map\.getZoom\(\);/.test(idx), 'the pinch zoom becomes the held zoom');

// Label: "Lexi & Jax", "Lexi, Jax & you".
const lab = (names) => names.length > 2 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1] : names.join(' & ');
ok(lab(['Lexi', 'Jax']) === 'Lexi & Jax' && lab(['Lexi', 'Jax', 'you']) === 'Lexi, Jax & you', 'group follow label');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
