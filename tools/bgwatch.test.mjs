// The "Your phone is pausing GroundLink" watchdog: a strike only when the phone MOVED while
// hidden and still wrote nothing. A parked phone writing nothing is the battery design working.
//
// The deferred verdict lives in the GPS handler. This cuts that exact block out of the shipped
// file and runs it with a fake _bgHealth, so the decision is the real code's.
//
// Usage: node tools/bgwatch.test.mjs [index.html]
import { readFileSync } from 'node:fs';
const file = process.argv[2] || 'public/index.html';
const src = readFileSync(file, 'utf8');

const start = src.indexOf("    // The watchdog's deferred verdict (see _bgHealth.awaitFix)");
if (start < 0) { console.error('verdict block not found'); process.exit(1); }
// The block is one try { ... } catch (e) {} -- walk braces from its "try {" to the matching close
// and then take the trailing "catch (e) {}".
const tryAt = src.indexOf('try {', start);
let depth = 0, end = -1;
for (let i = src.indexOf('{', tryAt); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } } }
const catchClose = src.indexOf('}', src.indexOf('catch (e) {', end)) + 1;
const blk = src.slice(tryAt, catchClose);

const ma = src.indexOf('function metersApart(');
let d2 = 0, mb = -1;
for (let i = src.indexOf('{', ma); i < src.length; i++) { if (src[i] === '{') d2++; else if (src[i] === '}') { d2--; if (!d2) { mb = i + 1; break; } } }
const metersApart = new Function(src.slice(ma, mb) + '; return metersApart;')();
const MIN_M = +(src.match(/var BGH_MOVED_MIN_M = (\d+);/) || [])[1];
const WARN = +(src.match(/var BGH_STRIKES_TO_WARN = (\d+);/) || [])[1];

let fail = 0;
const check = (name, ok, detail) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(64)} ${detail || ''}`); };
check('constants read from the file', MIN_M > 0 && WARN > 0, `BGH_MOVED_MIN_M=${MIN_M} m  BGH_STRIKES_TO_WARN=${WARN}`);

function run({ awaitFix, lat, lng, strikes = 0 }) {
  let n = strikes, banner = null; const evts = [];
  const window = { _bgHealth: { awaitFix }, _evt: (m) => evts.push(m) };
  const fn = new Function('window', 'lat', 'lng', 'metersApart', 'BGH_MOVED_MIN_M', 'BGH_STRIKES_TO_WARN', '_bghStrikes', '_bghSetStrikes', '_showBgHealthBanner', 'Date', blk);
  fn(window, lat, lng, metersApart, MIN_M, WARN, () => n, (v) => { n = v; }, (m) => { banner = m; }, Date);
  return { strikes: n, banner, evts, cleared: window._bgHealth.awaitFix === null };
}
const now = Date.now();
const home = { lat: 30.4400, lng: -84.9000 };

// Parked: the first fix after coming back is 60 ft from where we went hidden.
{
  const r = run({ awaitFix: { span: 22 * 60000, posAtHide: home, since: now - 5000 }, lat: 30.44016, lng: -84.9000, strikes: 1 });
  check('parked 22 min: no strike, strikes reset to 0, no banner', r.strikes === 0 && r.banner === null, `strikes=${r.strikes} banner=${r.banner}`);
  check('parked: the verdict is consumed', r.cleared, '');
  check('parked: says so in the event log', r.evts.some((m) => /parked while hidden/.test(m)), r.evts[0]);
}
// Moved: the first fix is 2 miles away and nothing was written -- that IS a pause.
{
  const r = run({ awaitFix: { span: 22 * 60000, posAtHide: home, since: now - 5000 }, lat: 30.4690, lng: -84.9000, strikes: 0 });
  check('moved 2 mi with no writes: one strike, no banner yet (needs ' + WARN + ')', r.strikes === 1 && r.banner === null, `strikes=${r.strikes}`);
  const r2 = run({ awaitFix: { span: 31 * 60000, posAtHide: home, since: now - 5000 }, lat: 30.4690, lng: -84.9000, strikes: WARN - 1 });
  check('moved again: strike ' + WARN + ' shows the banner with the span in minutes', r2.strikes === WARN && r2.banner === 31, `strikes=${r2.strikes} banner=${r2.banner}`);
}
// Just under the line: 400 ft is still "parked" (GPS wander, walking to the mailbox).
{
  const r = run({ awaitFix: { span: 15 * 60000, posAtHide: home, since: now - 5000 }, lat: 30.4411, lng: -84.9000, strikes: 0 });
  check('400 ft: parked, no strike', r.strikes === 0 && r.banner === null, `moved=${Math.round(metersApart(home.lat, home.lng, 30.4411, -84.9) * 3.28084)} ft`);
}
// No baseline: cannot judge -> no strike (never nag on a guess).
{
  const r = run({ awaitFix: { span: 15 * 60000, posAtHide: null, since: now - 5000 }, lat: 30.4690, lng: -84.9000, strikes: 1 });
  check('no position from before hiding: no strike, reset', r.strikes === 0 && r.banner === null && /cannot judge/.test(r.evts[0] || ''), r.evts[0]);
}
// Too late: a verdict older than 3 minutes is dropped without judging.
{
  const r = run({ awaitFix: { span: 15 * 60000, posAtHide: home, since: now - 4 * 60000 }, lat: 30.4690, lng: -84.9000, strikes: 1 });
  check('verdict older than 3 min: dropped, strikes untouched', r.strikes === 1 && r.banner === null && r.cleared, `strikes=${r.strikes}`);
}
// Nothing pending: the block is a no-op.
{
  const r = run({ awaitFix: null, lat: 30.4690, lng: -84.9000, strikes: 1 });
  check('no pending verdict: nothing happens', r.strikes === 1 && r.banner === null && r.evts.length === 0, '');
}
// Static guards: the immediate strike is gone from the resume handler; the hide branch stores the position.
check('resume handler no longer strikes immediately', !src.includes("'m (strike ' + n + ', verified against DB)'"), '');
check('hide branch records where we were', src.includes('window._bgHealth.posAtHide = (window._lastGPS && isFinite(+window._lastGPS.lat))'), '');

console.log(fail ? `\n${fail} FAILED` : '\nall pass');
process.exit(fail ? 1 : 0);
