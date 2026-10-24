// Patch #3 of the map-motion plan: while the member sheet is open, group-follow fits INSIDE the
// sheet's standing padding instead of re-asserting the toolbar padding over it, and closing the
// sheet hands the padding back to the chrome in one change rather than zero-then-restore.
//
// Exercises the SHIPPED code by pulling the real function text out of public/index.html and
// running it, the way tools/followpad.test.mjs does -- nothing here re-states the logic.
//
// PART 1 runs the pure helper (window._sheetFitPad) from the same slice followpad.test.mjs uses.
// PART 2 runs the whole camera span -- _sheetPad, _followPadding, _zoomForBounds,
// _groupFollowTick, _closeMemberSheet -- against fakes for the map and the DOM, and checks what
// the tick actually does to map.setPadding and to the published zoom target, then projects the
// group through the transform the sheet left standing to see where the dots really land.
//
// Usage:  node tools/sheetpad.test.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(70)} ${detail || ''}`);
};
const near = (x, y, eps = 1e-9) => Math.abs(x - y) <= eps;
const SIDES = ['top', 'bottom', 'left', 'right'];
const samePad = (p, q) => !!p && !!q && SIDES.every((k) => p[k] === q[k]);

// ── PART 1: the pure helper, from the followpad slice ─────────────────────────────────────
const a = src.indexOf('window._clampVertPad = function');
const b = src.indexOf('function _followPadding()', a);
if (a < 0 || b < 0) { console.error('could not extract the pure padding slice'); process.exit(1); }
const slice = src.slice(a, b);
check('static: _sheetFitPad sits inside the pure slice', slice.includes('window._sheetFitPad = function'));
const win1 = {};
new Function('window', slice)(win1);
if (typeof win1._sheetFitPad !== 'function') { console.error('_sheetFitPad did not load from the slice'); process.exit(1); }

{ // phone: a ~330px sheet standing (102 top / 354 bottom), reserves added on top
  const r = win1._sheetFitPad({ top: 102, bottom: 354, left: 0, right: 0 }, { left: 50, right: 50 }, 812);
  check('phone: top never comes down below the sheet pad', r.top >= 102, `top=${r.top}`);
  check('phone: bottom never comes up above the sheet pad', r.bottom >= 354, `bottom=${r.bottom}`);
  check('phone: leaves at least 120px of usable band', r.top + r.bottom <= 812 - 120, `sum=${r.top + r.bottom}`);
  check('phone: sides come from the marker reserve', r.left === 50 && r.right === 50, `left=${r.left} right=${r.right}`);
  // _followPadding's top on the same phone is ~128 after its 45% clamp; the sheet pad plus reserve
  // (132) already clears it, so the floor is a no-op where the sheet starts at topbar+12.
  const r2 = win1._sheetFitPad({ top: 102, bottom: 354, left: 0, right: 0 }, { top: 127.8, left: 50, right: 50 }, 812);
  check('phone: the topbar floor changes nothing when the sheet pad already clears it', r2.top === r.top, `top=${r2.top}`);
}
{ // wide window: the sheet is docked 440px on the left; reserved as is, not scaled by any clamp
  const r = win1._sheetFitPad({ top: 0, left: 440, right: 0, bottom: 0 }, { left: 60, right: 60 }, 800);
  check('wide: docked sheet keeps its full 440px', r.left === 440, `left=${r.left}`);
  check('wide: right side is the marker reserve', r.right === 60, `right=${r.right}`);
  // The docked sheet reserves nothing at the top, so without a floor the fit's top is the bare
  // 30px marker reserve and the northernmost dot goes under the topbar. _followPadding's top
  // (topbar + 12 + 30) is the floor.
  const r2 = win1._sheetFitPad({ top: 0, left: 440, right: 0, bottom: 0 }, { top: 112, left: 60, right: 60 }, 800);
  check('wide: top is floored at the chrome clearance, not the bare reserve', r2.top === 112, `top=${r2.top}`);
  check('wide: ... and the bottom reserve is unchanged by the floor', r2.bottom === r.bottom, `bottom=${r2.bottom}`);
}
{ // short landscape: no room for reserves -> k = 0 and the sheet pad passes through untouched
  let r = null, threw = false;
  try { r = win1._sheetFitPad({ top: 60, bottom: 280 }, undefined, 400); } catch (e) { threw = true; }
  check('short: never throws', !threw);
  check('short: no reserve when the band is already tight', !!r && r.top === 60 && r.bottom === 280, r ? `top=${r.top} bottom=${r.bottom}` : '');
}
{ // nothing standing at all
  const r0 = win1._sheetFitPad(undefined, { left: 40, right: 45 }, undefined);
  check('gp undefined, no canvas: fp sides and 0 tops', r0.left === 40 && r0.right === 45 && r0.top === 0 && r0.bottom === 0, JSON.stringify(r0));
  const r1 = win1._sheetFitPad(undefined, { left: 40, right: 45 }, 812);
  check('gp undefined, tall canvas: fp sides, reserves from 0', r1.left === 40 && r1.right === 45 && r1.top === 30 && r1.bottom === 125, JSON.stringify(r1));
}

// ── PART 2: the shipped camera span ───────────────────────────────────────────────────────
const s0 = src.indexOf('var fitAllInterval = null;');
const s1 = src.indexOf('window._fitAllTapped = function', s0);
if (s0 < 0 || s1 < 0) { console.error('could not extract the camera span'); process.exit(1); }
const span = src.slice(s0, s1) +
  '\nreturn { _groupFollowTick: _groupFollowTick, _followPadding: _followPadding, _zoomForBounds: _zoomForBounds, _sheetPad: _sheetPad };';

const mm = src.match(/function metersApart\([\s\S]*?\n\}/);
if (!mm) { console.error('could not extract metersApart'); process.exit(1); }
const metersApart = new Function(mm[0] + '\nreturn metersApart;')();

// Fakes. The span's only load-time code is the _syncTopbarH wiring (addEventListener,
// ResizeObserver, setTimeout) inside a try, so the fakes carry no-ops and the try swallows the
// rest. `classes` stands in for document.body.classList; member-open hides #map-controls, exactly
// as the CSS does, so _followPadding measures a zero-height toolbar while the sheet is open. The
// topbar stays showing (the CSS hides only the toolbar) and its height is settable per layout.
const state = { canvas: { clientWidth: 390, clientHeight: 812 }, standing: { top: 0, bottom: 0, left: 0, right: 0 }, topbarH: 90 };
const calls = [];
const classes = new Set();
const el = (rect, style) => ({ getBoundingClientRect: () => rect(), style: style || { display: '' } });
const doc = {
  body: { classList: { contains: (k) => classes.has(k), add: (k) => classes.add(k), remove: (k) => classes.delete(k) } },
  getElementById: (id) => {
    if (id === 'topbar') return el(() => ({ height: state.topbarH, top: 0, bottom: state.topbarH }));
    if (id === 'map-controls') return el(() => (classes.has('member-open') ? { height: 0, top: 0 } : { height: 50, top: state.canvas.clientHeight - 62 }));
    if (id === 'member-sheet') return el(() => ({ height: 330 }), { display: classes.has('member-open') ? 'block' : 'none' });
    return el(() => ({ height: 0, top: 0 }));
  },
  addEventListener() {},
  documentElement: { style: { setProperty() {} } },
  visibilityState: 'visible',
};
const win = { innerWidth: 390, innerHeight: 812, addEventListener() {} };
const map = {
  getZoom: () => 15,
  getCanvas: () => state.canvas,
  getPadding: () => state.standing,
  setPadding(p) { calls.push(Object.assign({}, p)); },
  project: ([lng, lat]) => ({ x: (lng + 85) * 1e5, y: (31 - lat) * 1e5 }),
  getCenter: () => ({ lng: -84.9, lat: 30.44 }),
  easeTo() {}, jumpTo() {}, setMinZoom() {},
};
class LngLatBounds {
  constructor(sw, ne) { this.w = sw[0]; this.s = sw[1]; this.e = ne[0]; this.n = ne[1]; }
  extend(p) { this.w = Math.min(this.w, p[0]); this.e = Math.max(this.e, p[0]); this.s = Math.min(this.s, p[1]); this.n = Math.max(this.n, p[1]); return this; }
  getEast() { return this.e; } getWest() { return this.w; } getNorth() { return this.n; } getSouth() { return this.s; }
  getCenter() { return { lng: (this.w + this.e) / 2, lat: (this.s + this.n) / 2 }; }
}
const mapboxgl = { LngLatBounds };
// Three members spread mostly north-south, so the VERTICAL padding is the axis that decides the
// zoom -- the axis the sheet changes. `pts`: about 0.2 and 0.4 miles (330 and 650 yards) apart,
// for the phone cases. `ptsWide`: about 0.7 and 1.4 miles apart, so that on a 1000x800 or 768x1024
// canvas the fit lands below the zoom-16 cap and the group really spans the vertical band.
const pts = { a: [-84.9000, 30.4400], b: [-84.9005, 30.4427], c: [-84.9010, 30.4454] };
const ptsWide = { a: [-84.9000, 30.4400], b: [-84.9010, 30.4500], c: [-84.9020, 30.4600] };
const cur = Object.assign({}, pts);                         // what the markers report right now
const mk = (key, name) => ({ getLngLat: () => ({ lng: cur[key][0], lat: cur[key][1] }), _lastTs: Date.now(), _name: name });
const userMarkers = { ua: mk('a', 'A'), ub: mk('b', 'B'), uc: mk('c', 'C') };
const bounds = () => { const bb = new LngLatBounds(cur.a, cur.a); bb.extend(cur.b); bb.extend(cur.c); return bb; };

// How Mapbox places the camera, for the projection checks: the map centre sits at the centre of
// the PADDED viewport (EdgeInsets.getCenter), and screen y grows with normalized-Mercator y at
// 512 * 2^zoom px per world unit. This models the transform the fit is aimed at; the fit itself
// (centre and zoom) comes from the extracted _groupFollowTick.
const merc = (lat) => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const screenOf = (ll, gp, W, H, tgt) => {
  const cx = (gp.left + W - gp.right) / 2, cy = (gp.top + H - gp.bottom) / 2;
  const sc = 512 * Math.pow(2, tgt.zoom);
  return { x: cx + ((ll[0] - tgt.center.lng) / 360) * sc, y: cy + (merc(ll[1]) - merc(tgt.center.lat)) * sc };
};

const fns = new Function('window', 'document', 'map', 'mapboxgl', 'userMarkers', 'userId', 'metersApart', 'toast',
                         'followUid', 'stopFollowing', 'setTimeout', 'requestAnimationFrame', span)(
  win, doc, map, mapboxgl, userMarkers, 'me', metersApart, () => {}, undefined, undefined, () => 0, () => 0);

// Seed: one forced tick, as the locate button or room entry does.
fns._groupFollowTick(true);
check('seed: forced tick published a zoom target', !!win._gfTarget && typeof win._gfTarget.zoom === 'number',
      win._gfTarget ? `z=${win._gfTarget.zoom.toFixed(3)}` : '');

// Case A: no sheet, padding drifted to zero -> the tick puts the chrome padding back, once.
calls.length = 0;
classes.delete('member-open');
state.standing = { top: 0, bottom: 0, left: 0, right: 0 };
fns._groupFollowTick(false);
const fpA = fns._followPadding();
check('A: no sheet -> setPadding called exactly once', calls.length === 1, `calls=${calls.length}`);
check('A: ... with the exact _followPadding() values', calls.length === 1 && samePad(calls[0], fpA), calls[0] ? JSON.stringify(calls[0]) : '');
const zA = win._gfTarget.zoom;

// Case B: sheet open on a phone, sheet pad standing -> no re-assert; the fit goes inside it.
calls.length = 0;
classes.add('member-open');
state.standing = { top: 102, bottom: 354, left: 0, right: 0 };
fns._groupFollowTick(false);
check('B: sheet open -> setPadding NOT called', calls.length === 0, `calls=${calls.length}`);
const fpB = fns._followPadding();                       // same DOM the tick saw: #map-controls hidden
const fitB = win1._sheetFitPad(state.standing, fpB, 812);
const zBexp = fns._zoomForBounds(bounds(), fitB, 390, 812);
check('B: target zoom is the fit inside the sheet pad', near(win._gfTarget.zoom, zBexp), `got=${win._gfTarget.zoom.toFixed(6)} want=${zBexp.toFixed(6)}`);
check('B: ... lower than the no-sheet fit (sheet is taller than the toolbar)', win._gfTarget.zoom < zA, `B=${win._gfTarget.zoom.toFixed(3)} A=${zA.toFixed(3)}`);
check('B: debug string carries the sheet pad, not the toolbar pad',
      (win._gfDbg || '').includes(` pad=${Math.round(fitB.top)}/${Math.round(fitB.bottom)}/`), win._gfDbg);
check('B: standing padding left exactly as the sheet set it', samePad(state.standing, { top: 102, bottom: 354, left: 0, right: 0 }));
{ // where the phone's dots land through the sheet's transform: between the topbar and the sheet
  const scr = Object.values(cur).map((ll) => screenOf(ll, state.standing, 390, 812, win._gfTarget));
  const northY = Math.min(...scr.map((p) => p.y)), southY = Math.max(...scr.map((p) => p.y));
  check('B: northernmost dot is below the topbar', northY >= state.topbarH, `y=${northY.toFixed(1)} bar=${state.topbarH}`);
  check('B: southernmost dot is above the sheet', southY <= 812 - 330, `y=${southY.toFixed(1)} sheet top=${812 - 330}`);
}

// Case C: docked sheet on a wide window -> the 440px side is reserved as is, AND the top is floored
// at the chrome clearance. _sheetPad reserves nothing at the top on a window >= 700px, so before
// the floor the fit's top was the bare 30px marker reserve and a vertically spread group put its
// northernmost dot about 77px from the top: 8px past a 70px bar at 1000x800 (part of the 44px dot
// tucked under it) and fully behind a 139px bar at 768x1024 (portrait, column-layout topbar).
const layouts = [
  { W: 1000, H: 800, bar: 70, oldUnder: false },
  { W: 768, H: 1024, bar: 139, oldUnder: true },
];
for (const L of layouts) {
  const tag = `C ${L.W}x${L.H} bar ${L.bar}`;
  calls.length = 0;
  classes.add('member-open');
  Object.assign(cur, ptsWide);
  state.canvas = { clientWidth: L.W, clientHeight: L.H }; win.innerWidth = L.W; win.innerHeight = L.H; state.topbarH = L.bar;
  state.standing = { top: 0, left: 440, right: 0, bottom: 0 };          // what _sheetPad sets on a window >= 700px
  check(`${tag}: _sheetPad is the docked panel pad here`, samePad(fns._sheetPad(), state.standing), JSON.stringify(fns._sheetPad()));
  fns._groupFollowTick(false);
  const fpC = fns._followPadding();
  const fitC = win1._sheetFitPad(state.standing, fpC, L.H);
  const padC = (win._gfDbg || '').match(/ pad=(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  check(`${tag}: docked sheet -> setPadding NOT called`, calls.length === 0, `calls=${calls.length}`);
  check(`${tag}: debug pad reserves the 440px panel on the left`, !!padC && padC[3] === '440', win._gfDbg);
  check(`${tag}: debug pad top clears the topbar (>= bar + 12)`, !!padC && +padC[1] >= L.bar + 12, win._gfDbg);
  check(`${tag}: debug pad is the sheet pad plus reserves, top floored`,
        !!padC && +padC[1] === Math.round(fitC.top) && +padC[2] === Math.round(fitC.bottom) && +padC[4] === Math.round(fitC.right), win._gfDbg);
  check(`${tag}: standing padding left exactly as the sheet set it`, samePad(state.standing, { top: 0, left: 440, right: 0, bottom: 0 }));
  // Where the dots land. A forced tick publishes the raw fit (no dead-band, no zoom-in dwell), the
  // way the locate button does; project the group through the transform the sheet left standing.
  calls.length = 0;
  fns._groupFollowTick(true);
  check(`${tag}: forced tick -> still no setPadding`, calls.length === 0, `calls=${calls.length}`);
  const tgt = win._gfTarget;
  const zRaw = Math.min(fns._zoomForBounds(bounds(), fitC, L.W, L.H), 16);
  check(`${tag}: forced target is the fit inside the floored pad`, near(tgt.zoom, zRaw), `got=${tgt.zoom.toFixed(6)} want=${zRaw.toFixed(6)}`);
  check(`${tag}: the vertical band decides the zoom (below the 16 cap)`, tgt.zoom < 16, `z=${tgt.zoom.toFixed(3)}`);
  const scr = Object.values(cur).map((ll) => screenOf(ll, state.standing, L.W, L.H, tgt));
  const northY = Math.min(...scr.map((p) => p.y)), southY = Math.max(...scr.map((p) => p.y)), westX = Math.min(...scr.map((p) => p.x));
  check(`${tag}: northernmost dot lands at or below the topbar edge`, northY >= L.bar, `y=${northY.toFixed(1)} bar=${L.bar}`);
  check(`${tag}: southernmost dot stays on the canvas`, southY <= L.H, `y=${southY.toFixed(1)} H=${L.H}`);
  check(`${tag}: group sits to the right of the docked panel`, westX >= 440, `x=${westX.toFixed(1)}`);
  // Regression guard: the same fit with the unfloored top (the bare 30px reserve) through the same
  // transform -- where the dot sat before this round.
  const bare = Object.assign({}, fitC, { top: 30 });
  const zOld = Math.min(fns._zoomForBounds(bounds(), bare, L.W, L.H), 16);
  const oldNorthY = Math.min(...Object.values(cur).map((ll) => screenOf(ll, state.standing, L.W, L.H, { center: bounds().getCenter(), zoom: zOld }).y));
  check(`${tag}: regression guard: the floor moved the dot down`, northY > oldNorthY, `now=${northY.toFixed(1)} before=${oldNorthY.toFixed(1)}`);
  if (L.oldUnder) check(`${tag}: regression guard: the unfloored fit did go behind the bar`, oldNorthY < L.bar, `before=${oldNorthY.toFixed(1)} bar=${L.bar}`);
}

// Case D: closing the sheet hands the padding back to the chrome in ONE change, never zero.
Object.assign(cur, pts);
state.canvas = { clientWidth: 390, clientHeight: 812 }; win.innerWidth = 390; win.innerHeight = 812; state.topbarH = 90;
calls.length = 0;
classes.add('member-open');
const spy = [];
win._applyChromePadding = () => { spy.push({ memberOpen: classes.has('member-open') }); };
win._closeMemberSheet();
check('D: close -> _applyChromePadding called once', spy.length === 1, `calls=${spy.length}`);
check('D: ... after body.member-open was removed', spy.length === 1 && spy[0].memberOpen === false, JSON.stringify(spy[0] || null));
check('D: ... and setPadding never received all-zeros', !calls.some((p) => SIDES.every((k) => (p[k] || 0) === 0)), `setPadding=${JSON.stringify(calls)}`);
check('D: member-open is off after close', !classes.has('member-open'));
// A close before initMap has run: no _applyChromePadding yet -> the chrome padding goes on directly.
calls.length = 0;
classes.add('member-open');
win._applyChromePadding = undefined;
win._closeMemberSheet();
const fpD = fns._followPadding();                       // member-open is off, so #map-controls has height
check('D: no _applyChromePadding -> setPadding once with _followPadding()', calls.length === 1 && samePad(calls[0], fpD), JSON.stringify(calls[0] || null));

// EXTRA static guards (never the only check): the all-zeros reset on close is gone from the source,
// and the fit helper floors its top at the chrome clearance.
{
  const c0 = src.indexOf('window._closeMemberSheet = function');
  const c1 = src.indexOf('\n};', c0);
  const body = src.slice(c0, c1);
  check('static: _closeMemberSheet no longer zeroes the padding', !/setPadding\(\{\s*top:\s*0/.test(body));
  check('static: _closeMemberSheet goes through _applyChromePadding', body.includes('_applyChromePadding'));
  check('static: _sheetFitPad floors its top at fp.top', /top:\s*Math\.max\(top \+ RES_T \* k,\s*fp\.top \|\| 0\)/.test(slice));
}

console.log(fail ? `\n${fail} failing` : `\nall pass`);
process.exit(fail ? 1 : 0);
