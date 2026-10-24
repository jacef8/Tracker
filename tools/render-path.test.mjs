// Runs the REAL _processUsersSnapInner -- the per-member render loop, pulled out of
// public/index.html by its function text -- against a room that contains the row no build
// before this one survived: a member with a name and no coordinates at all. Before the hasGps
// guard and the per-row catch, that row reached mapboxgl.Marker.setLngLat([undefined,
// undefined]), the library threw, nothing caught it (_processUsersSnap is try/FINALLY), and
// every member sorted after it lost their dot update and their People row on every viewer.
//
// This is also the standing check for the 955 class: a const read before its declaration
// parses perfectly and only shows up when the loop actually runs. node --check, check-syntax
// and tdz-check all passed 955; this would not have.
//
// Usage:  node tools/render-path.test.mjs        (exit 0 = the render path survives the rows)
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(58)} ${detail || ''}`);
};

// ── Pull the shipped text out, brace walk as in tdz-check.mjs ─────────────────────────────
function extractFn(name) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error(name + ' not found in public/index.html');
  let d = 0, end = -1;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error(name + ': braces never balanced');
  return src.slice(a, end + 1);
}
const fnSrc = extractFn('_processUsersSnapInner');
// A brace inside a string would end the walk early and hand us a truncated function that
// still parses. The real end sits just above the line that publishes the function; only
// comment lines may separate the two.
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

// ── A room for it to render into ──────────────────────────────────────────────────────────
// Everything the loop reaches for is a free identifier (helpers, constants, userMarkers,
// document, mapboxgl ...). Running it inside a sloppy-mode `with` over a Proxy resolves each
// one without enumerating them: a named override where the value matters, otherwise a no-op
// function, so the shape of the code under test is never restated here.
function makeScope(extra) {
  const warns = [], llCalls = [], grouping = { calls: 0 };
  class Node {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this._html = ''; this.textContent = ''; this.className = '';
      this.classList = { add() {}, remove() {}, contains() { return false; } }; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; if (v === '') this.children.length = 0; }   // listEl is wiped this way every render
    appendChild(c) { this.children.push(c); return c; }
    querySelector() { return null; }
    addEventListener() {}
    setAttribute() {}
  }
  const listEl = new Node();
  const document = { body: new Node(), getElementById: (id) => (id === 'user-list' ? listEl : new Node()), createElement: () => new Node() };
  // Mirrors mapbox-gl's LngLat constructor: isNaN on either value throws, so does a latitude
  // outside +-90. Every call is recorded so the test can prove the guard, not just the catch.
  class Marker {
    constructor(o) { this._o = o || {}; this._ll = null; }
    setLngLat(ll) {
      const lng = ll && ll[0], lat = ll && ll[1];
      llCalls.push([lng, lat]);
      if (isNaN(lng) || isNaN(lat)) throw new Error('Invalid LngLat object: (' + lng + ', ' + lat + ')');
      if (+lat > 90 || +lat < -90) throw new Error('Invalid LngLat latitude value: must be between -90 and 90');
      this._ll = { lng: +lng, lat: +lat }; return this;
    }
    addTo() { return this; }
    getLngLat() { return this._ll; }
    getElement() { return this._o.element; }
    remove() {}
  }
  // A plain room: no roster, no hidden/private members, no owner map. The five window.* calls
  // the loop makes WITHOUT a guard get a stub; everything else stays undefined, so a new
  // unguarded window.* call shows up here as a skipped row instead of in a phone's console.
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
      if (typeof k !== 'string' || k === '_processUsersSnapInner') return false;   // the function itself resolves outside
      return !(k in globalThis) || hasOwn(overrides, k);
    },
    get(_, k) {
      if (typeof k !== 'string') return undefined;   // Symbol.unscopables
      if (hasOwn(state, k)) return state[k];
      stubbed.add(k);
      return noops[k] || (noops[k] = function () {});
    },
    set(_, k, v) { state[k] = v; return true; },   // usersInitialLoad = false lands here
  });
  const fn = new Function('__s', 'with (__s) { ' + fnSrc + '\n return _processUsersSnapInner; }')(scope);
  return { fn, state, window, warns, llCalls, grouping, listEl, stubbed };
}
const now = Date.now();
const rows3 = () => ({
  // The bad row: a name, the no-GPS flag, a fresh ts -- and no lat/lng key at all. Sorts first.
  a: { name: 'Aaron', dev: 'PC', noGps: true, noGpsTs: now - 60e3, ts: now - 10e3 },
  b: { name: 'Beth', lat: 30.44, lng: -84.9, ts: now, fixTs: now, accuracy: 30 },
  c: { name: 'Carl', lat: 30.45, lng: -84.91, ts: now, fixTs: now },
});
const snapOf = (rows) => ({ val: () => rows });
const render = (S, rows) => { try { S.fn(snapOf(rows)); return null; } catch (e) { return e; } };
const first = (e) => (e ? String((e && e.stack) || e).split('\n')[0] : 'clean');

// The fake has to behave like the library or assertion 3 below proves nothing.
{
  let threw = null;
  try { new (makeScope().state.mapboxgl.Marker)({}).setLngLat([undefined, undefined]); } catch (e) { threw = e; }
  check('harness: the Marker fake throws on [undefined, undefined] like Mapbox', /Invalid LngLat/.test(String(threw && threw.message)));
}

// 1-4, 7: the row with no coordinates, then two more snapshots over the same markers.
{
  const S = makeScope();
  const e1 = render(S, rows3());
  check('no-coords row: nothing escapes the render', e1 === null, first(e1));
  check('no-coords row: Beth and Carl got markers', !!S.state.userMarkers.b && !!S.state.userMarkers.c, Object.keys(S.state.userMarkers).join(','));
  check('no-coords row: Aaron got none', !S.state.userMarkers.a);
  check('no-coords row: Mapbox never saw a non-finite lng/lat',
        S.llCalls.length === 2 && S.llCalls.every(([lng, lat]) => Number.isFinite(+lng) && Number.isFinite(+lat)),
        JSON.stringify(S.llCalls));
  check('no-coords row: the guard handled it, not the catch', !S.window._rowErrN, `_rowErrN=${S.window._rowErrN}`);
  check('no-coords row: all three People rows built', S.listEl.children.length === 3, `${S.listEl.children.length} rows`);
  check('no-coords row: grouping pass ran (render completed)', S.grouping.calls === 1);
  const e2 = render(S, rows3()), e3 = render(S, rows3());
  check('three renders: update path and here-anchor pass clean too',
        e2 === null && e3 === null && !S.window._rowErrN && S.grouping.calls === 3 && S.listEl.children.length === 3,
        first(e2 || e3));
  console.log(`      (${S.stubbed.size} helpers resolved to no-ops: ${[...S.stubbed].sort().join(' ')})`);
}

// 5: coordinates that are present but useless -- a string, and a latitude Mapbox would reject.
{
  const S = makeScope();
  const rows = rows3();
  rows.x = { name: 'Xena', lat: 'x', lng: 'y', ts: now, fixTs: now };
  rows.z = { name: 'Zed', lat: 123.4, lng: 10, ts: now, fixTs: now };
  const e = render(S, rows);
  check('lat:"x" and lat:123.4: no throw, no marker, catch untouched',
        e === null && !S.state.userMarkers.x && !S.state.userMarkers.z && !!S.state.userMarkers.b && !S.window._rowErrN,
        first(e) + ` markers=${Object.keys(S.state.userMarkers).join(',')}`);
  check('lat:"x" and lat:123.4: both still get a People row', S.listEl.children.length === 5, `${S.listEl.children.length} rows`);
}

// 6: prove the catch on the real path. Beth throws from inside a helper the create path calls;
// Carl sorts AFTER her, which is exactly the member who used to vanish.
{
  const S = makeScope({ _updateMarkerSpeed: (el, d, live, uid) => { if (uid === 'b') throw new Error('qa: synthetic row failure'); } });
  const e1 = render(S, rows3());
  check('catch: nothing escapes', e1 === null, first(e1));
  check('catch: Beth skipped, Carl (sorted after her) still rendered', !S.state.userMarkers.b && !!S.state.userMarkers.c, Object.keys(S.state.userMarkers).join(','));
  check('catch: counted once and names the row',
        S.window._rowErrN === 1 && !!S.window._rowErr && S.window._rowErr.uid === 'b' && /synthetic/.test(S.window._rowErr.msg),
        JSON.stringify(S.window._rowErr));
  check('catch: the render finished (grouping ran)', S.grouping.calls === 1);
  check('catch: only Beth lost her People row', S.listEl.children.length === 2, `${S.listEl.children.length} rows`);
  const e2 = render(S, rows3());
  check('catch: second render counts again but warns once',
        e2 === null && S.window._rowErrN === 2 && S.warns.length === 1 && /member row skipped/.test(S.warns[0][0]) && S.warns[0][1] === 'b',
        `_rowErrN=${S.window._rowErrN} warns=${S.warns.length}`);
}

// Extra guards on the text itself -- never the only check, see above.
check('source: hasGps carries the finite + range test', /const hasGps\s*=\s*isFinite\(\+data\.lat\)[\s\S]{0,200}Math\.abs\(\+data\.lng\) <= 180/.test(fnSrc));
check('source: the per-row catch is present and does not push to the room', (() => {
  // Code only: the catch's own comment names the writers it must not call.
  const a = fnSrc.indexOf('catch (_re) {'); if (a < 0) return false;
  const b = fnSrc.indexOf('\n    });', a); if (b < 0) return false;
  const code = fnSrc.slice(a, b).replace(/\/\/.*$/gm, '');
  return /member row skipped/.test(code) && !/writeDebugLog|_evt\(|fbPush|fbSet|fbUpdate/.test(code);
})());

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
