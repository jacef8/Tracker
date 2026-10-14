// Finds selectors declared more than once in index.html's stylesheets, where a later rule can
// silently beat an earlier one. This trap has cost six real bugs: the top bar, map controls,
// room-item:hover, .uname, the selected states, and the oval icon buttons. Each time the fix
// was "delete the duplicate", and each time it was found by accident.
import { readFileSync } from 'node:fs';
const src = readFileSync('public/index.html', 'utf8');
const styles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
const decl = new Map();           // selector -> [{props, important, line}]
for (const css of styles) {
  const base = src.indexOf(css);
  // Strip comments, then walk top-level rules (skip @media bodies by flattening one level).
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@') || sel.includes('%')) continue;
    const body = m[2];
    const line = src.slice(0, base + m.index).split('\n').length;
    for (const one of sel.split(',').map(x => x.trim()).filter(Boolean)) {
      if (!decl.has(one)) decl.set(one, []);
      decl.get(one).push({ line, important: /!important/.test(body), props: body });
    }
  }
}
const propsOf = b => [...b.matchAll(/(^|;)\s*([a-z-]+)\s*:/gi)].map(x => x[2].toLowerCase());
const rows = [];
for (const [sel, list] of decl) {
  if (list.length < 2) continue;
  if (!/ui-v2/.test(sel)) continue;             // the skin is where this keeps biting
  // Only interesting if a LATER rule re-declares a property an EARLIER one set.
  for (let i = 1; i < list.length; i++) {
    const later = new Set(propsOf(list[i].props));
    for (let j = 0; j < i; j++) {
      const clash = propsOf(list[j].props).filter(p => later.has(p));
      if (clash.length) {
        rows.push({ sel, winner: list[i].line, loser: list[j].line, clash: [...new Set(clash)].slice(0, 5),
                    bothImportant: list[i].important && list[j].important });
      }
    }
  }
}
rows.sort((a, b) => a.sel.localeCompare(b.sel));
console.log('selectors in the ui-v2 skin declared more than once, where the later one overrides:');
console.log('(winner = the line that actually applies)\n');
rows.forEach(r => console.log(
  '  ' + r.sel.slice(0, 54).padEnd(55) +
  'line ' + String(r.loser).padStart(5) + ' beaten by ' + String(r.winner).padStart(5) +
  (r.bothImportant ? '  [both !important]' : '') +
  '   ' + r.clash.join(', ')));
console.log('\ntotal: ' + rows.length);
process.exit(0);
