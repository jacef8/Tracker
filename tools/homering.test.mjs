// The home ring's "N sharing now" and the Our Crew People list used to answer the same
// question with two different rules: the ring counted positions newer than SHARING_FRESH_MS
// (15 min), the list classified with _presenceOf, whose PARKED covers a phone that is heard
// from but has an older fix. Owner's screenshot 2026-10-24: ring "1 PERSON SHARING NOW" while
// the list showed Vanesa LIVE, Lexi PARKED (last fix 17 min), Laura CHECK PHONE.
//
// This pulls the REAL _talkLoadDetail, _presenceOf, _presenceHealth and _talkUnreadFor out of
// index.html and runs them against that exact roster, so what is under test is the shipped
// text, not a restatement of it. The loader runs under a scope that holds ONLY what the home
// screen has (no map, no userMarkers, no roster): any other free identifier it reaches for is
// recorded and fails the run, which is the check that _presenceOf is safe to call off-map.
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
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(62)} ${detail || ''}`);
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

// One Crew, the viewer is `me`; `me-tab` is my own tablet (resolved by _isMyOwnUid).
const build = (users) => {
  const storage = { getItem() { return null; }, setItem() {} };
  const win = {
    _isMyOwnUid: (uid) => uid === 'me' || uid === 'me-tab',
    _fb: {
      db: {},
      ref: (db, path) => path,
      get: (path) => Promise.resolve({ val: () => (/\/users$/.test(path) ? users : {}) }),
    },
  };
  const vars = {
    window: win, userId: 'me', localStorage: storage,
    _getCircles: () => ({ ourcrew: 'Our Crew' }),
    LIVE_MS: C.LIVE_MS, PARKED_MAX_MS: C.PARKED_MAX_MS, SHARING_FRESH_MS: C.SHARING_FRESH_MS,
    FG_FRESH_MS: C.FG_FRESH_MS, TX_WINDOW_MS: C.TX_WINDOW_MS, TX_PER_CREW: C.TX_PER_CREW,
  };
  // _talkUnreadFor is a plain declaration; hand it its two free names directly.
  vars._talkUnreadFor = new Function('userId', 'localStorage', unread + '\nreturn _talkUnreadFor;')('me', storage);
  const { proxy, missing } = makeScope(vars);
  runIn(proxy, presence);   // defines win._presenceHealth / win._presenceOf
  runIn(proxy, loader);     // defines win._talkLoadDetail
  return { win, missing };
};
const load = async (users, withPresence) => {
  const { win, missing } = build(users);
  if (!withPresence) delete win._presenceOf;
  await win._talkLoadDetail();
  const people = ((win._talkDetail || {}).ourcrew || {}).people;
  if (!people) throw new Error('loader produced no people -- free names it reached for: ' + JSON.stringify(missing));
  const by = {}; people.forEach((p) => { by[p.uid] = p; });
  return { people, by, missing, sharing: people.filter((p) => p.sharing).length };
};

const now = Date.now();
const here = { lat: 30.4, lng: -84.9, spd: 0 };
// The roster from the screenshot, plus the rows the rule must ignore.
const roster = {
  'me':     { ...here, name: 'Me',     fixTs: now - 5e3 },
  'me-tab': { ...here, name: 'Me',     fixTs: now - 5e3 },
  vanesa:   { ...here, name: 'Vanesa', fixTs: now - 3e3, fgTs: now - 10e3 },
  lexi:     { ...here, name: 'Lexi',   fixTs: now - 17 * 60e3, hbTs: now - 60e3, batt: 70 },
  laura:    { ...here, name: 'Laura',  fixTs: now - 25 * 3600e3, oss: { iosVer: '26.0', locWhenInUse: true, locAlways: false } },
  hidden:   { ...here, name: 'Hidden', fixTs: now - 40 * 60e3, hidden: true },
  nogps:    { lat: 0, lng: 0, name: 'NoGps', ts: now - 40 * 60e3, noGps: true },
};

console.log(`home ring vs People list — LIVE ${C.LIVE_MS / 60000} min, PARKED up to ${C.PARKED_MAX_MS / 3600000} h, old rule ${C.SHARING_FRESH_MS / 60000} min\n`);

// ── The shipped rule ─────────────────────────────────────────────────────────────────────
{
  const r = await load(roster, true);
  check('loader reached for nothing the home screen lacks', r.missing.length === 0, JSON.stringify(r.missing));
  check('sharing count is 2 (Vanesa LIVE + Lexi PARKED), as the People list says', r.sharing === 2, `got ${r.sharing}`);
  check('own device excluded', !r.by.me, '');
  check('own tablet excluded through _isMyOwnUid', !r.by['me-tab'], '');
  check('Vanesa: presence live, sharing', r.by.vanesa && r.by.vanesa.presence === 'live' && r.by.vanesa.sharing === true, `presence=${r.by.vanesa && r.by.vanesa.presence}`);
  check('Lexi: 17 min fix, heard 1 min ago -> parked, SHARING', r.by.lexi && r.by.lexi.presence === 'parked' && r.by.lexi.sharing === true, `presence=${r.by.lexi && r.by.lexi.presence}`);
  check('Laura: 25 h, While Using only -> check, not sharing', r.by.laura && r.by.laura.presence === 'check' && r.by.laura.sharing === false, `presence=${r.by.laura && r.by.laura.presence}`);
  check('hidden row -> off, not sharing', r.by.hidden && r.by.hidden.presence === 'off' && r.by.hidden.sharing === false, `presence=${r.by.hidden && r.by.hidden.presence}`);
  check('noGps row -> nogps, not sharing', r.by.nogps && r.by.nogps.presence === 'nogps' && r.by.nogps.sharing === false, `presence=${r.by.nogps && r.by.nogps.presence}`);
  check('p.live (voice reach) untouched: Vanesa yes, Lexi no', r.by.vanesa.live === true && r.by.lexi.live === false, '');
  check('every existing field of p still present', ['uid', 'name', 'dev', 'ts', 'fgTs', 'hidden', 'noGps', 'priv'].every((k) => k in r.by.lexi), Object.keys(r.by.lexi).join(','));
}
// ── The fallback, and proof the test can tell the two apart ─────────────────────────────
{
  const r = await load(roster, false);
  check('without _presenceOf the old 15-min rule counts 1 (Lexi dropped)', r.sharing === 1, `got ${r.sharing}`);
  check('fallback rows carry an empty presence key', r.people.every((p) => p.presence === ''), '');
}
// A No-GPS heartbeat is fresh by age but is not a position. The list says NO GPS; the ring
// must not count it either -- and the old rule did.
{
  const two = { vanesa: roster.vanesa, nogpsFresh: { lat: 0, lng: 0, name: 'Beacon', ts: now - 60e3, noGps: true } };
  const a = await load(two, true), b = await load(two, false);
  check('fresh No-GPS heartbeat: shipped rule 1, old rule 2', a.sharing === 1 && b.sharing === 2, `shipped=${a.sharing} old=${b.sharing}`);
}
// ── Static guards (extra, never the only check) ─────────────────────────────────────────
check('mapper decides sharing by _presenceOf LIVE/PARKED', loader.includes("_pr.key === 'live' || _pr.key === 'parked'"), '');
check('mapper keeps the 15-min rule only as the fallback', /_pr \? \([^)]*\) : \(\(now - \(p\.ts \|\| 0\)\) < SHARING_FRESH_MS\)/.test(loader), '');
check('the ring still counts .sharing (same number as the room-meta label)', /\.sharing\b/.test(anchor) && src.includes("return p.sharing; }).length") && src.includes("' sharing now'"), '');
check('.sharing has exactly one writer, inside the loader', (src.match(/\.sharing\s*=/g) || []).length === 1 && /\.sharing\s*=/.test(loader), '');

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
