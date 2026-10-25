// A merged oval (two people riding together) must GLIDE to its new centre, not jump.
//
// Before this change the merged branch of _animateMarker recorded the fix, re-centred the oval
// through the grouping pass and returned before the glide: the oval sat still for ten seconds,
// jumped ~1,000 ft, sat again -- under a label reading 71 mph. This runs the shipped
// _animateMarker with a two-member group and checks that a glide is scheduled, that it starts
// from where the oval is DRAWN (not from the raw fix), that it ends on the group's centroid,
// that the member's own true fix is recorded unchanged, and that the grouping pass is told not
// to jump the oval while the glide is about to own it.
//
// Usage: node tools/ovalglide.test.mjs [index.html]
import { readFileSync } from 'node:fs';
const file = process.argv[2] || 'public/index.html';
const src = readFileSync(file, 'utf8');

const a = src.indexOf('function _animateMarker(marker');
const b = src.indexOf('// Smoothly recenter the map', a);
if (a < 0 || b < 0) { console.error('could not extract _animateMarker'); process.exit(1); }
const fnSrc = src.slice(a, b);

// metersApart, real.
const ma = src.indexOf('function metersApart(');
let depth = 0, mb = -1;
for (let i = src.indexOf('{', ma); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { mb = i + 1; break; } } }
const metersApart = new Function(src.slice(ma, mb) + '; return metersApart;')();

let fail = 0;
const check = (name, ok, detail) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(62)} ${detail || ''}`); };

function harness() {
  let nowMs = 100000;
  const rafs = [];
  const performance = { now: () => nowMs };
  const requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
  const cancelAnimationFrame = () => {};
  const mk = (lng, lat, uid) => {
    const m = { _uid: uid, _pos: [lng, lat], _curLngLat: [lng, lat], _ll: [lng, lat], _el: {}, _anim: null, _ts: 0 };
    m.setLngLat = (p) => { m._pos = [+p[0], +p[1]]; };
    m.getLngLat = () => ({ lng: m._pos[0], lat: m._pos[1] });
    return m;
  };
  const userMarkers = {};
  const window = { _markerGroupMembers: {}, _updateTrailTip: null, _camLockUid: null };
  const groupingCalls = [];
  const _updateMarkerGrouping = (immediate) => { groupingCalls.push({ immediate, ovalGlideDuringCall: !!userMarkers.p._ovalGlide }); };
  const map = { jumpTo() {}, setCenter() {} };
  const document = { visibilityState: 'visible' };
  const _camPad = () => null;
  const _camPlace = () => {};
  const _animateMarker = new Function('window', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    'metersApart', 'map', '_updateMarkerGrouping', 'userMarkers', '_camPad', '_camPlace', 'followUid', 'headingUpOn',
    fnSrc + '; return _animateMarker;')(window, document, performance, requestAnimationFrame, cancelAnimationFrame,
    metersApart, map, _updateMarkerGrouping, userMarkers, _camPad, _camPlace, null, false);
  return { window, userMarkers, mk, rafs, groupingCalls, _animateMarker, tick: (ms) => { nowMs += ms; const f = rafs.splice(0); f.forEach((fn) => fn(nowMs)); }, now: () => nowMs };
}

// ── Two people riding together: the primary's new fix ─────────────────────────────────────
{
  const H = harness();
  const P = H.mk(-84.9000, 30.4400, 'p');     // primary; the oval is drawn here
  const Q = H.mk(-84.9004, 30.4402, 'q');     // the other member, ~150 ft away
  H.userMarkers.p = P; H.userMarkers.q = Q;
  H.window._markerGroupMembers = { p: ['p', 'q'] };
  P._lastFixAt = H.now() - 10000; P._ts = 1000;

  const newLng = -84.8950, newLat = 30.4450;   // P's next fix, ~0.4 mi on
  H._animateMarker(P, newLng, newLat, [[30.4420, -84.8980, 1]], { fixTs: 11000, remote: true });

  check('a glide was scheduled (the old branch returned before any rAF)', H.rafs.length === 1, `rafs=${H.rafs.length}`);
  check('the member\'s TRUE fix is recorded on _ll', P._ll[0] === newLng && P._ll[1] === newLat, JSON.stringify(P._ll));
  check('the oval was not jumped to the raw fix before gliding', P._pos[0] === -84.9000 && P._pos[1] === 30.4400, JSON.stringify(P._pos));
  check('grouping ran once, immediate, with the no-jump flag raised', H.groupingCalls.length === 1 && H.groupingCalls[0].immediate === true && H.groupingCalls[0].ovalGlideDuringCall === true, JSON.stringify(H.groupingCalls));
  check('the flag is lowered again after grouping', P._ovalGlide === false, String(P._ovalGlide));

  const cx = (newLng + Q._ll[0]) / 2, cy = (newLat + Q._ll[1]) / 2;
  H.tick(5000);   // midway
  const mid = P._pos.slice();
  check('midway the oval is between its old spot and the centroid', mid[0] > -84.9000 && mid[0] < cx && mid[1] > 30.4400 && mid[1] < cy, JSON.stringify(mid));
  for (let i = 0; i < 40 && H.rafs.length; i++) H.tick(1000);
  check('the glide ends ON the group centroid, not on the raw fix', Math.abs(P._pos[0] - cx) < 1e-9 && Math.abs(P._pos[1] - cy) < 1e-9, `end=${JSON.stringify(P._pos)} centroid=${JSON.stringify([cx, cy])}`);
  check('the route (path) was ignored for the oval -- straight glide', mid[0] !== -84.8980, '');
  check('after the glide, _ll still holds the true fix (not the centroid)', P._ll[0] === newLng && P._ll[1] === newLat, '');
}

// ── Solo dot: nothing about the ordinary glide changed ───────────────────────────────────
{
  const H = harness();
  const S = H.mk(-84.9000, 30.4400, 's'); H.userMarkers.s = S;
  S._lastFixAt = H.now() - 10000; S._ts = 1000;
  H._animateMarker(S, -84.8950, 30.4450, null, { fixTs: 11000, remote: true });
  check('solo: glide scheduled, grouping NOT called', H.rafs.length === 1 && H.groupingCalls.length === 0, `rafs=${H.rafs.length} grouping=${H.groupingCalls.length}`);
  for (let i = 0; i < 40 && H.rafs.length; i++) H.tick(1000);
  check('solo: ends on its own fix', Math.abs(S._pos[0] + 84.8950) < 1e-9 && Math.abs(S._pos[1] - 30.4450) < 1e-9, JSON.stringify(S._pos));
}

// ── The grouping pass leaves a gliding oval alone (static guard on the shipped text) ───────
{
  const g = src.indexOf('function _updateMarkerGrouping(');
  const blk = src.slice(g, g + 12000);
  check('grouping only jumps the oval when no glide owns it', blk.includes('if (!_pmk._ovalGlide && !_pmk._anim) _pmk.setLngLat([_sx / _n, _sy / _n]);'), '');
}

console.log(fail ? `\n${fail} FAILED` : '\nall pass');
process.exit(fail ? 1 : 0);
