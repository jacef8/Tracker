// Dead reckoning past the last fix. Runs the REAL _animateMarker -- pulled out of public/index.html
// by its function text, together with the EXTRAP_* constants it reads -- under a settable clock and
// a hand-cranked requestAnimationFrame, and checks the tail that carries a moving dot on past its
// last fix until the next one lands. It also runs the real held-row gate from _processUsersSnapInner
// and the real centroid block of the grouping pass, each cut from the file by its own text.
//
// Why this exists: measured live on 2026-10-25 (Lexi, iOS 1.0.13, 65 mph), fixes land every
// 15-22 s, jittering, 1,400-2,100 ft apart. The glide is paced to ONE reporter interval (964), so
// whenever the next fix lands later than the last one did, the dot reaches its target and stands
// still until it arrives -- "she moves for a few seconds, stops for a few seconds, over and over,
// while the speed reads 65". The tail keeps the dot moving along the last heading at the row's own
// mph, bounded by distance (EXTRAP_MAX_FRAC of the leg), by time (EXTRAP_CAD_MULT reporter
// intervals, EXTRAP_MAX_MS at most), by speed (nothing under EXTRAP_MIN_MPH), never for the own
// dot, and not again after an overshoot until a fix has been accepted -- whether the fix that landed
// behind the dot found it on its tail or still mid-glide. Against build 970's file this test FAILS:
// the dot sits on its target at dur + 5 s.
//
// A note on "the leg": the bounds are taken from the GLIDE's leg -- from where the dot is drawn when
// the fix lands to the fix -- which is what the dot actually travelled. A glide lasts 1.08 x the
// interval, so when the next fix is on time the dot is ~7% short of the previous fix and the new
// leg carries that over: 65 mph x 18 s is a 1,717 ft road leg but a ~1,850 ft glide leg.
//
// Usage:  node tools/deadreckon.test.mjs [index.html]      (exit 0 = the tail behaves)
import { readFileSync } from 'node:fs';
const file = process.argv[2] || 'public/index.html';
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

// 1. The field case: 65 mph, an 18 s cadence (road legs of 1,717 ft), and the next fix is late.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  check('1 seed: _cadMs is the reporter interval (18 s) after two accepted fixes', m._cadMs === 18000, `_cadMs=${m._cadMs}`);
  const f = D.fix();                                       // the leg under test; nothing lands after it
  check('1 leg: glide paced to the reporter (18 s -> dur 19.44 s)', m._lastGapMs === 18000 && near(f.dur, 19440), `dur=${f.dur}`);
  check('1 leg: the glide leg carries the ~7% the last glide had not covered (~1,850 ft)', within(f.glideFt, D.legFt * (1 + (1 - 18000 / 19440)), 0.01), ft(f.glideFt));
  const n0 = m.sets.length;
  H.advanceTo(f.landed);
  check('1 at t = dur: the dot is ON its target', near(m._curLngLat[1], f.lat) && near(m._curLngLat[0], LNG), `${ft(ftN(m._curLngLat[1], f.lat))} past`);
  check('1 at t = dur: the tail has begun -- _extrap set at zero, a frame still pending', !!m._extrap && m._extrap.dist === 0 && m._extrap.since === f.landed && H.pending() === 1, JSON.stringify(m._extrap));
  H.advanceTo(f.landed + 5000);
  const past5 = ftN(m._curLngLat[1], f.lat);
  check('1 at t = dur + 5 s: PAST the target by ~477 ft (65 mph x 5 s), within 10%', within(past5, mphFt(65, 5), 0.10), ft(past5));
  check('1 at t = dur + 5 s: on the leg heading (no sideways drift)', Math.abs(ftE(m._curLngLat[0], LNG)) < 1, ft(ftE(m._curLngLat[0], LNG)));
  check('1 at t = dur + 5 s: _extrap carries since/dist/heading/rate', !!m._extrap && near(m._extrap.heading, 0, 1e-6) && within(m._extrap.dist / FT, mphFt(65, 5), 0.1) && m._extrap.rate > 0, JSON.stringify(m._extrap));
  check('1 at t = dur + 5 s: still animating (_anim set, frame pending)', m._anim !== null && H.pending() === 1);
  H.drain();
  const pastEnd = ftN(m._curLngLat[1], f.lat);
  const phaseMs = H.clock.t - f.landed;
  check(`1 the tail stops by itself at ${MAX_FRAC} of the glide leg (~${Math.round(MAX_FRAC * f.glideFt)} ft past), never further`,
    within(pastEnd, MAX_FRAC * f.glideFt, 0.005) && maxLat(m.sets, n0) <= m._curLngLat[1] + 1e-12, ft(pastEnd));
  check(`1 ...and ran under ${CAD_MULT} x the 18 s cadence`, phaseMs > 0 && phaseMs <= CAD_MULT * 18000, `${phaseMs} ms`);
  check('1 after the tail: _extrap cleared, _anim null, nothing pending', m._extrap === null && m._anim === null && H.pending() === 0);
  check('1 the dot never moved backwards', m.sets.slice(n0).every((p, i, arr) => i === 0 || p[1] >= arr[i - 1][1] - 1e-12));
  const tipsLeg = H.tips.filter((t) => t[0] === 'u');
  check('1 every frame set the marker AND welded the trail tip to the same spot (the tip follows the tail)',
    m.sets.length === tipsLeg.length && near(tipsLeg[tipsLeg.length - 1][2], m._curLngLat[1]), `sets=${m.sets.length} tips=${tipsLeg.length}`);
}

// 1b. The time bound. A 65 mph leg but the row now reads 5 mph (it braked): the tail crawls and the
//     cadence bound ends it -- 1.5 x 18 s = 27 s; at a 25 s cadence the 30 s ceiling wins.
for (const [cadMs, wantMs] of [[18000, 27000], [25000, 30000]]) {
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, cadMs);
  const f = D.fix(null, null, { spd: 5 });
  H.advanceTo(f.landed);
  H.drain();
  const phaseMs = H.clock.t - f.landed;
  const pastEnd = ftN(m._curLngLat[1], f.lat);
  check(`1b cadence ${cadMs / 1000} s, row 5 mph: the tail ends on TIME at ${wantMs / 1000} s`, phaseMs === wantMs, `${phaseMs} ms`);
  check(`1b cadence ${cadMs / 1000} s: covered 5 mph x ${wantMs / 1000} s (~${Math.round(mphFt(5, wantMs / 1000))} ft), well short of the distance cap`,
    within(pastEnd, mphFt(5, wantMs / 1000), 0.02) && pastEnd < MAX_FRAC * f.glideFt, ft(pastEnd));
}

// 1c. Frame dt comes from the rAF clock and is capped: a tab hidden for 5 s does not fling the dot
//     5 s of road on its first visible frame.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix();
  H.advanceTo(f.landed + 1000);
  const before = ftN(m._curLngLat[1], f.lat);
  H.frame(5000);
  const moved = ftN(m._curLngLat[1], f.lat) - before;
  check(`1c a 5 s frame moves the dot ${DT_CAP} ms worth (~${Math.round(mphFt(65, DT_CAP / 1000))} ft), not 5 s (~477 ft)`, within(moved, mphFt(65, DT_CAP / 1000), 0.05), ft(moved));
}

// 1d. Remote rows only: opts without `remote` (nobody passes these today -- the own dot passes no
//     opts at all, the feed passes remote:true) never run on, whatever spd says.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  H.advanceTo(H.clock.t + 18000);
  const to = latN(m._curLngLat[1], 1717);
  H.fn(m, LNG, to, null, { fixTs: m._ts + 18000, spd: 65, hdg: null });
  H.drain();
  check('1d opts without remote:true: lands on the fix and stops there, no _extrap', near(m._curLngLat[1], to) && !m._extrap && m._anim === null, ft(ftN(m._curLngLat[1], to)));
}

// 2. The next fix lands 22 s after the previous one, while the tail is running: the frame is
//    cancelled, the new glide starts from the EXTRAPOLATED position, and ends on the new fix.
//    The late fix lands a whole interval AHEAD of the dot, which is not an overshoot, so after
//    landing on it the tail begins again. North-bound and east-bound.
for (const dir of ['N', 'E']) {
  const H = harness();
  const { m, D } = dir === 'N' ? seeded(H, 'u', 65, 18000) : seededE(H, 'u', 65, 18000);
  const ax = dir === 'N' ? 1 : 0;                           // the axis the car runs along
  const prog = (ll) => dir === 'N' ? ftN(ll[1], LAT) : ftE(ll[0], LNG);
  const f = D.fix();
  H.advanceTo(f.start + 22000);                           // the moment the late fix lands
  const animId = m._anim;
  const pastBefore = prog(m._curLngLat) - prog([f.lng, f.lat]);
  check(`2 ${dir} before the fix: the tail is running, ~2.5 s past the target`, !!m._extrap && animId !== null && within(pastBefore, mphFt(65, (f.start + 22000 - f.landed) / 1000), 0.1), ft(pastBefore));
  const g = D.fix(22000);                                 // 22 s of road at 65 mph (~2,099 ft), landing now
  const from = m._curLngLat.slice();
  check(`2 ${dir} the fix cancels the tail's frame and clears _extrap`, H.cancelled[H.cancelled.length - 1] === animId && m._extrap === null && H.pending() === 1, `cancelled ${H.cancelled[H.cancelled.length - 1]} (was ${animId})`);
  check(`2 ${dir} a late fix AHEAD of the running-on dot is not an overshoot`, m._noExtrapOnce === false);
  check(`2 ${dir} the 22 s interval was accepted into the cadence EMA (0.7 x 18 + 0.3 x 22 = 19.2 s)`, near(m._cadMs, 19200, 1e-6), `_cadMs=${m._cadMs}`);
  check(`2 ${dir} the new glide is paced to 22 s`, m._lastGapMs === 22000, `_lastGapMs=${m._lastGapMs}`);
  H.frame(FRAME_MS);
  const step1 = prog(m._curLngLat) - prog(from);
  check(`2 ${dir} the first frame moves on from the EXTRAPOLATED spot (not back to the old target)`, step1 > 0 && step1 < 5 && within(prog(m._curLngLat) - prog([f.lng, f.lat]), pastBefore, 0.05), `${ft(step1)} on from the dot's spot; ${ft(prog(m._curLngLat) - prog([f.lng, f.lat]))} past the old target`);
  H.advanceTo(g.landed);
  check(`2 ${dir} at t = dur the dot is ON the new fix`, near(m._curLngLat[1], g.lat) && near(m._curLngLat[0], g.lng), `${ft(prog(m._curLngLat) - prog([g.lng, g.lat]))} off`);
  check(`2 ${dir} ...and the tail begins again (_extrap set, a frame pending)`, !!m._extrap && H.pending() === 1 && near(m._extrap.heading, dir === 'N' ? 0 : 90, 1e-6), `heading ${m._extrap && m._extrap.heading}`);
  void ax;
}

// 3. The fix lands BEHIND the extrapolated position by 40% of the leg (we ran past a stop; the row
//    still reads 60): the correction glide runs from _curLngLat, _noExtrapOnce is set, and after
//    THAT glide the dot does not run on. The following accepted fix at 60 mph earns the tail back.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix();
  const atMs = f.landed - f.start + 8000;                              // 8 s into the tail: ~763 ft past the fix
  H.advanceTo(f.start + atMs);
  const exLat = m._curLngLat[1];
  check('3 setup: 8 s into the tail, ~763 ft past the fix', within(ftN(exLat, f.lat), mphFt(65, 8), 0.1), ft(ftN(exLat, f.lat)));
  const behind = latN(exLat, -0.4 * D.legFt);
  const n0 = m.sets.length;
  const g = D.fix(atMs, behind, { spd: 60 });             // lands now, 40% of the leg behind the dot
  check('3 _noExtrapOnce raised: the fix is behind the dot along the heading', m._noExtrapOnce === true && m._extrap === null);
  check('3 the 27.4 s interval was still accepted (the correction is paced and the cadence learns it)', m._lastGapMs === atMs && near(m._cadMs, 0.7 * 18000 + 0.3 * atMs, 1e-6), `_cadMs=${m._cadMs}`);
  H.frame(FRAME_MS);
  check('3 the correction glides from _curLngLat (southward from the extrapolated spot), not a snap', m._curLngLat[1] < exLat && ftN(exLat, m._curLngLat[1]) < 5 && !near(m._curLngLat[1], behind), ft(ftN(exLat, m._curLngLat[1])));
  H.drain();
  check('3 after the correction the dot sits ON the fix -- no tail this time', near(m._curLngLat[1], behind) && m._anim === null && !m._extrap && H.pending() === 0, `${ft(ftN(m._curLngLat[1], behind))} off`);
  check('3 ...and never ran past it', minLat(m.sets, n0) >= behind - 1e-12);
  const h = D.fix(30000, latN(behind, 1500), { spd: 60 });   // moving again: 1,500 ft on, 60 mph (a 30 s gap: dur hits the 30 s ceiling)
  check('3 the next accepted fix clears _noExtrapOnce', m._noExtrapOnce === false);
  H.advanceTo(h.landed);
  check('3 on that fix at t = dur, with the tail begun again', near(m._curLngLat[1], h.lat) && !!m._extrap,
    `${ft(ftN(m._curLngLat[1], h.lat))} off; gap=${m._lastGapMs} dur=${h.dur} landed=+${h.landed - h.start} clock=+${H.clock.t - h.start} anim=${m._anim} pending=${H.pending()} extrap=${JSON.stringify(m._extrap)}`);
  H.drain();
  check(`3 the tail runs again, to ${MAX_FRAC} of the new 1,500 ft leg (~${Math.round(MAX_FRAC * 1500)} ft past)`, within(ftN(m._curLngLat[1], h.lat), MAX_FRAC * 1500, 0.02), ft(ftN(m._curLngLat[1], h.lat)));
  void g;
}
// 3a. East-bound overshoot: the fix lands 40% of the leg WEST of the dot. The longitude term of the
//     projection does all the work here (sin 90 = 1); flagged, and no tail after the correction.
{
  const H = harness();
  const { m, D } = seededE(H, 'u', 65, 18000);
  const f = D.fix();
  const atMs = f.landed - f.start + 8000; H.advanceTo(f.start + atMs);
  const exLng = m._curLngLat[0];
  const n0 = m.sets.length;
  const g = D.fix(atMs, lngE(exLng, -0.4 * D.legFt), { spd: 60 });
  check('3a east-bound: a fix 40% of the leg behind (west) raises _noExtrapOnce', m._noExtrapOnce === true);
  H.advanceTo(g.landed); H.drain();
  check('3a east-bound: ...no tail after the correction, and the dot never ran west of the fix', !m._extrap && m._anim === null && near(m._curLngLat[0], g.lng) && minLng(m.sets, n0) >= g.lng - 1e-12, `${ft(ftE(m._curLngLat[0], g.lng))} off`);
}

// 3b. Behind is measured ALONG the heading: a fix at the same progress but 150 ft off-axis is not
//     behind, so the tail is allowed again (and follows the new leg, east).
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix();
  const atMs = f.landed - f.start + 8000;
  H.advanceTo(f.start + atMs);
  const exLat = m._curLngLat[1];
  const eastLng = lngE(LNG, 150);
  D.fix(atMs, exLat, { spd: 60, lng: eastLng });          // lands now: same progress, 150 ft east
  check('3b same progress, 150 ft off-axis: NOT an overshoot', m._noExtrapOnce === false);
  H.drain();
  const east = ftE(m._curLngLat[0], eastLng);
  check(`3b the tail then follows the new (east) leg, to ${MAX_FRAC} of its 150 ft`, within(east, MAX_FRAC * 150, 0.02) && near(m._curLngLat[1], exLat, 1e-7), `${ft(east)} east of the fix`);
}
// 3b'. Off-axis by far MORE than any tolerance, same progress: still not behind (a raw-distance
//      comparison would call 700 ft "behind"). North-bound and east-bound.
for (const dir of ['N', 'E']) {
  const H = harness();
  const { m, D } = dir === 'N' ? seeded(H, 'u', 65, 18000) : seededE(H, 'u', 65, 18000);
  const f = D.fix();
  const atMs = f.landed - f.start + 8000; H.advanceTo(f.start + atMs);
  if (dir === 'N') D.fix(atMs, m._curLngLat[1], { spd: 60, lng: lngE(LNG, 700) });
  else D.fix(atMs, m._curLngLat[0], { spd: 60, lat: latN(LAT, 700) });
  check(`3b ${dir}: same progress, 700 ft (38% of the leg) off-axis: NOT behind`, m._noExtrapOnce === false);
}

// 3c. The tolerance is GPS jitter, not a share of the leg. 8 s into the tail, a fix 20 ft behind the
//     dot is noise (no flag); 15% of the leg behind -- a car that braked, the row still reading 60 --
//     IS behind: flagged, the correction glides back, and the dot does NOT run on past the fix the
//     wrong way (the correction's own bearing is backwards, so a tail along it read as reversing).
//     North-bound and east-bound, while the tail runs and after it has ended on its bound.
for (const dir of ['N', 'E']) {
  const run = (standing, behindFt, label) => {
    const H = harness();
    const { m, D } = dir === 'N' ? seeded(H, 'u', 65, 18000) : seededE(H, 'u', 65, 18000);
    const f = D.fix();
    let atMs;
    if (standing) { H.advanceTo(f.landed); H.drain(); atMs = H.clock.t - f.start + 2000; H.advanceTo(f.start + atMs); }
    else { atMs = f.landed - f.start + 8000; H.advanceTo(f.start + atMs); }
    const ex = m._curLngLat.slice();
    const n0 = m.sets.length;
    const g = dir === 'N' ? D.fix(atMs, latN(ex[1], -behindFt), { spd: 60 }) : D.fix(atMs, lngE(ex[0], -behindFt), { spd: 60 });
    return { H, m, g, n0, ex, flagged: m._noExtrapOnce === true };
  };
  const legFt = mphFt(65, 18) * (1 + (1 - 18000 / 19440));
  for (const standing of [false, true]) {
    const where = standing ? 'after the tail ended on its bound' : '8 s into the tail';
    const j = run(standing, 20);
    check(`3c ${dir} ${where}: a fix 20 ft behind the dot is jitter, no flag`, !j.flagged, `_noExtrapOnce=${j.m._noExtrapOnce}`);
    const k = run(standing, 0.15 * legFt);
    check(`3c ${dir} ${where}: a fix 15% of the leg (~${Math.round(0.15 * legFt)} ft) behind raises _noExtrapOnce`, k.flagged);
    k.H.drain();
    const onFix = near(k.m._curLngLat[1], k.g.lat) && near(k.m._curLngLat[0], k.g.lng);
    const neverPast = dir === 'N' ? minLat(k.m.sets, k.n0) >= k.g.lat - 1e-12 : minLng(k.m.sets, k.n0) >= k.g.lng - 1e-12;
    check(`3c ${dir} ${where}: ...the correction ends ON the fix, no tail, and the dot never ran on past it the wrong way`, onFix && !k.m._extrap && k.m._anim === null && neverPast,
      `${ft(dir === 'N' ? ftN(k.m._curLngLat[1], k.g.lat) : ftE(k.m._curLngLat[0], k.g.lng))} off`);
  }
}
// 3c'. The boundary, east-bound, where an unscaled longitude term would read 16% long: 27 ft behind is
//      under the 30 ft tolerance (unscaled it reads 31 ft and would flag); 40 ft behind is over it.
{
  const run = (behindFt) => {
    const H = harness();
    const { m, D } = seededE(H, 'u', 65, 18000);
    const f = D.fix();
    const atMs = f.landed - f.start + 8000; H.advanceTo(f.start + atMs);
    D.fix(atMs, lngE(m._curLngLat[0], -behindFt), { spd: 60 });
    return m._noExtrapOnce;
  };
  check(`3c' east-bound: 27 ft behind is under the ${BACK_FT} ft tolerance (an unscaled longitude term reads ${Math.round(27 / COS)} ft): no flag`, run(27) === false);
  check(`3c' east-bound: 40 ft behind is over it: flagged`, run(40) === true);
}
// 3d. The tail had already ended on its bound (the dot standing 60% past the fix) when a fix lands
//     behind: the dot is just as far past the truth, so the guard must still see it.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix();
  H.advanceTo(f.landed);
  H.drain();
  check('3d setup: the tail ended on its own, _extrap cleared, _extrapEnded keeps the geometry', m._extrap === null && !!m._extrapEnded && within(m._extrapEnded.dist / FT, MAX_FRAC * f.glideFt, 0.01), JSON.stringify(m._extrapEnded));
  const g = D.fix(40000, latN(m._curLngLat[1], -0.4 * D.legFt), { spd: 60 });   // 40 s after the fix, behind the dot
  check('3d a fix behind the standing dot still raises _noExtrapOnce, and the memory is consumed', m._noExtrapOnce === true && m._extrapEnded === null && m._extrap === null);
  H.drain();
  check('3d the correction ends on the fix with no tail', near(m._curLngLat[1], g.lat) && !m._extrap && m._anim === null);
}

// 3e. The heading comes from the last EXTRAP_HDG_BASE_FT of travel, never from the last waypoint
//     pair. Both writers round route vertices to 1e-6 degrees (_pathTake) and send the row's lat/lng
//     raw, and the route's final vertex IS the fix -- so with a route the last pair is a few inches
//     of rounding noise pointing anywhere. (a) a straight road north with such a route must tail
//     north, never sideways or backwards; (b) an L that turns east for its last 150 ft must tail east.
{
  const H = harness();
  const { m, D, f0 } = seeded(H, 'u', 65, 18000);
  const road0 = f0.lat;                                     // the previous fix: the road starts here
  const fixLat = latN(road0, 1717) + 3e-7, fixLng = LNG + 4e-7;   // raw; rounding moves both by > 1e-7
  const now = Date.now();
  const path = [[rnd6(latN(road0, 860)), rnd6(LNG), now], [rnd6(latN(road0, 1290)), rnd6(LNG), now], [rnd6(fixLat), rnd6(fixLng), now]];
  const f = D.fix(null, fixLat, { lng: fixLng, path });
  H.advanceTo(f.landed + 5000);
  const north = ftN(m._curLngLat[1], fixLat), east = ftE(m._curLngLat[0], fixLng);
  check('3e (a) a route ending on the rounded fix: the tail runs NORTH ~477 ft in 5 s', within(north, mphFt(65, 5), 0.10) && !!m._extrap, ft(north));
  check('3e (a) ...with no sideways component (the heading is the road\'s, not the noise pair\'s)', Math.abs(east) < 2 && !!m._extrap && Math.min(m._extrap.heading, 360 - m._extrap.heading) < 1, `east ${ft(east)}, heading ${m._extrap && m._extrap.heading.toFixed(2)}`);
  H.drain();
  check(`3e (a) the distance cap is still ${MAX_FRAC} of the WHOLE glide leg, not of the noise pair`, within(ftN(m._curLngLat[1], fixLat), MAX_FRAC * f.glideFt, 0.01), `${ft(ftN(m._curLngLat[1], fixLat))} past; leg ${ft(f.glideFt)}`);
}
{
  const H = harness();
  const { m, D, f0 } = seeded(H, 'u', 65, 18000);
  const road0 = f0.lat;
  const cornerLat = latN(road0, 1567);
  const fixLat = cornerLat + 3e-7, fixLng = lngE(LNG, 150) + 4e-7;
  const now = Date.now();
  const path = [[rnd6(latN(road0, 800)), rnd6(LNG), now], [rnd6(cornerLat), rnd6(LNG), now], [rnd6(cornerLat), rnd6(lngE(LNG, 75)), now], [rnd6(fixLat), rnd6(fixLng), now]];
  const f = D.fix(null, fixLat, { lng: fixLng, path });
  H.advanceTo(f.landed + 5000);
  const north = ftN(m._curLngLat[1], fixLat), east = ftE(m._curLngLat[0], fixLng);
  check('3e (b) an L turning east for its last 150 ft: the tail runs EAST ~477 ft in 5 s, not north', within(east, mphFt(65, 5), 0.10) && Math.abs(north) < 2 && !!m._extrap && near(m._extrap.heading, 90, 1), `east ${ft(east)}, north ${ft(north)}, heading ${m._extrap && m._extrap.heading.toFixed(2)}`);
}
// 3f. Fails closed: a glide leg shorter than the heading baseline has no direction worth running on
//     along (the row's 65 is stale -- the car all but stopped). A leg just over it still tails.
//     The leg is measured from where the DOT is drawn when the fix lands, so the frames up to that
//     moment run first.
{
  const H = harness();
  const { m, D, f0 } = seeded(H, 'u', 65, 18000);
  H.advanceTo(f0.start + 18000);
  const f = D.fix(null, latN(m._curLngLat[1], BASE_FT - 10));
  H.drain();
  check(`3f a ${BASE_FT - 10} ft leg (under the ${BASE_FT} ft baseline) at spd 65: lands and stops, no tail`, near(m._curLngLat[1], f.lat) && !m._extrap && !m._extrapEnded && m._anim === null, `glide leg ${ft(f.glideFt)}`);
}
{
  const H = harness();
  const { m, D, f0 } = seeded(H, 'u', 65, 18000);
  H.advanceTo(f0.start + 18000);
  const f = D.fix(null, latN(m._curLngLat[1], BASE_FT + 10));
  H.advanceTo(f.landed);
  check(`3f a ${BASE_FT + 10} ft leg (over the baseline): the tail begins, north`, !!m._extrap && near(m._extrap.heading, 0, 1e-6), `glide leg ${ft(f.glideFt)}, heading ${m._extrap && m._extrap.heading}`);
}

// 3g. A fix BEHIND a MID-GLIDE dot. The fix came early (12 s after the last one), so the dot is ~62%
//     along its glide with no tail yet -- and no tail memory for the guard to read. The correction
//     points backwards just the same, so the guard reads the in-flight glide's own bearing, kept on
//     the marker as _hdgPrev. Found in review: with the guard keyed to the tail alone, 100-1,200 ft
//     behind left _noExtrapOnce false and the dot ran 60-720 ft the wrong way with the row reading 60.
//     North-bound and east-bound. The control is the ordinary early fix: mid-glide, a whole interval
//     AHEAD -- not flagged, and the tail follows.
for (const dir of ['N', 'E']) {
  for (const behindFt of [100, 300, 600, 1200]) {
    const H = harness();
    const { m, D } = dir === 'N' ? seeded(H, 'u', 65, 18000) : seededE(H, 'u', 65, 18000);
    const f1 = D.fix();
    H.advanceTo(f1.start + 12000);                                    // 62% along the glide: no tail, a frame in flight
    if (behindFt === 100) check(`3g ${dir} setup: mid-glide, nothing but the glide in flight`, !m._extrap && !m._extrapEnded && m._anim !== null && H.pending() === 1);
    const dot = m._curLngLat.slice();
    const n0 = m.sets.length;
    const f2 = dir === 'N' ? D.fix(12000, latN(dot[1], -behindFt), { spd: 60 }) : D.fix(12000, lngE(dot[0], -behindFt), { spd: 60 });
    check(`3g ${dir} mid-glide, a fix ${behindFt} ft behind the dot raises _noExtrapOnce`, m._noExtrapOnce === true, `_noExtrapOnce=${m._noExtrapOnce}`);
    H.drain();
    const onFix = near(m._curLngLat[1], f2.lat) && near(m._curLngLat[0], f2.lng);
    const wrongWay = dir === 'N' ? ftN(f2.lat, minLat(m.sets, n0)) : ftE(f2.lng, minLng(m.sets, n0));
    check(`3g ${dir} ...the correction ends ON the fix with no tail, and the dot never ran past it the wrong way`, onFix && !m._extrap && !m._extrapEnded && m._anim === null && wrongWay < 1e-6,
      `${ft(dir === 'N' ? ftN(m._curLngLat[1], f2.lat) : ftE(m._curLngLat[0], f2.lng))} off; ${ft(wrongWay)} the wrong way`);
  }
  const H = harness();
  const { m, D } = dir === 'N' ? seeded(H, 'u', 65, 18000) : seededE(H, 'u', 65, 18000);
  const f1 = D.fix();
  H.advanceTo(f1.start + 12000);
  const f2 = D.fix(12000, null, { spd: 60 });                        // the road position 12 s on: a whole interval ahead of the dot
  check(`3g ${dir} control: a mid-glide fix a whole interval AHEAD is not flagged`, m._noExtrapOnce === false, `_noExtrapOnce=${m._noExtrapOnce}`);
  H.advanceTo(f2.landed + 2000);
  check(`3g ${dir} control: ...and the tail follows it`, !!m._extrap && near(m._extrap.heading, dir === 'N' ? 0 : 90, 1e-6), `heading ${m._extrap && m._extrap.heading}`);
}

// 3h. The guard never outlives its correction. Once a flagged correction has landed, the dot stands ON a
//     reported fix, and the leg from there to the next fix is the truth whichever way it points -- so
//     that fix is not checked against any older heading. (A rule that kept checking the last unflagged
//     heading switched the tail off for good on a car that turned round.)
//     (a) a U-turn: tail north, a fix a whole interval SOUTH flags; the correction lands; the next fix,
//     further south, is NOT flagged and the tail runs south, and so does the one after it.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f1 = D.fix();
  H.advanceTo(f1.landed + 8000);
  const atMs = H.clock.t - f1.start;
  const b = D.fix(atMs, latN(m._curLngLat[1], -1500), { spd: 60 });
  check('3h (a) U-turn: a fix 1,500 ft behind the tail flags', m._noExtrapOnce === true);
  H.drain();
  check('3h (a) U-turn: the correction lands ON that fix, no tail', near(m._curLngLat[1], b.lat) && !m._extrap && !m._extrapEnded && m._anim === null);
  const atC = H.clock.t - b.start + 1000;
  const c = D.fix(atC, latN(b.lat, -mphFt(60, atC / 1000)), { spd: 60 });    // southbound at 60 since
  check('3h (a) U-turn: the NEXT fix, further south, is not flagged -- the dot sat on a reported fix', m._noExtrapOnce === false, `_noExtrapOnce=${m._noExtrapOnce}`);
  H.advanceTo(c.landed + 5000);
  const south = -ftN(m._curLngLat[1], c.lat);
  check('3h (a) U-turn: ...and the tail runs SOUTH (~440 ft in 5 s at 60), heading 180', !!m._extrap && near(m._extrap.heading, 180, 1e-6) && within(south, mphFt(60, 5), 0.10), `south ${ft(south)}`);
  const atD = H.clock.t - c.start + 1000;
  D.fix(atD, latN(c.lat, -mphFt(60, atD / 1000)), { spd: 60 });
  check('3h (a) U-turn: a third southbound fix is not flagged either', m._noExtrapOnce === false, `_noExtrapOnce=${m._noExtrapOnce}`);
}
//     (b) mid-CORRECTION (the in-flight glide points backwards), an ordinary forward fix lands: not
//     flagged, tail north -- the correction's own bearing was never kept as the reference.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f1 = D.fix();
  H.advanceTo(f1.landed + 8000);
  const atMs = H.clock.t - f1.start;
  const b = D.fix(atMs, latN(m._curLngLat[1], -300), { spd: 60 });            // 300 ft behind: flagged, the correction heads south
  check('3h (b) setup: flagged, the correction in flight', m._noExtrapOnce === true && m._anim !== null);
  H.advanceTo(b.start + 8000);                                                 // mid-correction
  const c = D.fix(8000, latN(b.lat, 1500), { spd: 60 });                       // the car was going north all along
  check('3h (b) mid-correction, a forward fix is NOT flagged', m._noExtrapOnce === false, `_noExtrapOnce=${m._noExtrapOnce}`);
  H.advanceTo(c.landed + 2000);
  check('3h (b) ...and the tail runs north again', !!m._extrap && near(m._extrap.heading, 0, 1e-6), `heading ${m._extrap && m._extrap.heading}`);
}
//     (c) mid-correction, a U-turn fix far south: flagged (the dot was still drawn ahead of it); the
//     correction lands; the next southbound fix brings the tail back, south.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f1 = D.fix();
  H.advanceTo(f1.landed + 8000);
  const atMs = H.clock.t - f1.start;
  const b = D.fix(atMs, latN(m._curLngLat[1], -300), { spd: 60 });
  H.advanceTo(b.start + 8000);
  const n0 = m.sets.length;
  const c = D.fix(8000, latN(b.lat, -1500), { spd: 60 });
  check('3h (c) mid-correction, a U-turn fix far south: flagged', m._noExtrapOnce === true);
  H.drain();
  check('3h (c) ...the correction lands on it, never past it, no tail', near(m._curLngLat[1], c.lat) && minLat(m.sets, n0) >= c.lat - 1e-12 && !m._extrap && m._anim === null);
  const atD = H.clock.t - c.start + 1000;
  const d = D.fix(atD, latN(c.lat, -mphFt(60, atD / 1000)), { spd: 60 });
  check('3h (c) the next southbound fix: not flagged', m._noExtrapOnce === false, `_noExtrapOnce=${m._noExtrapOnce}`);
  H.advanceTo(d.landed + 2000);
  check('3h (c) ...tail south, heading 180', !!m._extrap && near(m._extrap.heading, 180, 1e-6), `heading ${m._extrap && m._extrap.heading}`);
}
//     (d) parked -- a 0 mph row glided into the lot heading north, no tail -- then leaving the way it
//     came in at 60: the dot sat ON its fix, so no flag, and the tail runs the new way.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f1 = D.fix(null, null, { spd: 0 });
  H.drain();
  check('3h (d) setup: parked ON the fix, no tail', near(m._curLngLat[1], f1.lat) && !m._extrap && !m._extrapEnded && m._anim === null);
  const c = D.fix(59000, latN(f1.lat, -800), { spd: 60 });                     // 59 s on (still an accepted interval), 800 ft back the way it came
  check('3h (d) leaving the way it came in: not flagged', m._noExtrapOnce === false, `_noExtrapOnce=${m._noExtrapOnce}`);
  H.advanceTo(c.landed + 2000);
  check('3h (d) ...tail south', !!m._extrap && near(m._extrap.heading, 180, 1e-6), `heading ${m._extrap && m._extrap.heading}`);
}

// 4. Slow or speedless rows do not run on: spd 0, spd 2, no spd. The floor itself (3) does.
for (const [label, spd, want] of [['spd 0', 0, false], ['spd 2', 2, false], ['no spd on the row', null, false], ['spd 3 (the floor)', 3, true]]) {
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix(null, null, { spd });
  H.advanceTo(f.landed);
  check(`4 ${label}: on target at t = dur`, near(m._curLngLat[1], f.lat));
  H.advanceTo(f.landed + 5000);
  const past = ftN(m._curLngLat[1], f.lat);
  if (want) check(`4 ${label}: carries on past the fix`, past > 10 && !!m._extrap, ft(past));
  else check(`4 ${label}: stops ON the fix at t = dur, as before (no tail, _anim null, nothing pending)`, near(m._curLngLat[1], f.lat) && m._anim === null && !m._extrap && H.pending() === 0, ft(past));
}

// 5. The viewer's own dot: both call sites pass no opts. Unchanged -- it stops on its target and
//    never learns a cadence.
{
  const H = harness();
  H.win._lastSpeedMph = 65;
  const m = makeMarker('me', LNG, LAT, { _lastFixAt: H.clock.t - 18000, _ts: T0 });
  const to = latN(LAT, 1700);
  H.fn(m, LNG, to);
  const dur = Math.max(700, Math.min(30000, m._lastGapMs * 1.08));
  H.advanceTo(H.clock.t + Math.ceil(dur / FRAME_MS) * FRAME_MS);
  check('5 own dot: on target at t = dur (viewer-gap pacing, 18 s)', near(m._curLngLat[1], to) && m._lastGapMs === 18000);
  H.advanceTo(H.clock.t + 5000);
  check('5 own dot: still on target 5 s later, _anim null, no _extrap, no _cadMs', near(m._curLngLat[1], to) && m._anim === null && !m._extrap && m._cadMs === undefined && H.pending() === 0);
}

// 6. A heading on the row (degrees clockwise from north) beats the leg bearing: north leg, hdg 90
//    -> the dot runs on EAST. (The call site passes null today -- the row carries no heading -- so
//    this is the function's contract, not the feed's.)
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix(null, null, { hdg: 90 });
  H.advanceTo(f.landed + 5000);
  const east = ftE(m._curLngLat[0], LNG), north = ftN(m._curLngLat[1], f.lat);
  check('6 hdg 90 on a north leg: the tail runs east (~477 ft in 5 s), not north', within(east, mphFt(65, 5), 0.10) && Math.abs(north) < 1 && !!m._extrap && m._extrap.heading === 90, `east ${ft(east)}, north ${ft(north)}`);
}

// 7. A merged oval (two people riding together) goes through the same glide since 970, aimed at
//    the centroid, with the primary's opts: it runs on along the CENTROID leg. The second rider
//    stands still, so the centroid leg is about half the primary's and the tail's rate is capped at
//    1.5 x that leg's own speed (~47 mph here), not the row's 65. Then the grouping pass's own
//    centroid block (the real text) is run against it, as every presence snapshot does.
{
  const H = harness();
  const P = makeMarker('p', LNG, LAT), Q = makeMarker('q', lngE(LNG, 100), LAT);
  const cLng = (LNG + Q._ll[0]) / 2;
  P._curLngLat = [cLng, LAT];                                // the oval is drawn at the centroid
  H.userMarkers.p = P; H.userMarkers.q = Q;
  H.win._markerGroupMembers = { p: ['p', 'q'] };
  const D = driver(H, P, 65, 18000); D.fix(); const f2 = D.fix();
  H.advanceTo(f2.start + 18000);                              // the moment the third fix lands
  const cFrom = P._curLngLat[1];                              // where the oval is drawn then
  const f = D.fix();
  const cLat = (f.lat + LAT) / 2;                             // the centroid target for this leg
  const glideFt = ftN(cLat, cFrom);
  check('7 merged: grouping asked to rebuild the oval on each fix, the TRUE fix kept on _ll', H.grouping.calls === 3 && near(P._ll[1], f.lat));
  H.advanceTo(f.landed);
  check('7 merged: at t = dur the oval is ON the centroid', near(P._curLngLat[1], cLat) && near(P._curLngLat[0], cLng), `${ft(ftN(P._curLngLat[1], cLat))} off`);
  H.advanceTo(f.landed + 5000);
  const legSpeedMph = glideFt / (f.dur / 1000) * 3600 / 5280;
  const past = ftN(P._curLngLat[1], cLat);
  check(`7 merged: 5 s on, the oval is past the centroid along its leg at 1.5 x the leg's own speed (~${Math.round(mphFt(1.5 * legSpeedMph, 5))} ft), the row's 65 capped`,
    within(past, mphFt(1.5 * legSpeedMph, 5), 0.03) && Math.abs(ftE(P._curLngLat[0], cLng)) < 1 && !!P._extrap, `${ft(past)}; leg ${ft(glideFt)} at ${legSpeedMph.toFixed(1)} mph`);
  // The grouping pass, mid-tail: a frame is in flight, so it leaves the oval alone (as before).
  let n0 = P.sets.length;
  H.centroid('p', ['p', 'q']);
  check('7 grouping pass mid-tail (_anim set): does not touch the oval', P.sets.length === n0);
  // ...and after the tail has ended on its bound: _anim is null again, the oval stands ~60% of the
  // leg past the centroid of the TRUE fixes, and the pass -- which runs on every presence snapshot
  // -- must NOT snap it back there (the next glide would start from _curLngLat and jump it forward again).
  H.drain();
  check('7 setup: the tail ended on its bound, _anim null, _extrapEnded set, the oval past the centroid', P._anim === null && !!P._extrapEnded && ftN(P._curLngLat[1], cLat) > 400, `${ft(ftN(P._curLngLat[1], cLat))} past`);
  n0 = P.sets.length;
  H.centroid('p', ['p', 'q']);
  check('7 grouping pass after the tail ended: stands down -- no setLngLat back to the centroid', P.sets.length === n0, `sets ${n0} -> ${P.sets.length}`);
  // The next fix clears the memory; a row that reads 0 mph lands on the new centroid with no tail,
  // and from then on the pass centres the oval again as it always did (the control).
  const g = D.fix(40000, null, { spd: 0 });
  check('7 the next fix clears _extrapEnded', P._extrapEnded === null);
  H.drain();
  const cLat2 = (g.lat + LAT) / 2;
  check('7 a 0 mph fix lands the oval on the new centroid with no tail', near(P._curLngLat[1], cLat2) && !P._extrap && P._anim === null);
  Q._ll = [lngE(LNG, 100), latN(LAT, 200)];                // the other rider moved 200 ft north
  n0 = P.sets.length;
  H.centroid('p', ['p', 'q']);
  const want = [(g.lng + Q._ll[0]) / 2, (g.lat + Q._ll[1]) / 2];
  check('7 control: with nothing in flight and no tail memory, the pass re-centres the oval as before', P.sets.length === n0 + 1 && near(P.sets[n0][0], want[0]) && near(P.sets[n0][1], want[1]));
}

// 8. The teleport and resume-snap returns never enter the tail, and neither feeds the cadence.
//    (The merged branch has had no early return since 970 -- it falls through to the glide, see 7.)
{
  const H = harness();
  const m = makeMarker('u', LNG, LAT, { _lastFixAt: H.clock.t - 18000, _ts: T0, _cadMs: 18000 });
  H.fn(m, LNG, LAT + 0.3, null, { fixTs: T0 + 18000, remote: true, spd: 65, hdg: null });
  check('8 teleport: placed, no frame, no _extrap, _cadMs untouched', H.pending() === 0 && !m._extrap && m._cadMs === 18000 && near(m._curLngLat[1], LAT + 0.3));
}
{
  const H = harness();
  H.win._resumeSnapUntil = Date.now() + 10000;
  const m = makeMarker('u', LNG, LAT, { _lastFixAt: H.clock.t - 45000, _ts: T0, _cadMs: 18000 });
  const to = latN(LAT, 1700);
  H.fn(m, LNG, to, null, { fixTs: T0 + 45000, remote: true, spd: 65, hdg: null });
  check('8 resume-snap: placed, no frame, no _extrap; a 45 s placement did NOT feed the cadence EMA', H.pending() === 0 && !m._extrap && m._cadMs === 18000 && near(m._curLngLat[1], to) && m._lastGapMs === undefined, `_cadMs=${m._cadMs}`);
}

// 9. Camera: with _camLockUid on this marker, the frame loop keeps carrying the camera through the
//    tail -- and stands down while the user is panning (_followPausedUntil), exactly as in the glide.
{
  const H = harness({ visible: true });
  H.win._camLockUid = 'u';
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix();
  H.advanceTo(f.landed);
  const c0 = H.cam.setCenter;
  H.advanceTo(f.landed + 5000);
  check('9 camera: setCenter on every tail frame (250 frames in 5 s)', H.cam.setCenter - c0 === 250 && H.cam.jumpTo === 0, `setCenter +${H.cam.setCenter - c0}`);
  H.win._followPausedUntil = Date.now() + 1e6;
  const c1 = H.cam.setCenter, l1 = m._curLngLat[1];
  H.advanceTo(f.landed + 6000);
  check('9 camera: a manual pan pauses the follow; the dot keeps moving, the camera does not', H.cam.setCenter === c1 && m._curLngLat[1] > l1);
  H.win._followPausedUntil = 0;
  H.advanceTo(f.landed + 7000);
  check('9 camera: follow resumes when the pause lapses', H.cam.setCenter - c1 === 50, `+${H.cam.setCenter - c1}`);
}

// 10. The held-row gate (the real lines from _processUsersSnapInner, with the real _animateMarker
//     behind it). A HELD row (coarse-fix hold, 965) is the last believed fix again with a new fixTs.
//     Before the tail the dot sat on that spot and the gate's 1 m short-circuit skipped the glide.
//     Once the dot can run on past the fix, that short-circuit no longer fires -- and gliding to
//     the held spot would drag the dot back up to 60% of a leg, then run it out again on the next
//     real fix. So a held row must leave a dot that is in, or just past, its tail alone.
{
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix();
  H.advanceTo(f.landed + 5000);                           // 5 s into the tail, ~477 ft past the fix
  const held = { lat: f.lat, lng: f.lng, fixTs: f.fixTs + 15000, spd: 65, path: null, _held: true };
  const before = m._curLngLat.slice(), animId = m._anim;
  let calls = H.gate('u', held);
  check('10 a held row while the tail runs: the gate does NOT call _animateMarker', calls === 0, `calls=${calls}`);
  check('10 ...the dot is not pulled back, the tail\'s frame is still pending, _extrap still set', near(m._curLngLat[1], before[1]) && m._anim === animId && H.pending() === 1 && !!m._extrap);
  H.advanceTo(f.landed + 6000);
  check('10 ...and the tail carries on moving the dot afterwards', m._curLngLat[1] > before[1]);
  H.drain();                                              // the tail ends on its bound: _extrapEnded, _anim null
  const stood = m._curLngLat.slice();
  calls = H.gate('u', Object.assign({}, held, { fixTs: f.fixTs + 40000 }));
  check('10 a held row after the tail ended on its bound (_extrapEnded): still no call, the dot stands where it got to', calls === 0 && near(m._curLngLat[1], stood[1]) && H.pending() === 0 && !!m._extrapEnded, `calls=${calls}`);
  // A REAL fix is not held: it goes through, re-targets from the standing spot and consumes the memory.
  const realFix = { lat: latN(f.lat, 2000), lng: f.lng, fixTs: f.fixTs + 40000, spd: 65, path: null };
  calls = H.gate('u', realFix);
  check('10 a real (not held) row does go through to _animateMarker and clears the memory', calls === 1 && m._extrapEnded === null && H.pending() === 1, `calls=${calls}`);
}
{
  // The existing short-circuits stand: a held row with the dot ON the held spot (a parked row, no
  // tail) is skipped, and a held row landing mid-glide (no tail, dot not yet there) still glides.
  const H = harness();
  const { m, D } = seeded(H, 'u', 65, 18000);
  const f = D.fix(null, null, { spd: 0 });                 // 0 mph: lands and stops, no tail
  H.advanceTo(f.landed + 2000);
  const n0 = m.sets.length;
  let calls = H.gate('u', { lat: f.lat, lng: f.lng, fixTs: f.fixTs + 15000, spd: 0, path: null, _held: true });
  check('10 control: a held row with the dot sitting ON the held spot: skipped (the old 1 m rule)', calls === 0 && m.sets.length === n0 && H.pending() === 0, `calls=${calls}`);
  const g = D.fix(25000, null, { spd: 0 });                // a new leg, 0 mph (25 s on: the clock is already 21.4 s past the last fix)
  H.advanceTo(g.start + 5000);                             // mid-glide (dur 27 s), well short of the fix, no tail
  calls = H.gate('u', { lat: g.lat, lng: g.lng, fixTs: g.fixTs + 15000, spd: 0, path: null, _held: true });
  check('10 control: a held row landing mid-glide with no tail: still glides to the held spot, as before', calls === 1 && !m._extrap && !m._extrapEnded, `calls=${calls}`);
}

// 11. No cadence learned yet. A member's first row after a silence longer than 60 s has a reporter gap
//     outside 300-60000 ms, so _cadMs is never set. The tail needs it for its time bound: without the
//     gate it would run with maxMs = NaN -- the time bound and the 30 s ceiling never fire -- and only
//     the distance cap would end it (1,020 ft on at 65 mph on this 1,700 ft leg).
{
  const H = harness();
  const m = makeMarker('u', LNG, LAT); H.userMarkers.u = m;
  m._ts = T0; m._lastFixAt = H.clock.t;
  H.advanceTo(H.clock.t + 90000);
  const to = latN(LAT, 1700);
  H.fn(m, LNG, to, null, { fixTs: T0 + 90000, remote: true, spd: 65, hdg: null });
  check('11 no cadence yet: _cadMs unset after an out-of-range (90 s) reporter gap', m._cadMs === undefined, String(m._cadMs));
  H.drain();
  check('11 no cadence yet: the dot lands and stops ON the fix, no tail', near(m._curLngLat[1], to) && !m._extrap && !m._extrapEnded && m._anim === null, ft(ftN(m._curLngLat[1], to)));
}

// 12. The heading walk-back scales longitude by cos(lat) like everything else: a road 1,000 ft north and
//     1,000 ft east bears 45 deg true. Unscaled, the east term reads 1/cos(30.44) long and the bearing
//     49.2 deg -- 35 ft sideways over a 477 ft tail. Every other heading test runs due north or due east,
//     where the scale cannot show. North-east and south-west.
for (const [label, dE, dN, want] of [['north-east', 1000, 1000, 45], ['south-west', -1000, -1000, 225]]) {
  const H = harness();
  const m = makeMarker('u', LNG, LAT, { _cadMs: 18000, _ts: T0, _lastFixAt: H.clock.t }); H.userMarkers.u = m;
  H.advanceTo(H.clock.t + 18000);
  const to = [lngE(LNG, dE), latN(LAT, dN)];
  H.fn(m, to[0], to[1], null, { fixTs: T0 + 18000, remote: true, spd: 65, hdg: null });
  H.advanceTo(H.clock.t + 20000);
  const unscaled = ((Math.atan2(Math.sign(dE) / COS, Math.sign(dN)) * 180 / Math.PI) + 360) % 360;
  check(`12 a diagonal leg ${label} (1,000 ft each way): the tail heading is ${want} deg true, not ${unscaled.toFixed(1)}`, !!m._extrap && Math.abs(m._extrap.heading - want) < 0.5, m._extrap ? m._extrap.heading.toFixed(2) : 'no tail');
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
  const g1 = run({ lng: 1, lat: 2, fixTs: 777, ts: 555, spd: 65, spdH: 0 });
  check('call site: passes the row\'s mph as spd, fixTs, remote:true, and hdg null (the row has no heading)', g1 && g1.opts.spd === 65 && g1.opts.fixTs === 777 && g1.opts.remote === true && g1.opts.hdg === null, JSON.stringify(g1 && g1.opts));
  const g2 = run({ lng: 1, lat: 2, fixTs: 777 });
  check('call site: a row without spd hands over null (no tail)', g2 && g2.opts.spd === null, JSON.stringify(g2 && g2.opts));
  const g3 = run({ lng: 1, lat: 2, fixTs: 777, spd: '65' });
  check('call site: a non-numeric spd is null, never coerced', g3 && g3.opts.spd === null, JSON.stringify(g3 && g3.opts));
  const g4 = run({ lng: 1, lat: 2, fixTs: 777, spd: 0 });
  check('call site: spd 0 is passed as 0 (a number), so the tail can refuse it', g4 && g4.opts.spd === 0, JSON.stringify(g4 && g4.opts));
}

// Extra guards on the text itself -- never the only check, see above.
const fnOnly = src.slice(a, b);
check('source: own-dot calls pass no opts (two of them)', (src.match(/_animateMarker\(userMarkers\[userId\], lng, lat\);/g) || []).length === 2);
check('source: _cadMs is fed in exactly one place, inside the accepted-interval block', (fnOnly.match(/marker\._cadMs = /g) || []).length === 1 && /if \(_mphR <= 150\) \{[^}]*marker\._cadMs = /s.test(fnOnly));
check('source: 964 pacing, 965/966 returns and the teleport guard stand', /Math\.max\(700, Math\.min\(30000, _gap \* 1\.08\)\)/.test(fnOnly) && /_rGap > 300 && _rGap < 60000/.test(fnOnly) && /> 0\.05\) \{/.test(fnOnly) && /window\._resumeSnapUntil/.test(fnOnly));
check('source: _lastGapMs is written in exactly one place', (fnOnly.match(/_lastGapMs\s*=/g) || []).length === 1);
check('source: the tail reads dt from the rAF clock, capped by EXTRAP_DT_CAP_MS', /Math\.min\(EXTRAP_DT_CAP_MS, Math\.max\(0, t2 - _x\.last\)\)/.test(fnOnly));
check('source: longitude steps are scaled by cos(lat)', /111320 \* \(Math\.cos\(_x\.lat \* Math\.PI \/ 180\) \|\| 1\)/.test(fnOnly));
check('source: the heading walks back to a baseline of EXTRAP_HDG_BASE_FT, not the last waypoint pair', /_baseDeg = \(EXTRAP_HDG_BASE_FT \/ 3\.28084\) \/ 111320/.test(fnOnly) && /for \(var _hi = _wp\.length - 2; _hi >= 0; _hi--\)/.test(fnOnly));
check('source: a glide in flight is noted BEFORE its frame is cancelled', /var _inFlight = !!marker\._anim;\s*\n\s*if \(marker\._anim\) \{ cancelAnimationFrame\(marker\._anim\)/.test(fnOnly));
check('source: the overshoot reference is the tail\'s heading, else the in-flight glide\'s kept bearing, else nothing', /var _refHdg = _wasEx \? _wasEx\.heading : \(\(_inFlight && isFinite\(marker\._hdgPrev\)\) \? marker\._hdgPrev : NaN\);/.test(fnOnly));
check('source: _hdgPrev is kept from an unflagged glide only, in one place', (fnOnly.match(/marker\._hdgPrev = /g) || []).length === 1 && /if \(!marker\._noExtrapOnce && isFinite\(_hdg\)\) marker\._hdgPrev = \(_hdg \+ 360\) % 360;/.test(fnOnly));
check('source: the tail needs a known cadence (_cadMs > 0)', /marker\._cadMs > 0 && isFinite\(_hdg\) && _legM > 0/.test(fnOnly));
check('source: the heading walk-back scales longitude by cos(lat)', /var _dE = \(_wb\[0\] - _wp\[_hi\]\[0\]\) \* _cosLat, _dN = _wb\[1\] - _wp\[_hi\]\[1\];/.test(fnOnly));
check('source: the overshoot guard is a fixed EXTRAP_BACK_FT along the heading', /_along < -EXTRAP_BACK_FT \/ 3\.28084\) marker\._noExtrapOnce = true/.test(fnOnly) && !/0\.25 \* _wasEx\.legM/.test(fnOnly));
check('source: the camera block still honours _followPausedUntil and visibility', /Date\.now\(\) >= \(window\._followPausedUntil \|\| 0\)/.test(fnOnly) && /document\.visibilityState === 'visible'/.test(fnOnly));
check('source: the trail tip is welded to the animated position every frame', /window\._updateTrailTip\(marker\._uid, lng, lat\)/.test(fnOnly));
check('source: the grouping pass stands down on _extrapEnded, around the unchanged no-jump line', !!centroidText && /if \(!_pmk\._extrapEnded\) \{\s*if \(!_pmk\._ovalGlide && !_pmk\._anim\) _pmk\.setLngLat\(\[_sx \/ _n, _sy \/ _n\]\);/.test(centroidText));
check('source: the held-row gate skips a dot in or just past its tail, keeping the 1 m rule', !!gateText && /data\.lng\) < 1\) _glide = false;/.test(gateText) && /if \(userMarkers\[uid\]\._extrap \|\| userMarkers\[uid\]\._extrapEnded\) _glide = false;/.test(gateText));

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
