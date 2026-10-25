// Runs the REAL _animateMarker -- pulled out of public/index.html by its function text -- with a
// settable clock, and reads back the glide duration it picked (marker._lastGapMs, which is also
// what _followRecenter/_camDur inherit).
//
// Why this exists: a remote dot's glide used to last as long as the VIEWER's gap since the last
// glide. That gap is jittered by the 400 ms render coalescing and inflated by every pause in
// arrivals (tab hidden, a teleport, a parked member setting off), so the first glide after a
// pause crawled for up to 30 s. The row already carries the reporter's clock (fixTs) and the
// marker keeps the previous report's time in _ts; the glide is now paced to that interval, with
// the viewer gap as a ceiling so no cadence ever glides LONGER than it did before. Own-dot calls
// pass no opts and must behave exactly as before.
//
// Usage:  node tools/glide.test.mjs        (exit 0 = the glide pacing behaves)
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(66)} ${detail || ''}`);
};

// ── Pull the shipped text out ─────────────────────────────────────────────────────────────
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
  const grouping = { calls: 0 };
  const fn = build(
    win,
    { visibilityState: 'hidden', body: { classList: { contains: () => false } } },   // hidden: the camera branch stays out of it
    { now: () => clock.t },
    (step) => { rafs.push(step); return rafs.length; },
    () => {},
    metersApart, {}, () => { grouping.calls++; });
  return { clock, rafs, win, fn, grouping, step: () => rafs[rafs.length - 1] };
}
// The marker fake carries exactly what _animateMarker reads and writes on a mapbox Marker.
function makeMarker(lng, lat, extra) {
  const m = {
    _uid: 'u', _curLngLat: [lng, lat], _ll: [lng, lat], _ts: 0, _lastFixAt: 0, _anim: null, sets: [],
    getLngLat() { return { lng: this._curLngLat[0], lat: this._curLngLat[1] }; },
    setLngLat(ll) { this.sets.push(ll.slice()); return this; },
  };
  return Object.assign(m, extra || {});
}
const LNG = -84.9, LAT = 30.44;
const DEG_PER_M = 1 / 111194.9;              // one metre of latitude, from the 6371 km sphere metersApart uses
const north = (m) => LAT + m * DEG_PER_M;
const MILE_M = 1609.344;
const T0 = 1760000000000;                    // an epoch-ms fixTs, like the row carries
const near = (x, y, eps) => Math.abs(x - y) <= (eps == null ? 1e-9 : eps);
const atTarget = (m, lng, lat) => near(m._curLngLat[0], lng) && near(m._curLngLat[1], lat);
const finish = (H, m) => { const s = H.step(); s(H.clock.t + 60000); return s; };   // t clamps at 1

// 1. The resume case: viewer away 60 s, reporter on a 10 s cadence, 300 m leg (67 mph).
{
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  const to = north(300);
  H.fn(m, LNG, to, null, { fixTs: T0 + 10000, remote: true });
  check('resume: glide paced to the reporter (10 s), not the viewer (60 s)', m._lastGapMs === 10000, `_lastGapMs=${m._lastGapMs}`);
  check('resume: _lastFixAt stamped to the clock', m._lastFixAt === H.clock.t);
  check('resume: one frame scheduled', H.rafs.length === 1 && m._anim === 1);
  const step = H.step();
  step(H.clock.t + 5400);
  check('resume: halfway at 5.4 s (dur is gap * 1.08)', near(m._curLngLat[1], (LAT + to) / 2) && near(m._curLngLat[0], LNG), `lat=${m._curLngLat[1]}`);
  step(H.clock.t + 10800);
  check('resume: on target at 10.8 s and the animation is over', atTarget(m, LNG, to) && m._anim === null, `anim=${m._anim}`);
  check('resume: setLngLat was called with the frame positions', m.sets.length === 2 && near(m.sets[1][1], to));
}

// 2. Own dot (no opts): today's rule, untouched -- including the 30 s ceiling.
{
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  const to = north(300);
  H.fn(m, LNG, to);
  check('own dot: _lastGapMs is the viewer gap (60 s)', m._lastGapMs === 60000, `_lastGapMs=${m._lastGapMs}`);
  const step = H.step();
  step(H.clock.t + 15000);
  check('own dot: halfway at 15 s (ceiling is 30 s, not lower)', near(m._curLngLat[1], (LAT + to) / 2), `lat=${m._curLngLat[1]}`);
  step(H.clock.t + 29999);
  check('own dot: still in flight just before 30 s', !atTarget(m, LNG, to) && m._anim !== null);
  step(H.clock.t + 30000);
  check('own dot: done at exactly 30 s', atTarget(m, LNG, to) && m._anim === null);
}

// 3. Deltas that are not an interval: zero, negative, 90 s -> viewer gap every time.
for (const [label, dt] of [['zero', 0], ['negative', -5000], ['90 s', 90000], ['exactly 300 ms', 300]]) {
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + dt, remote: true });
  check(`bad delta (${label}): falls back to the viewer gap`, m._lastGapMs === 60000, `_lastGapMs=${m._lastGapMs}`);
}

// 4. Plausibility: a 10 s reporter interval against a leg no car covers in 10 s.
{
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  H.fn(m, LNG, north(3 * MILE_M), null, { fixTs: T0 + 10000, remote: true });   // 3 mi / 10 s = 1,080 mph
  check('implausible (3 mi in 10 s): viewer gap, reporter interval rejected', m._lastGapMs === 60000, `_lastGapMs=${m._lastGapMs}`);
}
{
  // 17 miles never reaches the plausibility test: the teleport guard (0.05 deg) fires first.
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0, _lastGapMs: 4321 });
  H.fn(m, LNG, north(17 * MILE_M), null, { fixTs: T0 + 10000, remote: true });
  check('17 mi in 10 s: teleports, _lastGapMs untouched, no frame', m._lastGapMs === 4321 && H.rafs.length === 0 && atTarget(m, LNG, north(17 * MILE_M)));
}
for (const [label, mph, want] of [['140 mph', 140, 10000], ['150 mph', 150, 10000], ['160 mph', 160, 60000]]) {
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  const metres = (mph / 2.23694) * 10 * (mph === 150 ? 0.9999 : 1);   // keep the boundary case a hair inside
  H.fn(m, LNG, north(metres), null, { fixTs: T0 + 10000, remote: true });
  check(`speed gate at ${label} over 10 s -> ${want === 10000 ? 'reporter' : 'viewer'} gap`, m._lastGapMs === want, `_lastGapMs=${m._lastGapMs}`);
}

// 5. The reporter interval can only SHORTEN a glide: min() with the viewer gap.
{
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 9600, _ts: T0 });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check('viewer 9600 vs reporter 10000: the shorter one (9600) wins', m._lastGapMs === 9600, `_lastGapMs=${m._lastGapMs}`);
}

// 6. First report after the marker was created: _ts is 0 (or missing) -> viewer gap.
for (const [label, ts] of [['_ts 0', 0], ['_ts missing', undefined]]) {
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: ts });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check(`first report (${label}): viewer gap`, m._lastGapMs === 60000, `_lastGapMs=${m._lastGapMs}`);
}

// 7. Teleport: the arrival is stamped so the NEXT glide does not inherit the dead time.
{
  const H = harness();
  H.clock.t = 200000;
  const m = makeMarker(LNG, LAT, { _lastFixAt: 100000, _ts: T0, _lastGapMs: 4321 });
  H.fn(m, LNG, LAT + 0.3, null, { fixTs: T0 + 10000, remote: true });
  check('teleport: _lastFixAt stamped to the clock', m._lastFixAt === 200000, `_lastFixAt=${m._lastFixAt}`);
  check('teleport: _lastGapMs untouched (the camera must not ease toward a dot already there)', m._lastGapMs === 4321);
  check('teleport: no frame scheduled, dot placed at the target', H.rafs.length === 0 && atTarget(m, LNG, LAT + 0.3) && m.sets.length === 1);
  // And the glide after it measures from the teleport, not from before it.
  H.clock.t = 210000;
  H.fn(m, LNG, LAT + 0.3 + 300 * DEG_PER_M, null, { fixTs: T0 + 20000, remote: true });
  check('glide after teleport: viewer gap is 10 s (from the teleport), reporter 10 s', m._lastGapMs === 10000, `_lastGapMs=${m._lastGapMs}`);
}

// 8. Merged oval (build 970): the member's true fix is recorded, the grouping pass is asked to
//    rebuild the oval WITHOUT jumping it, and then the oval GLIDES like a solo dot -- it used to
//    return here with no frame, which is why a pair at 70 mph looked frozen between fixes.
//    tools/ovalglide.test.mjs covers the centroid target; here only the glide-engine facts.
{
  const H = harness();
  H.clock.t = 300000;
  H.win._markerGroupMembers = { u: ['u', 'x'] };
  const m = makeMarker(LNG, LAT, { _lastFixAt: 100000, _ts: T0, _lastGapMs: 4321 });
  const to = north(300);
  H.fn(m, LNG, to, null, { fixTs: T0 + 10000, remote: true });
  check('merged: _lastFixAt stamped to the clock', m._lastFixAt === 300000, `_lastFixAt=${m._lastFixAt}`);
  check('merged: the member\'s true fix is recorded on _ll', near(m._ll[1], to), JSON.stringify(m._ll));
  check('merged: a glide frame IS scheduled and nothing was jumped', H.rafs.length === 1 && m.sets.length === 0, `rafs=${H.rafs.length} sets=${m.sets.length}`);
  check('merged: grouping pass asked to rebuild the oval, once', H.grouping.calls === 1, `calls=${H.grouping.calls}`);
  check('merged: the glide is paced by the reporter (10 s), so _lastGapMs is written', m._lastGapMs === 10000, `_lastGapMs=${m._lastGapMs}`);
}

// 9. Ten chained legs at a 10 s reporter cadence; viewer arrivals jittered +400/-400 by the
//    render coalescing. Before: _lastGapMs wandered 9600-10400. After: 9600-10000, never 10400.
{
  const H = harness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t, _ts: T0 });
  const gaps = [], vGaps = [];
  for (let i = 1; i <= 10; i++) {
    const vGap = 10000 + (i % 2 ? 400 : -400);
    H.clock.t += vGap; vGaps.push(vGap);
    const fixTs = T0 + i * 10000;
    H.fn(m, LNG, north(i * 300), null, { fixTs, remote: true });
    finish(H, m);
    m._ts = fixTs;                       // the render loop restamps _ts after the glide call (see the feed)
    gaps.push(m._lastGapMs);
  }
  check('chained: every leg within [9600, 10000]', gaps.every((g) => g >= 9600 && g <= 10000), gaps.join(' '));
  check('chained: never the inflated 10400 the viewer clock alone would give', !gaps.includes(10400) && vGaps.includes(10400));
  check('chained: dot ends each leg on target', atTarget(m, LNG, north(3000)));
}

// ── The call site: the real line from _processUsersSnapInner, run with a capturing stub ───
{
  const fs = src.indexOf('function _processUsersSnapInner(');
  const fe = src.indexOf('window._processUsersSnap = _processUsersSnap;', fs);
  const ci = src.indexOf('_animateMarker(userMarkers[uid], data.lng, data.lat, data.path', fs);
  check('call site: the feed call sits inside _processUsersSnapInner', fs > 0 && ci > fs && ci < fe);
  const line = src.slice(src.lastIndexOf('\n', ci) + 1, src.indexOf('\n', ci)).trim();
  const run = (data) => {
    let got = null;
    new Function('_animateMarker', 'userMarkers', 'uid', 'data', line)((mk, lng, lat, path, opts) => { got = { mk, lng, lat, path, opts }; }, { r: 'M' }, 'r', data);
    return got;
  };
  const g1 = run({ lng: 1, lat: 2, path: [[2, 1, 5]], fixTs: 777, ts: 555 });
  check('call site: passes fixTs from the row with remote:true', g1 && g1.mk === 'M' && g1.lng === 1 && g1.lat === 2 && g1.path.length === 1 && g1.opts.fixTs === 777 && g1.opts.remote === true, JSON.stringify(g1 && g1.opts));
  const g2 = run({ lng: 1, lat: 2, ts: 555 });
  check('call site: a row without fixTs hands over ts (same expression _ts uses)', g2 && g2.opts.fixTs === 555, JSON.stringify(g2 && g2.opts));
  const g3 = run({ lng: 1, lat: 2 });
  check('call site: no clock at all -> fixTs 0 (viewer gap)', g3 && g3.opts.fixTs === 0, JSON.stringify(g3 && g3.opts));
  // _ts must still be the PREVIOUS report when the glide starts: its restamp comes after the call.
  const tsStamp = src.indexOf('userMarkers[uid]._ts = data.fixTs || data.ts || 0;', fs);
  check('call site: _ts is restamped AFTER the glide call, so the pair is a real interval', tsStamp > ci && tsStamp < fe);
}

// Extra guards on the text itself -- never the only check, see above.
check('source: own-dot calls pass no opts (two of them)', (src.match(/_animateMarker\(userMarkers\[userId\], lng, lat\);/g) || []).length === 2);
check('source: _lastGapMs is written in exactly one place (never on the early returns)', (fnSrc.match(/_lastGapMs\s*=/g) || []).length === 1);
check('source: the 30 s ceiling stands', /Math\.max\(700, Math\.min\(30000, _gap \* 1\.08\)\)/.test(fnSrc));
check('source: the interval window and speed gate are the spec\'s', /_rGap > 300 && _rGap < 60000/.test(fnSrc) && /_mphR <= 150/.test(fnSrc));

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
