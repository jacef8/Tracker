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
// Positional arg for diagnose/addgroup: the tester's email.
const argEmail = (process.argv[3] || '').trim().toLowerCase();
if (!['list', 'invite', 'diagnose', 'addgroup', 'builds', 'assignbuild', 'appstore', 'listing', 'publiclink', 'verify', 'add'].includes(mode)) {
  console.error('usage: asc-testflight-testers.mjs [verify|list|invite|diagnose|addgroup|builds|assignbuild|appstore|listing|publiclink] [email] [--all|--enable]');
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

// ── add ───────────────────────────────────────────────────────────────────────────────
// Create a brand-new tester and put them straight into the external group. For an external
// group, that single POST is also what makes Apple send the invitation email — there is no
// separate "send" step. Idempotent-ish: if the email already exists as a tester, fall through
// to the same group-attach the addgroup mode does.
if (mode === 'add') {
  if (!argEmail) { console.error('add needs an email: node asc-testflight-testers.mjs add someone@example.com'); process.exit(2); }
  const groupsRes = await asc('GET', `/apps/${app.id}/betaGroups?limit=200`);
  const ext = (groupsRes.json?.data || []).filter(g => !g.attributes?.isInternalGroup)
    .sort((a, b) => 0)[0];
  if (!ext) { console.error('No external beta group exists.'); process.exit(1); }

  const create = await asc('POST', '/betaTesters', {
    data: {
      type: 'betaTesters',
      attributes: { email: argEmail },
      relationships: { betaGroups: { data: [{ type: 'betaGroups', id: ext.id }] } },
    },
  });
  if (create.ok) {
    console.log(`+ created ${argEmail} in "${ext.attributes?.name}" — Apple is sending the invitation email now.`);
    process.exit(0);
  }
  const detail = create.json?.errors?.map(e => e.detail || e.title).join('; ') || create.text.slice(0, 300);
  if (create.status !== 409) { console.error(`! create FAILED (HTTP ${create.status}): ${detail}`); process.exit(1); }

  // Already a tester — attach them to the group instead, which also (re)invites.
  console.log(`= ${argEmail} already exists (${detail}) — attaching to "${ext.attributes?.name}" instead.`);
  const found = await asc('GET', `/betaTesters?filter[email]=${encodeURIComponent(argEmail)}&filter[apps]=${app.id}&limit=5`);
  const who = (found.json?.data || [])[0];
  if (!who) { console.error('! could not look the existing tester up'); process.exit(1); }
  const attach = await asc('POST', `/betaGroups/${ext.id}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: who.id }] });
  console.log(attach.ok ? '+ attached — invitation on its way'
    : `! attach FAILED (HTTP ${attach.status}): ${attach.json?.errors?.map(e => e.detail || e.title).join('; ') || attach.text.slice(0, 200)}`);
  process.exit(attach.ok ? 0 : 1);
}

// ── publiclink ────────────────────────────────────────────────────────────────────────
// A TestFlight public link is a plain URL that installs the app — no invitation email, no
// redeem code, nothing to be lost in a spam folder. Reported symptom: a tester opened the
// TestFlight app directly, landed on its Redeem screen, and had no code to type, because the
// invitation flow expects you to arrive from the email link rather than from the app.
//
// Read-only unless --enable is passed: turning it on makes the build installable by anyone who
// has the URL (up to the limit), which is a real exposure decision, not a formatting one.
if (mode === 'publiclink') {
  const enable = process.argv.includes('--enable');
  const groupsRes = await asc('GET', `/apps/${app.id}/betaGroups?limit=200`);
  const groups = (groupsRes.json?.data || []).filter(g => !g.attributes?.isInternalGroup);
  if (!groups.length) { console.error('No external beta group to publish.'); process.exit(1); }
  for (const g of groups) {
    const a = g.attributes || {};
    console.log(`"${a.name}"  publicLinkEnabled=${!!a.publicLinkEnabled}  limit=${a.publicLinkLimitEnabled ? a.publicLinkLimit : 'none'}`);
    if (a.publicLink) console.log(`   ${a.publicLink}`);
    if (!enable || a.publicLinkEnabled) continue;
    // 100 is TestFlight's external ceiling anyway; capping makes the exposure explicit rather
    // than unbounded-by-default.
    const r = await asc('PATCH', `/betaGroups/${g.id}`, {
      data: { type: 'betaGroups', id: g.id,
              attributes: { publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 100 } },
    });
    if (!r.ok) {
      console.error(`   ! enable FAILED (HTTP ${r.status}): ${r.json?.errors?.map(e => e.detail || e.title).join('; ') || r.text.slice(0, 300)}`);
      continue;
    }
    console.log(`   + enabled -> ${r.json?.data?.attributes?.publicLink || '(link pending, re-run to read it)'}`);
  }
  process.exit(0);
}

// ── listing ───────────────────────────────────────────────────────────────────────────
// Exactly which App Store listing fields are filled and which are blank. PREPARE_FOR_SUBMISSION
// means Apple is waiting on content, not on code — this says what content.
if (mode === 'listing') {
  const show = (label, val, required) => {
    const empty = !val || !String(val).trim();
    console.log(`  ${empty ? (required ? 'MISSING ' : 'blank   ') : 'ok      '} ${label.padEnd(22)} ${empty ? '' : String(val).replace(/\s+/g, ' ').slice(0, 70)}`);
  };

  const infoRes = await asc('GET', `/apps/${app.id}/appInfos?limit=5`);
  const info = (infoRes.json?.data || [])[0];
  if (info) {
    const locs = await asc('GET', `/appInfos/${info.id}/appInfoLocalizations?limit=20`);
    console.log('App information (applies to every version):');
    for (const l of (locs.json?.data || [])) {
      const a = l.attributes || {};
      console.log(` locale ${a.locale}`);
      show('name', a.name, true);
      show('subtitle', a.subtitle, false);
      show('privacyPolicyUrl', a.privacyPolicyUrl, true);
    }
  }

  const vers = await asc('GET', `/apps/${app.id}/appStoreVersions?limit=5`);
  const ver = (vers.json?.data || [])[0];
  if (!ver) { console.log('\nNo App Store version exists.'); process.exit(0); }
  console.log(`\nVersion ${ver.attributes?.versionString} — ${ver.attributes?.appStoreState || ver.attributes?.appVersionState}`);

  const vlocs = await asc('GET', `/appStoreVersions/${ver.id}/appStoreVersionLocalizations?limit=20`);
  for (const l of (vlocs.json?.data || [])) {
    const a = l.attributes || {};
    console.log(` locale ${a.locale}`);
    show('description', a.description, true);
    show('keywords', a.keywords, true);
    show('supportUrl', a.supportUrl, true);
    show('marketingUrl', a.marketingUrl, false);
    show('promotionalText', a.promotionalText, false);
    show('whatsNew', a.whatsNew, false);
    // Screenshots are per-localization; count them so "missing" is a fact, not a guess.
    const sets = await asc('GET', `/appStoreVersionLocalizations/${l.id}/appScreenshotSets?limit=20`);
    const setList = sets.json?.data || [];
    let total = 0;
    for (const s of setList) {
      const shots = await asc('GET', `/appScreenshotSets/${s.id}/appScreenshots?limit=20`);
      total += (shots.json?.data || []).length;
    }
    console.log(`  ${total ? 'ok      ' : 'MISSING '} screenshots            ${setList.length} set(s), ${total} image(s)`);
  }

  const rd = await asc('GET', `/appStoreVersions/${ver.id}/appStoreReviewDetail`);
  console.log('\nApp Review details:');
  if (rd.ok && rd.json?.data) {
    const a = rd.json.data.attributes || {};
    show('contactFirstName', a.contactFirstName, true);
    show('contactLastName', a.contactLastName, true);
    show('contactEmail', a.contactEmail, true);
    show('contactPhone', a.contactPhone, true);
    show('demoAccountName', a.demoAccountName, false);
    show('demoAccountRequired', String(a.demoAccountRequired), false);
    show('notes', a.notes, true);
  } else console.log('  MISSING  (no review detail record at all)');

  const age = await asc('GET', `/apps/${app.id}/ageRatingDeclaration`);
  console.log(`\nAge rating declaration: ${age.ok && age.json?.data ? 'present' : 'MISSING'}`);
  process.exit(0);
}

// ── builds / assignbuild / appstore ───────────────────────────────────────────────────
// These don't need the tester roster, so they run before it's fetched.
// ── verify ────────────────────────────────────────────────────────────────────────────
// One unambiguous answer to "did it ship?": what can external testers install RIGHT NOW.
//
// Everything upstream of this lies in its own way. A green build job means the binary
// compiled; "Successfully uploaded" means the bytes arrived; processingState=VALID means
// Apple unpacked them; group membership means the build was offered. None of those put an
// update on a tester's phone — six weeks of builds passed every one of those gates while
// every tester sat on v5. The authoritative field is buildBetaDetail.externalBuildState:
// IN_BETA_TESTING is shipped, and everything else is some flavour of not yet.
if (mode === 'verify') {
  const STATE = {
    IN_BETA_TESTING:            'INSTALLABLE NOW',
    READY_FOR_BETA_SUBMISSION:  'not submitted for Beta App Review',
    WAITING_FOR_BETA_REVIEW:    'waiting in Apple review queue',
    IN_BETA_REVIEW:             'in Apple review',
    BETA_APPROVED:              'approved, not yet released to the group',
    BETA_REJECTED:              'REJECTED by Beta App Review',
    PROCESSING:                 'still processing at Apple',
    PROCESSING_EXCEPTION:       'processing FAILED at Apple',
    MISSING_EXPORT_COMPLIANCE:  'blocked on export compliance',
    EXPIRED:                    'expired',
  };
  const groupsRes = await asc('GET', `/apps/${app.id}/betaGroups?limit=200`);
  const extGroups = (groupsRes.json?.data || []).filter(g => !g.attributes?.isInternalGroup);
  if (!extGroups.length) { console.error('No external group exists — nothing can ship.'); process.exit(1); }

  const newestRes = await asc('GET', `/builds?filter[app]=${app.id}&limit=1&sort=-uploadedDate`);
  const newest = (newestRes.json?.data || [])[0];
  if (newest) console.log(`Newest upload: v${newest.attributes?.version} (${(newest.attributes?.uploadedDate || '').slice(0, 16)})
`);

  let shippedNewest = false, bad = 0;
  for (const g of extGroups) {
    const testers = await asc('GET', `/betaGroups/${g.id}/betaTesters?limit=200`);
    const nTesters = (testers.json?.data || []).length;
    const gb = await asc('GET', `/betaGroups/${g.id}/builds?limit=200`);
    if (!gb.ok) { console.error(`"${g.attributes?.name}": could not list builds (HTTP ${gb.status}) — ASC API may be having a bad day; re-run before trusting anything.`); bad++; continue; }
    const builds = gb.json?.data || [];
    console.log(`"${g.attributes?.name}" — ${nTesters} tester(s), ${builds.length} build(s):`);
    if (!builds.length) console.log('  (no builds — testers can install nothing)');
    // Sort newest first by version number where possible.
    builds.sort((a, b) => Number(b.attributes?.version || 0) - Number(a.attributes?.version || 0));
    for (const b of builds) {
      const det = await asc('GET', `/builds/${b.id}/buildBetaDetail`);
      const st = det.json?.data?.attributes?.externalBuildState || '(unknown)';
      const label = STATE[st] || st;
      const mark = st === 'IN_BETA_TESTING' ? '✓' : ' ';
      console.log(`  ${mark} v${String(b.attributes?.version || '?').padEnd(5)} ${label}`);
      if (st === 'IN_BETA_TESTING' && newest && b.id === newest.id) shippedNewest = true;
    }
  }
  console.log('');
  if (newest) {
    console.log(shippedNewest
      ? `VERDICT: the newest upload (v${newest.attributes?.version}) is installable by external testers. Shipped.`
      : `VERDICT: the newest upload (v${newest.attributes?.version}) is NOT what external testers can install — there is drift.`);
  }
  process.exit(bad ? 1 : 0);
}

if (mode === 'builds' || mode === 'assignbuild' || mode === 'appstore') {
  if (mode === 'appstore') {
    // What's actually standing between this app and the public App Store.
    const vers = await asc('GET', `/apps/${app.id}/appStoreVersions?limit=10`);
    const list = vers.json?.data || [];
    console.log(`App Store versions: ${list.length}`);
    for (const v of list) {
      const a = v.attributes || {};
      console.log(`  ${String(a.versionString || '?').padEnd(10)} state=${a.appStoreState || a.appVersionState || '?'}  platform=${a.platform || '?'}  created=${(a.createdDate || '').slice(0, 10)}`);
    }
    if (!list.length) console.log('  (none — the app has never had an App Store version created)');

    // Beta App Review gates EXTERNAL TestFlight, and is a separate queue from App Store review.
    const bars = await asc('GET', `/builds?filter[app]=${app.id}&limit=5&include=betaAppReviewSubmission&sort=-uploadedDate`);
    const inc = bars.json?.included || [];
    console.log(`\nBeta App Review submissions on the 5 newest builds: ${inc.length}`);
    for (const s of inc) console.log(`  ${s.id}  state=${s.attributes?.betaReviewState || '?'}`);
    process.exit(0);
  }

  const groupsRes = await asc('GET', `/apps/${app.id}/betaGroups?limit=200`);
  const groups = groupsRes.json?.data || [];
  const ext = groups.filter(g => !g.attributes?.isInternalGroup);

  // Sort by -uploadedDate, not -version: `version` is a STRING on this endpoint, so it sorts
  // lexically and Apple rejects some sort keys outright. And check ok — swallowing the error
  // into `|| []` reported "Newest 0 build(s)" for an app with 13, which reads as "no builds"
  // rather than "the query was rejected".
  // Top-level /builds with filter[app], NOT /apps/{id}/builds — the relationship endpoint
  // rejects `sort` outright ("The parameter 'sort' can not be used with this request").
  const buildsRes = await asc('GET', `/builds?filter[app]=${app.id}&limit=10&sort=-uploadedDate`);
  if (!buildsRes.ok) {
    console.error(`could not list builds (HTTP ${buildsRes.status})`);
    console.error(buildsRes.text.slice(0, 600));
    process.exit(1);
  }
  const builds = buildsRes.json?.data || [];
  console.log(`Newest ${builds.length} build(s):`);
  const groupBuilds = {};
  for (const g of groups) {
    const gb = await asc('GET', `/betaGroups/${g.id}/builds?limit=200`);
    groupBuilds[g.id] = new Set((gb.json?.data || []).map(b => b.id));
  }
  for (const b of builds) {
    const a = b.attributes || {};
    const inGroups = groups.filter(g => groupBuilds[g.id].has(b.id)).map(g => g.attributes?.name).join(', ') || '(none)';
    console.log(`  v${String(a.version || '?').padEnd(5)} ${String(a.processingState || '?').padEnd(11)} expired=${String(!!a.expired).padEnd(5)} uploaded=${(a.uploadedDate || '').slice(0, 16)}  groups: ${inGroups}`);
  }

  if (mode === 'builds') { console.log('\n(builds mode — nothing was changed)'); process.exit(0); }

  // assignbuild: attach the newest VALID, unexpired build to every external group missing it.
  const newest = builds.find(b => (b.attributes?.processingState === 'VALID') && !b.attributes?.expired);
  if (!newest) { console.error('\nNo VALID unexpired build to assign.'); process.exit(1); }
  console.log(`\nAssigning build v${newest.attributes?.version} to external group(s)…`);
  let bad = 0;
  // Sanity-check the id before blaming the relationship call. Apple answered
  // "no resource of type 'builds' with id <uuid>" for an id it had just returned from
  // /builds?filter[app], twice, minutes apart — so the first question is whether the id
  // resolves on its own at all.
  const probe = await asc('GET', `/builds/${newest.id}`);
  console.log(`  build ${newest.id} direct GET -> HTTP ${probe.status}`
    + (probe.ok ? ` (processing=${probe.json?.data?.attributes?.processingState})` : ''));

  for (const g of ext) {
    if (groupBuilds[g.id].has(newest.id)) { console.log(`  = already in "${g.attributes?.name}"`); continue; }
    let r = await asc('POST', `/betaGroups/${g.id}/relationships/builds`, { data: [{ type: 'builds', id: newest.id }] });
    if (!r.ok) {
      // Same association, stated from the other side. The two endpoints are not always
      // interchangeable in practice, and one succeeding where the other 404s is cheap to try.
      console.log(`  … group->build gave HTTP ${r.status}; trying build->group`);
      r = await asc('POST', `/builds/${newest.id}/relationships/betaGroups`, { data: [{ type: 'betaGroups', id: g.id }] });
    }
    if (r.ok) console.log(`  + added to "${g.attributes?.name}"`);
    else { console.error(`  ! "${g.attributes?.name}" FAILED (HTTP ${r.status}): ${r.json?.errors?.map(e => e.detail || e.title).join('; ') || r.text.slice(0, 200)}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}

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

// ── diagnose / addgroup ───────────────────────────────────────────────────────────────
// "Tester has no installable build" (HTTP 409 on invite) means the tester isn't in any beta
// group that has a build attached — they're registered, but there is nothing for them to
// install, so Apple refuses to invite them. Show which groups exist, how many builds each
// has, and which groups this tester belongs to.
if (mode === 'diagnose' || mode === 'addgroup') {
  if (!argEmail) { console.error(`${mode} needs an email: node asc-testflight-testers.mjs ${mode} someone@example.com`); process.exit(2); }
  const who = rows.find(r => r.email.toLowerCase() === argEmail);
  if (!who) { console.error(`no tester with email ${argEmail}`); process.exit(1); }

  const groupsRes = await asc('GET', `/apps/${app.id}/betaGroups?limit=200`);
  const groups = groupsRes.json?.data || [];
  console.log(`\nBeta groups for this app: ${groups.length}`);

  const groupInfo = [];
  for (const g of groups) {
    const builds = await asc('GET', `/betaGroups/${g.id}/builds?limit=200`);
    const members = await asc('GET', `/betaGroups/${g.id}/betaTesters?limit=200`);
    const memberIds = new Set((members.json?.data || []).map(m => m.id));
    const info = {
      id: g.id,
      name: g.attributes?.name || '(unnamed)',
      internal: !!g.attributes?.isInternalGroup,
      buildCount: (builds.json?.data || []).length,
      hasTester: memberIds.has(who.id),
    };
    groupInfo.push(info);
    console.log(`  ${info.name.padEnd(28)} builds=${String(info.buildCount).padEnd(4)} internal=${String(info.internal).padEnd(6)} has-${argEmail}=${info.hasTester}`);
  }

  console.log(`\n${who.email}: state=${who.state}, in ${groupInfo.filter(g => g.hasTester).length} group(s)`);

  if (mode === 'diagnose') {
    const fixable = groupInfo.filter(g => g.buildCount > 0 && !g.hasTester);
    if (!groupInfo.some(g => g.buildCount > 0)) {
      console.log('\nNo group has any build attached — that is the blocker, not this tester.');
    } else if (fixable.length) {
      console.log(`\nFix: add them to a group that HAS builds, e.g. "${fixable[0].name}":`);
      console.log(`  node tools/asc-testflight-testers.mjs addgroup ${argEmail}`);
    } else {
      console.log('\nThey are already in a group with builds — the 409 has another cause.');
    }
    process.exit(0);
  }

  // Already in a group that has builds? Then there is nothing wrong and nothing to do.
  //
  // This check was missing, so a correctly-configured tester still got "fixed": the only group
  // they were missing from was the INTERNAL one, and the script dutifully tried to add them
  // there and took a 409 "Tester(s) cannot be assigned". Internal testers must be App Store
  // Connect team members, so an ordinary email can never join that group — attempting it is
  // always wrong, not merely unlucky.
  const settled = groupInfo.find(g => g.hasTester && g.buildCount > 0);
  if (settled) {
    console.log(`\nAlready in "${settled.name}" (${settled.buildCount} build(s)) — nothing to fix.`);
    console.log(`State is ${who.state}${/INVITED/i.test(who.state) ? ' — they have an installable build and simply have not redeemed the invite yet.' : '.'}`);
    process.exit(0);
  }

  // EXTERNAL groups only. An internal group can hold more builds and still be the wrong answer,
  // for the team-membership reason above — so it is excluded outright rather than ranked lower.
  const target = groupInfo.filter(g => g.buildCount > 0 && !g.hasTester && !g.internal)
    .sort((a, b) => b.buildCount - a.buildCount)[0];
  if (!target) { console.error('\nNothing to do — no build-carrying group they are missing from.'); process.exit(1); }

  console.log(`\nAdding ${argEmail} to "${target.name}"…`);
  const add = await asc('POST', `/betaGroups/${target.id}/relationships/betaTesters`, {
    data: [{ type: 'betaTesters', id: who.id }],
  });
  if (!add.ok) {
    console.error(`  ! FAILED (HTTP ${add.status}): ${add.json?.errors?.map(e => e.detail || e.title).join('; ') || add.text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log('  + added');

  const inv = await asc('POST', '/betaTesterInvitations', {
    data: {
      type: 'betaTesterInvitations',
      relationships: {
        app: { data: { type: 'apps', id: app.id } },
        betaTester: { data: { type: 'betaTesters', id: who.id } },
      },
    },
  });
  console.log(inv.ok ? '  + invitation sent'
    : `  ! invite FAILED (HTTP ${inv.status}): ${inv.json?.errors?.map(e => e.detail || e.title).join('; ') || inv.text.slice(0, 200)}`);
  process.exit(inv.ok ? 0 : 1);
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
