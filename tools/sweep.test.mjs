// Runs the REAL keepAliveSweep -- pulled out of server.js by its function text, together with
// the wake-outcome helpers it calls -- against fake rooms, a fake admin database and a clock
// the test moves by hand. server.js cannot be imported: it starts timers and Firebase at the
// top level. So the thing under test is the shipped text, never a copy of the logic.
//
// What it proves. The sweep used to send a wake poke and forget it; from outside, a phone with
// no token, a phone whose token works but which ignores the push, and a phone that woke and
// reported all looked the same. Now every poke is remembered and judged on a later sweep, the
// verdict lands at gl/_wake/<uid> with a bounded log, three unanswered pokes in a row move the
// phone to the hourly lane, one answer (or coming back fresh on its own) moves it back, and a
// parked phone that is still writing its rest beat is left alone instead of being bumped for a
// GPS fix it does not need. A phone is judged as ONE thing across every crew it is in: the rest
// beat is written to the open crew only, so its rows disagree, and a sibling row that was merely
// ahead at poke time must never read as an answer. Its cadence comes from the youngest row worth
// a poke, whichever crew sorts first -- a row left behind in a crew it no longer opens must not
// slow the pokes down. And the bookkeeping is best-effort: when the gl/_wake writes fail, the
// pokes still go out.
//
// Usage:  node tools/sweep.test.mjs            (exit 0 = all pass)
//         node tools/sweep.test.mjs <path>     run against another copy of server.js, to show
//                                              the test fails when the judge, the rest skip, the
//                                              per-device baseline, the streak reset, the
//                                              youngest-row rule or the write-failure catch is
//                                              taken out
import { readFileSync } from 'node:fs';
const SRC_PATH = process.argv[2] || 'server.js';
const src = readFileSync(SRC_PATH, 'utf8');
const rules = readFileSync('database.rules.json', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(70)} ${detail || ''}`);
};

// ── Pull the shipped text out: brace walk from `function NAME(` (async or not) ─────────────
function extractFn(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error(name + ' not found in ' + SRC_PATH);
  let d = 0, end = -1;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error(name + ': braces never balanced');
  return src.slice(m.index, end + 1);
}
const FN_NAMES = ['keepAliveSweep', '_wakeJudge', '_wakeRecord', '_heardAt', '_wakeLaneOf', '_wakeCooldownFor',
                  '_isIos', '_wakeCooldown', '_wakeStale'];
const ALL_FN_SRC = FN_NAMES.map(extractFn).join('\n');
// The WAKE_* thresholds, read from the file so a retuned constant retunes the test with it.
const consts = {};
for (const m of src.matchAll(/^const (WAKE_[A-Z_]+)\s*=\s*([^;]+);/gm)) consts[m[1]] = new Function('return (' + m[2] + ');')();
const { WAKE_IOS_COOLDOWN_MS, WAKE_SLOW_COOLDOWN_MS, WAKE_STALE_ANDROID_MS, WAKE_COOLDOWN_ANDROID_MS, WAKE_REST_BEAT_MS,
        WAKE_LOG_KEEP, WAKE_IGNORED_STREAK, WAKE_GIVE_UP_MS } = consts;
{
  // A brace inside a string would end the walk early and hand us a truncated function that
  // still parses. The sweep's real end sits just above the line that schedules it.
  const sweepSrc = extractFn('keepAliveSweep');
  const endIdx = src.indexOf(sweepSrc) + sweepSrc.length;
  const sched = src.indexOf('setInterval(function () { keepAliveSweep()', endIdx);
  const between = sched > 0 ? src.slice(endIdx, sched).split('\n').map((l) => l.trim()).filter(Boolean) : null;
  check('extraction: keepAliveSweep ends where the file schedules it',
        between && between.every((l) => l.startsWith('//')), `${sweepSrc.split('\n').length} lines`);
  let parses = true; try { new Function(ALL_FN_SRC); } catch (e) { parses = false; }
  check('extraction: the nine functions parse on their own', parses, FN_NAMES.join(' '));
  check('extraction: every WAKE_* constant the test leans on was found',
        [WAKE_IOS_COOLDOWN_MS, WAKE_SLOW_COOLDOWN_MS, WAKE_STALE_ANDROID_MS, WAKE_COOLDOWN_ANDROID_MS, WAKE_REST_BEAT_MS,
         WAKE_LOG_KEEP, WAKE_IGNORED_STREAK, WAKE_GIVE_UP_MS].every((v) => typeof v === 'number'),
        Object.keys(consts).join(' '));
}

// ── A tiny Realtime Database: paths, multi-path update(), ServerValue.increment ─────────────
function makeDb() {
  const root = {};
  const parts = (p) => String(p).split('/').filter(Boolean);
  function get(path) {
    let n = root;
    for (const k of parts(path)) { if (n === null || typeof n !== 'object' || !(k in n)) return null; n = n[k]; }
    return n === undefined ? null : n;
  }
  function setAt(path, v) {
    const ks = parts(path), last = ks.pop();
    let n = root;
    for (const k of ks) { if (n[k] === null || n[k] === undefined || typeof n[k] !== 'object') n[k] = {}; n = n[k]; }
    if (v === null) delete n[last]; else n[last] = v;
  }
  // Like the real thing: a key may be a slash path, null deletes, an undefined value is refused
  // outright (the SDK throws before anything is sent), and {'.sv':{increment:n}} adds server-side.
  function update(path, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) throw new Error('update() refused: undefined at ' + k);
      let val = v;
      if (v && typeof v === 'object' && v['.sv'] && typeof v['.sv'].increment === 'number') {
        const cur = get(path + '/' + k);
        val = (typeof cur === 'number' ? cur : 0) + v['.sv'].increment;
      }
      setAt(path + '/' + k, val);
    }
  }
  return { root, get, setAt, update };
}

// ── The world the sweep runs in ─────────────────────────────────────────────────────────────
// Every free name the functions touch resolves through the Proxy: a named fake where the value
// matters, otherwise a no-op function that is also RECORDED, so a new dependency the harness
// does not cover fails a check instead of silently doing nothing.
// opts.wakeWritesFail: every update() under gl/_wake rejects, the way a rules deny or an outage
// would, so the test can prove the pokes do not depend on the bookkeeping.
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-24T14:00:00Z');
function makeWorld(opts) {
  opts = opts || {};
  const db = makeDb();
  let clock = T0;
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const bumps = [], failures = {}, logs = [], errors = [];
  const calls = { updates: [], sets: [], transactions: [], logReads: 0, refused: 0 };
  const adminDb = {
    ref(path) {
      return {
        update: async (patch) => {
          if (opts.wakeWritesFail && path.startsWith('gl/_wake/')) { calls.refused++; throw new Error('PERMISSION_DENIED (fake)'); }
          calls.updates.push({ path, patch }); db.update(path, patch);
        },
        set: async (v) => { calls.sets.push({ path, v }); db.setAt(path, v); },
        transaction: async (fn) => { calls.transactions.push(path); db.setAt(path, fn(db.get(path))); },
        once: async () => ({ val: () => db.get(path) }),
      };
    },
  };
  const maps = { wakeLastSent: new Map(), wakePending: new Map(), wakeStreaks: new Map(), wakeLogKeys: new Map() };
  const overrides = Object.assign({
    Date: FakeDate,
    console: {
      log: (...a) => logs.push(a.join(' ')),
      error: (...a) => { errors.push(a.join(' ')); logs.push('ERROR ' + a.join(' ')); },
      warn() {},
    },
    fcmAdmin: { database: { ServerValue: { increment: (n) => ({ '.sv': { increment: n } }) } } },
    adminDb,
    _roomNames: async () => ['our_crew', 'family_men'],
    _dbGet: async (p) => { if (/\/log$/.test(p)) calls.logReads++; return db.get(p); },
    sendBump: async (uid) => { bumps.push(uid); return failures[uid] || { ok: true }; },
    shareWatchPass: async () => {}, authWatchCollect() {}, authWatchJudge: async () => {}, pruneSupersededDevices: async () => {},
  }, consts, maps);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const stubbed = new Set();
  const scope = new Proxy({}, {
    has(_, k) {
      if (typeof k !== 'string' || FN_NAMES.includes(k)) return false;   // the functions resolve among themselves
      return !(k in globalThis) || hasOwn(overrides, k);
    },
    get(_, k) {
      if (typeof k !== 'string') return undefined;   // Symbol.unscopables
      if (hasOwn(overrides, k)) return overrides[k];
      stubbed.add(k);
      return function () {};
    },
    set(_, k, v) { overrides[k] = v; return true; },
  });
  const fns = new Function('__s', 'with (__s) { ' + ALL_FN_SRC + '\n return { ' + FN_NAMES.join(', ') + ' }; }')(scope);
  const crew = (room, users) => { db.setAt('gl/' + room + '/config', { circle: true }); db.setAt('gl/' + room + '/users', users); };
  return {
    db, fns, bumps, failures, logs, errors, calls, maps, stubbed, crew,
    setClock(t) { clock = t; }, now: () => clock,
    sweep: () => fns.keepAliveSweep(),
    // The sweep at T0 + m minutes.
    at: async (m) => { clock = T0 + m * MIN; await fns.keepAliveSweep(); },
    rec: (uid) => db.get('gl/_wake/' + uid),
    log: (uid) => Object.entries((db.get('gl/_wake/' + uid) || {}).log || {}).map(([k, v]) => Object.assign({ at: Number(k) }, v)),
    row: (room, uid) => db.get('gl/' + room + '/users')[uid],
    wakeUpdates: (uid) => calls.updates.filter((u) => u.path === 'gl/_wake/' + uid).length,
    lastWakePatch: (uid) => { const l = calls.updates.filter((u) => u.path === 'gl/_wake/' + uid); return l.length ? l[l.length - 1].patch : null; },
  };
}
// Rows as the phones write them. An iPhone carries oss.iosVer and a native hbTs; a web/Android
// row has fixTs from a real fix and ts from whichever write came last (a rest beat refreshes ts
// alone). All times are "this long before T0".
const iphone = (fixAgo, extra) => Object.assign(
  { name: 'Chris', lat: 30.44, lng: -84.9, fixTs: T0 - fixAgo, ts: T0 - fixAgo, hbTs: T0 - fixAgo, oss: { iosVer: '1.0.13' } }, extra || {});
const android = (fixAgo, tsAgo, extra) => Object.assign(
  { name: 'Steph', lat: 30.45, lng: -84.91, fixTs: T0 - fixAgo, ts: T0 - tsAgo }, extra || {});
const advance = (row, to) => { row.fixTs = row.ts = to; if ('hbTs' in row) row.hbTs = to; };

// (1) a quiet iPhone is poked and the poke is recorded; (2) its fix two minutes later is judged
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  await W.sweep();
  const rec = W.rec('u_chris');
  check('1 quiet iPhone (fixTs 20 min): sendBump called once, for it', W.bumps.join(',') === 'u_chris', W.bumps.join(','));
  check('1 wakePending holds it, at = the poke time', W.maps.wakePending.get('u_chris') && W.maps.wakePending.get('u_chris').at === T0,
        JSON.stringify(W.maps.wakePending.get('u_chris')));
  check('1 gl/_wake/<uid>: pokes 1, lastResult sent, lane normal, ios, name, lastPokeAt/FixTs',
        !!rec && rec.pokes === 1 && rec.lastResult === 'sent' && rec.lane === 'normal' && rec.ios === true && rec.name === 'Chris'
        && rec.lastPokeAt === T0 && rec.lastPokeFixTs === T0 - 20 * MIN, JSON.stringify(rec));
  check('1 nothing judged yet: no log, no answered/ignored', !rec.log && rec.answered === undefined && rec.ignored === undefined);
  check('1 summary line names all four counts',
        W.logs.includes('keep-alive: poked 1, answered 0, ignored 0, resting-skipped 0'), W.logs.join(' | '));
  check('harness: every free name the sweep touched had a fake (nothing stubbed)', W.stubbed.size === 0, [...W.stubbed].join(' '));
  check('harness: no error reached console.error', W.errors.length === 0, W.errors.join(' | '));

  W.setClock(T0 + 2 * MIN);
  advance(W.row('our_crew', 'u_chris'), T0 + 90 * 1000);   // woke and fixed 90 s after the poke
  W.bumps.length = 0;
  await W.sweep();
  const rec2 = W.rec('u_chris'), log = W.log('u_chris');
  check('2 answered: answered 1, streak 0, lane normal, lastAnsweredAt = lastJudgedAt = now',
        rec2.answered === 1 && rec2.streak === 0 && rec2.lane === 'normal' && rec2.lastAnsweredAt === T0 + 2 * MIN
        && rec2.lastJudgedAt === T0 + 2 * MIN && rec2.pokes === 1, JSON.stringify(rec2));
  check('2 one log entry: answered, latencySec 90, fix true, ageSec 1200, keyed by judging time',
        log.length === 1 && log[0].result === 'answered' && log[0].latencySec === 90 && log[0].fix === true
        && log[0].ageSec === 1200 && log[0].at === T0 + 2 * MIN, JSON.stringify(log));
  check('2 pending cleared, not poked again (the row is fresh now)',
        !W.maps.wakePending.has('u_chris') && W.bumps.length === 0, `pending=${W.maps.wakePending.size} bumps=${W.bumps.length}`);
  check('2 exactly two writes to gl/_wake/<uid> so far (one per poke, one per verdict)', W.wakeUpdates('u_chris') === 2,
        `${W.wakeUpdates('u_chris')} updates`);
}

// (2b) an iPhone that woke and heartbeated (fresh ts/hbTs, ORIGINAL fixTs) answered the poke --
// that is what iOS 1.0.13 does when it has no new position -- and the log says no fix came
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  await W.sweep();
  W.setClock(T0 + 2 * MIN);
  const row = W.row('our_crew', 'u_chris');
  row.ts = row.hbTs = T0 + 15 * 1000;                     // heartbeat; fixTs stays 20 min old
  await W.sweep();
  const rec = W.rec('u_chris'), log = W.log('u_chris');
  check('2b heartbeat-only answer counts as answered (the phone woke), fix:false in the log',
        rec.answered === 1 && rec.streak === 0 && log.length === 1 && log[0].result === 'answered' && log[0].fix === false
        && log[0].latencySec === 15, JSON.stringify(log));
}

// (3) no answer: nothing judged until the device's cooldown has passed, then ignored, streak 1
// (4) three in a row: lane 'ignored', poked hourly -- not at +25 min after the last poke, at +61
// (5) one answer after that puts it back on the normal cadence
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  const row = W.row('our_crew', 'u_chris');
  await W.sweep();                                           // poke #1 at T0
  let judgedEarly = null;
  for (let m = 2; m < WAKE_IOS_COOLDOWN_MS / MIN; m += 2) {
    W.setClock(T0 + m * MIN); await W.sweep();
    if (W.rec('u_chris').log && judgedEarly === null) judgedEarly = m;
  }
  check('3 nothing judged in the sweeps before the 20-min iOS cooldown; still pending; one bump',
        judgedEarly === null && W.maps.wakePending.has('u_chris') && W.bumps.length === 1, `judgedEarly=${judgedEarly} bumps=${W.bumps.length}`);
  W.setClock(T0 + 20 * MIN); await W.sweep();
  let rec = W.rec('u_chris'), log = W.log('u_chris');
  check('3 at +20: ignored 1, streak 1, lane still normal, log entry ignored with ageSec 1200',
        rec.ignored === 1 && rec.streak === 1 && rec.lane === 'normal' && log.length === 1 && log[0].result === 'ignored'
        && log[0].ageSec === 1200 && log[0].latencySec === undefined, JSON.stringify(rec) + ' ' + JSON.stringify(log));
  check('3 the verdict comes BEFORE the re-poke in the same sweep: pokes 2, pending.at = +20',
        rec.pokes === 2 && W.bumps.length === 2 && W.maps.wakePending.get('u_chris').at === T0 + 20 * MIN,
        `pokes=${rec.pokes} bumps=${W.bumps.length}`);
  W.setClock(T0 + 40 * MIN); await W.sweep();                // verdict #2 ignored, poke #3
  W.setClock(T0 + 60 * MIN); await W.sweep();                // verdict #3 ignored -> hourly lane; NO poke #4
  rec = W.rec('u_chris');
  check('4 third ignored in a row: streak 3, lane ignored, ignored 3',
        rec.streak === 3 && rec.lane === 'ignored' && rec.ignored === 3 && rec.answered === undefined, JSON.stringify(rec));
  check('4 not re-poked at +60 (20 min after poke #3) -- the lane is hourly now',
        W.bumps.length === 3 && !W.maps.wakePending.has('u_chris'), `bumps=${W.bumps.length}`);
  check('4 _wakeCooldownFor reports the slow cooldown for it regardless of age',
        W.fns._wakeCooldownFor('u_chris', row, 60 * MIN) === WAKE_SLOW_COOLDOWN_MS
        && W.fns._wakeCooldown(row, 60 * MIN) === WAKE_IOS_COOLDOWN_MS, 'base cooldown untouched');
  W.setClock(T0 + 85 * MIN); await W.sweep();                // 45 min after poke #3
  check('4 still not poked at +45 min after the last poke', W.bumps.length === 3, `bumps=${W.bumps.length}`);
  W.setClock(T0 + 101 * MIN); await W.sweep();               // 61 min after poke #3
  rec = W.rec('u_chris');
  check('4 poked at +61 min after the last poke; the poke record carries lane ignored',
        W.bumps.length === 4 && rec.pokes === 4 && rec.lane === 'ignored' && rec.lastPokeAt === T0 + 101 * MIN, `bumps=${W.bumps.length}`);
  W.setClock(T0 + 103 * MIN);
  advance(row, T0 + 102 * MIN);                              // it answered this one
  await W.sweep();
  rec = W.rec('u_chris'); log = W.log('u_chris');
  check('5 one answer resets: streak 0, lane normal, answered 1, ignored still 3, pokes 4',
        rec.streak === 0 && rec.lane === 'normal' && rec.answered === 1 && rec.ignored === 3 && rec.pokes === 4
        && rec.lastAnsweredAt === T0 + 103 * MIN, JSON.stringify(rec));
  check('5 cadence back to the iOS cooldown', W.fns._wakeCooldownFor('u_chris', row, 25 * MIN) === WAKE_IOS_COOLDOWN_MS);
  check('5 log: ignored, ignored, ignored, answered -- in time order',
        log.map((e) => e.result).join(',') === 'ignored,ignored,ignored,answered' && log.every((e, i) => i === 0 || e.at > log[i - 1].at),
        log.map((e) => e.result).join(','));
}

// (6) a parked Android that still writes its rest beat is left alone; the same row without rest
// is bumped; a beat older than the window means the beat stopped, so bump
{
  const W = makeWorld();
  W.crew('our_crew', {
    u_steph: android(40 * MIN, 1 * MIN, { rest: true }),
    u_jrod: android(40 * MIN, 1 * MIN, { name: 'J-Rod' }),                 // same row, no rest flag
  });
  await W.sweep();
  check('6 resting Android (rest:true, ts 1 min, fixTs 40 min): not poked', !W.bumps.includes('u_steph'), W.bumps.join(','));
  check('6 the same row without rest: poked', W.bumps.includes('u_jrod'), W.bumps.join(','));
  check('6 counted in the summary, not recorded per device',
        W.logs.includes('keep-alive: poked 1, answered 0, ignored 0, resting-skipped 1') && !W.rec('u_steph'), W.logs.join(' | '));
  const W2 = makeWorld();
  W2.crew('our_crew', { u_steph: android(40 * MIN, 4.5 * MIN, { rest: 1 }) });   // the fix payload writes rest as 1
  await W2.sweep();
  check(`6 rest:1 with ts ${4.5} min old: inside the ${WAKE_REST_BEAT_MS / MIN}-min beat window (beat is 4 min, Android stale 3), not poked`,
        W2.bumps.length === 0 && WAKE_REST_BEAT_MS > WAKE_STALE_ANDROID_MS, `bumps=${W2.bumps.length}`);
  const W3 = makeWorld();
  W3.crew('our_crew', { u_steph: android(40 * MIN, 6 * MIN, { rest: true }) });
  await W3.sweep();
  check('6 rest:true but ts 6 min old -- the beat stopped -- poked', W3.bumps.join(',') === 'u_steph', W3.bumps.join(','));
}

// (6b) the rest beat is written to the OPEN crew only, so the same phone's row in another crew
// still carries the pre-rest fix with no rest flag. That stale sibling must not get the phone
// bumped: the skip is per device, whichever crew the resting row is in.
for (const [restRoom, staleRoom] of [['our_crew', 'family_men'], ['family_men', 'our_crew']]) {
  const W = makeWorld();
  W.crew(restRoom, { u_steph: android(40 * MIN, 1 * MIN, { rest: true }) });
  W.crew(staleRoom, { u_steph: android(40 * MIN, 40 * MIN) });
  await W.sweep();
  check(`6b resting in ${restRoom}, stale in ${staleRoom}: not poked, nothing recorded, nothing pending`,
        W.bumps.length === 0 && !W.rec('u_steph') && W.maps.wakePending.size === 0, W.bumps.join(','));
  check('6b the summary says so: poked 0, resting-skipped 1',
        W.logs.includes('keep-alive: poked 0, answered 0, ignored 0, resting-skipped 1'), W.logs.join(' | '));
  W.row(restRoom, 'u_steph').ts = T0 + 2 * MIN - 30 * 1000;   // the next beat
  await W.at(2);
  check('6b two minutes on, another beat: still nothing', W.bumps.length === 0 && !W.rec('u_steph'), W.bumps.join(','));
}
// The same two rows, but the beat stopped six minutes ago (the phone died while parked): poked,
// the baseline is the last beat, and with nothing moving on either row it is judged ignored --
// not 'answered' off the fresher row.
{
  const W = makeWorld();
  W.crew('our_crew', { u_steph: android(40 * MIN, 6 * MIN, { rest: true }) });
  W.crew('family_men', { u_steph: android(40 * MIN, 40 * MIN) });
  await W.sweep();
  check('6b beat stopped 6 min ago, stale sibling: poked once; the baseline is the last beat',
        W.bumps.join(',') === 'u_steph' && W.maps.wakePending.get('u_steph').heard === T0 - 6 * MIN,
        JSON.stringify(W.maps.wakePending.get('u_steph')));
  await W.at(2);
  check('6b +2, nothing moved on either row: still pending, not answered',
        W.maps.wakePending.has('u_steph') && W.rec('u_steph').answered === undefined && !W.rec('u_steph').log, JSON.stringify(W.rec('u_steph')));
  await W.at(WAKE_COOLDOWN_ANDROID_MS / MIN);
  check('6b at the Android cooldown: ignored 1, never answered',
        W.rec('u_steph').ignored === 1 && W.rec('u_steph').answered === undefined && W.log('u_steph').map((e) => e.result).join() === 'ignored',
        JSON.stringify(W.log('u_steph')));
}

// (7) sendBump fails: recorded on the spot as failed, no pending, cooldown still stamped
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  W.failures.u_chris = { ok: false, reason: 'no-token' };
  await W.sweep();
  const rec = W.rec('u_chris'), log = W.log('u_chris');
  check('7 no-token: pokes 1, failed 1, lastResult no-token, lastPokeAt stamped',
        rec.pokes === 1 && rec.failed === 1 && rec.lastResult === 'no-token' && rec.lastPokeAt === T0, JSON.stringify(rec));
  check('7 log entry: failed, reason no-token, ageSec 1200', log.length === 1 && log[0].result === 'failed' && log[0].reason === 'no-token'
        && log[0].ageSec === 1200, JSON.stringify(log));
  check('7 wakeLastSent stamped, wakePending NOT', W.maps.wakeLastSent.get('u_chris') === T0 && !W.maps.wakePending.has('u_chris'));
  check('7 the not-woken line still logs', W.logs.some((l) => /not woken — no-token/.test(l)), W.logs.join(' | '));
  W.setClock(T0 + 2 * MIN); await W.sweep();
  check('7 the cooldown holds after a failure: not retried two minutes later', W.bumps.length === 1, `bumps=${W.bumps.length}`);
}

// (8) one phone in two crews: poked once, judged once, two writes in all
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  W.crew('family_men', { u_chris: iphone(20 * MIN) });
  await W.sweep();
  check('8 two crews: sendBump once', W.bumps.join(',') === 'u_chris', W.bumps.join(','));
  check('8 two crews: pokes 1', W.rec('u_chris').pokes === 1);
  W.setClock(T0 + 2 * MIN);
  advance(W.row('our_crew', 'u_chris'), T0 + 60 * 1000);
  advance(W.row('family_men', 'u_chris'), T0 + 60 * 1000);
  await W.sweep();
  check('8 two crews: judged once -- answered 1, one log entry, two gl/_wake writes in total',
        W.rec('u_chris').answered === 1 && W.log('u_chris').length === 1 && W.wakeUpdates('u_chris') === 2,
        `answered=${W.rec('u_chris').answered} log=${W.log('u_chris').length} writes=${W.wakeUpdates('u_chris')}`);
  // A fix that reached only one crew (the fan-out missed one) is still a fix the phone took
  // after the poke: answered, once. Both rows were level when we poked, so nothing was ahead.
  const W2 = makeWorld();
  W2.crew('our_crew', { u_chris: iphone(20 * MIN) });
  W2.crew('family_men', { u_chris: iphone(20 * MIN) });
  await W2.sweep();
  W2.setClock(T0 + 2 * MIN);
  advance(W2.row('family_men', 'u_chris'), T0 + 60 * 1000);
  await W2.sweep();
  check('8 a fix written after the poke to the second crew only: answered, once',
        W2.rec('u_chris').answered === 1 && W2.log('u_chris').length === 1 && W2.log('u_chris')[0].latencySec === 60,
        JSON.stringify(W2.log('u_chris')));
}

// (8c) the rows disagree at poke time -- the second crew's clocks sit 5 ms ahead -- and the
// phone never answers. The baseline is the newest clock across both rows, so the sibling that
// was already ahead cannot be read as an answer on the next sweep: pending, then ignored.
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  const ahead = iphone(20 * MIN); ahead.ts += 5; ahead.hbTs += 5;
  W.crew('family_men', { u_chris: ahead });
  await W.sweep();
  const p = W.maps.wakePending.get('u_chris');
  check('8c the pending baseline is the newest row clock across both crews (5 ms ahead)',
        !!p && p.heard === T0 - 20 * MIN + 5 && p.fixTs === T0 - 20 * MIN, JSON.stringify(p));
  await W.at(2);
  check('8c +2 with nothing from the phone: still pending, no verdict, no log entry',
        W.maps.wakePending.has('u_chris') && W.rec('u_chris').answered === undefined && !W.rec('u_chris').log, JSON.stringify(W.rec('u_chris')));
  for (let m = 4; m <= WAKE_IOS_COOLDOWN_MS / MIN; m += 2) await W.at(m);
  check('8c judged ignored once the cooldown passed, never answered',
        W.rec('u_chris').ignored === 1 && W.rec('u_chris').answered === undefined && W.log('u_chris').map((e) => e.result).join() === 'ignored',
        JSON.stringify(W.log('u_chris')));
}

// (9) a row a week quiet is neither poked nor recorded; one a day quiet is poked, in the slow lane
{
  const W = makeWorld();
  W.crew('our_crew', { u_gone: iphone(8 * 24 * 60 * MIN, { name: 'Gone' }), u_slow: iphone(25 * 60 * MIN, { name: 'Slow' }) });
  await W.sweep();
  check('9 8 days quiet: not poked, no record, no pending',
        !W.bumps.includes('u_gone') && !W.rec('u_gone') && !W.maps.wakePending.has('u_gone'), W.bumps.join(','));
  check('9 25 h quiet: poked, recorded with lane slow', W.bumps.includes('u_slow') && W.rec('u_slow').lane === 'slow',
        JSON.stringify(W.rec('u_slow')));
}

// (10) the uptime sample is untouched: one transaction per seen device, at the same path
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN), u_steph: android(1 * MIN, 1 * MIN), u_gone: iphone(8 * 24 * 60 * MIN, { name: 'Gone' }) });
  W.crew('family_men', { u_chris: iphone(20 * MIN) });
  await W.sweep();
  const tx = W.calls.transactions;
  check('10 _uptime: exactly one transaction per seen uid (3), under gl/_uptime/<day>/<uid>',
        tx.length === 3 && new Set(tx).size === 3 && tx.every((p) => p.startsWith('gl/_uptime/2026-10-24/')), tx.join(' '));
  const up = W.db.get('gl/_uptime/2026-10-24');
  check('10 _uptime: samples 1 each, fresh only for the 1-min row',
        up.u_chris.samples === 1 && up.u_chris.fresh === 0 && up.u_steph.samples === 1 && up.u_steph.fresh === 1 && up.u_gone.samples === 1,
        JSON.stringify(up));
  check('10 no set() anywhere: the record is written with update() alone', W.calls.sets.length === 0, `sets=${W.calls.sets.length}`);
}

// (11) the log is bounded at WAKE_LOG_KEEP, pruned in the same write, and the existing keys are
// read once per device per process
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  const seeded = {};
  for (let i = 0; i < WAKE_LOG_KEEP; i++) seeded[String(T0 - (i + 10) * MIN)] = { result: 'ignored', ageSec: 900 };
  W.db.setAt('gl/_wake/u_chris', { pokes: 70, ignored: 60, log: seeded });
  const oldest = String(T0 - (WAKE_LOG_KEEP + 9) * MIN);
  await W.sweep();
  check('11 the poke increments the stored counter rather than resetting it (pokes 71)', W.rec('u_chris').pokes === 71, `pokes=${W.rec('u_chris').pokes}`);
  W.setClock(T0 + 2 * MIN);
  advance(W.row('our_crew', 'u_chris'), T0 + 60 * 1000);
  await W.sweep();
  const keys = Object.keys(W.rec('u_chris').log);
  const last = W.calls.updates[W.calls.updates.length - 1].patch;
  check(`11 after a verdict the log holds exactly ${WAKE_LOG_KEEP}: oldest gone, newest present`,
        keys.length === WAKE_LOG_KEEP && !keys.includes(oldest) && keys.includes(String(T0 + 2 * MIN)), `${keys.length} keys`);
  check('11 the prune rode in the SAME update as the verdict (log/<oldest>: null)',
        last['log/' + oldest] === null && !!last['log/' + (T0 + 2 * MIN)] && last.answered !== undefined, Object.keys(last).join(' '));
  check('11 existing keys read once (first sighting), not on every verdict', W.calls.logReads === 1, `logReads=${W.calls.logReads}`);
  W.setClock(T0 + 30 * MIN); await W.sweep();              // poke again (age 29 min)
  W.setClock(T0 + 32 * MIN);
  advance(W.row('our_crew', 'u_chris'), T0 + 31 * MIN);
  await W.sweep();
  check('11 second verdict: still 60 keys, still one read', Object.keys(W.rec('u_chris').log).length === WAKE_LOG_KEEP && W.calls.logReads === 1,
        `keys=${Object.keys(W.rec('u_chris').log).length} logReads=${W.calls.logReads}`);
}

// (12) a poke whose row has not been seen since does not sit pending forever
{
  const W = makeWorld();
  W.crew('our_crew', { u_chris: iphone(20 * MIN) });
  await W.sweep();
  W.db.setAt('gl/our_crew/users', {});                      // the row is gone (pruned, left the crew)
  W.setClock(T0 + 2 * WAKE_SLOW_COOLDOWN_MS + MIN);
  await W.sweep();
  check('12 pending entry dropped once it is older than twice the slow cooldown and unseen',
        !W.maps.wakePending.has('u_chris') && W.log('u_chris').length === 0, `pending=${W.maps.wakePending.size}`);
}

// (13) the streak does not outlive the outage. An Android dies for a quarter hour (three pokes
// ignored, hourly lane), comes back and reports for twenty minutes, then goes quiet again: it
// is chased on the normal cadence, not held to the hourly lane it earned while it was dead.
{
  const W = makeWorld();
  W.crew('our_crew', { u_steph: android(WAKE_STALE_ANDROID_MS, WAKE_STALE_ANDROID_MS) });   // just over the stale line
  const row = W.row('our_crew', 'u_steph');
  const cd = WAKE_COOLDOWN_ANDROID_MS / MIN;                                            // 4
  for (let m = 0; m <= 3 * cd; m += 2) await W.at(m);        // pokes at 0, 4, 8; ignored at 4, 8, 12
  let rec = W.rec('u_steph');
  check(`13 dead for ${3 * cd} min: three pokes (0, ${cd}, ${2 * cd}), three ignored, lane ignored, no fourth poke`,
        W.bumps.length === 3 && rec.streak === 3 && rec.lane === 'ignored' && rec.ignored === 3 && !W.maps.wakePending.has('u_steph'),
        `bumps=${W.bumps.length} ${JSON.stringify(rec)}`);
  const writesBefore = W.wakeUpdates('u_steph');
  for (let m = 32; m <= 50; m += 2) { advance(row, T0 + m * MIN - 30 * 1000); await W.at(m); }   // back, reporting
  rec = W.rec('u_steph');
  check('13 back and reporting fresh: streak 0 and lane normal written -- once -- no poke, no log entry',
        rec.streak === 0 && rec.lane === 'normal' && W.bumps.length === 3 && W.wakeUpdates('u_steph') === writesBefore + 1
        && W.log('u_steph').length === 3 && W.maps.wakeStreaks.get('u_steph') === 0,
        `writes=${W.wakeUpdates('u_steph') - writesBefore} ${JSON.stringify(rec)}`);
  check('13 the reset wrote streak and lane only',
        Object.keys(W.lastWakePatch('u_steph')).sort().join() === 'lane,streak', JSON.stringify(W.lastWakePatch('u_steph')));
  await W.at(52);                                            // 2.5 min quiet: not stale yet
  check('13 2.5 min quiet: not yet stale, not poked', W.bumps.length === 3, `bumps=${W.bumps.length}`);
  await W.at(54);                                            // 4.5 min quiet: stale; last poke was 46 min ago
  check('13 poked at 54 on the normal cadence -- not held until 68 by the hourly lane',
        W.bumps.length === 4 && W.rec('u_steph').lastPokeAt === T0 + 54 * MIN && W.rec('u_steph').lane === 'normal'
        && W.fns._wakeCooldownFor('u_steph', row, 4.5 * MIN) === WAKE_COOLDOWN_ANDROID_MS,
        `bumps=${W.bumps.length} lane=${W.rec('u_steph').lane}`);
}

// (14) the bookkeeping is best-effort. Every write under gl/_wake rejects (a rules deny, an
// outage): the sweep must not throw, every quiet phone is still poked, the _uptime samples
// still land, and the failure is reported rather than swallowed.
{
  const W = makeWorld({ wakeWritesFail: true });
  W.crew('our_crew', { u_chris: iphone(20 * MIN), u_steph: android(5 * MIN, 5 * MIN), u_slow: iphone(25 * 60 * MIN, { name: 'Slow' }) });
  W.failures.u_slow = { ok: false, reason: 'no-token' };     // the failed branch writes too
  let threw = null;
  try { await W.sweep(); } catch (e) { threw = e; }
  check('14 every gl/_wake write rejects: the sweep itself does not throw', threw === null, threw && threw.message);
  check('14 ...all three phones still went to sendBump', W.bumps.length === 3 && new Set(W.bumps).size === 3, W.bumps.join(','));
  check('14 ...the _uptime transactions still ran, one per phone', W.calls.transactions.length === 3, `${W.calls.transactions.length} transactions`);
  check('14 ...the refusals were reported through console.error, one per attempted write',
        W.calls.refused === 3 && W.errors.filter((e) => /wake record/.test(e)).length === 3, `refused=${W.calls.refused} ${W.errors.join(' | ')}`);
  check('14 ...nothing landed at gl/_wake; the not-woken line still logs; the summary still prints',
        !W.db.get('gl/_wake') && W.logs.some((l) => /not woken — no-token/.test(l))
        && W.logs.includes('keep-alive: poked 3, answered 0, ignored 0, resting-skipped 0'), W.logs.join(' | '));
  check('14 ...memory still carries the pokes: pending for the two that were sent, cooldown stamped for all three',
        W.maps.wakePending.has('u_chris') && W.maps.wakePending.has('u_steph') && !W.maps.wakePending.has('u_slow')
        && W.maps.wakeLastSent.size === 3, `pending=${W.maps.wakePending.size} stamped=${W.maps.wakeLastSent.size}`);
  // The verdict path with the write failing: judged, pending cleared, no throw, nobody else held up.
  advance(W.row('our_crew', 'u_chris'), T0 + 60 * 1000);
  threw = null;
  try { await W.at(2); } catch (e) { threw = e; }
  check('14 a verdict whose write fails still settles in memory (pending cleared, streak 0) and does not throw',
        threw === null && !W.maps.wakePending.has('u_chris') && W.maps.wakeStreaks.get('u_chris') === 0 && W.calls.transactions.length === 6,
        threw ? threw.message : `pending=${W.maps.wakePending.size} tx=${W.calls.transactions.length}`);
}

// (15) a row left behind. A phone that moved on from a crew leaves its last fix there for good,
// so one crew holds a row 30 h old while the crew it still opens shows it 10 min quiet. Before
// this patch the cooldown was tested row by row and the live row's cadence won; it has to win
// here too, whichever crew sorts first. Android, nothing answering: pokes at 0, 4 and 8 on the
// live row's cadence, then the hourly lane after the third ignored -- never the 24 h row's hourly
// cadence from the first poke, and every age the record carries is the live row's.
for (const [ghostRoom, liveRoom] of [['our_crew', 'family_men'], ['family_men', 'our_crew']]) {
  const W = makeWorld();
  W.crew(ghostRoom, { u_steph: android(30 * 60 * MIN, 30 * 60 * MIN) });
  W.crew(liveRoom, { u_steph: android(10 * MIN, 10 * MIN) });
  const cd = WAKE_COOLDOWN_ANDROID_MS / MIN, slow = WAKE_SLOW_COOLDOWN_MS / MIN;   // 4, 60
  const pokedAt = [];
  for (let m = 0; m <= 2 * cd + slow + 2; m += 2) {
    const before = W.bumps.length;
    await W.at(m);
    if (W.bumps.length > before) pokedAt.push(m);
    if (m === 0) {
      const p = W.maps.wakePending.get('u_steph'), rec = W.rec('u_steph');
      check(`15 ghost in ${ghostRoom}: the first poke goes by the 10-min row -- pending age 10 min, lane normal, lastPokeFixTs = its fix`,
            !!p && p.age === 10 * MIN && p.fixTs === T0 - 10 * MIN && p.heard === T0 - 10 * MIN && rec.lane === 'normal'
            && rec.lastPokeFixTs === T0 - 10 * MIN, JSON.stringify(p) + ' ' + JSON.stringify(rec));
    }
    if (m === 3 * cd) {
      const rec = W.rec('u_steph');
      check(`15 ghost in ${ghostRoom}: at ${3 * cd} the third ignored lands -- streak 3, lane ignored; the log's ages are the live row's (600, 840, 1080 s)`,
            rec.streak === 3 && rec.lane === 'ignored' && rec.ignored === 3 && rec.answered === undefined
            && W.log('u_steph').map((e) => e.ageSec).join() === [10, 10 + cd, 10 + 2 * cd].map((x) => x * 60).join(),
            JSON.stringify(W.log('u_steph')));
    }
  }
  check(`15 ghost in ${ghostRoom}: poked at 0, ${cd}, ${2 * cd}, then not until ${2 * cd + slow} -- the live row's cadence, then the ignored lane`,
        pokedAt.join() === [0, cd, 2 * cd, 2 * cd + slow].join(), pokedAt.join());
  check(`15 ghost in ${ghostRoom}: the hourly poke's record says why -- lane ignored, not slow`,
        W.rec('u_steph').lane === 'ignored' && W.rec('u_steph').pokes === 4, JSON.stringify(W.rec('u_steph')));
}
// (15b) the same ghost row beside a HEALTHY row that reports every sweep. Before this patch the
// ghost row alone got the phone poked once an hour and that stays as it was (the 4-minute cadence
// here would be a NEW poke on a healthy phone). What the record says about it has to agree with
// itself: the poke is on the slow lane because of the 30 h row, so the verdict names that lane
// too, rather than 'normal' off the fresh row.
{
  const W = makeWorld();
  W.crew('our_crew', { u_steph: android(30 * 60 * MIN, 30 * 60 * MIN) });
  W.crew('family_men', { u_steph: android(1 * MIN, 1 * MIN) });
  const live = W.row('family_men', 'u_steph');
  const pokedAt = [], lanes = [];
  for (let m = 0; m <= 62; m += 2) {
    advance(live, T0 + m * MIN - 30 * 1000);               // reporting all along
    const before = W.bumps.length;
    await W.at(m);
    if (W.bumps.length > before) pokedAt.push(m);
    if (m <= 2) lanes.push(W.rec('u_steph').lane);          // after the poke, after the verdict
  }
  check('15b a healthy phone with a 30 h row left behind: poked hourly as before (0, 60), never on the 4-min cadence',
        pokedAt.join() === '0,60', pokedAt.join());
  check('15b ...both pokes are answered (the phone is reporting), and the verdict names the lane the poke was on: slow, slow',
        W.rec('u_steph').answered === 2 && lanes.join() === 'slow,slow' && W.log('u_steph').map((e) => e.result).join() === 'answered,answered',
        `lanes=${lanes.join()} ${JSON.stringify(W.rec('u_steph'))}`);
}

// Guards on the text itself -- never the only check, see above.
check('source: /health exposes wake.pending for the deploy check', src.includes('wake: { pending: wakePending.size }'));
check('source: version string stepped to 1.8', /const CURRENT_VERSION = '1\.8';/.test(src));
check('source: the FCM bump payload is untouched',
      src.includes("data: { type: 'bump', ts: String(Date.now()) },") && src.includes("payload: { aps: { 'content-available': 1 } }")
      && src.includes("headers: { 'apns-push-type': 'background', 'apns-priority': '5' },"));
check('source: the ignored lane is three unanswered pokes', WAKE_IGNORED_STREAK === 3);
check('rules: gl/_wake is named with read and write both false (out of the $room wildcard)',
      /"_wake":\s*\{\s*"\.read":\s*false,\s*"\.write":\s*false\s*\}/.test(rules));

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
