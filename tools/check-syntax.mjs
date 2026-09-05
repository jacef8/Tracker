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

if (bad) {
  console.error(`\n${bad} problem(s) — DO NOT DEPLOY.`);
  process.exit(1);
}
console.log(`ok — ${n} script blocks parse, version markers agree`);
