// Exercises the SHIPPED battery-saver rest heartbeat by pulling the setInterval callback out of
// public/index.html and running it against fakes, so the thing under test is the live source
// and not a copy of it. Same for toggleLocationShare.
//
// The beat used to fbSet the WHOLE row from window._lastGPS with accuracy 0 and no fixTs every
// 4 minutes while idle. Two things the family saw: a parked phone with the app in front wore a
// green LIVE ring and its dot glided a few hundred feet every beat at "+/-0 ft"; and after a
// sleep/wake the overdue timer fired BEFORE any fix, republishing the PRE-SLEEP position over
// the native-PATCHed real one -- the 17-mile teleport that corrected itself seconds later. The
// beat is now a liveness-only merge (ts, rest, batt/chg); position keys are never touched. Two
// places that used to lean on the beat to heal a row (unhide, room entry) now open the fix
// gates themselves, and that is checked here too.
//
// Usage:  node tools/restbeat.test.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(62)} ${detail || ''}`);
};

// ── the heartbeat callback, extracted by markers ─────────────────────────────────────────────
const HB_OPEN = 'window._noGpsHeartbeat = setInterval(';
const a = src.indexOf(HB_OPEN + 'function() {');
const b = src.indexOf('}, 30000);', a);
if (a < 0 || b < 0) { console.error('could not extract the heartbeat callback'); process.exit(1); }
const hbSrc = src.slice(a + HB_OPEN.length, b + 1);
check('heartbeat callback extracted as a function expression',
      hbSrc.startsWith('function() {') && hbSrc.endsWith('}'), `${hbSrc.length} chars`);
const makeBeat = new Function('window', 'db', 'groupName', 'userId', 'userName', '_roomWritable',
  'locationHidden', 'fbSet', 'fbRef', '_deviceLabel', 'BS_HEARTBEAT_MS', 'return (' + hbSrc + ');');

const ROW = 'gl/qa/users/u1';
const BS_HEARTBEAT_MS = 4 * 60 * 1000;

// One tick of the callback against a fresh window. Returns everything that reached Firebase.
function beat(winOverrides, opts = {}) {
  const sets = [], updates = [];
  const win = {
    _fb: { update(path, val) { updates.push({ path, val }); return { catch() {} }; } },
    _writeRoomIndex() {},
    ...winOverrides,
  };
  if (opts.noUpdate) win._fb = {};   // an _fb without update(): the fallback path
  const tick = makeBeat(win, 'db', 'qa', 'u1', 'Jace', () => true, !!opts.hidden,
    (path, val) => sets.push({ path, val }), (db, path) => path, () => 'Phone', BS_HEARTBEAT_MS);
  tick();
  return { sets, updates, win };
}
const onRow = (list) => list.filter((w) => w.path === ROW || w.path.startsWith(ROW + '/'));

// The pre-sleep state at wake time: idle, an old _lastGPS, the beat overdue.
const idle = { _batterySaver: true, _bsIdle: true, _lastGPS: { lat: 30.44, lng: -84.9 }, _bsRestBeat: 0 };

// (1) the wake-time beat: liveness only, with the battery reading
{
  const r = beat({ ...idle, _battPct: 61, _battChg: false });
  const u = r.updates[0];
  check('idle beat: exactly one merge, on the row itself',
        r.updates.length === 1 && u.path === ROW, `updates=${r.updates.length} path=${u && u.path}`);
  const keys = u ? Object.keys(u.val).join(',') : '(none)';
  check('idle beat: keys are exactly ts,rest,batt,chg', keys === 'ts,rest,batt,chg', keys);
  check('idle beat: rest === true, batt 61, chg 0',
        !!u && u.val.rest === true && u.val.batt === 61 && u.val.chg === 0 && typeof u.val.ts === 'number',
        JSON.stringify(u && u.val));
  check('idle beat: no position key goes out (the 17-mile replay)',
        !!u && !('lat' in u.val) && !('lng' in u.val) && !('fixTs' in u.val) && !('accuracy' in u.val) && !('name' in u.val),
        'lat/lng/fixTs/accuracy/name all absent');
  check('idle beat: no fbSet on the row or any child of it',
        onRow(r.sets).length === 0, `row fbSets=${onRow(r.sets).length}`);
  check('idle beat: _bsRestBeat stamped so the next tick is rate-limited',
        r.win._bsRestBeat > 0 && Date.now() - r.win._bsRestBeat < 5000, String(r.win._bsRestBeat));
}
// (2) no battery reading on this platform (iOS: batt lives in oss, native-owned)
{
  const r = beat({ ...idle });
  const u = r.updates[0];
  const keys = u ? Object.keys(u.val).join(',') : '(none)';
  check('idle beat without _battPct: keys are exactly ts,rest', r.updates.length === 1 && keys === 'ts,rest', keys);
}
// (3) an _fb without update(): child writes, still never the row
{
  const r = beat({ ...idle, _battPct: 61 }, { noUpdate: true });
  const ts = r.sets.find((s) => s.path === ROW + '/ts');
  const rest = r.sets.find((s) => s.path === ROW + '/rest');
  check('fallback: /ts (number) and /rest (true) child writes',
        !!ts && typeof ts.val === 'number' && !!rest && rest.val === true && onRow(r.sets).length === 2,
        r.sets.map((s) => s.path.replace(ROW, '')).join(' '));
  check('fallback: nothing written to the row itself, no update()',
        r.sets.every((s) => s.path !== ROW) && r.updates.length === 0, `row sets=${r.sets.filter((s) => s.path === ROW).length}`);
}
// (4) beat not yet due: nothing at all
{
  const r = beat({ ...idle, _bsRestBeat: Date.now() - 60e3, _battPct: 61 });
  check('beat 1 min ago: no write of any kind (rate-limited, returns)',
        r.sets.length === 0 && r.updates.length === 0, `sets=${r.sets.length} updates=${r.updates.length}`);
}
// (5) regression guard: the hidden branch still writes the full hidden row exactly as before
{
  const r = beat({ ...idle }, { hidden: true });
  const s = r.sets.find((x) => x.path === ROW);
  const want = { lat: 0, lng: 0, name: 'Jace', dev: 'Phone', accuracy: 0, noGps: true, hidden: true };
  const same = !!s && Object.keys(want).every((k) => s.val[k] === want[k]) && typeof s.val.ts === 'number'
               && Object.keys(s.val).length === Object.keys(want).length + 1;
  check('hidden: full {lat:0,lng:0,...,hidden:true} row untouched by the patch',
        same && r.updates.length === 0, JSON.stringify(s && s.val));
}
// (5b) regression guard: stationary-but-tracking still bumps only /ts
{
  const r = beat({ _batterySaver: false, _bsIdle: false, _lastGPS: { lat: 30.44, lng: -84.9 } });
  check('stationary, saver off: only the /ts bump, as before',
        r.sets.length === 1 && r.sets[0].path === ROW + '/ts' && r.updates.length === 0,
        r.sets.map((s) => s.path.replace(ROW, '')).join(' '));
}
// (6) static guards: the old whole-row literal is gone; the deploy-check string is present
check('source: the old full-row rest literal is gone',
      !src.includes('accuracy: 0, ts: Date.now(), rest: true'));
check('source: deploy-check string present',
      src.includes('var _hb = { ts: Date.now(), rest: true }'));

// ── toggleLocationShare, extracted to its matching brace and run in a `with` scope ─────────
const tlsStart = src.indexOf('function toggleLocationShare(share) {');
if (tlsStart < 0) { console.error('toggleLocationShare not found'); process.exit(1); }
let depth = 0, tlsEnd = -1;
for (let j = src.indexOf('{', tlsStart); j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { tlsEnd = j + 1; break; } }
}
const tlsSrc = src.slice(tlsStart, tlsEnd);

// Every free name the function touches resolves through this Proxy: overridden names get the
// fake, anything else not already a Node global becomes a no-op function. Symbols must come
// back undefined or the `with` lookup (Symbol.unscopables) breaks.
function runToggle(share, winInit) {
  const log = [], sets = [];
  const win = { _onGpsFix() {}, ...winInit };
  const o = {
    window: win, db: 'db', groupName: 'qa', userId: 'u1', userName: 'Jace',
    navigator: { geolocation: { getCurrentPosition() {
      log.push({ bsLastWrite: win._bsLastWrite, forceReport: win._forceReport });
    } } },
    localStorage: { setItem() {} },
    fbRef: (db, path) => path,
    fbSet: (path, val) => sets.push({ path, val }),
    locationHidden: !share,   // the state before the toggle
    userMarkers: {},
  };
  const scope = new Proxy(o, {
    has(t, k) { return (k in t) || !(k in globalThis); },
    get(t, k) { if (typeof k === 'symbol') return undefined; return (k in t) ? t[k] : function () {}; },
  });
  const fn = new Function('__s', 'with (__s) { ' + tlsSrc + '; return toggleLocationShare; }')(scope);
  fn(share);
  return { log, sets, win, o };
}
// (7) unhide while idle: both gates opened, and BEFORE the priming fix is requested
{
  const r = runToggle(true, { _bsLastWrite: 12345, _forceReport: false });
  check('unhide: the real function ran (locationHidden now false)', r.o.locationHidden === false);
  check('unhide: getCurrentPosition requested exactly once', r.log.length === 1, `calls=${r.log.length}`);
  check('unhide: _bsLastWrite reset to 0 and _forceReport set',
        r.win._bsLastWrite === 0 && r.win._forceReport === true,
        `_bsLastWrite=${r.win._bsLastWrite} _forceReport=${r.win._forceReport}`);
  check('unhide: both gates were open BEFORE getCurrentPosition was called',
        r.log.length === 1 && r.log[0].bsLastWrite === 0 && r.log[0].forceReport === true,
        JSON.stringify(r.log[0]));
}
// (7b) regression guard: hide still writes the hidden row and asks for no fix
{
  const r = runToggle(false, { _bsLastWrite: 12345, _forceReport: false });
  const s = r.sets.find((x) => x.path === ROW);
  check('hide: hidden row written, no fix requested, gates untouched',
        !!s && s.val.hidden === true && s.val.noGps === true && r.log.length === 0
        && r.win._bsLastWrite === 12345 && r.win._forceReport === false,
        JSON.stringify(s && s.val));
}

// (8) room entry: the block is async and mid-function, so assert the source. The gate reset must
// sit AFTER the claim-placeholder `if` closes (both branches) and before the "joined" log line.
{
  const claim = src.indexOf('accuracy: 0, ts: Date.now(), claiming: true');
  const joined = src.indexOf("writeDebugLog(groupName, userName + ' joined')", claim);
  const between = claim > 0 && joined > claim ? src.slice(claim, joined) : '';
  check('room entry: gate reset lives between the placeholder and the joined log',
        between.includes('window._bsLastWrite = 0; window._forceReport = true;'), `span ${between.length} chars`);
  check('room entry: the reset is outside the if(!_skipClaimPlaceholder) block',
        /\}\);\s*\}\s*(?:\/\/[^\n]*\s*)*window\._bsLastWrite = 0; window\._forceReport = true;/.test(between));
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
