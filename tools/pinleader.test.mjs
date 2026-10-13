// Pulls the REAL _offsetCollidingPins out of public/index.html and runs it against a stub
// map, so this tests the shipped source rather than a retyped copy of it.
//
// The bug: the 40px nudge was computed in screen space and written back as a coordinate, so
// it was frozen at the zoom it happened at. Zoom in and the pin renders far from the truth,
// and because it is then clear of the marker the nudge never corrects it.
//
// The invariant that has to hold: at ANY zoom, the drawn position is at most ~40px from the
// true position, and the true position is never lost.
import { readFileSync } from 'node:fs';

const src = readFileSync('public/index.html', 'utf8');
const start = src.indexOf('window._offsetCollidingPins = function () {');
if (start < 0) throw new Error('function not found');
// Walk braces to the end of the assignment.
let i = src.indexOf('{', start), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const fnSrc = src.slice(start, end) + ';';

// ── Stub map: a flat projection where one screen pixel = (1 / 2^zoom) degrees. Crude, but it
//    has the property that matters -- the same ground distance is a different pixel distance
//    at a different zoom, which is the whole bug.
let ZOOM = 14;
const scale = () => Math.pow(2, ZOOM);
const map = {
  getSource: () => source,
  project: ([lng, lat]) => ({ x: lng * scale(), y: -lat * scale() }),
  unproject: ([x, y]) => ({ lng: x / scale(), lat: -y / scale() }),
};
const TRUE_LL = [-84.95, 30.42];
let source;
const freshSource = () => ({
  _data: {
    features: [{
      type: 'Feature',
      properties: { pid: 'p1' },
      geometry: { type: 'Point', coordinates: [TRUE_LL[0], TRUE_LL[1]] },
    }],
  },
  setData(d) { this._data = d; },
});

globalThis.window = { _mapReady: true, _deviceMarkers: null };
globalThis.map = map;
globalThis.PIN_HIT_PX = 34;   // module-scope in index.html; the harness has to supply it
// One marker sitting exactly on the pin -- the degenerate "straight down" case.
globalThis.userMarkers = { me: { _el: { style: {} }, _ll: [TRUE_LL[0], TRUE_LL[1]] } };

eval(fnSrc);

const pxApart = () => {
  const f = source._data.features[0];
  const a = map.project(f.geometry.coordinates);
  const b = map.project(TRUE_LL);
  return Math.hypot(a.x - b.x, a.y - b.y);
};

let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!cond) fail++;
};

source = freshSource();

// 1. One pass at zoom 14: the nudge should be ~40px.
ZOOM = 14; window._offsetCollidingPins();
check('zoom 14, one pass: offset is ~40px', Math.abs(pxApart() - 40) < 1.5, pxApart().toFixed(1) + 'px');

// 2. Repeat passes at the same zoom must NOT accumulate.
for (let n = 0; n < 25; n++) window._offsetCollidingPins();
check('zoom 14, 26 passes: still ~40px (no accumulation)', Math.abs(pxApart() - 40) < 1.5, pxApart().toFixed(1) + 'px');

// 3. THE BUG: zoom in four levels. Before the fix the stored coordinate was frozen, so the
//    same ground offset rendered 16x larger -- ~640px instead of 40px.
ZOOM = 18; window._offsetCollidingPins();
check('zoom 18 after nudging at z14: recomputed, still ~40px', Math.abs(pxApart() - 40) < 1.5, pxApart().toFixed(1) + 'px');

// 4. Zoom back out: must not have drifted either.
ZOOM = 11; window._offsetCollidingPins();
check('zoom 11: still ~40px', Math.abs(pxApart() - 40) < 1.5, pxApart().toFixed(1) + 'px');

// 5. The truth survives every pass.
const kept = source._data.features[0].properties._trueLL;
check('true position preserved', !!kept && kept[0] === TRUE_LL[0] && kept[1] === TRUE_LL[1], JSON.stringify(kept));

// 6. With no marker on top, the pin sits exactly on the truth.
globalThis.userMarkers = { me: { _el: { style: {} }, _ll: [-80.0, 25.0] } };
ZOOM = 16; window._offsetCollidingPins();
check('no collision: pin returns to the true position', pxApart() < 0.001, pxApart().toFixed(4) + 'px');

// 7. THE GUARD. On a flat map unproject is a clean inverse of project. Under 3D terrain,
//    pitch or a globe it is not, and a 40px nudge can resolve to a point a very long way off
//    -- which is what put a waypoint about a mile from its real position on a phone that
//    already had the accumulation fix. Simulate a lying inverse and require the pin to stay
//    exactly on the truth rather than be flung somewhere plausible-looking.
globalThis.userMarkers = { me: { _el: { style: {} }, _ll: [TRUE_LL[0], TRUE_LL[1]] } };
source = freshSource();
const honest = map.unproject;
map.unproject = ([x, y]) => { const r = honest([x, y]); return { lng: r.lng, lat: r.lat - 0.02 }; };
ZOOM = 14; window._offsetCollidingPins();
check('lying unproject: pin is NOT moved', pxApart() < 0.001, pxApart().toFixed(4) + 'px');
check('lying unproject: no leader drawn', (window._pinLeaderFeats || []).length === 0,
      String((window._pinLeaderFeats || []).length) + ' leaders');
map.unproject = honest;
ZOOM = 14; window._offsetCollidingPins();
check('honest unproject again: a normal 40px nudge', Math.abs(pxApart() - 40) < 1.5, pxApart().toFixed(1) + 'px');

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
