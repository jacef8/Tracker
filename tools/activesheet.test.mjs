// Patch #10 of the map-motion plan: tapping the home ring opens an "Active now" list of the
// people it counted, instead of jumping to a crew map. Owner, 2026-10-25: "The number says who's
// active -- the natural click would be to show me those active people." The old tap picked the
// crew with the most `live` people -- foreground-fresh, not the `sharing` the ring counts -- so
// nearly every crew scored 0 and the FIRST key won: a random map, with the number's people
// nowhere on it.
//
// Round 2 (review): the ring counts distinct PEOPLE so it agrees with the list under it; the
// crew sits in its own element so a 375px phone cannot ellipsise it away; a roster that has not
// arrived is "Checking…", not "Nobody"; opening the sheet asks for a fresh roster so the ages do
// not freeze at the last load; and the LIVE-before-PARKED / newest-first sort is proven on rows
// inserted in the wrong order.
//
// Round 3 (review): a Firebase read that FAILS is no longer an empty crew. The loader used to turn
// a rejected get() into {} and write it over the last good roster, so the refresh-on-open from
// round 2 could make the sheet say "Nobody sharing right now" and the ring read 0 in a dead spot.
// Now the crew keeps what it had, the sheet names the crews it could not refresh and how old its
// picture is, an open sheet's as-of line counts up on a 30 s redraw (no read), and a first load
// that fails is "checking…" -- the ring's retries actually run -- then "could not reach".
//
// Built on tools/homering.test.mjs's harness: the SHIPPED _talkLoadDetail, _presenceOf,
// _presenceHealth, _renderHomeAnchor and the new _renderActiveSheet, _anchorGo, _activeGo,
// _closeActiveSheet and _activeStopPoll are brace-walked out of public/index.html and run
// against a two-crew roster, a tiny recording DOM (no jsdom), fake timers and a fake clock.
// Nothing here re-states the logic; the static checks at the end are an extra guard, never the
// only one.
//
// Usage:  node tools/activesheet.test.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

// Brace walk from a marker to its matching close (tdz-check style). The slice has to end on
// the function's own `}` followed by `;` or a newline -- anything else means the walk was
// fooled by a brace in a string or comment, and the text is not the whole function.
const grabFn = (marker) => {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  let d = 0, end = -1;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  const tail = src[end + 1];
  if (end < 0 || (tail !== ';' && tail !== '\n')) throw new Error('brace walk did not land on the end of ' + marker);
  return src.slice(a, end + (tail === ';' ? 2 : 1));
};
const constOf = (re) => {
  const m = src.match(re);
  if (!m) throw new Error('constant not found: ' + re);
  return Function('return (' + m[1] + ');')();
};

const loader   = grabFn('window._talkLoadDetail = async function () {');
const presence = grabFn('window._presenceHealth = function (data) {') + '\n' +
                 grabFn('window._presenceOf = function (uid, data) {');
const unread   = grabFn('function _talkUnreadFor(roomKey, clips) {');
const anchor   = grabFn('window._renderHomeAnchor = function () {');
const anchorGo = grabFn('window._anchorGo = function () {');
const sheetFn  = grabFn('window._renderActiveSheet = function () {');
const closeFn  = grabFn('window._closeActiveSheet = function () {');
const stopFn   = grabFn('window._activeStopPoll = function () {');
const goFn     = grabFn('window._activeGo = function (room, uid, name) {');
const stopTick = grabFn('window._activeStopTick = function () {');
const txAgoSrc = grabFn('function _txAgo(ts) {');
const escSrc   = grabFn('function _escHtml(s) {');
const cleanSrc = grabFn('function _cleanName(s) {');
const _escHtml   = new Function(escSrc + '\nreturn _escHtml;')();
const _cleanName = new Function(cleanSrc + '\nreturn _cleanName;')();

const C = {
  LIVE_MS:          constOf(/\bconst LIVE_MS\s*=\s*([^;]+);/),
  PARKED_MAX_MS:    constOf(/\bvar PARKED_MAX_MS\s*=\s*([^;]+);/),
  SHARING_FRESH_MS: constOf(/\bvar SHARING_FRESH_MS\s*=\s*([^;]+);/),
  FG_FRESH_MS:      constOf(/\bvar FG_FRESH_MS\s*=\s*([^;]+);/),
  TX_WINDOW_MS:     constOf(/\bvar TX_WINDOW_MS\s*=\s*([^;]+);/),
  TX_PER_CREW:      constOf(/\bvar TX_PER_CREW\s*=\s*([^;]+);/),
};

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(74)} ${detail || ''}`);
};

// A scope that answers for exactly the names the home screen has. Locals inside the shipped
// functions never reach it (they resolve first); the language's own globals fall through; any
// OTHER name is remembered so the run can say what the code depended on.
const makeScope = (vars) => {
  const missing = [];
  const proxy = new Proxy(vars, {
    has(t, k) {
      if (typeof k !== 'string') return false;
      if (k in t) return true;
      if (k in globalThis) return false;
      if (!missing.includes(k)) missing.push(k);
      return true;
    },
    get(t, k) { return k === Symbol.unscopables ? undefined : t[k]; },
  });
  return { proxy, missing };
};
const runIn = (proxy, code) => new Function('__s', 'with (__s) {\n' + code + '\n}')(proxy);

// The recording DOM: getElementById hands back one object per id with the handful of members
// the shipped code touches. #active-sheet starts display:none, as the markup does.
const makeDoc = () => {
  const els = {};
  const get = (id) => {
    if (!els[id]) {
      els[id] = { id, innerHTML: '', textContent: '', style: {}, _attrs: {},
        setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; } };
    }
    return els[id];
  };
  get('active-sheet').style.display = 'none';
  return { getElementById: get, _els: els };
};
// Fake timers: tick() runs every live interval once, count() says how many are still armed.
// Timeouts (the ring's retry loop) sit in `later` until fire() runs them; pending() counts them.
const makeTimers = () => {
  const live = new Map(), later = new Map(); let seq = 0;
  return {
    setInterval(fn) { const id = ++seq; live.set(id, fn); return id; },
    clearInterval(id) { live.delete(id); },
    setTimeout(fn) { const id = ++seq; later.set(id, fn); return id; },
    clearTimeout(id) { later.delete(id); },
    tick(n = 1) { for (let i = 0; i < n; i++) [...live.values()].forEach((fn) => fn()); },
    count() { return live.size; },
    fire() { const fns = [...later.values()]; later.clear(); fns.forEach((fn) => fn()); return fns.length; },
    pending() { return later.size; },
  };
};
// A macrotask boundary: every microtask queued so far (the loader's awaits, the ring loop's
// .then chain) has run by the time this resolves. The REAL setTimeout -- the test's own clock.
const flush = () => new Promise((r) => setTimeout(r, 0));
// An onclick attribute is HTML-decoded by the browser and THEN read as JavaScript. Do the same
// here and run it against a spy, so a quote in a name that would end the string literal fails
// this check the way it would fail the tap.
const decodeAttr = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const clicksOf = (html) => {
  const calls = [];
  for (const m of html.matchAll(/onclick="([^"]*)"/g)) {
    const code = decodeAttr(m[1]);
    const spy = { _activeGo: (...a) => calls.push(a), _closeActiveSheet() {}, _homeGo: (a) => calls.push(['_homeGo', a]) };
    try { new Function('window', code)(spy); } catch (e) { calls.push(['SYNTAX ERROR', code, e.message]); }
  }
  return calls;
};

// Every fixture age is measured from this instant, and the shipped code reads the clock through
// the fake `Date` below, so "Live · 3s ago" is exactly 3s and a 30-minute jump is exactly that.
const now = Date.now();

// The viewer is `me`; `me-tab` is my own tablet (resolved by _isMyOwnUid). `withMarkers: false`
// leaves userMarkers undeclared, which is the home screen before any map has ever been built.
// `fbDown: true` is Firebase not ready: the loader's first line returns without reading.
// `failing` is a weak signal: get() REJECTS ("Client is offline", Firebase's own wording) for
// every path (`all`) or for one crew's paths (`only`); a test flips it between taps.
const build = (rosters, circles, withMarkers = true, opts = {}) => {
  const storage = { getItem() { return null; }, setItem() {} };
  const doc = makeDoc(), timers = makeTimers(), markers = {};
  const clock = { t: now };
  const calls = { openCrew: [], follow: [], gets: 0 };
  const failing = { all: !!opts.failAll, only: null };
  const loads = [];
  const win = {
    _uiV2On: () => true,
    _isMyOwnUid: (uid) => uid === 'me' || uid === 'me-tab',
    _openCrew: (k) => calls.openCrew.push(k),
    _followUser: (uid, name) => calls.follow.push([uid, name]),
    _fb: opts.fbDown ? null : {
      db: {},
      ref: (db, path) => path,
      get: (path) => {
        calls.gets++;
        if (failing.all || (failing.only && path.indexOf('gl/' + failing.only + '/') === 0)) return Promise.reject(new Error('Client is offline'));
        return Promise.resolve({ val: () => { const m = path.match(/^gl\/([^/]+)\/users$/); return m ? (rosters[m[1]] || {}) : {}; } });
      },
    },
  };
  // The loader's tail calls _renderCrewsSection, whose FIRST line is _renderHomeAnchor() (a
  // static check below pins that). The real section renders a Crews list this harness has no
  // business faking, so the stand-in is just that first line -- the link the sheet relies on.
  win._renderCrewsSection = () => win._renderHomeAnchor();
  const vars = {
    window: win, userId: 'me', localStorage: storage, document: doc,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval, toast() {},
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    Date: { now: () => clock.t },
    _getCircles: () => circles, _escHtml, _cleanName, _prettyGroup: (k) => k,
    LIVE_MS: C.LIVE_MS, PARKED_MAX_MS: C.PARKED_MAX_MS, SHARING_FRESH_MS: C.SHARING_FRESH_MS,
    FG_FRESH_MS: C.FG_FRESH_MS, TX_WINDOW_MS: C.TX_WINDOW_MS, TX_PER_CREW: C.TX_PER_CREW,
  };
  if (withMarkers) vars.userMarkers = markers;
  vars._talkUnreadFor = new Function('userId', 'localStorage', unread + '\nreturn _talkUnreadFor;')('me', storage);
  // The shipped age wording, reading the fake clock, so "As of 12m ago" is exactly 12 minutes.
  vars._txAgo = new Function('Date', txAgoSrc + '\nreturn _txAgo;')(vars.Date);
  const { proxy, missing } = makeScope(vars);
  runIn(proxy, presence);
  runIn(proxy, loader);
  runIn(proxy, anchor);
  runIn(proxy, anchorGo);
  runIn(proxy, sheetFn);
  runIn(proxy, closeFn);
  runIn(proxy, stopFn);
  runIn(proxy, stopTick);
  runIn(proxy, goFn);
  // Keep hold of every load the shipped code starts (the ring's fill, _anchorGo's refresh) so a
  // test can wait for it to land instead of guessing at microtask order.
  const realLoad = win._talkLoadDetail;
  win._talkLoadDetail = function () { const p = realLoad.apply(this, arguments); loads.push(p); return p; };
  const settle = async () => { while (loads.length) await Promise.all(loads.splice(0)); };
  // settle() only knows loads that have already STARTED; the ring's loop starts its load one
  // microtask after _renderHomeAnchor returns, so drain() crosses a macrotask on either side.
  const drain = async () => { await flush(); await settle(); await flush(); };
  const el = (id) => doc.getElementById(id);
  return { win, doc, el, timers, markers, calls, missing, clock, settle, drain, failing,
           sheetOpen: () => el('active-sheet').style.display !== 'none',
           header: () => el('active-sheet-title').textContent,
           list: () => el('active-sheet-list').innerHTML,
           ring: () => el('ha-num').textContent };
};

const here = { lat: 30.4, lng: -84.9, spd: 0 };
// Two crews. Vanesa is LIVE in both and fresher in family_men; Lexi is PARKED in our_crew with
// a name carrying a quote and a `<`; Laura is CHECK PHONE and reports her battery under oss only
// (an older native row); a hidden row; my own two devices.
const rosters = {
  our_crew: {
    me:     { ...here, name: 'Me', fixTs: now - 5e3 },
    vanesa: { ...here, name: 'Vanesa', dev: 'iPhone', fixTs: now - 6e3, fgTs: now - 10e3, batt: 85 },
    lexi:   { ...here, name: "Lexi O'Neil <3", dev: 'iPhone "15"', fixTs: now - 17 * 60e3, hbTs: now - 61e3, batt: 70 },
    laura:  { ...here, name: 'Laura', fixTs: now - 25 * 3600e3, oss: { iosVer: '26.0', locWhenInUse: true, locAlways: false, batt: 42 } },
    hidden: { lat: 30.4, lng: -84.9, name: 'Hidden', fixTs: now - 40 * 60e3, hidden: true },
  },
  family_men: {
    vanesa:   { ...here, name: 'Vanesa', dev: 'iPhone', fixTs: now - 3e3, fgTs: now - 10e3, batt: 85, spd: 31 },
    'me-tab': { ...here, name: 'Me', fixTs: now - 5e3 },
  },
};
// One real name, one slug -- the sheet must show "Family Men", the way the ring rows do.
const circles = { our_crew: 'Our Crew', family_men: 'family_men' };

console.log(`"Active now" sheet — LIVE ${C.LIVE_MS / 60000} min, PARKED up to ${C.PARKED_MAX_MS / 3600000} h\n`);

// ── The mapper carries what a row needs ──────────────────────────────────────────────────
const T = build(rosters, circles);
await T.win._talkLoadDetail();
{
  const by = {};
  Object.keys(T.win._talkDetail).forEach((k) => (T.win._talkDetail[k].people || []).forEach((p) => { by[k + '/' + p.uid] = p; }));
  const v = by['family_men/vanesa'], l = by['our_crew/lexi'], la = by['our_crew/laura'], h = by['our_crew/hidden'];
  check('loader reached for nothing the home screen lacks', T.missing.length === 0, JSON.stringify(T.missing));
  check('every pre-existing field of p still present',
        ['uid', 'name', 'dev', 'ts', 'fgTs', 'hidden', 'noGps', 'priv', 'presence', 'sharing', 'live'].every((k) => l && k in l), l ? Object.keys(l).join(',') : 'no lexi');
  check('Vanesa (family_men): line/label/color are the classifier\'s own',
        v && v.line === 'Live · 3s ago' && v.label === 'LIVE' && v.color === '#00e676', v && `${v.line} ${v.label} ${v.color}`);
  check('Vanesa (family_men): room is the crew the row came from, batt 85, spd 31',
        v && v.room === 'family_men' && v.batt === 85 && v.spd === 31, v && `${v.room} ${v.batt} ${v.spd}`);
  check('Lexi: parked line, room our_crew, batt 70, spd 0 (a number, not dropped)',
        l && l.line === 'Parked 17m · heard 61s' && l.label === 'PARKED' && l.room === 'our_crew' && l.batt === 70 && l.spd === 0,
        l && `${l.line} ${l.room} ${l.batt} ${l.spd}`);
  check('Laura: battery under oss only -> 42 (the fallback), still CHECK PHONE', la && la.batt === 42 && la.presence === 'check', la && `${la.batt} ${la.presence}`);
  check('Hidden: no speed reported -> null; no battery -> null', h && h.spd === null && h.batt === null, h && `${h.spd} ${h.batt}`);
}

// ── The ring and the list agree ──────────────────────────────────────────────────────────
{
  T.win._renderHomeAnchor();
  check('ring counts PEOPLE: Vanesa (in both crews) + Lexi = 2, not 3', T.ring() === '2', T.ring());
  check('ring label is the plural', T.el('ha-label').textContent === 'people sharing now', T.el('ha-label').textContent);
  const rows = T.el('ha-rows').innerHTML;
  check('per-crew rows stay per crew: Our Crew 2/4, Family Men 1/1', rows.includes('>2/4<') && rows.includes('>1/1<'), rows.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  check('ring did not fetch again: both crews already answered for', T.calls.gets === 4, `gets=${T.calls.gets}`);
}

// ── The tap: a list, not a map ───────────────────────────────────────────────────────────
{
  const before = T.calls.gets;
  T.win._anchorGo();
  check('_anchorGo opens the sheet', T.sheetOpen(), `display=${JSON.stringify(T.el('active-sheet').style.display)}`);
  check('_anchorGo no longer opens a crew', T.calls.openCrew.length === 0, JSON.stringify(T.calls.openCrew));
  check('header N is the ring\'s number', T.header() === '2 people sharing now' && T.ring() === '2', `${T.header()} / ring ${T.ring()}`);
  check('_anchorGo asked for a fresh roster (users + voicelog per crew)', T.calls.gets === before + 4, `gets ${before} -> ${T.calls.gets}`);
  const html = T.list();
  const clicks = clicksOf(html);
  check('every row\'s onclick is valid JavaScript after HTML decoding', clicks.every((c) => c[0] !== 'SYNTAX ERROR'), JSON.stringify(clicks));
  check('rows: Vanesa first (live), then Lexi (parked)', clicks.length === 2 && clicks[0][1] === 'vanesa' && clicks[1][1] === 'lexi', JSON.stringify(clicks.map((c) => c[1])));
  check('Vanesa listed ONCE, under family_men where she is freshest', clicks.filter((c) => c[1] === 'vanesa').length === 1 && clicks[0][0] === 'family_men', JSON.stringify(clicks[0]));
  check('Lexi\'s row names her room and uid; the quote is dropped from the JS literal, the < survives',
        clicks[1] && clicks[1][0] === 'our_crew' && clicks[1][2] === 'Lexi ONeil <3', JSON.stringify(clicks[1]));
  check('Laura, the hidden row and my own devices are absent', !/laura|hidden|'me'|me-tab/.test(html), '');
  check('visible name keeps its apostrophe, escaped', html.includes('Lexi O&#39;Neil &lt;3') && !html.includes("O'Neil"), '');
  check('device label escaped', html.includes('iPhone &quot;15&quot;') && !html.includes('"15"'), '');
  check('no raw < leaked into the markup (the <3)', !/<\d/.test(html), '');
  check('markup is balanced: one <button> closed per row', (html.match(/<button /g) || []).length === 2 && (html.match(/<\/button>/g) || []).length === 2, '');
  check('status lines are the classifier\'s sentences, each in its own .ln',
        html.includes('<span class="ln">Live · 3s ago</span>') && html.includes('<span class="ln">Parked 17m · heard 61s</span>'), '');
  check('the crew sits in its own .cr element after the status line (nothing to ellipsise it away)',
        html.includes('<span class="ln">Live · 3s ago</span><span class="cr">Family Men</span>') &&
        html.includes('heard 61s</span><span class="cr">Our Crew</span>'), '');
  check('... and never inside the status line', !/<span class="ln">[^<]*(Our Crew|Family Men)/.test(html), '');
  check('crew names: the slug is prettified, the real name kept', html.includes('Family Men') && html.includes('Our Crew') && !html.includes('family_men<'), '');
  check('battery shown as plain percent when known', html.includes('>85%<') && html.includes('>70%<'), '');
  check('presence dot takes the classifier\'s colour', html.includes('background:#00e676') && html.includes('background:#2ec4b6'), '');
  check('rows are the ring\'s own .ha-row housing', (html.match(/class="ha-row"/g) || []).length === 2, '');
  check('every crew answered: no "still checking" note', !html.includes('as-note'), '');
}

// ── Stays current while open; left alone while closed ───────────────────────────────────
{
  const lexi = T.win._talkDetail.our_crew.people.find((p) => p.uid === 'lexi');
  lexi.sharing = false;
  T.win._renderHomeAnchor();
  check('ring re-render refreshes the open sheet (Lexi dropped -> 1 person)', T.header() === '1 person sharing now' && T.ring() === '1', `${T.header()} / ring ${T.ring()}`);
  T.win._closeActiveSheet();
  check('_closeActiveSheet hides it', !T.sheetOpen(), '');
  lexi.sharing = true;
  T.win._renderHomeAnchor();
  check('ring re-render leaves a CLOSED sheet alone', T.header() === '1 person sharing now', T.header());
  T.win._anchorGo();
  check('reopening renders fresh (2 people again)', T.header() === '2 people sharing now', T.header());
  T.win._closeActiveSheet();
}

// ── Half an hour later: the sheet does not keep saying "3s ago" ─────────────────────────
{
  await T.settle();                       // the refreshes above land (same clock, same answers)
  const before = T.calls.gets;
  T.clock.t += 30 * 60e3;
  T.win._anchorGo();
  check('30 min on, the tap first shows what it has: the frozen "Live · 3s ago"', T.list().includes('Live · 3s ago'), '');
  check('... under a line saying how old that is, and that a refresh is under way',
        T.list().startsWith('<div class="as-note as-asof">As of 30m ago · refreshing…</div><button'), T.list().slice(0, 90));
  check('... and asks for a fresh roster', T.calls.gets === before + 4, `gets ${before} -> ${T.calls.gets}`);
  await T.settle();
  const fresh = T.list();
  check('reload landed: the open sheet re-rendered itself (loader tail -> ring -> hook)', !fresh.includes('Live · 3s ago'), '');
  check('reload landed: the as-of line is gone (the list is current) and nothing says refreshing', !fresh.includes('as-note') && !fresh.includes('refreshing'), fresh.slice(0, 60));
  check('Vanesa: PARKED 30m ago under Our Crew (her moving family_men copy is SIGNAL LOST, not sharing)',
        fresh.includes('<span class="ln">Parked 30m</span><span class="cr">Our Crew</span>'), '');
  check('Lexi: 47m ago, no longer "heard" (her heartbeat is 31 min old)', fresh.includes('<span class="ln">Parked 47m</span>'), '');
  const clicks = clicksOf(fresh);
  check('Vanesa\'s tap now goes to Our Crew, the copy that is still sharing', clicks[0] && clicks[0][0] === 'our_crew' && clicks[0][1] === 'vanesa', JSON.stringify(clicks[0]));
  check('header and ring still agree (both parked)', T.header() === '2 people sharing now' && T.ring() === '2', `${T.header()} / ring ${T.ring()}`);
  T.win._closeActiveSheet();
}

// ── Before the roster has arrived: "Checking", never "Nobody" ───────────────────────────
{
  const L = build(rosters, circles);
  L.win._anchorGo();
  check('no roster yet: the header says it is checking', L.header() === 'Checking your crews…', L.header());
  check('no roster yet: no "Nobody", no person rows, no crew button', !L.list().includes('Nobody') && !L.list().includes('ha-row') && clicksOf(L.list()).length === 0, L.list());
  check('no roster yet: the sheet is open and the roster was requested', L.sheetOpen() && L.calls.gets === 4, `gets=${L.calls.gets}`);
  await L.settle();
  check('roster landed: the open sheet filled itself in', L.header() === '2 people sharing now' && (L.list().match(/class="ha-row"/g) || []).length === 2, L.header());
  check('... and the ring was drawn with the same number', L.ring() === '2', L.ring());
}

// ── The loader gave up and nothing ever came: say so, do not pick a crew by name ────────
{
  const G = build(rosters, circles, true, { fbDown: true });
  G.win._anchorGaveUp = true;
  G.win._anchorGo();
  check('gave up, nothing known: header says the crews could not be reached', G.header() === 'Could not reach your crews', G.header());
  check('gave up, nothing known: not "Nobody", not "Checking"', !G.list().includes('Nobody') && !G.header().includes('Checking'), '');
  const clicks = clicksOf(G.list());
  check('two crews with nothing to choose by: the button goes to the Crews list, not the first name',
        clicks.length === 1 && clicks[0][0] === '_homeGo' && clicks[0][1] === 'crews' && G.list().includes('>Show my crews<'), JSON.stringify(clicks));
  check('Firebase down: the refresh bailed without reading', G.calls.gets === 0, `gets=${G.calls.gets}`);
  const One = build(rosters, { our_crew: 'Our Crew' }, true, { fbDown: true });
  One.win._anchorGaveUp = true;
  One.win._anchorGo();
  const c1 = clicksOf(One.list());
  check('one crew: that crew is offered (there is nothing else it could be)', c1.length === 1 && c1[0][0] === 'our_crew' && One.list().includes('>Open Our Crew<'), JSON.stringify(c1));
}

// ── One crew answered, one did not: list what is known, name what is not ───────────────
{
  const P = build(rosters, circles);
  await P.win._talkLoadDetail();
  delete P.win._talkDetail.family_men;
  P.win._fb = null;                       // Firebase goes away, so _anchorGo's refresh cannot refill it
  P.win._anchorGo();
  const html = P.list();
  const clicks = clicksOf(html);
  check('partial: the two people from the answered crew are listed', P.header() === '2 people sharing now' && clicks.length === 2, P.header());
  check('partial: Vanesa comes from the crew that answered', clicks[0][0] === 'our_crew' && clicks[0][1] === 'vanesa', JSON.stringify(clicks[0]));
  check('partial, still trying: a note under the rows names the crew that has not answered', html.endsWith('<div class="as-note">Still checking Family Men…</div>'), html.slice(-80));
  P.win._anchorGaveUp = true;
  P.win._renderActiveSheet();
  check('partial, gave up: the note says that crew could not be reached', P.list().endsWith('<div class="as-note">Could not reach Family Men</div>'), P.list().slice(-80));
}

// ── A refresh that gets no answer is not "nobody" ──────────────────────────────────────
// Firebase's get() rejects ("Client is offline") in a dead spot. The loader used to turn that
// into {} -- the same answer as a crew with nobody in it -- and write it over the last good
// roster, so the refresh-on-open above made a tap on the ring say "Nobody sharing right now" and
// took the ring to 0 about children who were still out. Now the crew keeps what it had, and the
// sheet says how old the picture is and which crews it could not refresh.
{
  const rE = JSON.parse(JSON.stringify(rosters));   // this block edits a fix time; the shared fixture stays as it is
  const E = build(rE, circles);
  await E.win._talkLoadDetail();
  E.win._renderHomeAnchor();
  const loaded = E.clock.t;
  E.clock.t += 12 * 60e3;
  E.failing.all = true;
  const before = E.calls.gets;
  E.win._anchorGo();
  check('12 min on, the first paint says how old the list is and that it is refreshing',
        E.list().startsWith('<div class="as-note as-asof">As of 12m ago · refreshing…</div><button'), E.list().slice(0, 90));
  await E.settle();
  check('every read was attempted (users + voicelog per crew)', E.calls.gets === before + 4, `gets ${before} -> ${E.calls.gets}`);
  check('failed refresh: the header still names the two people, not "Nobody"', E.header() === '2 people sharing now', E.header());
  check('failed refresh: the ring still says 2 and "people sharing now", not 0 and "nobody in them yet"',
        E.ring() === '2' && E.el('ha-label').textContent === 'people sharing now', `${E.ring()} / ${E.el('ha-label').textContent}`);
  check('failed refresh: both rows still listed, from the last good read',
        (E.list().match(/class="ha-row"/g) || []).length === 2 && E.list().includes('Live · 3s ago'), '');
  check('failed refresh: the note names both crews and the age of what is shown',
        E.list().startsWith('<div class="as-note as-asof">Could not refresh Our Crew, Family Men · showing as of 12m ago</div><button'), E.list().slice(0, 110));
  check('... and no longer says refreshing', !E.list().includes('refreshing') && E.win._activeRefreshing === false, '');
  check('"Nobody" appears nowhere', !E.list().includes('Nobody') && !E.header().includes('Nobody'), '');
  const oc = E.win._talkDetail.our_crew;
  check('the last good roster is intact: its people and readTs kept, failedAt stamped now',
        oc && oc.people.length === 4 && oc.readTs === loaded && oc.failedAt === E.clock.t, oc && `people=${oc.people.length} readTs-now=${oc.readTs - E.clock.t} failedAt-now=${oc.failedAt - E.clock.t}`);
  check('nothing reached for a name the home screen lacks', E.missing.length === 0, JSON.stringify(E.missing));

  // One crew answers, one does not: list what is current, keep what is not, name it.
  E.failing.all = false; E.failing.only = 'family_men';
  rE.our_crew.vanesa.fixTs = E.clock.t - 5e3;   // her phone kept reporting to the crew that answers
  E.win._closeActiveSheet(); E.win._anchorGo(); await E.settle();
  const html = E.list(), clicks = clicksOf(html);
  check('one crew failed: the crew that answered is current (Vanesa live 5s under Our Crew, Lexi 29m/13m)',
        clicks.length === 2 && clicks[0][0] === 'our_crew' && clicks[0][1] === 'vanesa' &&
        html.includes('<span class="ln">Live · 5s ago</span><span class="cr">Our Crew</span>') &&
        html.includes('<span class="ln">Parked 29m · heard 13m</span>'), JSON.stringify(clicks));
  check('one crew failed: the note names only that crew', html.startsWith('<div class="as-note as-asof">Could not refresh Family Men · showing as of 12m ago</div>'), html.slice(0, 100));
  check('the crew that answered carries a new readTs and no failedAt; the one that did not keeps the old read',
        E.win._talkDetail.our_crew.readTs === E.clock.t && !E.win._talkDetail.our_crew.failedAt &&
        E.win._talkDetail.family_men.readTs === loaded && E.win._talkDetail.family_men.failedAt === E.clock.t, '');
  check('header and ring agree (2)', E.header() === '2 people sharing now' && E.ring() === '2', `${E.header()} / ${E.ring()}`);

  // Signal back: the next refresh clears the note.
  E.failing.only = null;
  E.win._closeActiveSheet(); E.win._anchorGo(); await E.settle();
  check('signal back: no note, lines current, header and ring agree',
        !E.list().includes('as-note') && !E.list().includes('Live · 3s ago') && E.header() === '2 people sharing now' && E.ring() === '2', E.list().slice(0, 80));
  check('signal back: failedAt gone from both crews', !E.win._talkDetail.our_crew.failedAt && !E.win._talkDetail.family_men.failedAt, '');
  E.win._closeActiveSheet();
}

// ── A failed refresh over a crew with nobody sharing still says it could not refresh ──────
{
  const quietE = { our_crew: { laura: rosters.our_crew.laura, me: rosters.our_crew.me } };
  const QE = build(quietE, { our_crew: 'Our Crew' });
  await QE.win._talkLoadDetail();
  QE.clock.t += 5 * 60e3;
  QE.failing.all = true;
  QE.win._anchorGo(); await QE.settle();
  check('nobody + failed refresh: header "Nobody sharing right now" (the last good read did say nobody)', QE.header() === 'Nobody sharing right now', QE.header());
  check('nobody + failed refresh: the note says the crew could not be refreshed and how old the picture is',
        QE.list().startsWith('<div class="as-note as-asof">Could not refresh Our Crew · showing as of 5m ago</div><div class="as-empty">'), QE.list().slice(0, 110));
  check('nobody + failed refresh: the one crew is still offered', QE.list().includes('>Open Our Crew<'), '');
}

// ── Nothing ever answered: the ring keeps checking, then says it could not reach them ───
// Before this round a failed FIRST read also became {} -- "answered, nobody" -- so the ring's
// retry loop stopped after one try, the label read "2 crews · nobody in them yet" and the sheet
// "Nobody sharing right now". Now no entry is written, the loop's six tries actually run, and
// the gave-up states the sheet already had become reachable.
{
  const F0 = build(rosters, circles, true, { failAll: true });
  F0.win._renderHomeAnchor();
  await F0.drain();
  check('first read failed: no entry is written for either crew', !F0.win._talkDetail.our_crew && !F0.win._talkDetail.family_men, JSON.stringify(Object.keys(F0.win._talkDetail || {})));
  check('ring label: checking, not "nobody in them yet"', F0.el('ha-label').textContent === '2 crews · checking…', F0.el('ha-label').textContent);
  check('the ring\'s loader has a retry waiting', F0.timers.pending() === 1 && !F0.win._anchorGaveUp, `pending=${F0.timers.pending()}`);
  F0.win._anchorGo();
  check('tap while checking: "Checking your crews…", not "Nobody", no as-of line (nothing to date)',
        F0.header() === 'Checking your crews…' && !F0.list().includes('Nobody') && !F0.list().includes('as-asof'), F0.header());
  await F0.settle();
  F0.win._closeActiveSheet();
  let rounds = 0;
  while (F0.timers.pending() && rounds < 10) { F0.timers.fire(); await F0.drain(); rounds++; }
  // Six loads of four reads, plus the tap's own four = 28. (_anchorTries rests at 7: the loop
  // counts the attempt it then declines -- the shipped loop's own bookkeeping, not this patch's.)
  check('the retries ran out: six tries (24 reads) plus the tap, then the loader gave up with no retry pending',
        F0.calls.gets === 28 && F0.win._anchorGaveUp === true && rounds === 5 && F0.timers.pending() === 0, `tries=${F0.win._anchorTries} gaveUp=${F0.win._anchorGaveUp} rounds=${rounds} gets=${F0.calls.gets}`);
  check('ring label after giving up: tap to open, still not "nobody"', F0.el('ha-label').textContent === '2 crews · tap to open', F0.el('ha-label').textContent);
  F0.win._anchorGo();
  check('tap after giving up: "Could not reach your crews" and "Show my crews"',
        F0.header() === 'Could not reach your crews' && F0.list().includes('>Show my crews<') && !F0.list().includes('Nobody'), F0.header());
  await F0.settle();
  F0.failing.all = false;
  F0.win._closeActiveSheet(); F0.win._anchorGo(); await F0.settle();
  check('signal back: the list fills in and the ring agrees', F0.header() === '2 people sharing now' && F0.ring() === '2' && F0.el('ha-label').textContent === 'people sharing now', `${F0.header()} / ${F0.ring()}`);
  check('nothing reached for a name the home screen lacks', F0.missing.length === 0, JSON.stringify(F0.missing));
  F0.win._closeActiveSheet();
}

// ── Left open: the as-of line counts up on a redraw, with no read ───────────────────────
{
  const K = build(rosters, circles);
  await K.win._talkLoadDetail();
  K.win._anchorGo(); await K.settle();
  check('fresh list: no as-of line', !K.list().includes('as-note'), '');
  check('an open sheet arms exactly one redraw timer', K.timers.count() === 1 && K.win._activeTick != null, `timers=${K.timers.count()}`);
  const before = K.calls.gets;
  K.clock.t += 2 * 60e3;
  K.timers.tick();
  check('two minutes on, the redraw says how old the list is -- and read nothing',
        K.list().startsWith('<div class="as-note as-asof">As of 2m ago</div><button') && K.calls.gets === before, `${K.list().slice(0, 60)} gets ${before} -> ${K.calls.gets}`);
  check('... without "refreshing" (no load in flight)', !K.list().includes('refreshing'), '');
  K.el('active-sheet').style.display = 'none';   // hidden by other means (the Back handler's hide fallback)
  K.timers.tick();
  check('hidden by other means: the redraw stops itself', K.timers.count() === 0 && K.win._activeTick === null, `timers=${K.timers.count()}`);
  K.win._anchorGo(); await K.settle();
  check('reopened: current again (no as-of line), one timer re-armed', !K.list().includes('as-note') && K.timers.count() === 1, K.list().slice(0, 60));
  K.win._closeActiveSheet();
  check('_closeActiveSheet stops the redraw', K.timers.count() === 0 && K.win._activeTick === null, `timers=${K.timers.count()}`);
}

// ── _activeGo: open the crew, follow once the marker exists ──────────────────────────────
{
  const R = build(rosters, circles);
  await R.win._talkLoadDetail();
  R.win._anchorGo();
  R.win._activeGo('family_men', 'vanesa', 'Vanesa');
  check('_activeGo closes the sheet', !R.sheetOpen(), '');
  check('_activeGo opens the crew named by the row', R.calls.openCrew.length === 1 && R.calls.openCrew[0] === 'family_men', JSON.stringify(R.calls.openCrew));
  check('one poll armed, no follow yet (no marker)', R.timers.count() === 1 && R.calls.follow.length === 0, `polls=${R.timers.count()} follow=${R.calls.follow.length}`);
  R.timers.tick(2);
  check('two polls later, still waiting', R.calls.follow.length === 0 && R.timers.count() === 1, '');
  R.markers.vanesa = { getLngLat() { return { lng: 0, lat: 0 }; } };
  R.timers.tick();
  check('marker appears -> _followUser(uid, name) exactly once', R.calls.follow.length === 1 && R.calls.follow[0][0] === 'vanesa' && R.calls.follow[0][1] === 'Vanesa', JSON.stringify(R.calls.follow));
  check('... and the poll is released', R.timers.count() === 0 && R.win._activePoll === null, `polls=${R.timers.count()}`);
  R.timers.tick(5);
  check('later ticks do nothing (interval really cleared)', R.calls.follow.length === 1, '');

  // Marker never appears: bounded at 20 polls, silent.
  R.win._activeGo('our_crew', 'lexi', 'Lexi');
  R.timers.tick(19);
  check('19 polls without a marker: still waiting', R.timers.count() === 1 && R.calls.follow.length === 1, `polls=${R.timers.count()}`);
  R.timers.tick(1);
  check('20th poll: gives up, no follow, no throw', R.timers.count() === 0 && R.calls.follow.length === 1 && R.win._activePoll === null, `polls=${R.timers.count()}`);
  R.markers.lexi = {};
  R.timers.tick(3);
  check('a marker arriving after the give-up is ignored', R.calls.follow.length === 1, '');

  // A second tap cancels the first tap's poll.
  delete R.markers.lexi; delete R.markers.vanesa;
  R.win._activeGo('our_crew', 'lexi', 'Lexi');
  R.win._activeGo('family_men', 'vanesa', 'Vanesa');
  check('second tap: exactly one poll alive', R.timers.count() === 1, `polls=${R.timers.count()}`);
  R.markers.lexi = {};
  R.timers.tick();
  check('the cancelled poll\'s marker does not trigger a follow', R.calls.follow.length === 1, JSON.stringify(R.calls.follow));
  R.markers.vanesa = {};
  R.timers.tick();
  check('the live poll\'s marker does', R.calls.follow.length === 2 && R.calls.follow[1][0] === 'vanesa', JSON.stringify(R.calls.follow));

  // Closing the sheet cancels a waiting poll.
  delete R.markers.vanesa;
  R.win._activeGo('family_men', 'vanesa', 'Vanesa');
  check('poll armed', R.timers.count() === 1, '');
  R.win._closeActiveSheet();
  check('_closeActiveSheet releases the poll', R.timers.count() === 0 && R.win._activePoll === null, `polls=${R.timers.count()}`);

  // The empty-state button: a crew with no person to follow.
  R.calls.openCrew.length = 0;
  R.win._activeGo('our_crew');
  check('_activeGo(room) alone opens the crew and arms no poll', R.calls.openCrew[0] === 'our_crew' && R.timers.count() === 0, `polls=${R.timers.count()}`);
  check('_activeGo() with no room does nothing', (R.win._activeGo(), R.calls.openCrew.length === 1), '');
  check('nothing reached for a name the home screen lacks', R.missing.length === 0, JSON.stringify(R.missing));
}
// No map has ever been built: userMarkers is not declared at all. The typeof guard must hold.
{
  const N = build(rosters, circles, false);
  await N.win._talkLoadDetail();
  let threw = false;
  try { N.win._activeGo('our_crew', 'lexi', 'Lexi'); N.timers.tick(25); } catch (e) { threw = true; }
  check('userMarkers undeclared: the poll runs out quietly, nothing thrown', !threw && N.calls.follow.length === 0 && N.timers.count() === 0, `threw=${threw}`);
  check('... and userMarkers was the only name it reached for', N.missing.length === 1 && N.missing[0] === 'userMarkers', JSON.stringify(N.missing));
}

// ── Nobody sharing: the sheet still opens, and keeps the old jump as one button ──────────
{
  const quiet = {
    our_crew:   { laura: rosters.our_crew.laura, hidden: rosters.our_crew.hidden, me: rosters.our_crew.me },
    family_men: { old: { ...here, name: 'Old', fixTs: now - 3 * 86400e3 }, 'me-tab': rosters.family_men['me-tab'] },
  };
  const Q = build(quiet, circles);
  await Q.win._talkLoadDetail();
  Q.win._anchorGo();
  check('zero sharing: header says so', Q.header() === 'Nobody sharing right now', Q.header());
  check('zero sharing: the sheet is still showing (no redirect)', Q.sheetOpen() && Q.calls.openCrew.length === 0, '');
  const html = Q.list();
  check('zero sharing: no person rows, one empty-state line', !html.includes('class="ha-row"') && html.includes('class="as-empty"'), '');
  const clicks = clicksOf(html);
  check('zero sharing: one button opens the crew heard from most recently (Our Crew, 40 min, over family_men, 3 d)',
        clicks.length === 1 && clicks[0][0] === 'our_crew' && clicks[0].length === 1 && html.includes('>Open Our Crew<'), JSON.stringify(clicks));
}
{
  const Z = build({}, {});
  await Z.win._talkLoadDetail();
  Z.win._anchorGo();
  check('no crews at all: header, sheet open, and the button shows the crews area', Z.header() === 'Nobody sharing right now' && Z.sheetOpen() && clicksOf(Z.list()).some((c) => c[0] === '_homeGo' && c[1] === 'crews'), JSON.stringify(clicksOf(Z.list())));
}

// ── The sheet's order: LIVE before PARKED, then newest first -- on rows inserted wrong ───
// The loader pre-sorts each crew and the two-crew fixture above happens to arrive in the right
// order, so that case could never fail on the sort alone. These rows are injected directly, in
// the order parked 500, live 1000, parked 9000, live 2000: only the sort produces the answer,
// and a parked row NEWER than every live row proves live-first is a rule of its own.
{
  const two = { c1: 'Crew One', c2: 'Crew Two' };
  const S = build({}, two);
  S.win._talkDetail = {
    c1: { people: [
      { uid: 'p1', name: 'P1', sharing: true, presence: 'parked', ts: 500,  room: 'c1', line: 'Parked <b>x</b>', color: '#2ec4b6' },
      { uid: 'l1', name: 'L1', sharing: true, presence: 'live',   ts: 1000, room: 'c1', line: 'Live · 1s ago',   color: '#00e676' },
    ] },
    c2: { people: [
      { uid: 'p2', name: 'P2', sharing: true, presence: 'parked', ts: 9000, room: 'c2', line: 'Parked', color: '#2ec4b6' },
      { uid: 'l2', name: 'L2', sharing: true, presence: 'live',   ts: 2000, room: 'c2', line: 'Live',   color: '#00e676' },
      { uid: 'n0', name: 'N0', sharing: false, presence: 'check', ts: 99999, room: 'c2', line: 'Quiet for 3h' },
    ] },
  };
  S.win._renderActiveSheet();
  const html = S.list();
  const order = clicksOf(html).map((c) => c[1]);
  check('inserted parked 500, live 1000, parked 9000, live 2000 -> live 2000, live 1000, parked 9000, parked 500', order.join(',') === 'l2,l1,p2,p1', order.join(','));
  check('live-first is its own rule: parked 9000 is newer than both live rows and still sits below them', order.indexOf('p2') > order.indexOf('l1'), '');
  check('newest first within a band: live 2000 above live 1000, parked 9000 above parked 500', order.indexOf('l2') < order.indexOf('l1') && order.indexOf('p2') < order.indexOf('p1'), '');
  check('the non-sharing row is absent however fresh its ts', !order.includes('n0') && !html.includes('Quiet for'), '');
  check('a status line is text, never markup (escaped)', html.includes('<span class="ln">Parked &lt;b&gt;x&lt;/b&gt;</span>') && !html.includes('<b>x</b>'), '');
  check('a row with no device label has no <small>', !html.includes('<small>'), '');
}

// ── The rows under the ring: a stable order ──────────────────────────────────────────────
{
  const four = { zeta: 'Zeta', alpha: 'Alpha', mid: 'Mid', big: 'Big' };
  const F = build({}, four);
  F.win._talkDetail = {
    zeta:  { people: [{ uid: 'a', name: 'A', sharing: true, ts: 500 }] },
    alpha: { people: [{ uid: 'b', name: 'B', sharing: true, ts: 500 }] },
    mid:   { people: [{ uid: 'c', name: 'C', sharing: true, ts: 900 }, { uid: 'c2', name: 'C2', sharing: false, ts: 5000 }] },
    big:   { people: [{ uid: 'd', name: 'D', sharing: true, ts: 1 }, { uid: 'e', name: 'E', sharing: true, ts: 2 }] },
  };
  F.win._renderHomeAnchor();
  const order = [...F.el('ha-rows').innerHTML.matchAll(/_openCrew\('([^']+)'\)/g)].map((m) => m[1]);
  check('most sharing first, then the fresher of a tie, then a tie by name', order.join(',') === 'big,mid,alpha,zeta', order.join(','));
  check('the crew\'s freshest person decides the tie, sharing or not (mid carries ts 5000)', order[1] === 'mid', '');
  check('ring counts the five distinct sharing people (c2 is not sharing)', F.ring() === '5', F.ring());
  F.win._renderHomeAnchor();
  const again = [...F.el('ha-rows').innerHTML.matchAll(/_openCrew\('([^']+)'\)/g)].map((m) => m[1]);
  check('same order on the next render', again.join(',') === order.join(','), again.join(','));
}

// ── Static guards (extra, never the only check) ─────────────────────────────────────────
check('_anchorGo renders the sheet and does not open a crew', anchorGo.includes('_renderActiveSheet') && !anchorGo.includes('_openCrew'), '');
check('_anchorGo asks for a fresh roster after opening', /sheet\.style\.display = '';[\s\S]*window\._talkLoadDetail && window\._talkLoadDetail\(\)/.test(anchorGo), '');
check('the loader\'s tail reaches the ring: _renderCrewsSection starts with _renderHomeAnchor()', /window\._renderCrewsSection = function \(\) \{\n  try \{ window\._renderHomeAnchor\(\); \} catch \(e\) \{\}/.test(src), '');
check('the ring counts distinct uids, not rows', anchor.includes('live = Object.keys(seenOn).length; total = Object.keys(seenAll).length;'), '');
check('the ring rows\' sort carries the tiebreak', anchor.includes('(b.on - a.on) || (b.ts - a.ts) ||'), '');
check('the sheet re-render hook sits inside _renderHomeAnchor', anchor.includes("getElementById('active-sheet')") && anchor.includes('_renderActiveSheet'), '');
check('no row value is concatenated raw (everything via _escHtml or lit)', !/\+\s*(p\.\w+|crew|batt|best\.\w+)\s*\+/.test(sheetFn), '');
check('lit() is _escHtml over a quote-stripped literal', /var lit = function \(s\) \{ return _escHtml\(String\(s == null \? '' : s\)\.replace\(/.test(sheetFn), '');
check('onclick arguments all go through lit()', /onclick="window\._activeGo\(\\'' \+ lit\(p\.room\) \+ '\\',\\'' \+ lit\(p\.uid\) \+ '\\',\\'' \+ lit\(p\.name\) \+ '\\'\)"/.test(sheetFn), '');
check('the sheet tells an unanswered crew from an empty one', sheetFn.includes("filter(function (k) { return !detail[k]; })") && sheetFn.includes('window._anchorGaveUp'), '');
check('mapper carries line/label/color/room/batt/spd', ['p.line  =', 'p.label =', 'p.color =', 'p.room  = k;', 'p.batt  =', 'p.spd   ='].every((s) => loader.includes(s)), '');
check('the ring button says what it does now', src.includes('id="home-anchor-btn" onclick="window._anchorGo && window._anchorGo()" aria-label="Show who is sharing now"'), '');
check('the sheet markup exists, hidden by default, with its own close control', /<div id="active-sheet" style="display:none" role="dialog"[^>]*>/.test(src) && src.includes('class="as-x" onclick="window._closeActiveSheet && window._closeActiveSheet()" aria-label="Close"'), '');
check('hardware Back closes it through the overlay walk', src.includes("'active-sheet': function () { if (window._closeActiveSheet) window._closeActiveSheet(); else hide('active-sheet'); }") && /var IDS = \[[^\]]*'active-sheet'/.test(src), '');
check('the sheet never blurs or sees through: no backdrop-filter on #active-sheet rules', !/#active-sheet[^{]*\{[^}]*backdrop-filter/.test(src), '');
{
  const m = src.match(/body\.ui-v2 #active-sheet \.ha-row \.ln,\n\s*body\.ui-v2 #active-sheet \.ha-row \.cr \{([^}]*)\}/);
  check('rows are 56px tap targets', src.includes('body.ui-v2 #active-sheet .ha-row { min-height: 56px;'), '');
  check('.ln and .cr are 16px body text and WRAP: no nowrap, no ellipsis to eat the crew', !!m && m[1].includes('font-size: 16px') && !/nowrap|ellipsis/.test(m[1]), m ? m[1].trim() : 'rule not found');
  check('the "still checking" note has its own 16px rule', /body\.ui-v2 #active-sheet \.as-note \{[^}]*font-size: 16px/.test(src), '');
}
check('the users read\'s failure is null, not an empty crew',
      loader.includes("'/users')).then(function (s) { return s.val() || {}; }).catch(function () { return null; }),"), '');
check('a null answer stamps failedAt on the kept entry and returns before anything is written',
      /if \(users === null\) \{[\s\S]*?var prev = window\._talkDetail\[k\];\n\s*if \(prev\) prev\.failedAt = Date\.now\(\);\n\s*return;\n\s*\}/.test(loader), '');
check('the voicelog read still falls back to {} (not this round\'s business)',
      loader.includes("'/voicelog')).then(function (s) { return s.val() || {}; }).catch(function () { return {}; })"), '');
check('each crew entry carries readTs', loader.includes('clips: recent, readTs: now };'), '');
check('the sheet reads readTs, failedAt and the refreshing flag', sheetFn.includes('d.readTs') && sheetFn.includes('d.failedAt') && sheetFn.includes('window._activeRefreshing') && sheetFn.includes('_txAgo('), '');
check('_anchorGo raises the refreshing flag before the first paint and clears it however the load ends',
      /window\._activeRefreshing = true;\n\s*if \(window\._renderActiveSheet\) window\._renderActiveSheet\(\);/.test(anchorGo) &&
      anchorGo.includes('window._activeRefreshing = false;') && anchorGo.includes('p.then(settled, settled); else settled();'), '');
check('_anchorGo arms a 30 s redraw; _closeActiveSheet stops it', anchorGo.includes('window._activeTick = setInterval(') && anchorGo.includes('}, 30000);') && closeFn.includes('window._activeStopTick();'), '');
check('the as-of line has its own rule, above the rows', src.includes('body.ui-v2 #active-sheet .as-note.as-asof {'), '');
check('no new whole-row write: the patch calls neither fbSet nor _fb.set nor update', !/fbSet|_fb\.set|\.update\(/.test(sheetFn + anchorGo + goFn + closeFn + stopFn + stopTick), '');

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
