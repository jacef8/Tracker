// A const read before its own declaration line throws at RUNTIME ("Cannot access 'x' before
// initialization") and parses perfectly, so node --check and check-syntax both pass it. Build
// 955 shipped exactly that inside _processUsersSnapInner: a const declared 23 lines above the
// const it read. It threw on the first row of every users snapshot, so the map drew no
// markers and the People list stayed empty -- on a live family-safety app, reported from a
// phone. This catches that class before it ships.
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');

// The render-critical functions. A throw inside any of these empties the map.
const FNS = ['_processUsersSnapInner', '_processUsersSnap', '_applyMarkerSolo', '_applyMarkerMerged', '_buildPersonSheetHTML'];
let bad = 0, checked = 0;
for (const fn of FNS) {
  const a = src.indexOf('function ' + fn);
  if (a < 0) { console.log('warn  ' + fn + ' not found'); continue; }
  let d = 0, end = a;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { end = j; break; } }
  }
  const lines = src.slice(a, end).split('\n');
  const decl = {};
  lines.forEach((l, n) => {
    const m = l.match(/^\s*(?:const|let)\s+(_[A-Za-z0-9_]+)\s*=/);
    if (m && !(m[1] in decl)) decl[m[1]] = n;
  });
  for (const [name, dn] of Object.entries(decl)) {
    checked++;
    for (let n = 0; n < dn; n++) {
      const l = lines[n].replace(/\/\/.*$/, '');
      if (new RegExp('(?<![A-Za-z0-9_.])' + name + '(?![A-Za-z0-9_])').test(l)) {
        console.log(`FAIL  ${fn}: ${name} is read at line ${n} but declared at ${dn} — temporal dead zone, throws at runtime`);
        console.log(`      ${lines[n].trim().slice(0, 100)}`);
        bad++;
        break;
      }
    }
  }
}
console.log(bad ? `\n${bad} temporal-dead-zone bug(s)` : `ok — no const/let read before its declaration (${checked} bindings across ${FNS.length} render functions)`);
process.exit(bad ? 1 : 0);
