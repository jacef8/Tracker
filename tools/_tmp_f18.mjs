import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const now = Date.now();
const ago = t => !t ? 'never' : ((now - t)/3600000).toFixed(2) + 'h (' + new Date(t).toISOString() + ')';
const gl = (await db.ref('gl').get()).val() || {};
const rooms = Object.keys(gl).filter(k => k[0] !== '_');
const hits = [];
for (const room of rooms) for (const [uid, u] of Object.entries(gl[room].users || {})) {
  if (u && /vanesa|vanessa/i.test(u.name || '')) hits.push({ room, uid, u });
}
const uids = [...new Set(hits.map(h => h.uid))];
console.log('Vanesa device uids:', uids);
for (const h of hits) {
  const u = h.u; const cfg = gl[h.room].config || {};
  console.log(`\n== room ${h.room} circle=${cfg.circle} owner=${cfg.owner}`);
  console.log(`  uid=${h.uid} name=${u.name} dev=${u.dev} build=${u.build} ts=${ago(u.ts)} fixTs=${ago(u.fixTs)} fgTs=${ago(u.fgTs)} noGps=${u.noGps} rest=${u.rest} lat=${u.lat} lng=${u.lng} acc=${u.accuracy}`);
  console.log('  keys:', Object.keys(u).join(','));
  console.log('  oss:', JSON.stringify(u.oss));
  console.log('  acl has device uid?', !!(gl[h.room].acl||{})[h.uid], ' acl keys count', Object.keys(gl[h.room].acl||{}).length);
  console.log('  members has device uid?', !!(gl[h.room].members||{})[h.uid]);
  console.log('  diag:', JSON.stringify((gl[h.room].diag||{})[h.uid]));
  console.log('  coverage:', JSON.stringify((gl[h.room].coverage||{})[h.uid]));
  console.log('  pushSubs:', JSON.stringify(((gl[h.room].pushSubs||{})[h.uid])||null)?.slice(0,300));
}
for (const uid of uids) {
  const devOwner = (gl._devOwner||{})[uid];
  console.log(`\n_devOwner[${uid}] =`, JSON.stringify(devOwner));
  const acct = devOwner && devOwner.acct;
  if (acct) {
    for (const h of hits) console.log(`  acl[${h.room}] has acct ${acct}?`, !!(gl[h.room].acl||{})[acct]);
    console.log('  _authMap[acct]=', JSON.stringify((gl._authMap||{})[acct]));
    console.log('  _directory[acct]=', JSON.stringify((gl._directory||{})[acct])?.slice(0,300));
    console.log('  _presence[acct]=', JSON.stringify((gl._presence||{})[acct]));
  }
  console.log('  _authMap[uid]=', JSON.stringify((gl._authMap||{})[uid]));
  console.log('  _presence[uid]=', JSON.stringify((gl._presence||{})[uid]));
  console.log('  _voipSubs[uid]=', JSON.stringify((gl._voipSubs||{})[uid])?.slice(0,200));
  console.log('  _pttSubs[uid]=', JSON.stringify((gl._pttSubs||{})[uid])?.slice(0,200));
  console.log('  _diag.devices[uid]=', JSON.stringify(((gl._diag||{}).devices||{})[uid])?.slice(0,600));
  for (const [room, am] of Object.entries(gl._aclMiss||{})) if (am[uid]) console.log(`  _aclMiss[${room}][uid]=`, JSON.stringify(am[uid]));
  if (acct) for (const [room, am] of Object.entries(gl._aclMiss||{})) if (am[acct]) console.log(`  _aclMiss[${room}][acct]=`, JSON.stringify(am[acct]));
  // uptime series
  const up = gl._uptime || {};
  const days = Object.keys(up).sort();
  console.log('  _uptime days with this uid:', days.filter(d => up[d][uid]).map(d => d + ':' + JSON.stringify(up[d][uid])).join(' | '));
  // trail history
  const glh = (await db.ref('glh').get()).val() || {};
  for (const [crew, byUid] of Object.entries(glh)) {
    const mine = byUid[uid]; if (!mine) continue;
    const dates = Object.keys(mine).sort();
    console.log(`  glh[${crew}][uid] dates:`, dates.slice(-6).join(','));
    const last = dates[dates.length-1];
    const pts = Object.values(mine[last]||{}).sort((a,b)=>a.ts-b.ts);
    const srcs = {}; pts.forEach(p => { srcs[p.src||'web'] = (srcs[p.src||'web']||0)+1; });
    console.log(`    last date ${last}: ${pts.length} pts, srcs=${JSON.stringify(srcs)}, first=${ago(pts[0]?.ts)} last=${ago(pts[pts.length-1]?.ts)}`);
  }
}
// also list every room's config.circle & acl presence for uids
process.exit(0);
