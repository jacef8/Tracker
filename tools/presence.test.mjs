// Pulls the REAL _presenceOf/_presenceHealth out of index.html and runs the state table
// against it, so the thing under test is the shipped source and not a copy of it.
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');
const grab = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + startMarker);
  return src.slice(a, b);
};
const body = grab('window._presenceHealth = function', '// Track known users');
const win = {};
new Function('window', 'LIVE_MS', body)(win, 4 * 60 * 1000);

const now = Date.now();
const ago = m => now - m * 60000;
const base = { lat: 30.4, lng: -84.9, spd: 0 };
const iosOk = { iosVer: '26.6.1', locAlways: true, locServices: true, precise: true,
                bgRefresh: true, bgRefreshDenied: false, lowPower: false, authDowns: 0 };

const cases = [
  ['live now',                 { ...base, fixTs: ago(1),  oss: iosOk },                      'live'],
  ['Lexi: parked 43 min, healthy iPhone', { ...base, fixTs: ago(43), batt: 80, oss: iosOk }, 'parked'],
  ['parked 3 hours',           { ...base, fixTs: ago(180), batt: 80, oss: iosOk },           'parked'],
  ['parked 9 hours -> no claim',{ ...base, fixTs: ago(540), batt: 80, oss: iosOk },          'stale'],
  ['stale at 64 mph',          { ...base, fixTs: ago(43), spd: 64, oss: iosOk },             'lost'],
  ['While Using only',         { ...base, fixTs: ago(43), oss: { ...iosOk, locAlways: false, locWhenInUse: true } }, 'check'],
  ['Low Power Mode on',        { ...base, fixTs: ago(43), oss: { ...iosOk, lowPower: true } },'check'],
  ['Background refresh denied',{ ...base, fixTs: ago(43), oss: { ...iosOk, bgRefreshDenied: true } }, 'check'],
  ['location denied',          { ...base, fixTs: ago(43), oss: { ...iosOk, locDenied: true } }, 'check'],
  ['battery was 7%, unplugged',{ ...base, fixTs: ago(43), batt: 7, chg: 0 },                 'check'],
  ['battery 7% but charging',  { ...base, fixTs: ago(43), batt: 7, chg: 1 },                 'parked'],
  ['sharing off',              { ...base, fixTs: ago(5), hidden: true },                     'off'],
  ['no gps, no coords',        { lat: 0, lng: 0, fixTs: ago(5), noGps: true },               'nogps'],
  ['noGps flag but real coords (the stale-flag trap)', { ...base, fixTs: ago(1), noGps: true }, 'live'],
  ['never reported',           { lat: 0, lng: 0 },                                           'stale'],
  ['Android, no oss block, parked', { ...base, fixTs: ago(43), batt: 60 },                   'parked'],
  ['iPhone parked 11 h, heard from 12 min ago (hbTs)', { ...base, fixTs: ago(660), hbTs: ago(12), oss: iosOk }, 'parked'],
  ['iPhone parked 11 h, NOT heard from for 2 h', { ...base, fixTs: ago(660), hbTs: ago(120), oss: iosOk }, 'stale'],
];

let fail = 0;
for (const [name, data, want] of cases) {
  const p = win._presenceOf('u', data);
  const ok = p.key === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(48)} -> ${p.key.padEnd(7)} "${p.label}" ${p.calm ? 'calm' : 'ALERT'}  "${p.line}"${p.why ? '  why="' + p.why + '"' : ''}`);
}
// Nothing may ever imply a stale reading is current.
for (const [name, data] of cases) {
  const p = win._presenceOf('u', data);
  if (p.key !== 'live' && /^Live/.test(p.line)) { console.log('FAIL  stale row claims Live: ' + name); fail++; }
}
console.log(fail ? `\n${fail} failing` : `\nall ${cases.length} pass`);
process.exit(fail ? 1 : 0);
