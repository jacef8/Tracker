// Build 986: the pin sheet opens on a top-5, the outbox writes each pin under one fixed key,
// and the worker opens the app page from the phone.
//
// Usage:  node tools/pinfav986.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
const sw = readFileSync(dir + '/sw.js', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

function cut(src, head) {
  const a = src.indexOf(head); if (a < 0) throw new Error('missing ' + head);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '"' || c === "'" || c === '`') { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(a, i + 1);
  }
}

// 1. Top-5 logic, run for real against a fake localStorage.
const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const PIN_DEFS = Object.fromEntries(['Waypoint', 'Deer Stand', 'Hazard', 'Vehicle', 'Meeting Point', 'Hog', 'Feeder', 'Custom'].map((k) => [k, {}]));
const defs = idx.slice(idx.indexOf('var PIN_FAV_DEFAULTS'), idx.indexOf('window._togglePinFav'));
const pinFavs = new Function('localStorage', 'PIN_DEFS', 'var window = {};\n' + defs + '\nreturn window._pinFavs;')(localStorage, PIN_DEFS);
ok(JSON.stringify(pinFavs()) === JSON.stringify(['Waypoint', 'Deer Stand', 'Hazard', 'Vehicle', 'Meeting Point']), 'no history: the default five');
store.gl_pin_use = JSON.stringify({ Hog: 9, Feeder: 4, Gone: 50 });
ok(JSON.stringify(pinFavs()) === JSON.stringify(['Hog', 'Feeder', 'Waypoint', 'Deer Stand', 'Hazard']), 'most-dropped first, unknown types ignored, topped up from defaults');
store.gl_pin_favs = JSON.stringify(['Custom', 'Hog']);
ok(JSON.stringify(pinFavs()) === JSON.stringify(['Custom', 'Hog']), 'a chosen set wins, even under five');
store.gl_pin_favs = JSON.stringify(['Hog', 'Feeder', 'Waypoint', 'Hazard', 'Vehicle', 'Custom', 'Deer Stand']);
ok(pinFavs().length === 5, 'never more than five');

// 2. Sheet wiring.
ok(/<div id="pin-favs"/.test(idx) && /<div id="pin-more-wrap" style="display:none">/.test(idx), 'favourites row first, full list hidden behind More');
ok(/window\._setPinMore\(false\);\s*window\._markPinCat\(/.test(cut(idx, 'window._openPinAt = function')), 'a new drop opens collapsed with a favourite chosen');
ok(/window\._setPinMore\(true\)/.test(cut(idx, 'window.editPin = function')), 'edit opens the full list');
ok(/if \(!_editingPid\) window\._notePinUse\(selectedCat\)/.test(idx), 'only new drops count toward the default five');
ok(/!e\.target\.closest\('\.cat-star'\)/.test(idx), 'a star tap does not count as choosing that type');

// 3. Outbox: a retry rewrites the same pin.
const flush = cut(idx, 'window._flushOutbox = function');
ok(/item\.key = fbPush\(/.test(flush) && /_setOutbox\(_cur\)/.test(flush), 'each queued pin is named once and the name is saved before uploading');
ok(/fbRef\(db, 'gl\/' \+ item\.room \+ '\/pins\/' \+ item\.key\)/.test(flush), 'upload writes to the saved name');

// 4. Worker: app page from the phone, refreshed behind it, never an error page.
ok(/const PAGE_CACHE = 'gl-page'/.test(sw) && /k !== PAGE_CACHE/.test(sw), 'page copy survives worker updates');
ok(/if \(have\) return have;/.test(sw), 'a saved page is served at once');
ok(/if \(!b\) return resp;/.test(sw), 'a page without a build number is never saved');
ok(/type: 'gl-new-build'/.test(sw) && /d\.type !== 'gl-new-build'/.test(idx), 'a new build is announced and heard');
ok(/gl_nb_reload/.test(idx), 'switching builds is limited to once per two minutes');

// 5. The map starts before sign-in.
const early = idx.indexOf("// 986: start the map now.");
ok(early > 0 && early < idx.indexOf('waitForFirebase(async fb => {\n    db = fb.db;'), 'initMap runs ahead of the Firebase wait');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
