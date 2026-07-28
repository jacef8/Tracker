#!/usr/bin/env node
// Enable App ID capabilities via the App Store Connect API, so adding an entitlement never
// again means clicking through developer.apple.com and rotating a provisioning-profile secret.
//
// Background: adding com.apple.developer.associated-domains to App.entitlements broke the
// TestFlight build with "Provisioning profile doesn't include the Associated Domains
// capability". The profile was a stored base64 secret generated before the entitlement
// existed, so the only fix was manual portal work. This script closes that loop: CI enables
// the capability on the App ID, then fastlane's sigh regenerates the profile against it.
//
// Auth uses the App Store Connect API key already in CI (ASC_KEY_ID / ASC_ISSUER_ID /
// ASC_KEY_CONTENT, the last base64-encoded .p8). No Apple ID password is involved.
//
// Usage: node asc-enable-capabilities.mjs <bundleId> <CAPABILITY> [CAPABILITY...]
//   e.g. node asc-enable-capabilities.mjs com.groundlink.ios ASSOCIATED_DOMAINS
//
// Idempotent: a capability that's already on is reported and skipped, so re-running is safe.

import crypto from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com/v1';

const [bundleIdentifier, ...capabilities] = process.argv.slice(2);
if (!bundleIdentifier || !capabilities.length) {
  console.error('usage: asc-enable-capabilities.mjs <bundleId> <CAPABILITY> [CAPABILITY...]');
  process.exit(2);
}

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT } = process.env;
for (const [name, v] of Object.entries({ ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT })) {
  if (!v) { console.error(`missing required env var ${name}`); process.exit(2); }
}

// ── JWT (ES256) ────────────────────────────────────────────────────────────────────────
// Apple requires the signature as raw r||s, NOT the DER encoding Node produces by default —
// hence dsaEncoding: 'ieee-p1363'. Getting this wrong yields a confusing 401 with no detail.
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken() {
  // The key may arrive base64-encoded (how it's stored in CI) or as raw PEM text.
  let pem = ASC_KEY_CONTENT.trim();
  if (!pem.includes('BEGIN')) pem = Buffer.from(pem, 'base64').toString('utf8');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  const signature = crypto.sign('SHA256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(pem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

const token = makeToken();

async function asc(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json, text };
}

// ── Find the App ID ────────────────────────────────────────────────────────────────────
const found = await asc('GET',
  `/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}&include=bundleIdCapabilities&limit=200`);

if (!found.ok) {
  console.error(`could not look up bundle id (HTTP ${found.status})`);
  console.error(found.text.slice(0, 800));
  process.exit(1);
}

const record = (found.json?.data || []).find(d => d.attributes?.identifier === bundleIdentifier);
if (!record) {
  console.error(`no App ID registered for "${bundleIdentifier}" on this team.`);
  console.error('Registering a new App ID is deliberately NOT automated here — it would be');
  console.error('easy to silently create a second identifier and ship against the wrong one.');
  process.exit(1);
}

const existing = new Set(
  (found.json.included || [])
    .filter(i => i.type === 'bundleIdCapabilities')
    .map(i => i.attributes?.capabilityType)
    .filter(Boolean)
);

console.log(`App ID ${bundleIdentifier} (${record.id})`);
console.log(`  already enabled: ${[...existing].sort().join(', ') || '(none reported)'}`);

// ── Enable whatever is missing ─────────────────────────────────────────────────────────
let failed = 0;
for (const capability of capabilities) {
  if (existing.has(capability)) {
    console.log(`  = ${capability} already enabled, skipping`);
    continue;
  }
  const res = await asc('POST', '/bundleIdCapabilities', {
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType: capability },
      relationships: { bundleId: { data: { type: 'bundleIds', id: record.id } } },
    },
  });
  if (res.ok) {
    console.log(`  + ${capability} enabled`);
  } else if (res.status === 409) {
    // Already present but not returned in the include above — treat as success, not failure.
    console.log(`  = ${capability} already enabled (409), skipping`);
  } else {
    const detail = res.json?.errors?.map(e => e.detail || e.title).join('; ') || res.text.slice(0, 300);
    console.error(`  ! ${capability} FAILED (HTTP ${res.status}): ${detail}`);
    failed++;
  }
}

process.exit(failed ? 1 : 0);
