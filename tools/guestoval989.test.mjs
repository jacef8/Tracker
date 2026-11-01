// Build 989: the People list tags guests, and a merged oval floats above its group with a line
// and a dot on the group's true spot.
//
// Usage:  node tools/guestoval989.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

// 1. Guest flag is reported and shown.
ok(idx.includes('guest: (window._isGuestDevice && window._isGuestDevice()) ? 1 : 0,'), 'every real fix says whether this device is a guest');
ok(idx.split('hidden: true, guest: (window._isGuestDevice').length - 1 === 3, 'the no-GPS heartbeats carry it too (they replace the whole row)');
ok(idx.split("(window._guestBadge ? window._guestBadge(data) : '') +").length - 1 === 3, 'People row, member card and person sheet all show the tag');
const gb = new Function('var window = {};\n' + idx.slice(idx.indexOf('window._guestBadge = function'), idx.indexOf('window._setCallout = function')) + '\nreturn window._guestBadge;')();
ok(/GUEST/.test(gb({ guest: 1 })) && gb({ guest: 0 }) === '' && gb({}) === '', 'tag only for guest:1 -- an old row with no flag shows nothing');

// 2. Merged oval callout.
ok(/var MK_MERGE_LIFT = 46;/.test(idx), 'the oval floats 46px up on a map-pin point (992)');
ok(/if \(mk\._mergedOval\) on = true;/.test(idx), 'the spread pass can no longer set the oval back on the ground');
ok(/mk\._mergedOval = true;\s*try \{ window\._setCallout\(mk, true\); \} catch \(e\) \{\}\s*_setGroupBadge/.test(idx), 'merging marks the oval');
ok(/function _applyMarkerSolo\(mk\) \{\s*if \(mk && mk\._mergedOval\) \{ mk\._mergedOval = false;/.test(idx), 'splitting drops it back to a plain dot');
// 991: the stem is part of the oval (it moved off the map layer, which lagged a moving oval).
ok(/stem\.className = 'mk-stem'/.test(idx) && /var len = MK_MERGE_LIFT - 19;/.test(idx), 'stem + dot are children of the oval');
ok(!/_groupLeaderFeats\(\)/.test(idx) && !/grpdot/.test(idx), 'the lagging map-layer line is gone');
ok(/if \(v\.mk && v\.mk\._mergedOval\) \{ ml = ''; mt = ''; \}/.test(idx), 'the spread pass no longer bends the stem sideways');
ok(/if \(v\.mk && v\.mk\._mergedOval\) return;/.test(idx), 'an oval does not also get a spread leader to one member');
ok(/var _skip = immediate === 'zoom' \|\| \(immediate && !_splits\);/.test(idx), 'a group only splits after the debounce...');
ok(/_updateMarkerGrouping\(window\._gfCamDriving \? true : 'zoom'\)/.test(idx), '...unless the person zoomed themselves');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
