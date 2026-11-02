// Build 1000: starting a follow is one smooth camera move, not three that cancel each other.
//
// Usage:  node tools/followstart1000.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(!idx.includes('try { window._spiderfy(uid, _grpMembers); } catch (e) {}'), 'group tap no longer bursts open and snaps shut');
ok(idx.includes('if (mk._ll && !mk._isLive) {'), 'person card: live people get only the follow move');
ok(idx.includes('if (!primaryMk._isLive) {'), 'group card: same');
ok(idx.includes('window._followEaseUntil = Date.now() + _fo.duration + 20;'), 'the first move is allowed to finish');
ok(idx.includes("&& Date.now() >= (window._followEaseUntil || 0)"), 'frame loop waits for it');
ok(idx.includes('_cc = { uid: marker._uid, t: _cn - 16, lng: _mc.lng, lat: _mc.lat };'), 'and eases in from where the camera is');
ok(idx.includes('window._followEaseUntil = Date.now() + 420;'), 'post-pinch re-centre also finishes');
ok(idx.includes('var c = map.project(map.getCenter());'), 'off-centre measured from the padded centre');
ok(idx.includes('if (!(_gm && _gm._anim) && _isOffCenter(target))'), '3 s tick leaves a gliding dot to the frame loop');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
