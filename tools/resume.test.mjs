// Runs the REAL resume catch-up code -- pulled out of public/index.html by its text -- at all
// four places it lives: the feed's visibilitychange handler (opens the window), _animateMarker
// (a remote row inside the window is PLACED, not glided), the per-member render loop (a NON-live
// row inside the window is placed too, which today's rule never does, and group follow re-fits
// once from the placed dots) and _camPlace (a placement takes the camera with it for the member
// the viewer follows).
//
// Why this exists: reopening the app after minutes away, a member who moved glided there from
// the old spot (a catch-up sprint of up to 30 s), and a member whose row aged past LIVE_MS was
// never moved at all -- the dot sat a block from its own chip, leader and cluster tap, which all
// read the new coordinate. Life360 shows everyone where they are now and resumes motion from
// there. The window is 8 s, opens only after 20 s hidden, and never touches the own dot.
//
// Why the camera is in here: the frame loop in step() carries the camera for the followed member
// (follow-one, or group follow with one framed member), and a placement runs no frames -- so a
// placed child could land off-screen with nothing coming after. _camPlace eases to the placement
// for follow-one; the render re-fits group follow once per window after the dots are placed.
//
// Usage:  node tools/resume.test.mjs        (exit 0 = the resume catch-up behaves)
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(74)} ${detail || ''}`);
};

// ── Pull the shipped text out (brace walk as in tdz-check.mjs) ────────────────────────────
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
const _camDur = new Function(extractFn('_camDur') + '\n return _camDur;')();
// _camPlace reads window, followUid, fitAllInterval, map and _camPad as the same script's globals;
// here each harness hands in its own.
const cpSrc = extractFn('_camPlace');
const buildCP = new Function('window', 'followUid', 'fitAllInterval', 'map', '_camPad', cpSrc + '\n return _camPlace;');
const LNG = -84.9, LAT = 30.44;
const DEG_PER_M = 1 / 111194.9;              // one metre of latitude, from the 6371 km sphere metersApart uses
const FT = 0.3048;
const north = (m, lat) => (lat == null ? LAT : lat) + m * DEG_PER_M;
const near = (x, y, eps) => Math.abs(x - y) <= (eps == null ? 1e-9 : eps);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (1) _animateMarker: a remote row inside the window is placed, everything else glides as before
// ═══════════════════════════════════════════════════════════════════════════════════════════
const amA = src.indexOf('function _animateMarker(marker');
const amB = src.indexOf('// Smoothly recenter the map', amA);
if (amA < 0 || amB < 0) { console.error('could not extract _animateMarker'); process.exit(1); }
const amSrc = src.slice(amA, amB);
{
  let parses = true; try { new Function(amSrc); } catch (e) { parses = false; }
  check('extraction: _animateMarker text parses on its own', parses, `${amSrc.split('\n').length} lines`);
}
const buildAM = new Function('window', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
                             'metersApart', 'map', '_updateMarkerGrouping', '_camPlace', amSrc + '\n return _animateMarker;');
function amHarness() {
  const clock = { t: 100000 };
  const rafs = [], cancels = [], tips = [], eases = [];
  const win = { _updateTrailTip: (uid, lng, lat) => { tips.push([uid, lng, lat]); } };
  const map = { easeTo: (o) => { eases.push(o); } };
  // The REAL _camPlace over this harness's window and map: nobody followed unless a test sets
  // win._camLockUid, group follow off, no sheet open.
  const camPlace = buildCP(win, null, null, map, () => null);
  const fn = buildAM(
    win,
    { visibilityState: 'hidden', body: { classList: { contains: () => false } } },   // hidden: the camera branch in step() stays out of it
    { now: () => clock.t },
    (step) => { rafs.push(step); return rafs.length; },
    (id) => { cancels.push(id); },
    metersApart, map, () => {}, camPlace);
  return { clock, rafs, cancels, tips, eases, win, fn };
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
const T0 = 1760000000000;                    // an epoch-ms fixTs, like the row carries
const atTarget = (m, lng, lat) => near(m._curLngLat[0], lng) && near(m._curLngLat[1], lat);

// 1a. Inside the window, remote: a 300 m move is placed at once -- no frame, no glide.
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() + 5000;
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0, _lastGapMs: 10000 });
  const to = north(300);
  H.fn(m, LNG, to, null, { fixTs: T0 + 10000, remote: true });
  check('snap: placed at the target instantly (one setLngLat, no frame)', m.sets.length === 1 && near(m.sets[0][1], to) && H.rafs.length === 0 && m._anim === null, `sets=${m.sets.length} rafs=${H.rafs.length}`);
  check('snap: _curLngLat is the target', atTarget(m, LNG, to));
  check('snap: _lastFixAt stamped to the clock', m._lastFixAt === H.clock.t, `_lastFixAt=${m._lastFixAt}`);
  check('snap: the camera gap is cleared (no measured interval on a placement)', !('_lastGapMs' in m), `_lastGapMs=${m._lastGapMs}`);
  check('snap: trail tip welded once to (uid, toLng, toLat)', H.tips.length === 1 && H.tips[0][0] === 'u' && H.tips[0][1] === LNG && near(H.tips[0][2], to), JSON.stringify(H.tips));
  check('snap: nobody followed -> the camera is left alone', H.eases.length === 0, `eases=${H.eases.length}`);
}
// 1b. Follow-one. _followUser always sets window._camLockUid, so the real _followRecenter stands
//     down on its lock check and never eases: the camera for a followed member rides in step(),
//     which a placement never runs. _camPlace is what moves it after a snap.
{
  const frSrc = extractFn('_followRecenter');
  const buildFR = new Function('followUid', 'userMarkers', 'window', 'map', '_camPad', '_camDur', frSrc + '\n return _followRecenter;');
  const frEases = [];
  buildFR('u', { u: { _anim: null } }, { _camLockUid: 'u' }, { easeTo: (o) => frEases.push(o) }, () => null, _camDur)(LNG, LAT);
  check('follow-one: _followRecenter stands down while _camLockUid is set (the state _followUser leaves)', frEases.length === 0, `eases=${frEases.length}`);
  const run = (win, followUid, fitAllInterval, pad) => {
    const e = [];
    buildCP(win, followUid, fitAllInterval, { easeTo: (o) => e.push(o) }, () => (pad == null ? null : pad))('u', LNG, north(500));
    return e;
  };
  const locked = run({ _camLockUid: 'u' }, null, null);
  check('follow-one: _camPlace eases 800 ms, linear, to the placed coordinate for the locked member', locked.length === 1 && locked[0].center[0] === LNG && near(locked[0].center[1], north(500)) && locked[0].duration === 800 && locked[0].easing(0.3) === 0.3 && !('padding' in locked[0]), JSON.stringify(locked[0]));
  check('follow-one: ...and for followUid when no lock is set (the same fallback step() uses)', run({}, 'u', null).length === 1);
  const padded = run({ _camLockUid: 'u' }, null, null, { top: 1, bottom: 420, left: 3, right: 4 });
  check('follow-one: an open member sheet\'s padding rides along (dot stays above the sheet)', padded.length === 1 && padded[0].padding && padded[0].padding.bottom === 420);
  check('follow-one: someone else is followed -> camera untouched', run({ _camLockUid: 'x' }, null, null).length === 0);
  check('follow-one: nobody followed -> camera untouched', run({ _camLockUid: null }, null, null).length === 0);
  check('follow-one: user is panning (_followPausedUntil ahead) -> camera untouched', run({ _camLockUid: 'u', _followPausedUntil: Date.now() + 5000 }, null, null).length === 0);
  check('follow-one: a lapsed pause no longer holds it back', run({ _camLockUid: 'u', _followPausedUntil: Date.now() - 1 }, null, null).length === 1);
  check('group follow on: _camPlace stands down (the render re-fits with one forced tick -- see 2i)', run({ _camLockUid: 'u' }, null, 7).length === 0);
  check('_camPlace: a throwing map never escapes', (() => { try { buildCP({ _camLockUid: 'u' }, null, null, { easeTo: () => { throw new Error('qa'); } }, () => null)('u', LNG, LAT); return true; } catch (e) { return false; } })());
}
// 1c. Own dot (no opts) inside the window, even while that dot is the one followed: today's
//     glide, untouched -- the frame loop carries the camera for it as before.
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() + 5000;
  H.win._camLockUid = 'u';
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  H.fn(m, LNG, north(300));
  check('own dot in the window: a frame is scheduled (normal glide), nothing placed', H.rafs.length === 1 && m._anim === 1 && m.sets.length === 0 && H.tips.length === 0);
  check('own dot in the window: _lastGapMs is the viewer gap, as before', m._lastGapMs === 60000, `_lastGapMs=${m._lastGapMs}`);
  check('own dot in the window: no easeTo (step() carries the camera for it, as before)', H.eases.length === 0);
}
// 1d. Remote, window expired: normal glide.
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() - 1;
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check('window expired: a frame is scheduled (normal glide), paced to the reporter', H.rafs.length === 1 && m._anim === 1 && m.sets.length === 0 && m._lastGapMs === 10000, `_lastGapMs=${m._lastGapMs}`);
}
// 1e. Remote, no window ever opened (_resumeSnapUntil unset): normal glide.
{
  const H = amHarness();
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check('no window: a frame is scheduled (normal glide)', H.rafs.length === 1 && m.sets.length === 0);
}
// 1f. A glide parked in _anim from before the hide is cancelled before the placement.
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() + 5000;
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0, _anim: 77 });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check('snap: the in-flight frame is cancelled first', H.cancels.length === 1 && H.cancels[0] === 77 && m._anim === null && m.sets.length === 1, `cancels=${JSON.stringify(H.cancels)}`);
}
// 1g. A merged oval inside the window: grouping still owns the position (that branch runs first).
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() + 5000;
  H.win._markerGroupMembers = { u: ['u', 'x'] };
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0, _lastGapMs: 4321 });
  const to = north(300);
  H.fn(m, LNG, to, null, { fixTs: T0 + 10000, remote: true });
  check('merged oval in the window: no setLngLat, position recorded, _lastGapMs untouched', m.sets.length === 0 && atTarget(m, LNG, to) && m._lastGapMs === 4321 && H.rafs.length === 0);
}
// 1h. After the window: the first glide measures from the snap, not from before the hide.
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() + 5000;
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  H.fn(m, LNG, north(300), null, { fixTs: T0 + 10000, remote: true });        // the snap
  m._ts = T0 + 10000;                                                          // the render loop restamps _ts after the call
  H.win._resumeSnapUntil = Date.now() - 1;                                     // window over
  H.clock.t += 10000;                                                          // next report lands 10 s later
  H.fn(m, LNG, north(600), null, { fixTs: T0 + 20000, remote: true });
  check('glide after the snap: viewer gap 10 s (from the snap), reporter 10 s -> 10 s glide', m._lastGapMs === 10000 && H.rafs.length === 1, `_lastGapMs=${m._lastGapMs}`);
}
// 1i. End to end: the snap carries the camera for the locked member, and for nobody else.
{
  const H = amHarness();
  H.win._resumeSnapUntil = Date.now() + 5000;
  H.win._camLockUid = 'u';
  const m = makeMarker(LNG, LAT, { _lastFixAt: H.clock.t - 60000, _ts: T0 });
  const to = north(300);
  H.fn(m, LNG, to, null, { fixTs: T0 + 10000, remote: true });
  check('snap, followed member: map.easeTo once, to the snapped coordinate, 800 ms', H.eases.length === 1 && H.eases[0].center[0] === LNG && near(H.eases[0].center[1], to) && H.eases[0].duration === 800 && m.sets.length === 1, JSON.stringify(H.eases[0]));
  const H2 = amHarness();
  H2.win._resumeSnapUntil = Date.now() + 5000;
  H2.win._camLockUid = 'x';
  H2.fn(makeMarker(LNG, LAT, { _lastFixAt: H2.clock.t - 60000, _ts: T0 }), LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check('snap, someone else followed: placed, no camera move', H2.eases.length === 0);
  const H3 = amHarness();
  H3.win._resumeSnapUntil = Date.now() - 1;
  H3.win._camLockUid = 'u';
  H3.fn(makeMarker(LNG, LAT, { _lastFixAt: H3.clock.t - 60000, _ts: T0 }), LNG, north(300), null, { fixTs: T0 + 10000, remote: true });
  check('window expired, followed member: no easeTo (the glide\'s frames carry the camera, as before)', H3.eases.length === 0 && H3.rafs.length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (2) The render loop: a NON-live row inside the window is placed; outside it, today's rule
// ═══════════════════════════════════════════════════════════════════════════════════════════
// The harness is the one tools/render-path.test.mjs runs the loop in: a sloppy-mode `with` over
// a Proxy resolves every free identifier the loop reaches for, a named override where the value
// matters, otherwise a no-op. One change: the Marker fake keeps its position in _pos, because
// the loop itself writes userMarkers[uid]._ll (an array) and the placement branch reads
// getLngLat() back -- a fake that stored its position in _ll would hand it the wrong shape.
const rpSrc = extractFn('_processUsersSnapInner');
{
  const endIdx = src.indexOf(rpSrc) + rpSrc.length;
  const pub = src.indexOf('window._processUsersSnap = _processUsersSnap;', endIdx);
  const between = pub > 0 ? src.slice(endIdx, pub).split('\n').map((l) => l.trim()).filter(Boolean) : null;
  check('extraction: _processUsersSnapInner ends where the file publishes it', between && between.every((l) => l.startsWith('//')), `${rpSrc.split('\n').length} lines`);
  let parses = true; try { new Function(rpSrc); } catch (e) { parses = false; }
  check('extraction: the loop text parses on its own', parses);
}
const _settleMemberRow = new Function(extractFn('_settleMemberRow') + '\n return _settleMemberRow;')();
function makeScope(extra) {
  const warns = [], llCalls = [], grouping = { calls: 0 }, animCalls = [];
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
  class Marker {
    constructor(o) { this._o = o || {}; this._pos = null; }
    setLngLat(ll) {
      const lng = ll && ll[0], lat = ll && ll[1];
      llCalls.push([lng, lat]);
      if (isNaN(lng) || isNaN(lat)) throw new Error('Invalid LngLat object: (' + lng + ', ' + lat + ')');
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
    LIVE_MS: 4 * 60 * 1000, STALE_MS: 20 * 60 * 1000, BS_REST_MAX_MS: 3 * 24 * 60 * 60 * 1000,
    HERE_MOVE_M: 40, MOVE_ON_MPH: 3, MOVE_OFF_MPH: 1.5, MOVE_STICKY_MS: 75 * 1000, MK_TAIL: 12,
    metersApart, _settleMemberRow,
    _animateMarker: (mk, lng, lat, path, opts) => { animCalls.push({ mk, lng, lat, opts }); },
    _getFriends: () => ({}),
    _assignDistinctAutoColors: () => ({}),
    _updateMarkerGrouping: () => { grouping.calls++; },
    userColor: (u) => 'color-' + u,
    escapeHtmlJs: (s) => String(s == null ? '' : s),
  }, extra || {});
  const state = Object.assign({}, overrides);
  const noops = {};
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const scope = new Proxy({}, {
    has(_, k) {
      if (typeof k !== 'string' || k === '_processUsersSnapInner') return false;
      return !(k in globalThis) || hasOwn(overrides, k);
    },
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      if (hasOwn(state, k)) return state[k];
      return noops[k] || (noops[k] = function () {});
    },
    set(_, k, v) { state[k] = v; return true; },
  });
  const fn = new Function('__s', 'with (__s) { ' + rpSrc + '\n return _processUsersSnapInner; }')(scope);
  return { fn, state, window, warns, llCalls, grouping, animCalls, listEl };
}
const render = (S, rows) => { try { S.fn({ val: () => rows }); return null; } catch (e) { return e; } };
const first = (e) => (e ? String((e && e.stack) || e).split('\n')[0] : 'clean');
const OLD = { lng: LNG, lat: LAT };
const FAR = { lng: LNG, lat: north(1300 * FT) };          // 1,300 ft north: a block away
const NUDGE = { lng: LNG, lat: north(10) };               // 10 m: GPS wobble
// Beth parked at the OLD spot a while ago (her marker is drawn there), Carl live beside her.
const liveRows = (now) => ({
  b: { name: 'Beth', lat: OLD.lat, lng: OLD.lng, ts: now - 30e3, fixTs: now - 30e3, accuracy: 30 },
  c: { name: 'Carl', lat: 30.45, lng: -84.91, ts: now, fixTs: now },
});
// Beth's row moved while the viewer was away, but its fixTs is 5 minutes old: NOT live.
const parkedMoved = (now, to) => ({
  b: { name: 'Beth', lat: to.lat, lng: to.lng, ts: now - 5 * 60e3, fixTs: now - 5 * 60e3, accuracy: 30 },
  c: { name: 'Carl', lat: 30.45, lng: -84.91, ts: now, fixTs: now },
});
const repOf = (r) => (r.fixTs || r.ts || 0) + '@' + r.lng + ',' + r.lat;

// 2a. Window open: the non-live row is placed, _lastRep consumed.
{
  const S = makeScope();
  const now = Date.now();
  const e1 = render(S, liveRows(now));
  const mk = S.state.userMarkers.b;
  check('setup: Beth drawn at the old spot, _lastRep unset by the create path', e1 === null && !!mk && near(mk.getLngLat().lat, OLD.lat) && mk._lastRep === undefined, first(e1));
  const before = S.llCalls.length;
  S.window._resumeSnapUntil = Date.now() + 8000;
  const rows = parkedMoved(now, FAR);
  const e2 = render(S, rows);
  const last = S.llCalls[S.llCalls.length - 1];
  check('window open, non-live row 1,300 ft away: nothing escapes the render', e2 === null && !S.window._rowErrN, first(e2) + ` _rowErrN=${S.window._rowErrN}`);
  check('window open, non-live row 1,300 ft away: Mapbox received the new coordinate', S.llCalls.length === before + 1 && last[0] === FAR.lng && near(last[1], FAR.lat), JSON.stringify(last));
  check('window open, non-live row 1,300 ft away: _curLngLat follows, _lastRep consumed', mk._curLngLat && near(mk._curLngLat[1], FAR.lat) && mk._lastRep === repOf(rows.b), `_lastRep=${mk._lastRep}`);
  check('window open, non-live row: the glide branch was NOT used for it', S.animCalls.every((c) => c.mk !== mk));
  check('window open: the render completed (grouping ran twice)', S.grouping.calls === 2);
  // A second identical snapshot (somebody else wrote) must not place her again.
  const e3 = render(S, rows);
  check('window open, same row again: no second placement', e3 === null && S.llCalls.length === before + 1);
}
// 2b. Window expired: today's rule -- a non-live row never moves the dot, _lastRep untouched.
{
  const S = makeScope();
  const now = Date.now();
  render(S, liveRows(now));
  const mk = S.state.userMarkers.b;
  const before = S.llCalls.length;
  S.window._resumeSnapUntil = Date.now() - 1;
  const e2 = render(S, parkedMoved(now, FAR));
  check('window expired, non-live row 1,300 ft away: not moved, _lastRep unchanged', e2 === null && S.llCalls.length === before && near(mk.getLngLat().lat, OLD.lat) && mk._lastRep === undefined, first(e2) + ` llCalls=${S.llCalls.length - before}`);
}
// 2c. No window ever opened: same.
{
  const S = makeScope();
  const now = Date.now();
  render(S, liveRows(now));
  const before = S.llCalls.length;
  const e2 = render(S, parkedMoved(now, FAR));
  check('no window, non-live row 1,300 ft away: not moved', e2 === null && S.llCalls.length === before);
}
// 2d. Window open, 10 m: under the 30 m threshold, not moved (but the row is consumed).
{
  const S = makeScope();
  const now = Date.now();
  render(S, liveRows(now));
  const mk = S.state.userMarkers.b;
  const before = S.llCalls.length;
  S.window._resumeSnapUntil = Date.now() + 8000;
  const rows = parkedMoved(now, NUDGE);
  const e2 = render(S, rows);
  check('window open, non-live row moved 10 m: not moved (30 m threshold), _lastRep consumed', e2 === null && S.llCalls.length === before && mk._lastRep === repOf(rows.b), first(e2) + ` llCalls=${S.llCalls.length - before}`);
}
// 2e. Window open, LIVE row: the glide branch (remote:true) takes it, not the placement branch.
{
  const S = makeScope();
  const now = Date.now();
  render(S, liveRows(now));
  const mk = S.state.userMarkers.b;
  const before = S.llCalls.length;
  S.window._resumeSnapUntil = Date.now() + 8000;
  const rows = { b: { name: 'Beth', lat: FAR.lat, lng: FAR.lng, ts: now, fixTs: now, accuracy: 30 }, c: liveRows(now).c };
  const e2 = render(S, rows);
  const mine = S.animCalls.filter((c) => c.mk === mk);
  check('window open, LIVE row: handed to _animateMarker with remote:true (the snap lives there)', e2 === null && mine.length === 1 && mine[0].opts && mine[0].opts.remote === true && S.llCalls.length === before, first(e2) + ` anim=${mine.length}`);
}
// 2f. Window open, the viewer's OWN non-live row moved: never placed from the feed.
{
  const S = makeScope();
  const now = Date.now();
  const rows1 = Object.assign({ me: { name: 'Me', lat: OLD.lat, lng: OLD.lng, ts: now, fixTs: now } }, liveRows(now));
  const e1 = render(S, rows1);
  const me = S.state.userMarkers.me;
  check('setup: the own marker exists', e1 === null && !!me, first(e1));
  const before = S.llCalls.length;
  S.window._resumeSnapUntil = Date.now() + 8000;
  const rows2 = Object.assign({ me: { name: 'Me', lat: FAR.lat, lng: FAR.lng, ts: now - 5 * 60e3, fixTs: now - 5 * 60e3 } }, liveRows(now));
  const e2 = render(S, rows2);
  check('window open, own non-live row 1,300 ft away: not moved, no glide call either', e2 === null && S.llCalls.length === before && S.animCalls.every((c) => c.mk !== me) && me._lastRep === undefined, first(e2));
}
// 2g. A glide parked in _anim before the hide is cancelled before the placement.
{
  const cancels = [];
  const S = makeScope({ cancelAnimationFrame: (id) => { cancels.push(id); } });
  const now = Date.now();
  render(S, liveRows(now));
  const mk = S.state.userMarkers.b;
  mk._anim = 42;
  S.window._resumeSnapUntil = Date.now() + 8000;
  const e2 = render(S, parkedMoved(now, FAR));
  check('window open, a stale frame parked in _anim: cancelled, then placed', e2 === null && cancels.length === 1 && cancels[0] === 42 && mk._anim === null && near(mk.getLngLat().lat, FAR.lat), first(e2) + ` cancels=${JSON.stringify(cancels)}`);
}
// 2h. Follow-one on Beth (the state _followUser leaves: followUid AND _camLockUid): the placement
//     carries the camera to her new spot. The REAL _camPlace, over this scope's window and map.
{
  const eases = [];
  const map = { easeTo: (o) => eases.push(o) };
  const S = makeScope({ followUid: 'b', map });
  S.window._camLockUid = 'b';
  S.state._camPlace = buildCP(S.window, 'b', null, map, () => null);
  const now = Date.now();
  render(S, liveRows(now));
  S.window._resumeSnapUntil = Date.now() + 8000;
  const e2 = render(S, parkedMoved(now, FAR));
  check('follow-one on Beth, window open, her non-live row 1,300 ft away: camera eased to the placement', e2 === null && eases.length === 1 && eases[0].center[0] === FAR.lng && near(eases[0].center[1], FAR.lat) && eases[0].duration === 800, first(e2) + ` ${JSON.stringify(eases[0])}`);
  render(S, parkedMoved(now, FAR));
  check('follow-one on Beth: the same row again moves nothing, so no second ease', eases.length === 1);
  // Following Carl instead: Beth's placement leaves the camera alone.
  const eases2 = [];
  const map2 = { easeTo: (o) => eases2.push(o) };
  const S2 = makeScope({ followUid: 'c', map: map2 });
  S2.window._camLockUid = 'c';
  S2.state._camPlace = buildCP(S2.window, 'c', null, map2, () => null);
  render(S2, liveRows(now));
  S2.window._resumeSnapUntil = Date.now() + 8000;
  const e3 = render(S2, parkedMoved(now, FAR));
  check('follow-one on Carl: Beth is placed, camera untouched', e3 === null && eases2.length === 0 && near(S2.state.userMarkers.b.getLngLat().lat, FAR.lat), first(e3));
  // Under the 30 m threshold nothing is placed, so nothing is eased either.
  const eases3 = [];
  const map3 = { easeTo: (o) => eases3.push(o) };
  const S3 = makeScope({ followUid: 'b', map: map3 });
  S3.window._camLockUid = 'b';
  S3.state._camPlace = buildCP(S3.window, 'b', null, map3, () => null);
  render(S3, liveRows(now));
  S3.window._resumeSnapUntil = Date.now() + 8000;
  render(S3, parkedMoved(now, NUDGE));
  check('follow-one on Beth, 10 m wobble: not placed, camera untouched', eases3.length === 0);
}
// 2i. Group follow on: the first render inside the window re-fits ONCE, after the dots are placed.
{
  const ticks = [];
  let S = null;
  const tick = (force) => { const m = S && S.state.userMarkers.b; ticks.push({ force, bethLat: m && m.getLngLat().lat }); return true; };
  S = makeScope({ fitAllInterval: 7, _groupFollowTick: tick });
  const now = Date.now();
  const e1 = render(S, liveRows(now));
  check('group follow on, no window: a plain render never forces a tick', e1 === null && ticks.length === 0, first(e1));
  S.window._resumeSnapUntil = Date.now() + 8000;
  const e2 = render(S, parkedMoved(now, FAR));
  check('group follow on, window open: ONE forced tick, run after Beth was placed (it sees the new spot)', e2 === null && ticks.length === 1 && ticks[0].force === true && near(ticks[0].bethLat, FAR.lat), first(e2) + ` ticks=${JSON.stringify(ticks)}`);
  check('group follow on, window open: the window is marked as framed', S.window._resumeFramedFor === S.window._resumeSnapUntil);
  const e3 = render(S, parkedMoved(now, FAR));
  check('group follow on, same window, another render: no second forced tick', e3 === null && ticks.length === 1);
  S.window._resumeSnapUntil = Date.now() + 9000;             // a later resume opens a NEW window
  const e4 = render(S, parkedMoved(now, FAR));
  check('group follow on, a new window: re-fits once again', e4 === null && ticks.length === 2);
  S.window._resumeSnapUntil = Date.now() - 1;                // and an expired one never does
  S.window._resumeFramedFor = undefined;
  const e5 = render(S, parkedMoved(now, FAR));
  check('group follow on, window expired: no forced tick', e5 === null && ticks.length === 2);
  const S6 = makeScope({ fitAllInterval: 7, _groupFollowTick: () => { throw new Error('qa: tick failed'); } });
  render(S6, liveRows(now));
  S6.window._resumeSnapUntil = Date.now() + 8000;
  const e6 = render(S6, parkedMoved(now, FAR));
  check('group follow on, the tick throws: swallowed, Beth still placed, render completed', e6 === null && near(S6.state.userMarkers.b.getLngLat().lat, FAR.lat) && S6.grouping.calls === 2, first(e6));
}
// 2j. Group follow off: the render never forces a tick, window or not.
{
  const ticks = [];
  const S = makeScope({ fitAllInterval: null, _groupFollowTick: (f) => ticks.push(f) });
  const now = Date.now();
  render(S, liveRows(now));
  S.window._resumeSnapUntil = Date.now() + 8000;
  render(S, parkedMoved(now, FAR));
  check('group follow off, window open: no forced tick', ticks.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (3) The handler: hidden > 20 s then visible opens the window; a tab flick does nothing
// ═══════════════════════════════════════════════════════════════════════════════════════════
const hdSrc = (() => {
  const anchor = src.indexOf('window._feedsResume = function');
  const a = src.indexOf("document.addEventListener('visibilitychange', function () {", anchor);
  if (anchor < 0 || a < 0) throw new Error('feed visibilitychange handler not found');
  let d = 0, end = -1;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  if (end < 0 || src.slice(end, end + 3) !== '});') throw new Error('handler braces never balanced');
  return src.slice(a, end + 3);
})();
{
  let parses = true; try { new Function(hdSrc); } catch (e) { parses = false; }
  check('extraction: the handler text parses on its own', parses, `${hdSrc.split('\n').length} lines`);
  check('extraction: it is the feed handler (pauses feeds after 45 s hidden)', /_feedsPause\(\); \}, 45000\)/.test(hdSrc) && /_feedsResume\(\)/.test(hdSrc));
}
const buildHD = new Function('document', 'window', 'Date', 'performance', 'userMarkers', 'fitAllInterval', '_groupFollowTick',
                             'clearTimeout', 'setTimeout', hdSrc);
function hdHarness(opts) {
  opts = opts || {};
  const clock = { t: 1000000 }, perf = { t: 5000 };
  const timers = [], cleared = [], ticks = [], pauses = [], resumes = [];
  let handler = null;
  const document = { hidden: false, addEventListener: (ev, fn) => { if (ev === 'visibilitychange') handler = fn; } };
  const window = { _feedsPause: () => pauses.push(1), _feedsResume: () => resumes.push(1) };
  const userMarkers = { a: { _lastFixAt: 1 }, b: { _lastFixAt: 2 }, gone: null };
  const tick = opts.tickThrows ? (f) => { ticks.push(f); throw new Error('qa: tick failed'); } : (f) => { ticks.push(f); };
  buildHD(document, window, { now: () => clock.t }, { now: () => perf.t }, userMarkers,
          'fitAllInterval' in opts ? opts.fitAllInterval : 7, opts.noTick ? undefined : tick,
          (id) => cleared.push(id), (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  if (!handler) throw new Error('the handler never registered itself');
  const hide = () => { document.hidden = true; handler(); };
  const show = (afterMs) => { clock.t += afterMs; document.hidden = false; handler(); };
  return { clock, perf, timers, cleared, ticks, pauses, resumes, window, userMarkers, document, hide, show };
}
// 3a. Hidden 30 s, then visible: the window opens, arrival clocks stamped, group follow re-framed.
{
  const H = hdHarness();
  H.hide();
  check('hidden: _glHiddenAt stamped, 45 s pause timer armed, feeds not resumed', H.window._glHiddenAt === H.clock.t && H.timers.length === 1 && H.timers[0].ms === 45000 && H.resumes.length === 0, `_glHiddenAt=${H.window._glHiddenAt}`);
  H.timers[0].fn();   // 45 s pass with the tab still hidden
  check('hidden 45 s: _feedsPause still fires', H.pauses.length === 1);
  H.perf.t = 9000;
  H.show(30000);
  check('visible after 30 s: the pending timer is cleared and _feedsResume fires', H.cleared.length === 2 && H.resumes.length === 1, `cleared=${H.cleared.length} resumes=${H.resumes.length}`);
  check('visible after 30 s: _resumeSnapUntil is now + 8 s', H.window._resumeSnapUntil === H.clock.t + 8000, `_resumeSnapUntil=${H.window._resumeSnapUntil}`);
  check('visible after 30 s: both markers\' _lastFixAt stamped to performance.now (a null slot is skipped)', H.userMarkers.a._lastFixAt === 9000 && H.userMarkers.b._lastFixAt === 9000);
  check('visible after 30 s: _groupFollowTick(true) called once', H.ticks.length === 1 && H.ticks[0] === true, JSON.stringify(H.ticks));
}
// 3b. Hidden 5 s (a tab flick): none of that.
{
  const H = hdHarness();
  H.hide();
  H.perf.t = 9000;
  H.show(5000);
  check('visible after 5 s: _feedsResume fires', H.resumes.length === 1);
  check('visible after 5 s: no window, no stamps, no forced tick', H.window._resumeSnapUntil === undefined && H.userMarkers.a._lastFixAt === 1 && H.userMarkers.b._lastFixAt === 2 && H.ticks.length === 0, `_resumeSnapUntil=${H.window._resumeSnapUntil}`);
}
// 3c. Exactly 20 s is not "more than 20 s"; 20.001 s is.
{
  const H1 = hdHarness(); H1.hide(); H1.show(20000);
  const H2 = hdHarness(); H2.hide(); H2.show(20001);
  check('threshold: 20.000 s hidden -> no window; 20.001 s -> window', H1.window._resumeSnapUntil === undefined && H2.window._resumeSnapUntil === H2.clock.t + 8000);
}
// 3d. Group follow off: no forced tick, the window still opens.
{
  const H = hdHarness({ fitAllInterval: null });
  H.hide(); H.show(60000);
  check('group follow off: window opens, no tick', H.window._resumeSnapUntil === H.clock.t + 8000 && H.ticks.length === 0);
}
// 3e. The tick throwing, or not existing, never breaks the handler.
{
  const H = hdHarness({ tickThrows: true });
  H.hide(); H.show(60000);
  check('tick throws: swallowed, window and stamps already in place', H.window._resumeSnapUntil === H.clock.t + 8000 && H.userMarkers.a._lastFixAt === 5000 && H.ticks.length === 1);
  const H2 = hdHarness({ noTick: true });
  H2.hide(); H2.show(60000);
  check('no _groupFollowTick at all: window opens, nothing thrown', H2.window._resumeSnapUntil === H2.clock.t + 8000 && H2.resumes.length === 1);
}
// 3f. Page loaded hidden (no hide event ever ran): the first show counts as a long absence.
{
  const H = hdHarness();
  H.show(0);
  check('first show with no _glHiddenAt: window opens (everyone is placed on first sight)', H.window._resumeSnapUntil === H.clock.t + 8000 && H.resumes.length === 1);
}

// ── Extra guards on the text itself -- never the only check, see above ────────────────────
check('source: the snap branch sits after the _anim cancel and before the glide reads cur', (() => {
  const cancel = amSrc.lastIndexOf('if (marker._anim) { cancelAnimationFrame(marker._anim); marker._anim = null; }');
  const snap = amSrc.indexOf('if (opts && opts.remote && Date.now() < (window._resumeSnapUntil || 0))');
  const cur = amSrc.indexOf('var cur = marker._curLngLat;');
  return cancel > 0 && snap > cancel && cur > snap;
})());
check('source: the snap carries the camera (_camPlace) inside the snap branch, before it returns', (() => {
  const snap = amSrc.indexOf('if (opts && opts.remote && Date.now() < (window._resumeSnapUntil || 0))');
  const cam = amSrc.indexOf('_camPlace(marker._uid, toLng, toLat)', snap);
  const cur = amSrc.indexOf('var cur = marker._curLngLat;', snap);
  return snap > 0 && cam > snap && cam < cur && (amSrc.match(/_camPlace\(/g) || []).length === 1;
})());
check('source: the feed placement branch is the non-live sibling of the glide gate, gated on !isMine', (() => {
  const glide = rpSrc.indexOf('if (!isMine && isLive && userMarkers[uid]._lastRep !== _rep) {');
  const place = rpSrc.indexOf("} else if (!isMine && !isLive && Date.now() < (window._resumeSnapUntil || 0) && userMarkers[uid]._lastRep !== _rep) {");
  return glide > 0 && place > glide && /metersApart\(_cl\[1\], _cl\[0\], data\.lat, data\.lng\) > 30/.test(rpSrc);
})());
check('source: the feed placement carries the camera inside the 30 m block, and only there', (() => {
  const i = rpSrc.indexOf('metersApart(_cl[1], _cl[0], data.lat, data.lng) > 30');
  const cam = rpSrc.indexOf('_camPlace(uid, data.lng, data.lat);', i);
  const close = rpSrc.indexOf('\n          }', i);
  return i > 0 && cam > i && cam < close && (rpSrc.match(/_camPlace\(/g) || []).length === 1;
})());
check('source: the post-render re-fit sits after the grouping pass, once per window, group follow only', (() => {
  const grp = rpSrc.indexOf('try { _updateMarkerGrouping(); } catch (e) {}');
  const refit = rpSrc.indexOf('window._resumeFramedFor !== window._resumeSnapUntil', grp);
  const tick = rpSrc.indexOf('_groupFollowTick(true);', refit);
  return grp > 0 && refit > grp && tick > refit && /fitAllInterval && typeof _groupFollowTick === 'function'\s*\n\s*&& Date\.now\(\) < \(window\._resumeSnapUntil \|\| 0\)/.test(rpSrc);
})());
check('source: _camPlace stands down for group follow and respects the interaction pause', /if \(typeof fitAllInterval !== 'undefined' && fitAllInterval\) return;/.test(cpSrc) && /Date\.now\(\) < \(window\._followPausedUntil \|\| 0\)\) return;/.test(cpSrc) && /window\._camLockUid \|\| \(typeof followUid !== 'undefined' \? followUid : null\)/.test(cpSrc));
check('source: the window is 8 s after more than 20 s hidden', /window\._resumeSnapUntil = Date\.now\(\) \+ 8000;/.test(hdSrc) && /Date\.now\(\) - \(window\._glHiddenAt \|\| 0\) > 20000/.test(hdSrc));
check('source: own-dot calls still pass no opts (two of them)', (src.match(/_animateMarker\(userMarkers\[userId\], lng, lat\);/g) || []).length === 2);

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
