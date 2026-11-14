#!/usr/bin/env node
// Make sure the App ID for an app EXTENSION exists, creating it if it does not (iOS 1.0.17).
//
// asc-enable-capabilities.mjs deliberately refuses to register App IDs, so a typo can never
// quietly create a second identifier for the app itself. An extension is different: it needs
// its own App ID, and the only valid shape is <app bundle id>.<suffix>. This tool creates
// exactly that and nothing else -- it refuses any identifier that is not a child of the app's.
//
// Usage: node asc-ensure-extension-id.mjs <parentBundleId> <extensionBundleId> "<name>"
//   e.g. node asc-ensure-extension-id.mjs com.groundlink.ios com.groundlink.ios.locpush "GroundLink Location Push"
//
// Auth: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_CONTENT (base64 .p8), as in the other asc-* tools.
// Idempotent: an existing App ID is reported and left alone.

import crypto from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com/v1';
const [parent, ident, name] = process.argv.slice(2);
if (!parent || !ident || !name) {
  console.error('usage: asc-ensure-extension-id.mjs <parentBundleId> <extensionBundleId> "<name>"');
  process.exit(2);
}
if (!ident.startsWith(parent + '.') || !/^[A-Za-z0-9.-]+$/.test(ident)) {
  console.error(`refusing: "${ident}" is not an extension id under "${parent}"`);
  process.exit(2);
}
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT } = process.env;
for (const [k, v] of Object.entries({ ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT })) {
  if (!v) { console.error(`missing required env var ${k}`); process.exit(2); }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function makeToken() {
  let pem = ASC_KEY_CONTENT.trim();
  if (!pem.includes('BEGIN')) pem = Buffer.from(pem, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }))}`;
  const sig = crypto.sign('SHA256', Buffer.from(input), { key: crypto.createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
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
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const find = async (id) => {
  const r = await asc('GET', `/bundleIds?filter[identifier]=${encodeURIComponent(id)}&limit=200`);
  if (!r.ok) { console.error(`lookup of ${id} failed (HTTP ${r.status}): ${r.text.slice(0, 400)}`); process.exit(1); }
  return (r.json?.data || []).find(d => d.attributes?.identifier === id);
};

if (!(await find(parent))) { console.error(`parent App ID "${parent}" is not registered on this team`); process.exit(1); }
if (await find(ident)) { console.log(`= ${ident} already registered`); process.exit(0); }

const made = await asc('POST', '/bundleIds', {
  data: { type: 'bundleIds', attributes: { identifier: ident, name, platform: 'IOS' } },
});
if (!made.ok) {
  const detail = made.json?.errors?.map(e => e.detail || e.title).join('; ') || made.text.slice(0, 300);
  console.error(`! could not register ${ident} (HTTP ${made.status}): ${detail}`);
  process.exit(1);
}
console.log(`+ ${ident} registered (${made.json?.data?.id})`);
