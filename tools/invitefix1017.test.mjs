// Build 1017: notification taps are heard from launch; accepting a crew invite writes membership as
// the signed-in account; the Add-people search keeps names above the keyboard.
//
// Usage:  node tools/invitefix1017.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
const wire = idx.indexOf('window._wireFcmTaps = function'), reg = idx.indexOf('async function _registerFcm(silent)');
ok(wire > 0 && wire < reg && idx.includes("try { window._wireFcmTaps(); } catch (e) {}\ndocument.addEventListener('DOMContentLoaded'"), 'tap listener wired at page load');
ok((idx.match(/addListener\('notificationActionPerformed'/g) || []).length === 1, 'exactly one tap listener (no double handling)');
ok(idx.includes("if (_au) { try { f.set(f.ref(f.db, 'gl/' + inv.key + '/members/' + _au), _mrec)"), 'membership written as the signed-in account');
ok(idx.includes('onfocus="window._invitePickerCompact(true)"'), 'search box compacts the picker');
ok(idx.includes("window.visualViewport.addEventListener('resize', fit)"), 'picker height follows the keyboard');
ok((idx.match(/try \{ window\._invitePickerCompact\(false\); \} catch \(e\) \{\}/g) || []).length >= 3, 'reset on open (both pickers) and close');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
