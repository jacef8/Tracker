#!/usr/bin/env node
// After an iPhone build is uploaded: wait until Apple has finished processing it (so testers can
// actually install it), then write public/native-latest.json. The app compares its own build to
// that file and, when it is behind, shows "Your GroundLink app needs an update" with a button
// that opens TestFlight. Run by the announce job in .github/workflows/ios-release.yml.
//
//   node tools/asc-announce-beta.mjs <buildNumber> <versionString>
// Uses the same App Store Connect key as the other asc-* tools (ASC_KEY_ID / ASC_ISSUER_ID /
// ASC_KEY_CONTENT). Writes the file only; the workflow commits it.
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com/v1';
const BUNDLE_ID = 'com.groundlink.ios';
const build = String(process.argv[2] || '').trim(), version = String(process.argv[3] || '').trim();
if (!/^\d+$/.test(build) || !/^\d+(\.\d+)*$/.test(version)) { console.error('usage: asc-announce-beta.mjs <build> <version>'); process.exit(2); }
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT } = process.env;
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_CONTENT) { console.error('missing ASC_* env'); process.exit(2); }

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function token() {
  let pem = ASC_KEY_CONTENT.trim();
  if (!pem.includes('BEGIN')) pem = Buffer.from(pem, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }))}`;
  const sig = crypto.sign('SHA256', Buffer.from(input), { key: crypto.createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}
async function get(path) {
  const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token() } });
  return r.ok ? r.json() : null;
}

const apps = await get(`/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
const appId = apps?.data?.[0]?.id;
if (!appId) { console.error('app not found'); process.exit(1); }
const deadline = Date.now() + 50 * 60000;
let state = '';
while (Date.now() < deadline) {
  const b = await get(`/builds?filter[app]=${appId}&filter[version]=${build}&limit=5`);
  state = b?.data?.[0]?.attributes?.processingState || 'not visible yet';
  console.log(new Date().toISOString(), 'build', build, state);
  if (state === 'VALID') break;
  if (state === 'FAILED' || state === 'INVALID') { console.error('build failed processing; not announcing'); process.exit(1); }
  await new Promise(r => setTimeout(r, 30000));
}
if (state !== 'VALID') { console.error('build never finished processing; not announcing'); process.exit(1); }
writeFileSync('public/native-latest.json', JSON.stringify({ ios: +build, iosVersion: version, ts: Date.now() }) + '\n');
console.log('announced build', build, '(' + version + ')');
