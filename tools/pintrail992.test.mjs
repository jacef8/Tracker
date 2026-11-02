// Build 992: a crew drop's saved copy never draws on that crew's map (Jace saw two pins with two
// delete windows), and a shown trail starts when it is turned on (History has the past).
//
// Usage:  node tools/pintrail992.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

ok(idx.includes('if (_alsoShare && _shareRoom) _sp.room = _shareRoom;'), 'a crew drop\'s copy remembers its crew');
ok(idx.includes('if (pin.room && typeof groupName !== \'undefined\' && pin.room === groupName && !window._soloMode) return;'), 'that crew\'s map skips the copy');
ok(idx.includes('if (_near({ lat: +pin.lat, lng: +pin.lng })) return;'), 'a copy within ~30 ft of a drawn pin is skipped');
ok(idx.includes("window._savedReT = setTimeout(function () { try { if (window._showSavedOnMap) _renderSavedOnMap();"), 'the copies re-check every time the pin layer is rebuilt');

ok(idx.includes('if (m[uid]) delete m[uid]; else { m[uid] = Date.now();'), 'Show trail stores when it was turned on');
ok(idx.includes("window._myTrailSince = breadcrumbsOn ? Date.now() : 0;"), 'my trail button stores it too');
ok(idx.includes('now - p.ts < TRAIL_DRAW_MS && p.ts >= _since'), 'the line drops points from before that moment');
const sf = new Function('var userId="me", window={_myTrailSince:500}, _ts={a:900,b:1};function _getTrailShow(){return _ts;}\n' +
  idx.slice(idx.indexOf('function _trailSinceFor(uid)'), idx.indexOf('}', idx.indexOf('return (typeof v')) + 1) + '\nreturn _trailSinceFor;')();
ok(sf('me') === 500 && sf('a') === 900 && sf('b') === 0 && sf('zz') === 0, 'start time per person; an old "1" flag means no cut-off');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
