// 1041 smoothness check: replays a 45 mph drive (fixes every 8-12 s, arriving 1-2.5 s late, +-5 m GPS
// wobble) through the real _animateMarker and the pin spring, on a 60 Hz simulated clock, and reports
// how evenly the DRAWN pin moves. Run: node tools/pinspring.sim.mjs [public/index.html]
import { readFileSync } from 'node:fs';
const src = readFileSync(process.argv[2] || 'public/index.html', 'utf8');
const a = src.indexOf('function _animateMarker(marker');
const c0 = src.lastIndexOf('var EXTRAP_MIN_MPH', a);
const e = src.indexOf('function _camPad()', a);
const fnSrc = src.slice(c0, e);
function extractFn(name) {
  const s = src.indexOf('function ' + name + '('); let d = 0, end = -1;
  for (let j = src.indexOf('{', s); j < src.length; j++) { const c = src[j]; if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } } }
  return src.slice(s, end + 1);
}
const metersApart = new Function(extractFn('metersApart') + '\n return metersApart;')();
function run(springOn, seed) {
  let rs = seed; const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
  const clock = { t: 100000 }; const rafs = new Map(); let id = 0;
  const win = { _markerGroupMembers: null, _pinSpringOff: !springOn, _resumeSnapUntil: 0 };
  const doc = { visibilityState: 'visible', body: { classList: { contains: () => false } }, addEventListener() {} };
  const map = { setCenter() {}, jumpTo() {}, getCenter() { return { lng: 0, lat: 0 }; } };
  const realNow = Date.now;
  const epoch0 = 1760000000000;
  Date.now = () => epoch0 + clock.t;
  const build = new Function('window', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    'metersApart', 'map', '_updateMarkerGrouping', 'userMarkers', '_camPad', '_camPlace', 'followUid', 'headingUpOn',
    fnSrc + '\n return _animateMarker;');
  const anim = build(win, doc, { now: () => clock.t }, (s) => { rafs.set(++id, s); return id; }, (i) => rafs.delete(i),
    metersApart, map, () => {}, {}, () => null, () => {}, null, false);
  const lat0 = 30.433, lng0 = -85.0, mps = 20.1, cos = Math.cos(lat0 * Math.PI / 180);
  const m = { _uid: 'max', _curLngLat: [lng0, lat0], _ll: [lng0, lat0], _ts: 0, _lastFixAt: 0, _anim: null, drawn: [lng0, lat0],
    getLngLat() { return { lng: this.drawn[0], lat: this.drawn[1] }; }, setLngLat(ll) { this.drawn = [+ll[0], +ll[1]]; return this; } };
  const rec = [];
  let nextFix = clock.t + 1000, t0 = clock.t;
  const END = t0 + 240000;
  while (clock.t < END) {
    if (clock.t >= nextFix) {
      const fixAge = 1000 + rnd() * 1500;
      const el = (clock.t - fixAge - t0) / 1000;
      const nz = () => (rnd() - 0.5) * 2 * 5 / 111320;
      const lng = lng0 + mps * el / (111320 * cos) + nz(), lat = lat0 + nz();
      const fixTs = epoch0 + clock.t - fixAge;
      anim(m, lng, lat, null, { remote: true, fixTs, spd: 45, hdg: 90 });
      m._ts = fixTs; m._ll = [lng, lat];
      nextFix = clock.t + 8000 + rnd() * 4000;
    }
    clock.t += 16.7;
    const fs = [...rafs.values()]; rafs.clear(); fs.forEach((s) => s(clock.t));
    if (clock.t - t0 > 30000) rec.push([clock.t, m.drawn[0], m.drawn[1]]);
  }
  Date.now = realNow;
  // speed over 100 ms windows, in mph
  const sp = [];
  for (let i = 6; i < rec.length; i += 6) {
    const dt = (rec[i][0] - rec[i - 6][0]) / 1000;
    const dx = (rec[i][1] - rec[i - 6][1]) * 111320 * cos, dy = (rec[i][2] - rec[i - 6][2]) * 111320;
    sp.push(Math.sqrt(dx * dx + dy * dy) / dt * 2.23694);
  }
  const s = sp.slice().sort((x, y) => x - y), mean = sp.reduce((x, y) => x + y, 0) / sp.length;
  const sd = Math.sqrt(sp.reduce((x, y) => x + (y - mean) ** 2, 0) / sp.length);
  let maxJerk = 0; for (let i = 1; i < sp.length; i++) maxJerk = Math.max(maxJerk, Math.abs(sp[i] - sp[i - 1]));
  // how far the drawn dot sits from the true car, in feet
  const lagFt = []; for (const r of rec) { const el = (r[0] - t0) / 1000; const trueLng = lng0 + mps * el / (111320 * cos); lagFt.push((trueLng - r[1]) * 111320 * cos * 3.28084); }
  const lg = lagFt.slice().sort((x, y) => x - y);
  return { median: +s[s.length >> 1].toFixed(1), p5: +s[Math.floor(s.length * .05)].toFixed(1), p95: +s[Math.floor(s.length * .95)].toFixed(1), max: +s[s.length - 1].toFixed(1),
           stoppedPct: +(100 * sp.filter((v) => v < 5).length / sp.length).toFixed(1), unevenPct: Math.round(100 * sd / mean),
           biggestSpeedChangeIn100ms: +maxJerk.toFixed(1), behindFt_median: Math.round(lg[lg.length >> 1]), behindFt_worst: Math.round(Math.max(...lg.map(Math.abs))) };
}
for (const seed of [7, 99, 1234]) {
  console.log('seed', seed, '\n  before (no spring):', JSON.stringify(run(false, seed)), '\n  after  (spring):   ', JSON.stringify(run(true, seed)));
}
