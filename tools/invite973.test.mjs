// Exercises build 973's invite and phone-browser changes by cutting the real functions out of
// the page and running them with fakes, rather than re-stating what they are meant to do.
//
//   - a link tapped with the app installed keeps the room key (ik), so nobody waits for approval
//   - groundlink://join?room=&ik= (the website's "Open in the app" button) lands in the crew
//   - a share waits for the room key instead of sending a link without it
//   - the Invite button records the name it showed, and turns into "Invited ✓"
//   - a phone on the website that went quiet reads WEBSITE ONLY, not SIGNAL LOST / PARKED
//   - iPhone browsers get the install screen with no way past; Android gets a way through;
//     the app itself and computers get nothing
//
// Usage:  node tools/invite973.test.mjs [origin | path/to/index.html]
import { readFileSync, existsSync } from 'node:fs';
const arg = process.argv[2] || 'https://tracker-production-3b03.up.railway.app';
const src = existsSync(arg) ? readFileSync(arg, 'utf8')
  : await (await fetch(`${arg}/index.html?raw=${Math.random()}`)).text();

// Brace-walk from `head` to its matching close, skipping strings and comments.
function cut(head) {
  const a = src.indexOf(head);
  if (a < 0) throw new Error('not in page: ' + head);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced: ' + head);
}

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

// ── 1. deep links ──────────────────────────────────────────────────────────────────────
{
  const fn = cut('function applyDeepLink(url) {');
  const run = (url, here = '/') => {
    let went = null;
    const window = { location: { pathname: here.split('?')[0], search: here.includes('?') ? '?' + here.split('?')[1] : '', replace: (t) => { went = t; } } };
    new Function('window', 'url', fn + '\napplyDeepLink(url);')(window, url);
    return went;
  };
  const w = run('https://tracker-production-3b03.up.railway.app/j/outkasts?ik=AbC123xyz789');
  ok(w && /room=outkasts/.test(w) && /ik=AbC123xyz789/.test(w), 'universal link /j/ keeps the room key: ' + w);
  const w2 = run('https://tracker-production-3b03.up.railway.app/?room=outkasts&k=MTIz&ik=KEYKEYKEYKEY');
  ok(w2 && /k=MTIz/.test(w2) && /ik=KEYKEYKEYKEY/.test(w2), 'query link keeps passcode and room key');
  const w3 = run('groundlink://join?room=outkasts&ik=KEYKEYKEYKEY');
  ok(w3 === '/?room=outkasts&ik=KEYKEYKEYKEY', 'groundlink://join lands in the crew with its key: ' + w3);
  ok(run('groundlink://open') === null, 'groundlink://open just opens the app');
  ok(run('https://tracker-production-3b03.up.railway.app/j/outkasts') === '/?room=outkasts', 'a link with no key still works');
}

// ── 2. share waits for the key ─────────────────────────────────────────────────────────
{
  const fn = cut('function _withInviteKey(target, fn) {');
  const mk = (keys, ensure) => {
    const window = { _inviteKeys: keys, _ensureInviteKey: ensure };
    const timers = [];
    const f = new Function('window', 'setTimeout', fn + '\nreturn _withInviteKey;')(window, (cb, ms) => timers.push(cb));
    return { f, window, timers };
  };
  // key already there: runs at once
  { const h = mk({ outkasts: 'K' }, () => { throw new Error('should not fetch'); }); let ran = 0; h.f('outkasts', () => ran++); ok(ran === 1, 'key present: shares immediately'); }
  // key missing: waits for the fetch, runs exactly once
  {
    let resolve; const p = new Promise((r) => { resolve = r; });
    const h = mk({}, () => p.then(() => { h.window._inviteKeys.outkasts = 'K'; }));
    let ran = 0; h.f('outkasts', () => ran++);
    ok(ran === 0, 'key missing: does not share before the key arrives');
    resolve(); await p; await null; await null;
    ok(ran === 1, 'key missing: shares once the key arrives');
    h.timers.forEach((t) => t());
    ok(ran === 1, 'the 3 s fallback does not share a second time');
  }
  // fetch hangs: the fallback still shares
  { const h = mk({}, () => new Promise(() => {})); let ran = 0; h.f('outkasts', () => ran++); h.timers.forEach((t) => t()); ok(ran === 1, 'a hung fetch still shares after the fallback'); }
}

// ── 3. invite name and button ──────────────────────────────────────────────────────────
{
  const code = cut('function _inviteeName(uid, btn) {') + '\n' + cut('function _markInvited(roomKey, uid, btn) {') + '\nreturn { _inviteeName, _markInvited };';
  const window = { _presenceAll: {}, _mySessions: {} };
  const { _inviteeName, _markInvited } = new Function('window', '_getFriends', code)(window, () => ({}));
  const btn = { attrs: { 'data-name': 'Elijah Spikes' }, getAttribute(k) { return this.attrs[k]; }, style: {} };
  ok(_inviteeName('rqY', btn) === 'Elijah Spikes', 'name comes from the row that was tapped');
  ok(_inviteeName('rqY', null) === 'them', 'with nothing to go on it still falls back');
  window._presenceAll.abc = { name: 'Jay Evans' };
  ok(_inviteeName('abc', null) === 'Jay Evans', 'presence name still used when no button');
  _markInvited('outkasts', 'rqY', btn);
  ok(btn.disabled === true && /Invited/.test(btn.textContent), 'button turns into Invited ✓ and is disabled');
  ok(window._invitedNow && window._invitedNow['outkasts|rqY'] === 1, 'remembered so a re-render keeps it');
  // the picker row renders the sent state
  const row = src.slice(src.indexOf("var _sentAlready ="), src.indexOf("var _sentAlready =") + 400);
  ok(/_invitedNow/.test(row) && /pending/.test(row), 'picker rows read the sent state');
  ok(src.includes(`'\\', this)" style=`), 'Invite button passes itself so it can change');
}

// ── 4/5. website-only presence ────────────────────────────────────────────────────────
{
  ok(/plat: _isNativeApp\(\) \? 'app' : 'web'/.test(src), 'every fix says app or web');
  const LIVE = (src.match(/var LIVE_MS = ([^;]+);/) || [])[1];
  const code = 'var LIVE_MS = ' + (LIVE || '120000') + ';\nvar PARKED_MAX_MS = 8*3600e3;\nvar window = {};\n' +
    'window._presenceHealth = ' + cut('window._presenceHealth = function (data) {').replace(/^window\._presenceHealth = /, '') + ';\n' +
    'var _presenceOf = ' + cut('window._presenceOf = function (uid, data) {').replace(/^window\._presenceOf = /, '') + ';\nreturn _presenceOf;';
  const P = new Function(code)();
  const now = Date.now();
  const page = { lat: 30.5, lng: -84.8, fixTs: now - 14 * 60e3, spd: 68, plat: 'web', dev: 'phone' };
  const r = P('IbjZ', page);
  ok(r.label === 'WEBSITE ONLY' && /website/i.test(r.line), 'Page (website, driving, 14 min quiet) reads WEBSITE ONLY: ' + r.label);
  ok(P('x', { ...page, spd: 0 }).label === 'WEBSITE ONLY', 'website + parked does not claim PARKED');
  ok(P('x', { ...page, fixTs: now - 5e3 }).key === 'live', 'website while open is still LIVE');
  ok(P('x', { ...page, plat: 'app' }).label === 'SIGNAL LOST', 'the app at speed is still SIGNAL LOST');
  ok(P('x', { ...page, dev: 'PC' }).label !== 'WEBSITE ONLY', 'a computer is not told to install the app');
  ok(P('x', { ...page, plat: undefined }).label === 'SIGNAL LOST', 'older rows with no plat are unchanged');
}

// ── 6/7. phone browser screen ─────────────────────────────────────────────────────────
{
  const code = 'var GL_APPSTORE_URL = "https://apps.apple.com/us/app/groundlink-family/id6790179901";\nvar GL_PLAY_TEST_URL = "https://play.google.com/apps/testing/com.groundlink.app";\n' +
    'window._phoneBrowserKind = ' + cut('window._phoneBrowserKind = function () {').replace(/^window\._phoneBrowserKind = /, '') + ';\n' +
    'window._showGetAppScreen = ' + cut('window._showGetAppScreen = function (kind) {').replace(/^window\._showGetAppScreen = /, '') + ';';
  const esc = (src.match(/function escapeHtmlJs\(s\) \{[^\n]*\n/) || [])[0];
  const h = (ua, native, search) => {
    const body = [];
    const els = {};
    const document = {
      body: { appendChild(e) { body.push(e); els[e.id] = e; } },
      createElement() { return { style: {}, setAttribute() {}, remove() { body.splice(body.indexOf(this), 1); delete els[this.id]; } }; },
      getElementById(id) { if (id === 'get-app-continue') { const g = els['get-app-gate']; return g && /get-app-continue/.test(g.innerHTML) ? (g._c ||= {}) : null; } return els[id] || null; },
    };
    const window = { location: { search } };
    const ss = {};
    new Function('window', 'document', 'navigator', '_isNativeApp', 'URLSearchParams', '_prettyGroup', 'sessionStorage', esc + code)(
      window, document, { userAgent: ua }, () => native, URLSearchParams, (k) => k === 'outkasts' ? 'Outkasts' : k,
      { setItem: (k, v) => { ss[k] = v; }, getItem: (k) => ss[k] || null });
    return { window, body, els, ss };
  };
  const IPH = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const AND = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
  ok(h(IPH, false, '').window._phoneBrowserKind() === 'ios', 'iPhone Safari is an iPhone browser');
  ok(h(IPH + ' GroundLinkNative', true, '').window._phoneBrowserKind() === '', 'the iPhone app is not');
  ok(h(AND, false, '').window._phoneBrowserKind() === 'android', 'Android Chrome is an Android browser');
  ok(h('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130 Safari/537.36', false, '').window._phoneBrowserKind() === '', 'an Android tablet is left alone');
  ok(h('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', false, '').window._phoneBrowserKind() === '', 'a computer is left alone');

  const ios = h(IPH, false, '?room=outkasts&ik=KEYKEYKEYKEY');
  ios.window._showGetAppScreen('ios');
  const g = ios.els['get-app-gate'];
  ok(g && /Get the app to join Outkasts/.test(g.innerHTML), 'iPhone screen names the crew');
  ok(/apps\.apple\.com\/us\/app\/groundlink-family\/id6790179901/.test(g.innerHTML), 'App Store button');
  ok(g.innerHTML.includes('groundlink://join?room=outkasts&ik=KEYKEYKEYKEY'), 'Open in the app carries the room and key');
  ok(!/get-app-continue/.test(g.innerHTML), 'iPhone has no way past');
  ok(/inset:0/.test(g.style.cssText), 'full screen');

  const an = h(AND, false, '?room=outkasts');
  an.window._showGetAppScreen('android');
  ok(/play\.google\.com\/apps\/testing\/com\.groundlink\.app/.test(an.els['get-app-gate'].innerHTML), 'Android points at the tester sign-up');
  const c = an.els['get-app-gate']._c || (an.els['get-app-gate']._c = {});
  an.document = null;
  // the continue button was wired on the element returned by getElementById
  ok(typeof (an.els['get-app-gate']._c.onclick) === 'function', 'Android has "Use the website for now"');
  an.els['get-app-gate']._c.onclick();
  ok(!an.els['get-app-gate'] && an.ss.gl_web_ok === '1', 'continuing hides it for this visit');

  // the gate runs first thing in tryResume, and iPhone returns before any session resumes
  const tr = src.slice(src.indexOf('(function tryResume() {'), src.indexOf('(function tryResume() {') + 900);
  ok(/if \(_pbk === 'ios'\) \{ window\._showGetAppScreen\('ios'\); return; \}/.test(tr) && tr.indexOf("_pbk === 'ios'") < tr.indexOf('getSavedSession()'), 'iPhone browser stops before resuming a session');
}

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
