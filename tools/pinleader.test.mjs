// Pulls the REAL _offsetCollidingPins out of public/index.html and runs it against a stub
// map, so this tests the shipped source rather than a retyped copy of it.
//
// THE CONTRACT, as of build 923: a pin is drawn exactly where it is, always. No screen-space
// nudge, no leader line, under any projection, at any zoom, however many times the layout
// pass runs.
//
// It used to nudge a pin 40px clear of a marker covering it, which is a reasonable thing to
// want and cost far too much: the offset was written back as a coordinate and so froze at one
// zoom (918), and even after that was fixed it still drew a waypoint a mile from its real
// position, then 80px from a position six feet away. On a map people walk by in the dark,
// where a pin is drawn is the whole product. Markers are DOM elements with their own
// collision layout, so the marker moves and the pin does not.
import { readFileSync } from 'node:fs';

const src = readFileSync('public/index.html', 'utf8');
const start = src.indexOf('window._offsetCollidingPins = function () {');
if (start < 0) throw new Error('function not found');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const fnSrc = src.slice(start, end) + ';';

// Flat stub projection: one screen pixel = (1 / 2^zoom) degrees. Crude, but it has the
// property that matters -- the same ground distance is a different pixel distance at a
// different zoom, which is what the old bug turned on.
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
globalThis.userMarkers = { me: { _el: { style: {} }, _ll: [TRUE_LL[0], TRUE_LL[1]] } };

eval(fnSrc);

const pxApart = () => {
  const f = source._data.features[0];
  const a = map.project(f.geometry.coordinates);
  const b = map.project(TRUE_LL);
  return Math.hypot(a.x - b.x, a.y - b.y);
};
const leaders = () => (window._pinLeaderFeats || []).length;

let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!cond) fail++;
};

// 1. A pin sitting exactly under a marker -- the case the nudge existed for.
source = freshSource();
ZOOM = 14; window._offsetCollidingPins();
check('pin under a marker: not moved', pxApart() < 0.001, pxApart().toFixed(4) + 'px');
check('pin under a marker: no leader', leaders() === 0, leaders() + ' leaders');

// 2. Repeated layout passes must not creep.
for (let n = 0; n < 40; n++) window._offsetCollidingPins();
check('40 layout passes: still exactly on the truth', pxApart() < 0.001, pxApart().toFixed(4) + 'px');

// 3. Zoom changes must not move it either -- this is what froze at one zoom before.
for (const z of [18, 11, 20, 9]) { ZOOM = z; window._offsetCollidingPins(); }
check('across zooms 18/11/20/9: unmoved', pxApart() < 0.001, pxApart().toFixed(4) + 'px');

// 4. A projection whose inverse lies (terrain / pitch / globe) must change nothing.
const honest = map.unproject;
map.unproject = ([x, y]) => { const r = honest([x, y]); return { lng: r.lng, lat: r.lat - 0.02 }; };
ZOOM = 14; window._offsetCollidingPins();
check('lying unproject: unmoved', pxApart() < 0.001, pxApart().toFixed(4) + 'px');
check('lying unproject: no leader', leaders() === 0, leaders() + ' leaders');
map.unproject = honest;

// 5. Nothing colliding at all -- the ordinary case.
globalThis.userMarkers = { me: { _el: { style: {} }, _ll: [-80.0, 25.0] } };
source = freshSource();
ZOOM = 16; window._offsetCollidingPins();
check('no collision: on the truth', pxApart() < 0.001, pxApart().toFixed(4) + 'px');
check('no collision: no leader', leaders() === 0, leaders() + ' leaders');

// 6. A displacement baked in by an older build must be cleaned up, not preserved.
source = freshSource();
source._data.features[0].geometry.coordinates = [TRUE_LL[0], TRUE_LL[1] - 0.01];
source._data.features[0].properties._trueLL = [TRUE_LL[0], TRUE_LL[1]];
globalThis.userMarkers = { me: { _el: { style: {} }, _ll: [TRUE_LL[0], TRUE_LL[1]] } };
ZOOM = 14; window._offsetCollidingPins();
check('stale displacement from an older build: restored', pxApart() < 0.001, pxApart().toFixed(4) + 'px');

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
