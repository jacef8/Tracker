// Validate every inline <script> in public/index.html and EXIT NON-ZERO if any fail.
//
// This check already existed as an inline node -e in the deploy chain, and on 2026-09-05 it
// correctly reported "SCRIPT #3 Invalid or unexpected token" -- and the build shipped anyway,
// because it printed the error and exited 0. A validator that cannot fail a build is decoration.
//
// Usage:  node tools/check-syntax.mjs        (exit 0 = safe to deploy)

import { readFileSync } from 'node:fs';

const file = 'public/index.html';
const html = readFileSync(file, 'utf8');
const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;

let m, n = 0, bad = 0;
while ((m = re.exec(html))) {
  n++;
  const src = m[1]
    .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];/gm, '')
    .replace(/\bexport\s+(default\s+)?(function|async\s+function|const|let|var|class)/g, '$2')
    .replace(/\bexport\s*\{[^}]*\};?/g, '');
  try {
    new Function(src);
  } catch (e) {
    bad++;
    // Point at the offending line in the FILE, not just in the block, so it can be found.
    const before = html.slice(0, m.index).split('\n').length;
    console.error(`FAIL  script block #${n} (starts near ${file}:${before}): ${e.message}`);
  }
}

// Also confirm the two version markers agree. A mismatch tells every phone an update exists and
// then serves it the same build -- it happened twice today when a patch aborted midway.
try {
  const vj = JSON.parse(readFileSync('public/version.json', 'utf8'));
  const inPage = (html.match(/var APP_BUILD = (\d+);/) || [])[1];
  if (String(vj.build) !== String(inPage)) {
    bad++;
    console.error(`FAIL  version mismatch: version.json says ${vj.build}, index.html says ${inPage}`);
  }
} catch (e) {
  bad++;
  console.error('FAIL  could not compare version.json with APP_BUILD: ' + e.message);
}

// A second definition of the same global silently replaces the first — whichever loads last
// wins, and the other one's fixes quietly stop applying. It has happened in this file (two
// window.__nativeSettings handlers, only one of which ran). Top-level `function X` (column 0)
// and `window.X = function` anywhere must each be unique.
{
  const seen = new Map();
  const defRe = /^(?:function\s+([A-Za-z_$][\w$]*)\s*\(|\s*window\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b)/;
  html.split('\n').forEach((ln, i) => {
    const d = ln.match(defRe);
    if (!d) return;
    const name = d[1] || ('window.' + d[2]);
    if (seen.has(name)) {
      bad++;
      console.error(`FAIL  ${name} is defined twice: ${file}:${seen.get(name)} and ${file}:${i + 1}`);
    } else seen.set(name, i + 1);
  });
}

// ── Duplicate CSS selectors in the skin ────────────────────────────────────────────────
// A WARNING, never a failure: layering a later rule over an earlier one is a legitimate way
// to build a skin, and this file is full of deliberate refinements. But it is also how six
// real bugs happened — the top bar, map controls, room-item:hover, .uname, the selected
// states and the oval icon buttons — where a forgotten second copy of a selector silently
// beat the rule somebody had just written, both marked !important so specificity could not
// break the tie. Printing the count every build is what stops the seventh being found by
// accident. `node tools/css-dupes.mjs` lists them with line numbers.
{
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const decl = new Map();
  for (const css of styles) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@') || sel.includes('%')) continue;
      for (const one of sel.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!/ui-v2/.test(one)) continue;
        if (!decl.has(one)) decl.set(one, []);
        decl.get(one).push(m[2]);
      }
    }
  }
  const props = (b) => [...b.matchAll(/(^|;)\s*([a-z-]+)\s*:/gi)].map((x) => x[2].toLowerCase());
  let clashes = 0;
  for (const [, list] of decl) {
    for (let i = 1; i < list.length; i++) {
      const later = new Set(props(list[i]));
      for (let j = 0; j < i; j++) {
        if (props(list[j]).some((pr) => later.has(pr))) { clashes++; break; }
      }
    }
  }
  if (clashes) {
    console.warn(`warn  ${clashes} overriding duplicate selector(s) in the skin — node tools/css-dupes.mjs`);
  }
}

if (bad) {
  console.error(`\n${bad} problem(s) — DO NOT DEPLOY.`);
  process.exit(1);
}
console.log(`ok — ${n} script blocks parse, version markers agree, no duplicate globals`);
