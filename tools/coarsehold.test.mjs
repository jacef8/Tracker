// Runs the REAL _processUsersSnapInner -- the per-member render loop, pulled out of
// public/index.html by its function text -- against the row seen live on 2026-10-24: a native
// iPhone PATCHed lat/lng with an error radius of 18190 ft (3.45 mi), 2.89 mi from the last
// position. Every viewer's dot for her skipped 2.89 miles on a fix that cannot tell those two
// spots apart, then skipped back on the next good fix. The web WRITER already holds such a fix
// (window._lastGoodFix in the fix handler); the native writers do not, so the VIEWER now mirrors
// the same rule per member (window._goodFix) and renders a held row at the last believed spot
// with its accuracy, age and battery left raw.
//
// The release differs from the writer's on purpose: the writer gets a fix every few seconds, so
// "age of the last good fix" IS "how long fixes have been refused". Rows reaching a viewer are
// sparse (a parked iPhone re-sends the same fix for hours), so the window is measured on the
// fixes' own clock from the first fix refused. The cases below pin that: the same held fix
// re-rendered at +240 s of wall clock stays held, a reporter clock ten minutes ahead changes
// nothing, and a cell-tower fix after a quiet half hour is held rather than waved through. The
// window also LAPSES when refusals stop (LIVE_HOLD_LAPSE_MS): a parked phone re-sends one refused
// fix for hours, so a second lone cell fix hours later must be held too, not read as "refused for
// hours" and believed on sight.
//
// Harness as in tools/render-path.test.mjs: the shipped text under a `with` over a Proxy, the
// fake Mapbox Marker, real _settleMemberRow and metersApart, and the three writer constants read
// from the file so the thresholds under test are the shipped ones. Date.now() inside the loop
// reads a clock the test moves, so "time passes with no new fix" can be rendered.
//
// Usage:  node tools/coarsehold.test.mjs [path/to/index.html]
//         (exit 0 = a coarse fix no longer relocates a dot; argv[2] lets the served page be tested)
import { readFileSync } from 'node:fs';
const file = process.argv[2] || 'public/index.html';
const src = readFileSync(file, 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(76)} ${detail || ''}`);
};

// ── Pull the shipped text out, brace walk as in tdz-check.mjs ─────────────────────────────
function extractFn(name) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error(name + ' not found in ' + file);
  let d = 0, end = -1;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error(name + ': braces never balanced');
  return src.slice(a, end + 1);
}
const fnSrc = extractFn('_processUsersSnapInner');
{
  const endIdx = src.indexOf(fnSrc) + fnSrc.length;
  const pub = src.indexOf('window._processUsersSnap = _processUsersSnap;', endIdx);
  const between = pub > 0 ? src.slice(endIdx, pub).split('\n').map((l) => l.trim()).filter(Boolean) : null;
  check('extraction: function text ends where the file publishes it',
        between && between.every((l) => l.startsWith('//')), `${fnSrc.split('\n').length} lines`);
  let parses = true; try { new Function(fnSrc); } catch (e) { parses = false; }
  check('extraction: the text parses on its own', parses);
}
const metersApart = new Function(extractFn('metersApart') + '\n return metersApart;')();
const _settleMemberRow = new Function(extractFn('_settleMemberRow') + '\n return _settleMemberRow;')();

// The writer's thresholds, as shipped. A hand-typed copy here would let the two drift apart.
const constOf = (name) => {
  const m = src.match(new RegExp('^const ' + name + '\\s*=\\s*([^;/]+);', 'm'));
  if (!m) throw new Error(name + ' not found in ' + file);
  return new Function('return (' + m[1] + ');')();
};
const LIVE_MAX_ACC_M = constOf('LIVE_MAX_ACC_M');
const TRAIL_MAX_MPH = constOf('TRAIL_MAX_MPH');
const LIVE_HOLD_MAX_MS = constOf('LIVE_HOLD_MAX_MS');
const LIVE_HOLD_LAPSE_MS = constOf('LIVE_HOLD_LAPSE_MS');
check('constants: read from the file', LIVE_MAX_ACC_M > 0 && TRAIL_MAX_MPH > 0 && LIVE_HOLD_MAX_MS > 0 && LIVE_HOLD_LAPSE_MS > LIVE_HOLD_MAX_MS,
      `LIVE_MAX_ACC_M=${LIVE_MAX_ACC_M} m  TRAIL_MAX_MPH=${TRAIL_MAX_MPH}  LIVE_HOLD_MAX_MS=${LIVE_HOLD_MAX_MS}  LIVE_HOLD_LAPSE_MS=${LIVE_HOLD_LAPSE_MS}`);

// One fixed "now" for every fixture, so a render is deterministic however long the file takes
// to read. The loop's own Date.now() reads S.clock.t (default: this), see makeScope.
const now = Date.now();

// ── A room for it to render into ──────────────────────────────────────────────────────────
function makeScope(extra) {
  const warns = [], llCalls = [], glides = [], grouping = { calls: 0 }, clock = { t: now };
  class Node {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this._html = ''; this.textContent = ''; this.className = '';
      this.classList = { add() {}, remove() {}, contains() { return false; } }; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; if (v === '') this.children.length = 0; }
    appendChild(c) { this.children.push(c); return c; }
    querySelector() { return null; }
    addEventListener() {}
    setAttribute() {}
  }
  const listEl = new Node();
  const document = { body: new Node(), getElementById: (id) => (id === 'user-list' ? listEl : new Node()), createElement: () => new Node() };
  // The position lives in _pos, not _ll: the render loop stamps its own `_ll = [lng, lat]`
  // expando on every marker (the merge pass reads it), exactly as it does on a real Mapbox
  // Marker, whose getLngLat() reads a private field and is unaffected.
  class Marker {
    constructor(o) { this._o = o || {}; this._pos = null; }
    setLngLat(ll) {
      const lng = ll && ll[0], lat = ll && ll[1];
      llCalls.push([lng, lat]);
      if (isNaN(lng) || isNaN(lat)) throw new Error('Invalid LngLat object: (' + lng + ', ' + lat + ')');
      if (+lat > 90 || +lat < -90) throw new Error('Invalid LngLat latitude value: must be between -90 and 90');
      this._pos = { lng: +lng, lat: +lat }; return this;
    }
    addTo() { return this; }
    getLngLat() { return this._pos; }
    getElement() { return this._o.element; }
    remove() {}
  }
  const window = {
    _refreshPeopleBadge() {},
    _presenceOf() { return { key: 'live', label: 'LIVE', color: '#00e676', calm: true, line: 'Live', why: '' }; },
    _rosterHas() { return false; },
    _locReason() { return ''; },
    _motionOf() { return null; },
  };
  const overrides = Object.assign({
    document, window, mapboxgl: { Marker }, map: {}, userMarkers: {}, userId: 'me', groupName: 'qa',
    knownUsers: {}, usersInitialLoad: true, followUid: null, fitAllInterval: null,
    console: { log() {}, warn(...a) { warns.push(a); }, error() {} },
    // The viewer's wall clock. The loop only ever calls Date.now() (no `new Date`), so a
    // plain object with now() is the whole surface; moving clock.t is "time passes".
    Date: { now: () => clock.t },
    LIVE_MS: 4 * 60 * 1000, STALE_MS: 20 * 60 * 1000, BS_REST_MAX_MS: 3 * 24 * 60 * 60 * 1000,
    HERE_MOVE_M: 40, MOVE_ON_MPH: 3, MOVE_OFF_MPH: 1.5, MOVE_STICKY_MS: 75 * 1000, MK_TAIL: 12,
    LIVE_MAX_ACC_M, TRAIL_MAX_MPH, LIVE_HOLD_MAX_MS, LIVE_HOLD_LAPSE_MS,
    metersApart, _settleMemberRow,
    // The glide, recorded. Arrival is immediate so the marker's position IS the glide target.
    _animateMarker: (m, lng, lat) => { glides.push([lng, lat]); m.setLngLat([lng, lat]); m._curLngLat = [lng, lat]; },
    _getFriends: () => ({}),
    _assignDistinctAutoColors: () => ({}),
    _updateMarkerGrouping: () => { grouping.calls++; },
    userColor: (u) => 'color-' + u,
    escapeHtmlJs: (s) => String(s == null ? '' : s),
  }, extra || {});
  const state = Object.assign({}, overrides);
  const noops = {}, stubbed = new Set();
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const scope = new Proxy({}, {
    has(_, k) {
      if (typeof k !== 'string' || k === '_processUsersSnapInner') return false;
      return !(k in globalThis) || hasOwn(overrides, k);
    },
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      if (hasOwn(state, k)) return state[k];
      stubbed.add(k);
      return noops[k] || (noops[k] = function () {});
    },
    set(_, k, v) { state[k] = v; return true; },
  });
  const fn = new Function('__s', 'with (__s) { ' + fnSrc + '\n return _processUsersSnapInner; }')(scope);
  return { fn, state, window, warns, llCalls, glides, grouping, listEl, stubbed, clock };
}
const snapOf = (rows) => ({ val: () => rows });
const render = (S, rows) => { try { S.fn(snapOf(rows)); return null; } catch (e) { return e; } };
// A render at a given moment of the viewer's clock -- the real loop runs moments after a row
// lands, so most cases render each fix at fixTs + 5 s and keep the row LIVE (the glide only
// runs for live rows, and a broken hold shows as a glide to the coarse spot).
const atClock = (S, t, rows) => { S.clock.t = t; return render(S, rows); };
const first = (e) => (e ? String((e && e.stack) || e).split('\n')[0] : 'clean');

// ── Geometry (imperial, as the app speaks) ────────────────────────────────────────────────
const MILE_M = 1609.344;
const DEG_PER_M = 1 / 111194.9;                       // one metre of latitude on metersApart's sphere
const P1 = { lat: 30.44, lng: -84.9 };
const P2 = { lat: P1.lat + 2.89 * MILE_M * DEG_PER_M, lng: P1.lng };    // 2.89 mi north: the live case
const Q50 = { lat: P1.lat + 50 * MILE_M * DEG_PER_M, lng: P1.lng };     // 50 mi north: the teleport case
const HALF = { lat: P1.lat + 0.5 * MILE_M * DEG_PER_M, lng: P1.lng };   // 0.5 mi north: a walk, not a teleport
const P3 = { lat: P1.lat - 2.0 * MILE_M * DEG_PER_M, lng: P1.lng };     // 2 mi south: a second, different cell tower
const H = 60 * 60e3;
const COARSE_FT = 18190;                              // 3.45 mi error radius, as PATCHed
const FT_PER_M = 3.28084;
check('geometry: P2 is 2.89 mi from P1', Math.abs(metersApart(P1.lat, P1.lng, P2.lat, P2.lng) / MILE_M - 2.89) < 0.01);
check('geometry: 18190 ft is past the writer threshold, 100 ft is not',
      COARSE_FT > LIVE_MAX_ACC_M * FT_PER_M && 100 < LIVE_MAX_ACC_M * FT_PER_M, `threshold ${Math.round(LIVE_MAX_ACC_M * FT_PER_M)} ft`);

// A member row. fixTs doubles as ts so the row is LIVE (the glide only runs for live rows);
// `extra` can set ts on its own, as a heartbeat does (fresh ts, ORIGINAL fixTs).
const row = (name, p, accFt, fixTs, extra) => Object.assign({ name, lat: p.lat, lng: p.lng, accuracy: accFt, ts: fixTs, fixTs, spd: 0 }, extra || {});
const at = (m) => (m && m.getLngLat());
const near = (a, p) => !!a && Math.abs(a.lat - p.lat) < 1e-9 && Math.abs(a.lng - p.lng) < 1e-9;
const llNear = (ll, p) => Array.isArray(ll) && Math.abs(ll[1] - p.lat) < 1e-9 && Math.abs(ll[0] - p.lng) < 1e-9;
const fmt = (a) => (a ? a.lat.toFixed(6) + ',' + a.lng.toFixed(6) : 'none');
const coordsOf = (p) => p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);
const gfOf = (S) => S.window._goodFix && S.window._goodFix.b;

// Harness premise: the fake Marker is where the dot would be, and the loop reads our clock.
{
  let threw = null;
  try { new (makeScope().state.mapboxgl.Marker)({}).setLngLat([undefined, undefined]); } catch (e) { threw = e; }
  check('harness: the Marker fake throws on [undefined, undefined] like Mapbox', /Invalid LngLat/.test(String(threw && threw.message)));
  const S = makeScope();
  S.clock.t = 1234567;
  render(S, { b: row('Beth', P1, 16, 1234000) });
  check('harness: the loop reads the test clock (marker _lastFixAt or _ts stamped from a 1970s row, no throw)',
        !!S.state.userMarkers.b, 'rendered at t=1234567');
}

// 1. First-ever fix for b is coarse: accepted anyway (something beats nothing), marker created there.
{
  const S = makeScope();
  const e = render(S, { b: row('Beth', P2, COARSE_FT, now - 1000) });
  check('1 first fix coarse: accepted, marker created at it', e === null && near(at(S.state.userMarkers.b), P2), first(e) + ' ' + fmt(at(S.state.userMarkers.b)));
  check('1 first fix coarse: _goodFix.b holds it with acc in feet',
        !!gfOf(S) && gfOf(S).acc === COARSE_FT && near(gfOf(S), P2), JSON.stringify(gfOf(S)));
  check('1 first fix coarse: nothing held', S.window._heldN === 0, `heldN=${S.window._heldN}`);
}

// 2 + 3. The live case: good at P1, coarse 2.89 mi away a minute later, then good at P2.
{
  const S = makeScope();
  const T1 = now - 130e3, T2 = T1 + 60e3, T3 = now;
  const e1 = render(S, { b: row('Beth', P1, 16, T1) });
  check('2 good fix at P1: marker at P1, _goodFix.b = P1', e1 === null && near(at(S.state.userMarkers.b), P1) && near(gfOf(S), P1), first(e1));
  const glidesBefore = S.glides.length;
  const e2 = render(S, { b: row('Beth', P2, COARSE_FT, T2, { path: [[P1.lat + 0.001, P1.lng, T2 - 30e3]] }) });
  const m = S.state.userMarkers.b;
  check('2 coarse fix 2.89 mi away: no throw', e2 === null, first(e2));
  check('2 coarse fix: the dot stays at P1', near(at(m), P1), fmt(at(m)));
  check('2 coarse fix: no glide was started (target is where the dot sits)', S.glides.length === glidesBefore, `glides=${S.glides.length - glidesBefore}`);
  check('2 coarse fix: _goodFix.b stays P1 with its own accuracy, heldSince = heldLast = the refused fix', near(gfOf(S), P1) && gfOf(S).acc === 16 && gfOf(S).ts === T1 && gfOf(S).heldSince === T2 && gfOf(S).heldLast === T2,
        JSON.stringify(gfOf(S)));
  check('2 coarse fix: _ll (merged-oval centroid input) is P1', llNear(m._ll, P1), JSON.stringify(m._ll));
  check('2 coarse fix: sheet shows P1 coordinates', typeof m._sheetHTML === 'string' && m._sheetHTML.includes(coordsOf(P1)) && !m._sheetHTML.includes(coordsOf(P2)));
  check('2 coarse fix: sheet ± label stays the RAW 18190 ft', typeof m._sheetHTML === 'string' && m._sheetHTML.includes('±' + COARSE_FT + 'ft'));
  check('2 coarse fix: marker _acc / _ts carry the raw fix (merge slack stays honest)', m._acc === COARSE_FT && m._ts === T2, `_acc=${m._acc} _ts=${m._ts}`);
  check('2 coarse fix: heldN === 1', S.window._heldN === 1, `heldN=${S.window._heldN}`);
  check('2 coarse fix: the raw row was not mutated (read-side only)', (() => {
    const r = row('Beth', P2, COARSE_FT, T2); const rows = { b: r }; render(S, rows);
    return r.lat === P2.lat && r.lng === P2.lng && r._held === undefined;
  })());
  check('2 coarse fix: a re-render holds again, heldN still 1 (per render)', S.window._heldN === 1, `heldN=${S.window._heldN}`);
  const e3 = render(S, { b: row('Beth', P2, 20, T3) });
  check('3 good fix at P2: dot moves to P2', e3 === null && near(at(S.state.userMarkers.b), P2), first(e3) + ' ' + fmt(at(S.state.userMarkers.b)));
  check('3 good fix at P2: a glide ran to P2', S.glides.length === glidesBefore + 1 && Math.abs(S.glides[S.glides.length - 1][1] - P2.lat) < 1e-9);
  check('3 good fix at P2: _goodFix advances, hold cleared', near(gfOf(S), P2) && gfOf(S).acc === 20 && gfOf(S).ts === T3 && gfOf(S).heldSince === undefined && gfOf(S).heldLast === undefined, JSON.stringify(gfOf(S)));
  check('3 good fix at P2: heldN back to 0', S.window._heldN === 0, `heldN=${S.window._heldN}`);
  console.log(`      (${S.stubbed.size} helpers resolved to no-ops: ${[...S.stubbed].sort().join(' ')})`);
}

// 4. The teleport rule: 50 mi in 10 s. Worse accuracy than the held fix -> held. Better -> believed.
{
  const S = makeScope();
  render(S, { b: row('Beth', P1, 16, now - 20e3) });
  const e = render(S, { b: row('Beth', Q50, 100, now - 10e3) });    // 100 ft: inside LIVE_MAX_ACC_M, so only the speed rule can hold it
  check('4 teleport, worse accuracy: held at P1', e === null && near(at(S.state.userMarkers.b), P1) && S.window._heldN === 1, first(e) + ' ' + fmt(at(S.state.userMarkers.b)));
}
{
  const S = makeScope();
  render(S, { b: row('Beth', P1, 16, now - 20e3) });
  const e = render(S, { b: row('Beth', Q50, 10, now - 10e3) });
  check('4 teleport, better accuracy: believed, dot at Q50', e === null && near(at(S.state.userMarkers.b), Q50) && S.window._heldN === 0, first(e) + ' ' + fmt(at(S.state.userMarkers.b)));
}

// 5. Release: measured on the FIXES' clock, from the first fix refused. Good at P1, coarse A
//    (held), coarse B just inside the window (held), coarse C just past it (believed), then
//    the heartbeat that re-sends C (not a refusal -- the dot is already there).
{
  const S = makeScope();
  const T = now - 600e3, A = T + 60e3, B = A + LIVE_HOLD_MAX_MS - 20e3, C = A + LIVE_HOLD_MAX_MS + 20e3;
  atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
  const m = S.state.userMarkers.b;
  const eA = atClock(S, A + 5e3, { b: row('Beth', P2, COARSE_FT, A) });
  check('5 release: coarse A held at P1, heldSince = A (the fix clock, not ours)', eA === null && near(at(m), P1) && S.window._heldN === 1 && gfOf(S).heldSince === A,
        first(eA) + ' ' + JSON.stringify(gfOf(S)));
  const eB = atClock(S, B + 5e3, { b: row('Beth', P2, COARSE_FT, B) });
  check('5 release: coarse B just inside the window: still held, heldSince still A', eB === null && near(at(m), P1) && S.window._heldN === 1 && gfOf(S).heldSince === A && gfOf(S).ts === T,
        first(eB) + ` B-A=${(B - A) / 1000}s`);
  const glidesBefore = S.glides.length;
  const eC = atClock(S, C + 5e3, { b: row('Beth', P2, COARSE_FT, C) });
  check('5 release: coarse C past the window: believed, dot glides to P2', eC === null && near(at(m), P2) && S.glides.length === glidesBefore + 1,
        first(eC) + ' ' + fmt(at(m)) + ` C-A=${(C - A) / 1000}s`);
  check('5 release: _goodFix now P2 with the raw acc, hold cleared, heldN 0', near(gfOf(S), P2) && gfOf(S).acc === COARSE_FT && gfOf(S).ts === C && gfOf(S).heldSince === undefined && gfOf(S).heldLast === undefined && S.window._heldN === 0,
        JSON.stringify(gfOf(S)) + ` heldN=${S.window._heldN}`);
  const eH = atClock(S, C + 65e3, { b: row('Beth', P2, COARSE_FT, C, { ts: C + 60e3 }) });
  check('5 release: the heartbeat re-sending the believed fix is not a refusal (heldN 0, no heldSince)',
        eH === null && near(at(m), P2) && S.window._heldN === 0 && gfOf(S).heldSince === undefined, first(eH) + ` heldN=${S.window._heldN}`);
}
// 5. Wall clock: the same held fix re-rendered as the native heartbeat sends it (fresh ts,
//    ORIGINAL fixTs, nothing new) stays held however long this viewer's clock runs. The old
//    `now - ts` rule let it walk onto the map at 181 s with no new fix, at a different moment
//    on every viewer.
{
  const S = makeScope();
  const T = now - 900e3, A = T + 60e3;
  atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
  const m = S.state.userMarkers.b;
  atClock(S, A + 5e3, { b: row('Beth', P2, COARSE_FT, A) });
  const results = [];
  for (const dt of [61e3, 181e3, 240e3, 600e3]) {
    const e = atClock(S, A + dt, { b: row('Beth', P2, COARSE_FT, A, { ts: A + dt - 1e3 }) });
    results.push({ dt: dt / 1000, e: first(e), p: fmt(at(m)), ll: llNear(m._ll, P1), heldN: S.window._heldN });
  }
  check('5 wall clock: held fix re-rendered at +61/+181/+240/+600 s: dot and _ll stay at P1, heldN 1 each time',
        results.every((r) => r.e === 'clean' && r.heldN === 1 && r.ll) && near(at(m), P1),
        results.map((r) => `+${r.dt}s:${r.heldN}`).join(' ') + ' ' + fmt(at(m)));
  check('5 wall clock: _goodFix untouched by the passage of time', near(gfOf(S), P1) && gfOf(S).ts === T && gfOf(S).heldSince === A, JSON.stringify(gfOf(S)));
}
// 5. Clock skew: the reporter's clock ten minutes AHEAD of this viewer. The window is still
//    LIVE_HOLD_MAX_MS between refused fixes; under the old rule `now - ts` went negative and the
//    hold lasted thirteen minutes.
{
  const S = makeScope();
  const SKEW = 10 * 60e3;
  const T = now - 600e3, A = T + 60e3, B = A + LIVE_HOLD_MAX_MS - 20e3, C = A + LIVE_HOLD_MAX_MS + 20e3;
  atClock(S, T + 5e3, { b: row('Beth', P1, 16, T + SKEW) });
  const m = S.state.userMarkers.b;
  const eA = atClock(S, A + 5e3, { b: row('Beth', P2, COARSE_FT, A + SKEW) });
  const eB = atClock(S, B + 5e3, { b: row('Beth', P2, COARSE_FT, B + SKEW) });
  check('5 skew +10 min: A and B held at P1', eA === null && eB === null && near(at(m), P1) && S.window._heldN === 1, first(eA || eB) + ' ' + fmt(at(m)));
  const eC = atClock(S, C + 5e3, { b: row('Beth', P2, COARSE_FT, C + SKEW) });
  check('5 skew +10 min: C past the window is believed at the same point as without skew', eC === null && near(at(m), P2) && S.window._heldN === 0 && gfOf(S).ts === C + SKEW,
        first(eC) + ' ' + fmt(at(m)));
}
// 5. Parked: a good fix half an hour ago, heartbeats re-sending it since, then the first NEW
//    fix is a cell tower 2.89 mi away. Measured from the last good fix that would be "held too
//    long" and waved through -- the shape the patch exists for. Held; follows only after three
//    minutes of coarse fixes.
{
  const S = makeScope();
  const T0 = now - 30 * 60e3;
  atClock(S, T0 + 5e3, { b: row('Beth', P1, 16, T0) });
  const m = S.state.userMarkers.b;
  const eH1 = atClock(S, now - 20 * 60e3, { b: row('Beth', P1, 16, T0, { ts: now - 20 * 60e3 - 1e3 }) });
  const eH2 = atClock(S, now - 10 * 60e3, { b: row('Beth', P1, 16, T0, { ts: now - 10 * 60e3 - 1e3 }) });
  check('5 parked: half an hour of heartbeats, nothing held', eH1 === null && eH2 === null && S.window._heldN === 0 && gfOf(S).heldSince === undefined && gfOf(S).ts === T0,
        first(eH1 || eH2) + ' ' + JSON.stringify(gfOf(S)));
  const A = now - 5e3;
  const eA = atClock(S, now, { b: row('Beth', P2, COARSE_FT, A) });
  check('5 parked: the first fix after a quiet half hour is coarse: HELD at P1', eA === null && near(at(m), P1) && S.window._heldN === 1 && gfOf(S).heldSince === A,
        first(eA) + ' ' + fmt(at(m)) + ` heldN=${S.window._heldN}`);
  const C = A + LIVE_HOLD_MAX_MS + 20e3;
  const eC = atClock(S, C + 5e3, { b: row('Beth', P2, COARSE_FT, C) });
  check('5 parked: three minutes of coarse fixes later the dot follows', eC === null && near(at(m), P2) && S.window._heldN === 0, first(eC) + ' ' + fmt(at(m)));
}

// 5. Lone Z: the stale-heldSince gap the safety review found in round 2. Good P1; coarse A held;
//    the parked phone re-sends A for five hours (every heartbeat is another refusal of A, same
//    fixTs, fresh ts); then a SECOND lone cell-tower fix Z at a third spot. Measured from the
//    first refusal alone, "refused since A" is five hours and Z was believed on sight -- the dot
//    walked 2.89 mi onto Z and back. Z must be held like A was (the window restarts at Z), and
//    released only by a fresh refusal LIVE_HOLD_MAX_MS after it.
{
  const S = makeScope();
  const T = now - 6 * H, A = T + 60e3, Z = A + 5 * H + 60e3, Y = Z + LIVE_HOLD_MAX_MS + 60e3;
  atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
  const m = S.state.userMarkers.b;
  const eA = atClock(S, A + 5e3, { b: row('Beth', P2, COARSE_FT, A) });
  check('5 lone Z: coarse A held at P1, heldSince = heldLast = A', eA === null && near(at(m), P1) && S.window._heldN === 1 && gfOf(S).heldSince === A && gfOf(S).heldLast === A,
        first(eA) + ' ' + JSON.stringify(gfOf(S)));
  const hb = [];
  for (let k = 1; k <= 20; k++) {
    const t = A + k * 15 * 60e3;
    const e = atClock(S, t, { b: row('Beth', P2, COARSE_FT, A, { ts: t - 1e3 }) });
    hb.push({ e: first(e), heldN: S.window._heldN, p1: near(at(m), P1) });
  }
  check('5 lone Z: five hours of heartbeats re-sending A: held every time, heldSince and heldLast still A',
        hb.every((r) => r.e === 'clean' && r.heldN === 1 && r.p1) && gfOf(S).heldSince === A && gfOf(S).heldLast === A && gfOf(S).ts === T,
        `${hb.length} beats, heldN=${hb.map((r) => r.heldN).join('')} ` + JSON.stringify(gfOf(S)));
  const glidesBefore = S.glides.length;
  const eZ = atClock(S, Z + 5e3, { b: row('Beth', P3, COARSE_FT, Z) });
  check('5 lone Z: a second lone cell fix hours later is HELD at P1, window restarted at Z',
        eZ === null && near(at(m), P1) && S.glides.length === glidesBefore && S.window._heldN === 1 && near(gfOf(S), P1) && gfOf(S).heldSince === Z && gfOf(S).heldLast === Z,
        first(eZ) + ' ' + fmt(at(m)) + ` heldN=${S.window._heldN} ` + JSON.stringify(gfOf(S)));
  const eY = atClock(S, Y + 5e3, { b: row('Beth', P3, COARSE_FT, Y) });
  check('5 lone Z: a coarse fix four minutes after Z releases: dot follows to P3, hold cleared',
        eY === null && near(at(m), P3) && S.window._heldN === 0 && near(gfOf(S), P3) && gfOf(S).heldSince === undefined && gfOf(S).heldLast === undefined,
        first(eY) + ' ' + fmt(at(m)) + ` Y-Z=${(Y - Z) / 1000}s`);
}
// 5. Same tower, hours apart: coarse A held, nothing new for two hours, then a NEW fixTs at the
//    same tower coordinates. Two refusals two hours apart are not "refused for two hours": held.
//    Pins the lapse from above -- a lapse of two hours or more would wave this through.
{
  const S = makeScope();
  const T = now - 3 * H, A = T + 60e3, Z = A + 2 * H;
  atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
  const m = S.state.userMarkers.b;
  atClock(S, A + 5e3, { b: row('Beth', P2, COARSE_FT, A) });
  const eZ = atClock(S, Z + 5e3, { b: row('Beth', P2, COARSE_FT, Z) });
  check('5 same tower 2 h later: held at P1, window restarted at the new fix',
        eZ === null && near(at(m), P1) && S.window._heldN === 1 && gfOf(S).heldSince === Z && gfOf(S).heldLast === Z && gfOf(S).ts === T,
        first(eZ) + ' ' + fmt(at(m)) + ` heldN=${S.window._heldN} ` + JSON.stringify(gfOf(S)));
}
// 5. Precise Location off: such an iPhone reports about every 15 min, every fix ~3000 ft, each at
//    a slightly different spot. Refusals 15 min apart are one episode (inside the lapse), so the
//    second is past the window and believed: the dot is never more than one fix behind. Pins the
//    lapse from below -- under 15 min it restarts on every fix and the dot sticks for good.
{
  const STEP = 15 * 60e3;
  check('5 precise-off fixtures: the 15 min cadence sits between the window and the lapse', STEP > LIVE_HOLD_MAX_MS && STEP < LIVE_HOLD_LAPSE_MS,
        `window=${LIVE_HOLD_MAX_MS / 60e3} min  cadence=15 min  lapse=${LIVE_HOLD_LAPSE_MS / 60e3} min`);
  const S = makeScope();
  const T = now - 3 * H;
  atClock(S, T + 5e3, { b: row('Beth', P1, 3000, T) });
  const m = S.state.userMarkers.b;
  const out = [];
  let last = P1;
  for (let k = 1; k <= 6; k++) {
    const p = { lat: P1.lat + k * 0.002, lng: P1.lng };   // ~730 ft steps north
    const e = atClock(S, T + k * STEP + 5e3, { b: row('Beth', p, 3000, T + k * STEP) });
    out.push(k + ':' + (e ? 'THREW' : near(at(m), p) ? 'FOLLOWS' : near(at(m), last) ? 'held' : 'ELSEWHERE'));
    if (near(at(m), p)) last = p;
  }
  check('5 precise-off, 3000 ft fixes every 15 min: held, follows, held, follows -- never stuck',
        out.join(' ') === '1:held 2:FOLLOWS 3:held 4:FOLLOWS 5:held 6:FOLLOWS', out.join(' '));
}
// 5. The lapse is measured from the LATEST refusal (heldLast), not the first: A held, B two
//    minutes later still held (inside the window), then C a minute short of the lapse after B
//    though a minute past it after A. B and C are one episode: C is past the window, released.
{
  check('5 latest-refusal fixtures: two minutes is inside the window, the lapse is well past it', 2 * 60e3 < LIVE_HOLD_MAX_MS && LIVE_HOLD_LAPSE_MS - 60e3 > LIVE_HOLD_MAX_MS);
  const S = makeScope();
  const T = now - 2 * H, A = T + 60e3, B = A + 2 * 60e3, C = B + LIVE_HOLD_LAPSE_MS - 60e3;
  atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
  const m = S.state.userMarkers.b;
  atClock(S, A + 5e3, { b: row('Beth', P2, COARSE_FT, A) });
  const eB = atClock(S, B + 5e3, { b: row('Beth', P2, COARSE_FT, B) });
  check('5 latest refusal: B two minutes after A still held, heldLast moves to B, heldSince stays A',
        eB === null && near(at(m), P1) && S.window._heldN === 1 && gfOf(S).heldSince === A && gfOf(S).heldLast === B, first(eB) + ' ' + JSON.stringify(gfOf(S)));
  const eC = atClock(S, C + 5e3, { b: row('Beth', P2, COARSE_FT, C) });
  check('5 latest refusal: C inside the lapse after B (past it after A) is released to P2',
        eC === null && near(at(m), P2) && S.window._heldN === 0 && gfOf(S).heldSince === undefined, first(eC) + ' ' + fmt(at(m)) + ` C-B=${(C - B) / 60e3} min C-A=${(C - A) / 60e3} min`);
}

// 6. Your own row is never consulted: that dot is driven by onGpsFix.
{
  const S = makeScope();
  const e1 = render(S, { me: row('Me', P1, 16, now - 20e3) });
  const e2 = render(S, { me: row('Me', Q50, COARSE_FT, now - 10e3) });
  check('6 isMine: no _goodFix entry, no hold', e1 === null && e2 === null && !(S.window._goodFix && S.window._goodFix.me) && S.window._heldN === 0,
        first(e1 || e2) + ' ' + JSON.stringify(S.window._goodFix));
}

// 7. A row that fails hasGps is not consulted.
{
  const S = makeScope();
  const e = render(S, {
    a: { name: 'Aaron', dev: 'PC', noGps: true, noGpsTs: now - 60e3, ts: now - 10e3 },
    x: { name: 'Xena', lat: 'x', lng: 'y', ts: now, fixTs: now, accuracy: 5 },
    b: row('Beth', P1, 16, now),
  });
  check('7 no-GPS rows: no entry, no throw, Beth still tracked',
        e === null && !S.window._goodFix.a && !S.window._goodFix.x && near(gfOf(S), P1) && !S.window._rowErrN,
        first(e) + ' ' + Object.keys(S.window._goodFix).join(','));
}

// 8. Patch-2 behaviour intact: a throwing row still does not stop the others, hold or no hold.
{
  const S = makeScope({ _updateMarkerSpeed: (el, d, live, uid) => { if (uid === 'b') throw new Error('qa: synthetic row failure'); } });
  const e = render(S, { b: row('Beth', P1, 16, now), c: row('Carl', P2, 16, now) });
  check('8 throwing row: Beth skipped, Carl rendered, counted once',
        e === null && !S.state.userMarkers.b && !!S.state.userMarkers.c && S.window._rowErrN === 1 && S.window._rowErr.uid === 'b',
        first(e) + ' markers=' + Object.keys(S.state.userMarkers).join(','));
  check('8 throwing row: Carl still got a _goodFix entry', near(S.window._goodFix.c, P2));
}

// 9. The threshold itself, by behaviour: row accuracy is FEET, LIVE_MAX_ACC_M is METRES. A fix
//    0.5 mi away 150 s later (12 mph, so the speed rule is silent) with an accuracy UNDER the
//    metre limit is believed; OVER it is held. The two values sit between the bare metre number
//    and a doubled conversion, so a missing, inverted or doubled factor flips one of them.
{
  const UNDER_FT = Math.round(LIVE_MAX_ACC_M * FT_PER_M * 0.6);
  const OVER_FT = Math.round(LIVE_MAX_ACC_M * FT_PER_M * 1.4);
  check('9 threshold fixtures: under-limit value is past the bare metre number, over-limit value short of a doubled factor',
        UNDER_FT > LIVE_MAX_ACC_M && UNDER_FT < LIVE_MAX_ACC_M * FT_PER_M && OVER_FT > LIVE_MAX_ACC_M * FT_PER_M && OVER_FT < LIVE_MAX_ACC_M * FT_PER_M * FT_PER_M,
        `under=${UNDER_FT} ft  over=${OVER_FT} ft  limit=${Math.round(LIVE_MAX_ACC_M * FT_PER_M)} ft`);
  const mph = (metersApart(P1.lat, P1.lng, HALF.lat, HALF.lng) / 150) * 2.23694;
  check('9 threshold fixtures: 0.5 mi in 150 s is well under TRAIL_MAX_MPH', mph < TRAIL_MAX_MPH / 4, `${mph.toFixed(1)} mph`);
  {
    const S = makeScope();
    const T = now - 160e3;
    atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
    const m = S.state.userMarkers.b;
    const e = atClock(S, now, { b: row('Beth', HALF, UNDER_FT, T + 150e3) });
    check(`9 threshold: ${UNDER_FT} ft (under ${LIVE_MAX_ACC_M} m) is believed: dot moves, _goodFix advances`,
          e === null && near(at(m), HALF) && S.window._heldN === 0 && near(gfOf(S), HALF) && gfOf(S).acc === UNDER_FT,
          first(e) + ' ' + fmt(at(m)) + ` heldN=${S.window._heldN}`);
  }
  {
    const S = makeScope();
    const T = now - 160e3;
    atClock(S, T + 5e3, { b: row('Beth', P1, 16, T) });
    const m = S.state.userMarkers.b;
    const e = atClock(S, now, { b: row('Beth', HALF, OVER_FT, T + 150e3) });
    check(`9 threshold: ${OVER_FT} ft (over ${LIVE_MAX_ACC_M} m) is held: dot stays at P1, heldN 1`,
          e === null && near(at(m), P1) && S.window._heldN === 1 && near(gfOf(S), P1) && gfOf(S).acc === 16,
          first(e) + ' ' + fmt(at(m)) + ` heldN=${S.window._heldN}`);
  }
}

// Extra guards on the text itself -- never the only check, see above.
check('source: the hold substitutes lat/lng only and marks the row', /data = Object\.assign\(\{\}, data, \{ lat: _gf\.lat, lng: _gf\.lng, path: null, _held: true \}\)/.test(fnSrc));
check('source: the hold converts the metre constant to feet (anchored)', /_accFt > LIVE_MAX_ACC_M \* 3\.28084\s*;/.test(fnSrc));
check('source: the release is measured on the fixes\' clock, never the viewer\'s', (() => {
  const a = fnSrc.indexOf('Coarse-fix hold (viewer side)'); if (a < 0) return false;
  const b = fnSrc.indexOf('const _ago', a); if (b < 0) return false;
  const code = fnSrc.slice(a, b).replace(/\/\/.*$/gm, '');
  return /\(_fixAtMs - _gf\.heldSince\) > LIVE_HOLD_MAX_MS/.test(code) && !/now - _gf\./.test(code);
})());
check('source: the window lapses from the LATEST refusal (heldLast), on the fixes\' clock', (() => {
  const a = fnSrc.indexOf('Coarse-fix hold (viewer side)'); if (a < 0) return false;
  const b = fnSrc.indexOf('const _ago', a); if (b < 0) return false;
  const code = fnSrc.slice(a, b).replace(/\/\/.*$/gm, '');
  return /\(_fixAtMs - \(_gf\.heldLast \|\| _gf\.heldSince\)\) > LIVE_HOLD_LAPSE_MS\) _gf\.heldSince = _fixAtMs;/.test(code)
      && /_gf\.heldLast = Math\.max\(_gf\.heldLast \|\| 0, _fixAtMs\);/.test(code);
})());
check('source: the hold block does not write to the room', (() => {
  const a = fnSrc.indexOf('Coarse-fix hold (viewer side)'); if (a < 0) return false;
  const b = fnSrc.indexOf('const _ago', a); if (b < 0) return false;
  const code = fnSrc.slice(a, b).replace(/\/\/.*$/gm, '');
  return !/fbSet|fbUpdate|fbPush|_fb\.update|writeDebugLog|_evt\(/.test(code);
})());
check('source: _writeDiag carries heldN', /heldN: window\._heldN \|\| 0/.test(src));

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
