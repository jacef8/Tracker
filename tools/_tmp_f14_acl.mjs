// READ-ONLY audit for finding F14 (only .get() calls).
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const db = admin.database();
const get = async p => (await db.ref(p).get()).val();
const ago = t => !t ? 'never' : (d => d<60?Math.round(d)+'m':d<1440?(d/60).toFixed(1)+'h':(d/1440).toFixed(1)+'d')((Date.now()-t)/60000);
const s8 = x => (x||'').toString().slice(0,10);
const [authMap, devOwner, roomIndex] = await Promise.all([get('gl/_authMap'), get('gl/_devOwner'), get('gl/_roomIndex')]);
const am = Object.entries(authMap||{});
const c = {};
for (const [au, r] of am) {
  if ((Date.now() - (r.ts||0)) > 48*3600e3) continue;
  const k = s8(r.glUid) + ' ' + (r.name||'?') + ' ' + r.plat;
  c[k] = c[k] || { other: 0, acct: 0, dev: 0 };
  c[k][au === r.glUid ? 'dev' : (au === r.acct ? 'acct' : 'other')]++;
}
console.log('== _authMap rows written in the last 48h, per device: fresh-anonymous uid / account uid / adopted-device uid ==');
for (const [k, v] of Object.entries(c)) console.log('  ' + k.padEnd(40) + ' freshAnon=' + v.other + ' account=' + v.acct + ' adoptedDevice=' + v.dev);
const rooms = Object.keys(roomIndex||{});
console.log(`\n== crews (config.circle===true) among ${rooms.length} indexed rooms ==`);
for (const room of rooms) {
  const [cfg, acl, users, diag] = await Promise.all([get(`gl/${room}/config`), get(`gl/${room}/acl`), get(`gl/${room}/users`), get(`gl/${room}/diag`)]);
  if (!cfg || cfg.circle !== true) continue;
  const aclKeys = Object.keys(acl||{});
  const canRead = au => !!(au && (acl?.[au] || cfg.owner === au));
  console.log(`\n-- CREW ${room}  owner=${s8(cfg.owner)} acl=${aclKeys.length} users=${Object.keys(users||{}).length} diag=${Object.keys(diag||{}).length}`);
  for (const [D, u] of Object.entries(users||{})) {
    const acct = devOwner?.[D]?.acct || '';
    const aus = am.filter(([au, r]) => r.glUid === D).map(([au]) => au);
    const dg = diag?.[D] || {};
    const flags = [];
    if (!canRead(D) && !canRead(acct) && !aus.some(canRead)) flags.push('NO-ID-CAN-READ');
    if (canRead(D) && acct && !canRead(acct)) flags.push('FLIP-WOULD-REVOKE(device ok, acct not)');
    if (!canRead(D) && acct && canRead(acct)) flags.push('anon-attach-denied(acct ok, device not)');
    console.log(`   ${s8(D)} ${(u.name||'?').padEnd(12)} rowTs=${ago(u.ts).padEnd(6)} acct=${s8(acct).padEnd(10)} devInAcl=${canRead(D)} acctInAcl=${canRead(acct)} build=${dg.build||u.build||'?'} vis=${dg.vis||'?'} ${flags.length ? '  <<< ' + flags.join('; ') : ''}`);
  }
}
process.exit(0);
