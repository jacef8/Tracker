// Exercises the shipped location fix screen (build 972) by cutting the real _locProblems,
// _showLocNudgeCard and _checkLocNudge out of the page and running them against a fake DOM,
// rather than re-stating what they are supposed to do.
//
// Apple writes its own permission popup and lets an app open only GroundLink's top page in
// Settings, so when a phone drops to While Using the app shows its own full screen with the two
// remaining taps. "Not now" must hide it for this visit only, and the screen must vanish on its
// own the moment the phone reports Always.
//
// Usage:  node tools/locfix.test.mjs [origin | path/to/index.html]
import { readFileSync, existsSync } from 'node:fs';
const arg = process.argv[2] || 'https://tracker-production-3b03.up.railway.app';
const src = existsSync(arg) ? readFileSync(arg, 'utf8')
  : await (await fetch(`${arg}/index.html?raw=${Math.random()}`)).text();

const a = src.indexOf('window._locProblems = function');
const endMark = "if (document.hidden) window._locFixNotNow = false; }); } catch (e) {}";
const b = src.indexOf(endMark);
if (a < 0 || b < 0) { console.error('FAIL — fix screen not in the page'); process.exit(1); }
const code = src.slice(a, b + endMark.length);
const esc = (src.match(/function escapeHtmlJs\(s\) \{[^\n]*\n/) || [])[0];

function harness(ua) {
  const body = [];
  const listeners = {};
  const store = {};
  const mkEl = () => {
    const el = {
      id: '', attrs: {}, style: {}, innerHTML: '', _btn: {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      querySelector(sel) { const id = sel.replace('#', ''); return (this._btn[id] ||= { id, onclick: null }); },
      remove() { const i = body.indexOf(this); if (i >= 0) body.splice(i, 1); },
    };
    Object.defineProperty(el.style, 'cssText', { set() {}, get() { return ''; } });
    return el;
  };
  const document = {
    hidden: false, body: { appendChild(el) { body.push(el); } },
    createElement: mkEl,
    getElementById(id) { const el = body.find((e) => e.id === id); if (!el) return null;
      // The card wires buttons via getElementById; hand back the element's own button.
      return el; },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
  };
  // Buttons looked up by id from the document (card path) resolve to the last element's button.
  const origGet = document.getElementById;
  document.getElementById = (id) => {
    if (id === 'loc-nudge') return origGet(id);
    const el = body[body.length - 1]; return el ? el.querySelector('#' + id) : null;
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  };
  const window = { opened: 0 };
  window.GLOpenSettings = () => { window.opened++; return true; };
  new Function('window', 'document', 'localStorage', 'navigator', `${esc}\n${code}`)(
    window, document, localStorage, { userAgent: ua });
  const fire = (t) => (listeners[t] || []).forEach((f) => f());
  const screen = () => body.find((e) => e.id === 'loc-nudge');
  return { window, document, store, body, fire, screen };
}

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';

// 1. While Using: full screen with three numbered steps, the Always Allow advice, and the button.
{
  const h = harness(IPHONE);
  h.window._iosSettings = { locWhenInUse: true, locAlways: false, authDowns: 1 };
  h.window._checkLocNudge();
  const s = h.screen();
  ok(s, 'While Using shows a screen');
  ok(s && s.getAttribute('data-k') === 'whenInUse', 'it is the full screen, keyed whenInUse');
  ok(s && /inset:0/.test(s.style.cssText || 'inset:0'), 'full screen');
  ok(s && /Tap <b>Location<\/b>/.test(s.innerHTML) && /Tap <b>Always<\/b>/.test(s.innerHTML), 'steps name Location then Always');
  ok(s && /Always Allow/.test(s.innerHTML), 'tells them which button to tap on Apple\'s reminder');
  ok(s && /turned off background sharing/.test(s.innerHTML), 'title from the problem');
  s.querySelector('#loc-fix-open').onclick();
  ok(h.window.opened === 1, 'gold button opens Settings');
  // Called again with the same problem: no duplicate, no rebuild.
  h.window._checkLocNudge();
  ok(h.body.filter((e) => e.id === 'loc-nudge').length === 1, 'no duplicate screen on recheck');
  // Phone reports Always -> screen disappears by itself.
  h.window._iosSettings = { locWhenInUse: false, locAlways: true };
  h.window._checkLocNudge();
  ok(!h.screen(), 'screen goes away once the phone reports Always');
}

// 2. Not now: hidden for this visit, back after the app is left and reopened.
{
  const h = harness(IPHONE);
  h.window._iosSettings = { locWhenInUse: true, locAlways: false };
  h.window._checkLocNudge();
  h.screen().querySelector('#loc-fix-later').onclick();
  ok(!h.screen(), 'Not now hides it');
  h.window._checkLocNudge();
  ok(!h.screen(), 'stays hidden for the rest of this visit');
  h.document.hidden = true; h.fire('visibilitychange');
  h.document.hidden = false; h.window._checkLocNudge();
  ok(h.screen(), 'comes back on the next open');
  ok(!Object.keys(h.store).some((k) => k.startsWith('gl_locnudge_whenInUse')), 'no multi-day snooze stored');
}

// 3. I changed it: hides and clears the measured-failure evidence.
{
  const h = harness(IPHONE);
  h.store.gl_bg_fails = '3'; h.store.gl_bg_spots = '[1,2]';
  h.window._checkLocNudge();
  ok(h.screen() && h.screen().getAttribute('data-k') === 'bg', 'measured failure gets the full screen on iPhone');
  h.screen().querySelector('#loc-fix-done').onclick();
  ok(!h.screen(), 'I changed it hides it');
  ok(h.store.gl_bg_fails === '0' && !('gl_bg_spots' in h.store), 'evidence cleared');
}

// 4. Denied gets the full screen too.
{
  const h = harness(IPHONE);
  h.window._iosSettings = { locDenied: true };
  h.window._checkLocNudge();
  ok(h.screen() && h.screen().getAttribute('data-k') === 'denied', 'denied -> full screen');
}

// 5. Minor problems keep the small card (no data-k, has Later / I fixed it).
{
  const h = harness(IPHONE);
  h.window._iosSettings = { locAlways: true, precise: false };
  h.window._checkLocNudge();
  const s = h.screen();
  ok(s && !s.getAttribute('data-k'), 'precise-location problem keeps the small card');
  s.querySelector('#loc-nudge-later').onclick();
  ok(/^\d+$/.test(h.store.gl_locnudge_precise || ''), 'card Later still snoozes a day');
}

// 6. Android and the plain browser (no GLOpenSettings) keep the card.
{
  const h = harness('Mozilla/5.0 (Linux; Android 14)');
  h.store.gl_bg_fails = '3';
  h.window._checkLocNudge();
  ok(h.screen() && !h.screen().getAttribute('data-k'), 'Android keeps the card');
  const w = harness(IPHONE);
  delete w.window.GLOpenSettings;
  w.window._iosSettings = { locWhenInUse: true, locAlways: false };
  w.window._checkLocNudge();
  ok(w.screen() && !w.screen().getAttribute('data-k'), 'no Settings bridge -> card');
}

// 7. Nothing wrong: nothing shown.
{
  const h = harness(IPHONE);
  h.window._iosSettings = { locAlways: true };
  h.window._checkLocNudge();
  ok(!h.screen(), 'healthy phone shows nothing');
}

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
