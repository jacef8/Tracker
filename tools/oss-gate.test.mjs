// Exercises the shipped settings-publish gate (build 960) by pulling its exact text out of
// the live page and running it, rather than re-stating what it is supposed to do.
//
// The gate exists because position writes are whole-row fbSet calls and TWO writers attach a
// permission reading to the same row: the native layer (live, from CLLocationManager) and this
// page (window._iosSettings, refreshed only on foreground, restored from localStorage up to
// seven days old). They took turns, and the published permission was whichever wrote last --
// 277 phantom always/whenInUse flips on one phone over three days.
//
// Usage:  node tools/oss-gate.test.mjs [origin]
const ORIGIN = process.argv[2] || 'https://tracker-production-3b03.up.railway.app';

const src = await (await fetch(`${ORIGIN}/index.html?raw=${Math.random()}`)).text();
const m = src.match(/var _os = window\._iosSettings;[\s\S]{0,300}?_ossStaleSkips[^\n]*\n/);
if (!m) { console.error('FAIL — the gate is not in the shipped page at all'); process.exit(1); }
const gate = m[0];

const MAX = (src.match(/_OSS_PUBLISH_MAX_MS = ([^;]+);/) || [])[1];
if (!MAX) { console.error('FAIL — _OSS_PUBLISH_MAX_MS not defined'); process.exit(1); }
const maxMs = Function(`return ${MAX}`)();

const run = (settings) => {
  const win = { _iosSettings: settings, _OSS_PUBLISH_MAX_MS: maxMs, _ossStaleSkips: 0 };
  const payload = {};
  new Function('window', '_fixPayload', gate)(win, payload);
  return { published: 'oss' in payload, skipped: win._ossStaleSkips === 1 };
};

const now = Date.now();
// published: does this reading go onto the shared row? skipped: is the refusal counted?
const cases = [
  ['fresh, 1 min old',          { at: now - 60e3 },          true,  false],
  ['just inside the window',    { at: now - maxMs + 30e3 },  true,  false],
  ['just outside the window',   { at: now - maxMs - 30e3 },  false, true ],
  ['a week old (the bug)',      { at: now - 7 * 86400e3 },   false, true ],
  ['no .at (old native build)', { always: true },            false, true ],
  ['nothing cached yet',        null,                        false, false],
  ['clock skew, stamped ahead', { at: now + 60e3 },          true,  false],
];

let bad = 0;
console.log(`oss publish gate — window ${Math.round(maxMs / 60000)} min\n`);
for (const [name, settings, wantPub, wantSkip] of cases) {
  const got = run(settings);
  const ok = got.published === wantPub && got.skipped === wantSkip;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} published=${got.published} counted=${got.skipped}`);
}
console.log(bad ? `\n${bad} case(s) wrong` : '\nall cases behave');
process.exit(bad ? 1 : 0);
