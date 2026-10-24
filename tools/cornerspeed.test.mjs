// Runs the REAL _animateMarker -- pulled out of public/index.html by its function text -- round
// an L-shaped route with a settable clock, and reads back WHERE the dot is at known fractions of
// the glide.
//
// Why this exists: each leg of a routed glide gets a share of the time proportional to its
// length, and that length was measured in raw DEGREES. A degree of longitude is only cos(lat) as
// long as a degree of latitude, so at ~30 N an east-west leg got about 13% more time per foot
// than a north-south one, and a dot going round a corner visibly braked or sped up. The leg
// lengths now scale longitude by cos(lat), so every leg's share matches real ground distance and
// the dot holds one speed through the corner. _atFraction interpolates within a leg by fraction,
// which the scale does not touch; the straight glide (no path) is untouched too.
//
// Usage:  node tools/cornerspeed.test.mjs        (exit 0 = even speed through corners)
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(70)} ${detail || ''}`);
};

// ── Pull the shipped text out (same extraction as tools/glide.test.mjs) ──────────────────
const a = src.indexOf('function _animateMarker(marker');
const b = src.indexOf('// Smoothly recenter the map', a);
if (a < 0 || b < 0) { console.error('could not extract _animateMarker'); process.exit(1); }
const fnSrc = src.slice(a, b);
{
  let parses = true; try { new Function(fnSrc); } catch (e) { parses = false; }
  check('extraction: _animateMarker text parses on its own', parses, `${fnSrc.split('\n').length} lines`);
}
function extractFn(name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error(name + ' not found in public/index.html');
  let d = 0, end = -1;
  for (let j = src.indexOf('{', s); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error(name + ': braces never balanced');
  return src.slice(s, end + 1);
}
const metersApart = new Function(extractFn('metersApart') + '\n return metersApart;')();
const build = new Function('window', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
                           'metersApart', 'map', '_updateMarkerGrouping', fnSrc + '\n return _animateMarker;');

// ── Harness: a clock we set by hand, a rAF that hands us the step function ────────────────
function harness() {
  const clock = { t: 100000 };
  const rafs = [];
  const win = {};
  const fn = build(
    win,
    { visibilityState: 'hidden', body: { classList: { contains: () => false } } },   // hidden: the camera branch stays out of it
    { now: () => clock.t },
    (step) => { rafs.push(step); return rafs.length; },
    () => {},
    metersApart, {}, () => {});
  return { clock, rafs, win, fn, step: () => rafs[rafs.length - 1] };
}
// The marker fake carries exactly what _animateMarker reads and writes on a mapbox Marker.
// _lastFixAt 0 means "never took a report": the viewer gap falls back to 1400 ms, and with no
// reporter clock on the call the glide is max(700, min(30000, 1400 * 1.08)) = 1512 ms.
function makeMarker(lng, lat) {
  return {
    _uid: 'u', _curLngLat: [lng, lat], _ll: [lng, lat], _ts: 0, _lastFixAt: 0, _anim: null, sets: [],
    getLngLat() { return { lng: this._curLngLat[0], lat: this._curLngLat[1] }; },
    setLngLat(ll) { this.sets.push(ll.slice()); return this; },
  };
}
const DUR = 1512;
const LNG0 = -84.9;
const EPS = 1e-6;
const near = (x, y, eps) => Math.abs(x - y) <= (eps == null ? EPS : eps);
const at = (m, lng, lat, eps) => near(m._curLngLat[0], lng, eps) && near(m._curLngLat[1], lat, eps);
const pos = (m) => `[${m._curLngLat[0].toFixed(7)}, ${m._curLngLat[1].toFixed(7)}]`;
// An L: east by `d` degrees of longitude, then north by `d` degrees of latitude. Rows carry the
// route as [lat, lng, ts], which is what the feed hands _animateMarker.
function glideL(lat0, d, opts, pathTs) {
  const H = harness();
  const m = makeMarker(LNG0, lat0);
  const corner = [LNG0 + d, lat0], target = [LNG0 + d, lat0 + d];
  const path = [[corner[1], corner[0], pathTs == null ? Date.now() - 5000 : pathTs]];
  H.fn(m, target[0], target[1], path, opts);
  return { H, m, corner, target, start: H.clock.t };
}

// 1. The spec's case: 60 N, where cos(lat) = 0.5 exactly, so the east leg is HALF the ground
//    length of the north leg although equal in degrees. Even speed means the corner comes at
//    one third of the glide, not half.
{
  const { H, m, corner, target, start } = glideL(60, 0.01);
  check('60 N: glide paced to the 1400 ms viewer gap (dur 1512)', m._lastGapMs === 1400 && H.rafs.length === 1, `_lastGapMs=${m._lastGapMs}`);
  const step = H.step();
  step(start + DUR / 3);
  check('60 N: at dur/3 the dot is ON the corner (east leg is 1/3 of the ground distance)', at(m, corner[0], corner[1]), pos(m));
  step(start + DUR / 2);
  // Before the patch the equal-degree legs split the time evenly and dur/2 WAS the corner
  // (lat exactly 60). Now the dot is a quarter of the way up the north leg.
  check('60 N: at dur/2 the dot is PAST the corner, up the north leg', near(m._curLngLat[0], corner[0]) && m._curLngLat[1] > corner[1] + EPS, pos(m));
  check('60 N: at dur/2 it is a quarter of the way up (lat 60.0025)', at(m, corner[0], corner[1] + 0.0025), pos(m));
  step(start + 2 * DUR / 3);
  check('60 N: at 2dur/3 it is halfway up the north leg (lat 60.005)', at(m, corner[0], corner[1] + 0.005), pos(m));
  step(start + DUR);
  check('60 N: at dur the dot is on target and the animation is over', at(m, target[0], target[1]) && m._anim === null, `anim=${m._anim}`);
  // The point of it all: the same ground speed on both legs.
  const eastM = metersApart(60, LNG0, corner[1], corner[0]);
  const northM = metersApart(corner[1], corner[0], target[1], target[0]);
  const mphEast = (eastM / (DUR / 3 / 1000)) * 2.23694, mphNorth = (northM / (2 * DUR / 3 / 1000)) * 2.23694;
  check('60 N: ground speed is the same on both legs (within 0.1%)', Math.abs(mphEast / mphNorth - 1) < 1e-3, `east ${mphEast.toFixed(1)} mph, north ${mphNorth.toFixed(1)} mph`);
}

// 2. The feed's real call shape (remote, with the reporter clock absent) takes the same route.
{
  const { H, m, corner, start } = glideL(60, 0.01, { fixTs: 0, remote: true });
  H.step()(start + DUR / 3);
  check('60 N via the feed call shape: corner at dur/3 as well', at(m, corner[0], corner[1]), pos(m));
}

// 3. The equator: cos(0) = 1, degrees ARE ground distance, so the scale changes nothing and the
//    equal-degree L splits the glide evenly.
{
  const { H, m, corner, start } = glideL(0, 0.01);
  H.step()(start + DUR / 2);
  check('equator: corner at exactly dur/2 (scale is a no-op where degrees are equal)', at(m, corner[0], corner[1]), pos(m));
}

// 4. Home latitude (30.44 N): the corner comes at c/(1+c) of the glide, c = cos(lat).
{
  const lat0 = 30.44, c = Math.cos(lat0 * Math.PI / 180);
  const { H, m, corner, start } = glideL(lat0, 0.01);
  const f = c / (1 + c);
  H.step()(start + DUR * f);
  check(`30.44 N: corner at ${f.toFixed(4)} of the glide (cos/(1+cos))`, at(m, corner[0], corner[1]), pos(m));
  check('30.44 N: the old even split (dur/2) is no longer the corner', Math.abs(f - 0.5) > 0.03, `old 0.5000 vs new ${f.toFixed(4)}`);
}

// 5. Regression: a straight glide with no path reaches the midpoint at dur/2 exactly as before.
{
  const H = harness();
  const m = makeMarker(LNG0, 60);
  H.fn(m, LNG0 + 0.01, 60.01);
  check('straight (no path): dur 1512 as before', m._lastGapMs === 1400);
  const step = H.step();
  step(H.clock.t + DUR / 2);
  check('straight (no path): midpoint at dur/2', at(m, LNG0 + 0.005, 60.005), pos(m));
  step(H.clock.t + DUR);
  check('straight (no path): on target at dur, animation over', at(m, LNG0 + 0.01, 60.01) && m._anim === null);
}
// A straight glide whose path is a single waypoint ON the line is also unchanged: both legs
// scale by the same cos(lat), so their shares are what plain distance gives.
{
  const H = harness();
  const m = makeMarker(LNG0, 60);
  H.fn(m, LNG0, 60.01, [[60.0025, LNG0, Date.now() - 5000]]);   // waypoint a quarter of the way north
  const step = H.step();
  step(H.clock.t + DUR / 4);
  check('straight with an on-line waypoint: quarter mark at dur/4', at(m, LNG0, 60.0025), pos(m));
  step(H.clock.t + DUR / 2);
  check('straight with an on-line waypoint: midpoint at dur/2', at(m, LNG0, 60.005), pos(m));
}

// 6. The path-staleness guard still nulls a route older than 10 min: the dot glides straight
//    to the target instead of round the corner.
{
  const { H, m, corner, target, start } = glideL(60, 0.01, undefined, Date.now() - 11 * 60 * 1000);
  const step = H.step();
  step(start + DUR / 2);
  check('stale path (11 min): ignored, dot at the straight-line midpoint at dur/2', at(m, (LNG0 + target[0]) / 2, (60 + target[1]) / 2), pos(m));
  check('stale path (11 min): never visited the corner', !m.sets.some((p) => near(p[0], corner[0]) && near(p[1], corner[1])));
  step(start + DUR);
  check('stale path (11 min): on target at dur', at(m, target[0], target[1]) && m._anim === null);
}
{
  const { H, m, corner, start } = glideL(60, 0.01, undefined, Date.now() - 9 * 60 * 1000);
  H.step()(start + DUR / 3);
  check('fresh path (9 min): still followed, corner at dur/3', at(m, corner[0], corner[1]), pos(m));
}

// 7. The pole: cos(90) is as good as zero, an east-west leg has no ground length there, and the
//    numbers must stay finite and the dot still arrive.
{
  const { H, m, target, start } = glideL(90 - 0.01, 0.01);   // from 89.99 N east then north to the pole
  const step = H.step();
  step(start + DUR / 2);
  check('near the pole: positions finite', isFinite(m._curLngLat[0]) && isFinite(m._curLngLat[1]), pos(m));
  step(start + DUR);
  check('near the pole: on target at dur, animation over', at(m, target[0], target[1]) && m._anim === null, pos(m));
}

// Extra guards on the text itself -- never the only check, see above.
check('source: _cosLat is cos(fromLat) with the pole guard', /var _cosLat = Math\.cos\(fromLat \* Math\.PI \/ 180\) \|\| 1;/.test(fnSrc));
check('source: the longitude delta is the one scaled by _cosLat', /var _dx = \(_wp\[_si\]\[0\] - _wp\[_si - 1\]\[0\]\) \* _cosLat, _dy = _wp\[_si\]\[1\] - _wp\[_si - 1\]\[1\];/.test(fnSrc));
check('source: the scale is applied before _atFraction walks the legs', fnSrc.indexOf('_cosLat') > 0 && fnSrc.indexOf('_cosLat') < fnSrc.indexOf('function _atFraction'));
check('source: _atFraction itself is unchanged (walks _seg by fraction u)', /var u = _seg\[i\] > 0 \? \(want - acc\) \/ _seg\[i\] : 1;/.test(fnSrc));

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
