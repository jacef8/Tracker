#!/usr/bin/env node
// List TestFlight testers, and optionally re-send Apple's invitation email to them.
//
// Auth reuses the App Store Connect API key already in CI (ASC_KEY_ID / ASC_ISSUER_ID /
// ASC_KEY_CONTENT, the last base64-encoded .p8). No Apple ID password involved.
//
// Usage:
//   node asc-testflight-testers.mjs list                    # read-only, sends nothing
//   node asc-testflight-testers.mjs invite                  # RE-SENDS the invite email to
//                                                           # every tester not yet installed
//   node asc-testflight-testers.mjs invite --all            # re-sends to EVERYONE
//
// `list` is the default and is completely safe. `invite` sends real email to real people and
// cannot be recalled, so it is never the default and never inferred.
//
// Note on wording: Apple's TestFlight invitation is a fixed template — it carries the redeem
// link and install instructions, but no custom message. Anything in your own words has to go
// out from your own mailbox instead.

import crypto from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com/v1';
const BUNDLE_ID = 'com.groundlink.ios';

const mode = (process.argv[2] || 'list').toLowerCase();
const inviteAll = process.argv.includes('--all');
if (!['list', 'invite'].includes(mode)) {
  console.error('usage: asc-testflight-testers.mjs [list|invite] [--all]');
  process.exit(2);
}

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT } = process.env;
for (const [n, v] of Object.entries({ ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT })) {
  if (!v) { console.error(`missing required env var ${n}`); process.exit(2); }
}

const b64url = b => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeToken() {
  let pem = ASC_KEY_CONTENT.trim();
  if (!pem.includes('BEGIN')) pem = Buffer.from(pem, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  const head = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const body = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const input = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(body))}`;
  // Raw r||s, not DER — see asc-enable-capabilities.mjs.
  const sig = crypto.sign('SHA256', Buffer.from(input), {
    key: crypto.createPrivateKey(pem), dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${b64url(sig)}`;
}
const token = makeToken();

async function asc(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

const apps = await asc('GET', `/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
if (!apps.ok || !apps.json?.data?.length) {
  console.error(`could not find app ${BUNDLE_ID} (HTTP ${apps.status})`);
  console.error(apps.text.slice(0, 600));
  process.exit(1);
}
const app = apps.json.data[0];
console.log(`App: ${app.attributes?.name || BUNDLE_ID}  (id ${app.id})\n`);

// Page through every tester — a short list today shouldn't silently truncate later.
let testers = [], next = `/betaTesters?filter[apps]=${app.id}&limit=200`;
while (next) {
  const page = await asc('GET', next);
  if (!page.ok) {
    console.error(`could not list testers (HTTP ${page.status})`);
    console.error(page.text.slice(0, 600));
    process.exit(1);
  }
  testers = testers.concat(page.json?.data || []);
  const link = page.json?.links?.next;
  next = link ? link.replace(API, '') : null;
}

if (!testers.length) { console.log('No testers found.'); process.exit(0); }

const rows = testers.map(t => ({
  id: t.id,
  email: t.attributes?.email || '(no email)',
  name: [t.attributes?.firstName, t.attributes?.lastName].filter(Boolean).join(' ') || '(no name)',
  state: t.attributes?.state || t.attributes?.inviteType || '(unknown)',
}));

console.log(`${rows.length} tester(s):`);
for (const r of rows) console.log(`  ${r.state.padEnd(22)} ${r.email.padEnd(34)} ${r.name}`);

if (mode === 'list') {
  console.log('\n(list mode — nothing was sent)');
  process.exit(0);
}

// ── invite ────────────────────────────────────────────────────────────────────────────
// Default to only those who haven't installed; --all overrides. INSTALLED means they already
// have the build and don't need chasing.
const pending = inviteAll ? rows : rows.filter(r => !/INSTALLED/i.test(r.state));
console.log(`\nRe-sending Apple's TestFlight invitation to ${pending.length} tester(s)${inviteAll ? ' (--all)' : ' not yet installed'}:`);

let failed = 0;
for (const r of pending) {
  const res = await asc('POST', '/betaTesterInvitations', {
    data: {
      type: 'betaTesterInvitations',
      relationships: {
        app: { data: { type: 'apps', id: app.id } },
        betaTester: { data: { type: 'betaTesters', id: r.id } },
      },
    },
  });
  if (res.ok) console.log(`  + sent to ${r.email}`);
  else {
    const detail = res.json?.errors?.map(e => e.detail || e.title).join('; ') || res.text.slice(0, 200);
    console.error(`  ! ${r.email} FAILED (HTTP ${res.status}): ${detail}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
