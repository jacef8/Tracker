// Build 1027: SHOW WHERE THEY ARE NOW. A moving remote dot glides to its new fix in LIVE_GLIDE_MS,
// aimed at the fix carried forward by the row's speed for (fix age + glide), and the dead-reckoning
// tail carries on from there -- instead of gliding over the whole ~10 s gap and always being one
// report (~15 s) behind (Jace, 2026-11-18). The harness below is deadreckon.test.mjs's, verbatim.
//
// Usage:  node tools/livelead1027.test.mjs [index.html]      (exit 0 = the lead behaves)
import { readFileSync } from 'node:fs';
const _arg = process.argv[2] || 'public/index.html';
const file = /.html$/.test(_arg) ? _arg : _arg.replace(/[/]$/, '') + '/index.html';
const src = readFileSync(file, 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(84)} ${detail || ''}`);
};

// ── Pull the shipped text out ─────────────────────────────────────────────────────────────
const a = src.indexOf('function _animateMarker(marker');
const b = src.indexOf('// Smoothly recenter the map', a);
if (a < 0 || b < 0) { console.error('could not extract _animateMarker'); process.exit(1); }
// The constants the tail reads sit just above the function. When they are missing (build 970)
// the prefix is empty and the behavioural checks below report what the dot does, rather than
// the extraction crashing.
const c0 = src.lastIndexOf('var EXTRAP_MIN_MPH', a);
const constSrc = (c0 > 0 && a - c0 < 4000) ? src.slice(c0, a) : '';
const fnSrc = constSrc + '\n' + src.slice(a, b);
{
  let parses = true; try { new Function(fnSrc); } catch (e) { parses = false; }
  check('extraction: EXTRAP_* constants + _animateMarker text parse on their own', parses, `${fnSrc.split('\n').length} lines`);
}
function extractFn(name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error(name + ' not found in ' + file);
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
  'metersApart', 'map', '_updateMarkerGrouping', 'userMarkers', '_camPad', '_camPlace', 'followUid', 'headingUpOn',
  fnSrc + '\n return _animateMarker;');
// The constants' VALUES, read back from the same text the function runs with (empty on 970).
const K = new Function(constSrc + `
  return typeof EXTRAP_MIN_MPH === 'undefined' ? {} :
    { MIN_MPH: EXTRAP_MIN_MPH, MAX_FRAC: EXTRAP_MAX_FRAC, CAD_MULT: EXTRAP_CAD_MULT, MAX_MS: EXTRAP_MAX_MS, DT_CAP_MS: EXTRAP_DT_CAP_MS,
      HDG_BASE_FT: typeof EXTRAP_HDG_BASE_FT === 'undefined' ? undefined : EXTRAP_HDG_BASE_FT,
      BACK_FT: typeof EXTRAP_BACK_FT === 'undefined' ? undefined : EXTRAP_BACK_FT };`)();
check('constants: the spec\'s values (3 mph, 0.6 of the leg, 1.5 intervals, 30 s) and a 250 ms frame cap',
  K.MIN_MPH === 3 && K.MAX_FRAC === 0.6 && K.CAD_MULT === 1.5 && K.MAX_MS === 30000 && K.DT_CAP_MS === 250, JSON.stringify(K));
check('constants: a 50 ft heading baseline and a 30 ft overshoot tolerance, in feet', K.HDG_BASE_FT === 50 && K.BACK_FT === 30, `base=${K.HDG_BASE_FT} back=${K.BACK_FT}`);
const MAX_FRAC = K.MAX_FRAC ?? 0.6, CAD_MULT = K.CAD_MULT ?? 1.5, DT_CAP = K.DT_CAP_MS ?? 250, BASE_FT = K.HDG_BASE_FT ?? 50, BACK_FT = K.BACK_FT ?? 30;

// The held-row gate: the real lines from _processUsersSnapInner, from `var _glide = true;` to the
// end of the `if (_glide) { ... }` block that calls _animateMarker.
const gateText = (() => {
  const fs = src.indexOf('function _processUsersSnapInner(');
  const gs = src.indexOf('var _glide = true;', fs);
  const fr = src.indexOf('_followRecenter(data.lng, data.lat);', gs);
  if (fs < 0 || gs < 0 || fr < 0) return null;
  return src.slice(gs, src.indexOf('}', fr) + 1);
})();
// The grouping pass's centroid block: the `try { var _pmk = userMarkers[primary]; ... } catch (_ce) {}`
// that places a merged oval at the centre of its members' true fixes.
const centroidText = (() => {
  const ps = src.indexOf('var _pmk = userMarkers[primary];');
  if (ps < 0) return null;
  const ts = src.lastIndexOf('try {', ps), te = src.indexOf('} catch (_ce) {}', ps);
  return (ts < 0 || te < 0) ? null : src.slice(ts, te + '} catch (_ce) {}'.length);
})();
check('extraction: the held-row gate and the grouping centroid block were found and parse', !!gateText && !!centroidText && (() => {
  try { new Function('userMarkers', 'uid', 'data', 'metersApart', '_animateMarker', 'followUid', '_followRecenter', gateText); new Function('userMarkers', 'members', 'primary', centroidText); return true; } catch (e) { return false; }
})(), `gate ${gateText ? gateText.split('\n').length : 0} lines, centroid ${centroidText ? centroidText.split('\n').length : 0} lines`);

// ── Harness: a clock we set by hand, a rAF queue we crank, a camera and trail tip that count ──
const FRAME_MS = 20;                         // a steady 50 Hz rAF; every scheduled moment below is a multiple of it
function harness(o) {
  o = o || {};
  const clock = { t: 100000 };
  const rafs = new Map();                    // id -> frame callback, queued the way the browser does
  const cancelled = [];
  let nextId = 0;
  const win = { _markerGroupMembers: null, _camLockUid: null, _followPausedUntil: 0, _resumeSnapUntil: 0 };
  const tips = [];
  win._updateTrailTip = (uid, lng, lat) => { tips.push([uid, lng, lat]); };
  win._liveLeadOff = false;
  const cam = { setCenter: 0, jumpTo: 0 };
  const map = { setCenter() { cam.setCenter++; }, jumpTo() { cam.jumpTo++; } };
  const doc = { visibilityState: o.visible ? 'visible' : 'hidden', body: { classList: { contains: () => false } } };
  const userMarkers = {};
  const grouping = { calls: 0 };
  const fn = build(win, doc, { now: () => clock.t },
    (step) => { rafs.set(++nextId, step); return nextId; },
    (id) => { cancelled.push(id); rafs.delete(id); },
    metersApart, map, () => { grouping.calls++; }, userMarkers, () => null, () => {}, o.followUid || null, false);
  const runPending = () => { const fs = [...rafs.values()]; rafs.clear(); fs.forEach((s) => s(clock.t)); };
  const H = {
    clock, cancelled, win, cam, userMarkers, grouping, tips, fn,
    pending: () => rafs.size,
    // One frame, dt ms after the last (a hidden tab's first visible frame can be seconds late).
    frame(dt) { clock.t += dt; runPending(); },
    // Steady frames until the clock reaches T. Frames stop when nothing is scheduled; the clock
    // still lands on T, which is when the next fix is handed over.
    advanceTo(T) { while (rafs.size && clock.t + FRAME_MS <= T) { clock.t += FRAME_MS; runPending(); } clock.t = T; },
    // Steady frames until nothing is scheduled (5-minute ceiling: a runaway loop fails, not hangs).
    drain() { let n = 0; while (rafs.size && n++ < 15000) { clock.t += FRAME_MS; runPending(); } return n; },
    // The feed's held-row gate, run with the real _animateMarker above. Returns how many times the
    // gate called it.
    gate(uid, data, followUid) {
      let calls = 0;
      new Function('userMarkers', 'uid', 'data', 'metersApart', '_animateMarker', 'followUid', '_followRecenter', gateText)
        (userMarkers, uid, data, metersApart, (...args) => { calls++; fn(...args); }, followUid || null, () => {});
      return calls;
    },
    // The grouping pass's centroid block, as it runs on every presence snapshot for a merged group.
    centroid(primary, members) {
      new Function('userMarkers', 'members', 'primary', centroidText)(userMarkers, members, primary);
    },
  };
  return H;
}
// The marker fake carries exactly what _animateMarker reads and writes on a mapbox Marker.
function makeMarker(uid, lng, lat, extra) {
  const m = {
    _uid: uid, _curLngLat: [lng, lat], _ll: [lng, lat], _ts: 0, _lastFixAt: 0, _anim: null, sets: [],
    getLngLat() { return { lng: this._curLngLat[0], lat: this._curLngLat[1] }; },
    setLngLat(ll) { this.sets.push([+ll[0], +ll[1]]); return this; },
  };
  return Object.assign(m, extra || {});
}
const LNG = -84.9, LAT = 30.44;
const M_PER_DEG = 111194.9;                  // one degree of latitude on the 6371 km sphere metersApart uses
const COS = Math.cos(LAT * Math.PI / 180);
const FT = 0.3048;
const latN = (lat0, ft) => lat0 + ft * FT / M_PER_DEG;            // ft north of lat0
const lngE = (lng0, ft) => lng0 + ft * FT / (M_PER_DEG * COS);    // ft east of lng0
const ftN = (lat, lat0) => (lat - lat0) * M_PER_DEG / FT;         // how far north of lat0, in feet
const ftE = (lng, lng0) => (lng - lng0) * M_PER_DEG * COS / FT;
const mphFt = (mph, s) => mph * 5280 / 3600 * s;                  // feet covered at mph in s seconds
const T0 = 1760000000000;                    // an epoch-ms fixTs, like the row carries
const near = (x, y, eps) => Math.abs(x - y) <= (eps == null ? 1e-9 : eps);
const within = (x, want, frac) => Math.abs(x - want) <= Math.abs(want) * frac;
const ft = (n) => `${Math.round(n)} ft`;
const minLat = (sets, from) => sets.slice(from).reduce((lo, p) => Math.min(lo, p[1]), Infinity);
const maxLat = (sets, from) => sets.slice(from).reduce((hi, p) => Math.max(hi, p[1]), -Infinity);
const minLng = (sets, from) => sets.slice(from).reduce((lo, p) => Math.min(lo, p[0]), Infinity);
const rnd6 = (v) => Math.round(v * 1e6) / 1e6;                    // _pathTake's rounding of a route vertex (~4 in)

// A car driving north at `mph`, reporting every `cadMs`. fix() lands the next report `afterMs`
// (default cadMs) after the PREVIOUS one on both clocks -- the viewer's frames run up to that
// moment first, as they do in the field -- at `toLat` (default: the road position for that
// interval). `o` overrides the row: spd, hdg, lng, path. _ts is restamped after the call, as the
// feed does. Returns the glide's own leg (dot -> fix, in feet) alongside the fix, since the tail's
// bounds are taken from that leg.
function driver(H, m, mph, cadMs) {
  let fixTs = T0, lat = m._curLngLat[1], lastStart = H.clock.t;
  m._ts = fixTs; m._lastFixAt = lastStart;
  return {
    legFt: mphFt(mph, cadMs / 1000),
    fix(afterMs, toLat, o) {
      if (afterMs == null) afterMs = cadMs;
      o = o || {};
      const start = lastStart + afterMs;
      if (H.clock.t > start) throw new Error(`fix(${afterMs}) is in the past: the clock is already +${H.clock.t - lastStart} ms after the last fix`);
      H.advanceTo(start);
      const fromLat = m._curLngLat[1];                              // where the dot is drawn as the fix lands
      fixTs += afterMs; lastStart = start;
      lat = (toLat == null) ? latN(lat, mphFt(mph, afterMs / 1000)) : toLat;
      H.fn(m, o.lng == null ? LNG : o.lng, lat, o.path || null, { fixTs, remote: true, spd: 'spd' in o ? o.spd : mph, hdg: 'hdg' in o ? o.hdg : null });
      m._ts = fixTs;
      // `landed` is the first frame at or after dur -- where t clamps to 1 and the tail begins. The
      // same arithmetic as the function's own dur (964 pacing with its 700 ms floor and 30 s
      // ceiling), so a gap whose x1.08 is not exact lands one frame later here too, not a hair before.
      const dur = Math.max(700, Math.min(30000, m._lastGapMs * 1.08));
      return { lat, lng: o.lng == null ? LNG : o.lng, fixTs, start, dur, landed: start + Math.ceil(dur / FRAME_MS) * FRAME_MS, glideFt: ftN(lat, fromLat) };
    },
  };
}
// The same car driving EAST, so the longitude term of every projection matters (sin(90) = 1).
function driverE(H, m, mph, cadMs) {
  let fixTs = T0, lng = m._curLngLat[0], lastStart = H.clock.t;
  m._ts = fixTs; m._lastFixAt = lastStart;
  return {
    legFt: mphFt(mph, cadMs / 1000),
    fix(afterMs, toLng, o) {
      if (afterMs == null) afterMs = cadMs;
      o = o || {};
      const start = lastStart + afterMs;
      if (H.clock.t > start) throw new Error(`fix(${afterMs}) is in the past`);
      H.advanceTo(start);
      const fromLng = m._curLngLat[0];
      fixTs += afterMs; lastStart = start;
      lng = (toLng == null) ? lngE(lng, mphFt(mph, afterMs / 1000)) : toLng;
      H.fn(m, lng, o.lat == null ? LAT : o.lat, o.path || null, { fixTs, remote: true, spd: 'spd' in o ? o.spd : mph, hdg: 'hdg' in o ? o.hdg : null });
      m._ts = fixTs;
      const dur = Math.max(700, Math.min(30000, m._lastGapMs * 1.08));
      return { lng, lat: o.lat == null ? LAT : o.lat, fixTs, start, dur, landed: start + Math.ceil(dur / FRAME_MS) * FRAME_MS, glideFt: ftE(lng, fromLng) };
    },
  };
}
// Two accepted fixes, so the cadence is known. f0 is the second: its lat/lng is where the road is
// (the dot itself is still ~7% short of it, mid-glide, until the next fix lands).
const seeded = (H, uid, mph, cadMs) => {
  const m = makeMarker(uid, LNG, LAT); H.userMarkers[uid] = m;
  const D = driver(H, m, mph, cadMs); D.fix(); const f0 = D.fix();
  return { m, D, f0 };
};
const seededE = (H, uid, mph, cadMs) => {
  const m = makeMarker(uid, LNG, LAT); H.userMarkers[uid] = m;
  const D = driverE(H, m, mph, cadMs); D.fix(); const f0 = D.fix();
  return { m, D, f0 };
};

// ── 1027 scenarios. fixTs is on the real clock (Date.now), because the fix's AGE is the point. ──
const LK = new Function(constSrc + `return typeof LIVE_GLIDE_MS === 'undefined' ? {} : { G: LIVE_GLIDE_MS, MAXAGE: LIVE_LEAD_MAX_MS, REACH: LIVE_REACH_FRAC };`)();
check('constants: 1.2 s glide, 20 s age ceiling, 1.25 legs of reach', LK.G === 1200 && LK.MAXAGE === 20000 && LK.REACH === 1.25, JSON.stringify(LK));

// Feed a car driving north at mph, reporting every cadMs; each fix is ageMs old when it lands.
// The wall clock follows the harness clock, so fix intervals and fix ages are both consistent.
const _realNow = Date.now, WALL0 = _realNow();
let _H = null; Date.now = () => WALL0 + (_H ? _H.clock.t : 0);
function liveCar(H, m, mph, cadMs, ageMs) {
  _H = H;
  let lat = m._curLngLat[1], lastStart = H.clock.t;
  m._ts = Date.now() - ageMs; m._lastFixAt = lastStart;
  return {
    fix() {
      const start = lastStart + cadMs;
      H.advanceTo(start);
      lastStart = start;
      lat = latN(lat, mphFt(mph, cadMs / 1000));
      const fixTs = Date.now() - ageMs;            // taken ageMs before it reached this viewer
      H.fn(m, LNG, lat, null, { fixTs, remote: true, spd: mph, hdg: 0 });
      m._ts = fixTs;
      return { lat, start };
    },
  };
}

// 1. 65 mph, 10 s reports, each fix 3 s old on arrival. The first two fixes only seed the cadence.
{
  const H = harness();
  const m = makeMarker('u', LNG, LAT); H.userMarkers['u'] = m;
  const C = liveCar(H, m, 65, 10000, 3000);
  C.fix(); C.fix();
  const f = C.fix();
  H.advanceTo(f.start + 1200 + FRAME_MS);
  // Where the car really is now: the fix + 65 mph x (3 s age + 1.22 s since it landed).
  const want = mphFt(65, (3000 + 1220) / 1000);
  const got = ftN(m.sets[m.sets.length - 1][1], f.lat);
  check('1 the glide lands in ~1.2 s, carried ahead of the fix by speed x (age + glide)', within(got, want, 0.12), `${ft(got)} ahead, want ~${ft(want)}`);
  H.advanceTo(f.start + 6000);
  const want2 = mphFt(65, (3000 + 6000) / 1000);
  const got2 = ftN(m.sets[m.sets.length - 1][1], f.lat);
  check('1 six seconds after the fix the dot is where the car is NOW (fix + 65 mph x 9 s), within 12%', within(got2, want2, 0.12), `${ft(got2)} ahead, want ~${ft(want2)}`);
  const leg = mphFt(65, 10);
  H.advanceTo(f.start + 20000);
  const got3 = ftN(m.sets[m.sets.length - 1][1], f.lat);
  check('1 with no next fix, it never runs past 1.25 legs of the fix', got3 <= leg * 1.25 + 5, `${ft(got3)} vs cap ${ft(leg * 1.25)}`);
}
// 2. Walking pace: below EXTRAP_MIN_MPH there is no lead -- the old full-gap glide.
{
  const H = harness();
  const m = makeMarker('w', LNG, LAT); H.userMarkers['w'] = m;
  const C = liveCar(H, m, 2, 10000, 3000);
  C.fix(); C.fix(); const f = C.fix();
  H.advanceTo(f.start + 5000);
  const got = ftN(m.sets[m.sets.length - 1][1], f.lat);
  check('2 a 2 mph row still glides across the whole gap and never passes its fix', got < 1, `${got.toFixed(1)} ft relative to the fix`);
}
// 3. A stale fix (60 s old) is carried at most LIVE_LEAD_MAX_MS, and never past the reach cap.
{
  const H = harness();
  const m = makeMarker('s', LNG, LAT); H.userMarkers['s'] = m;
  const C = liveCar(H, m, 65, 10000, 60000);
  C.fix(); C.fix(); const f = C.fix();
  H.advanceTo(f.start + 1300);
  const got = ftN(m.sets[m.sets.length - 1][1], f.lat);
  check('3 a 60 s old fix is led no further than 1.25 legs', got <= mphFt(65, 10) * 1.25 + 5, `${ft(got)}`);
}
// 4. The pin: with _liveLeadOff the old timing is untouched (deadreckon.test.mjs relies on it).
check('source: the lead is gated on window._liveLeadOff', /if \(_ex && window\._liveLeadOff !== true\)/.test(src));

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
