// Build 1010: every callback is timed and the slowest go out in diag as `slow`; background
// time no longer counts as a frame gap.
//
// Usage:  node tools/stallprobe1010.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
const probe = idx.indexOf('window._stall = { worst: [] }');
ok(probe > 0 && probe < idx.indexOf('mapbox-gl.js"></script>'), 'probe installed before Mapbox loads');
ok(idx.includes("window.requestAnimationFrame = function (cb) { return raf.call(window, wrap(cb, 'frame')); };"), 'frames timed');
ok(idx.includes("return rem.call(this, type, (typeof fn === 'function' && cache.get(fn)) || fn, opt);"), 'removeEventListener still finds the wrapped listener');
ok((idx.match(/fbOnValue = window\._timedOnValue \? window\._timedOnValue\(/g) || []).length === 2, 'both Firebase hookups timed');
ok(idx.includes('var gap = document.hidden ? 0 : t - last; last = t;'), 'background time is not a freeze');
ok(idx.includes('        slow: (function () {'), 'diag reports slow');
// Run the probe against stubs: a slow timer is recorded, a fast one is not, removal works.
const a = idx.indexOf('<script>\n// 1010: STALL PROBE'), b = idx.indexOf('</script>', a);
const code = idx.slice(a + 8, b);
let now = 0; const pending = []; const listeners = new Set();
class ET { addEventListener(t, f) { listeners.add(f); } removeEventListener(t, f) { listeners.delete(f); } }
const win = { requestAnimationFrame: f => f, setTimeout: (f) => { pending.push(f); return 1; }, setInterval: () => 2 };
const ctx = { window: win, performance: { now: () => now }, EventTarget: ET, WebSocket: function () {}, WeakMap, Date };
new Function(...Object.keys(ctx), code)(...Object.values(ctx));
win.setTimeout(function slowOne() { now += 500; });
win.setTimeout(function fastOne() { now += 5; });
pending.forEach(f => f());
ok(win._stall.worst.length === 1 && win._stall.worst[0].l === 'timer:slowOne' && win._stall.worst[0].ms === 500, 'slow timer recorded by name: ' + JSON.stringify(win._stall.worst));
const t = new ET(); const h = () => {}; t.addEventListener('click', h); t.removeEventListener('click', h);
ok(listeners.size === 0, 'listener removed through the wrapper');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
