// Build 998: an open "N PEOPLE TOGETHER" card follows the group when it splits.
//
// Usage:  node tools/groupsheet998.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };

ok(idx.includes("try { window._refreshOpenGroupSheet(); } catch (e) {}"), 'every grouping pass checks the open card');
ok(idx.includes('window._openGroupUids = uids.slice();'), 'the card remembers its group');
ok(/if \(quiet\) return;\s+\/\/ 998: a redraw/.test(idx) && /if \(quiet\) return;\s+\/\/ 998: swapped in/.test(idx), 'a redraw leaves the camera alone');

const src = idx.slice(idx.indexOf('window._refreshOpenGroupSheet = function'), idx.indexOf('// ── SPIDERFY: fan a merged cluster out'));
const run = (open, groups, follow) => {
  const calls = [];
  const window = {
    _openGroupUids: open, _markerGroupMembers: groups,
    _showGroupedMemberSheet: (u, q) => calls.push(['group', u.slice().sort().join(','), q]),
    _showMemberSheet: (u, q) => calls.push(['one', u, q]),
    _closeMemberSheet: () => calls.push(['close']),
  };
  const document = { getElementById: () => ({ style: { display: 'block' } }) };
  new Function('window', 'document', 'followUid', 'userMarkers', src + '\nwindow._refreshOpenGroupSheet();')(window, document, follow, { a: {}, b: {}, c: {} });
  return calls;
};
ok(run(['a', 'b', 'c'], { a: ['a', 'b', 'c'] }, 'a').length === 0, 'no change, no redraw');
const s1 = run(['a', 'b', 'c'], { a: ['a', 'b'] }, 'a');
ok(s1.length === 1 && s1[0][0] === 'group' && s1[0][1] === 'a,b' && s1[0][2] === true, 'Vanesa splits off: card shows Lexi and Jax');
const s2 = run(['a', 'b'], {}, 'b');
ok(s2.length === 1 && s2[0][0] === 'one' && s2[0][1] === 'b' && s2[0][2] === true, 'the pair splits: card shows the person being followed');

console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
