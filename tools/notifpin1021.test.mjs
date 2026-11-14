// Build 1021: a pin notification carries the pin, and the receiving phone draws it at once.
import { readFileSync } from 'node:fs';
const idx = readFileSync(((process.argv[2] || 'public').replace(/\/$/, '')) + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes("'&pc=' + encodeURIComponent(cat || '') + '&pl=' + encodeURIComponent(label || '') +"), 'link carries the pin');
ok(!/'&pt=' \+ Date\.now\(\)/.test(idx), 'no timestamp to defeat the server duplicate check');
ok(idx.includes("try { window._showNotifPin(window._pinFromNotifUrl(data.url)); } catch (e) {}   // 1021"), 'drawn on arrival or tap in the same room');
ok(idx.includes("{ location.href = data.url; return; }"), 'carried through a room switch');
ok(idx.includes("if (window._pendingPinShow) { try { window._showNotifPin(window._pendingPinShow); }"), 'drawn on room entry from the link');
// helper behaviour, run on its own
const a = idx.indexOf('window._pinFromNotifUrl = function'), b = idx.indexOf('// Draw a notified pin now.');
const f = new Function('window', 'URLSearchParams', '_parsePinParam', idx.slice(a, b) + '; return window._pinFromNotifUrl;');
const pp = (v) => { const [la, ln] = String(v || '').split(',').map(Number); return isFinite(la) && isFinite(ln) ? { lat: la, lng: ln } : null; };
const get = f({}, URLSearchParams, pp);
const r = get('/?room=our_crew&pin=30.1,-84.9&pc=Hazard&pl=Gate%20open&pb=Jace');
ok(r && r.lat === 30.1 && r.cat === 'Hazard' && r.label === 'Gate open' && r.name === 'Jace', 'parses the pin: ' + JSON.stringify(r));
ok(get('/?room=our_crew&pin=30.1,-84.9') === null, 'old notifications (spot only) are left alone');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
