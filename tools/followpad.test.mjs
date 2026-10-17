// The vertical clamp in _followPadding, extracted from index.html and exercised directly.
// Build 950 fixed a case where the clamp scaled the top padding BELOW the height of the
// topbar, which put a member behind the bar and cut the top off their pin.
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');
const a = src.indexOf('window._clampVertPad = function');
const b = src.indexOf('function _followPadding()', a);
if (a < 0 || b < 0) { console.error('could not extract _clampVertPad'); process.exit(1); }
const win = {};
new Function('window', src.slice(a, b))(win);

let fail = 0;
const check = (name, got, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
};

// The reported case: a phone, a two-row topbar, the bottom toolbar.
{
  const ch = 812, chromeTop = 190, chromeBottom = 110;
  const top = chromeTop + 12 + 30, bottom = chromeBottom + 12 + 125;
  const r = win._clampVertPad(top, bottom, chromeTop, chromeBottom, ch);
  check('phone: top padding never goes under the topbar', r,
        r.top >= chromeTop, `top=${r.top.toFixed(0)} (bar ${chromeTop}) bottom=${r.bottom.toFixed(0)}`);
  check('phone: stays inside the 45% budget', r,
        r.top + r.bottom <= ch * 0.45 + 0.5, `sum=${(r.top + r.bottom).toFixed(0)} budget=${(ch * 0.45).toFixed(0)}`);
  check('phone: bottom padding never goes under the toolbar', r,
        r.bottom >= chromeBottom, `bottom=${r.bottom.toFixed(0)} (bar ${chromeBottom})`);
}
// Roomy desktop: nothing should be touched at all.
{
  const ch = 1400, chromeTop = 90, chromeBottom = 100;
  const top = chromeTop + 42, bottom = chromeBottom + 137;
  const r = win._clampVertPad(top, bottom, chromeTop, chromeBottom, ch);
  check('desktop: padding is left exactly as asked', r,
        r.top === top && r.bottom === bottom, `top=${r.top} bottom=${r.bottom}`);
}
// Pathological: the bars alone exceed the budget. Must still return something legal.
{
  const ch = 500, chromeTop = 200, chromeBottom = 180;
  const r = win._clampVertPad(chromeTop + 30, chromeBottom + 125, chromeTop, chromeBottom, ch);
  check('tiny screen: still inside the budget rather than throwing', r,
        r.top + r.bottom <= ch * 0.45 + 0.5, `sum=${(r.top + r.bottom).toFixed(0)} budget=${(ch * 0.45).toFixed(0)}`);
}
// The old behaviour, asserted as a regression guard: proportional scaling DID go under the bar.
{
  const ch = 812, chromeTop = 190, chromeBottom = 110;
  const top = chromeTop + 42, bottom = chromeBottom + 137;
  const sy = (ch * 0.45) / (top + bottom);
  check('regression guard: the old proportional clamp did go under the bar', null,
        top * sy < chromeTop, `old top would be ${(top * sy).toFixed(0)} vs bar ${chromeTop}`);
}
console.log(fail ? `\n${fail} failing` : `\nall pass`);
process.exit(fail ? 1 : 0);
