// Read an iPhone's flight recorder (iOS 1.0.19+): node tools/flight.mjs [name-or-uid] [hours]
// Prints the timeline the app uploaded to gl/_debug/flight/<uid>, oldest first, and marks every
// change of the location permission. Default: Laura, last 48 hours.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(new URL('../.keys/tracker-58b87-firebase-adminsdk-fbsvc-1f0441c5d4.json', import.meta.url), 'utf8'))), databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com' });
const db = admin.database();
const who = process.argv[2] || 'Laura';
const hours = +(process.argv[3] || 48);
const t = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const all = (await db.ref('gl/_debug/flight').get()).val() || {};
const diag = (await db.ref('gl/_diag/devices').get()).val() || {};
const uids = Object.keys(all).filter(u => u === who || u.startsWith(who) || ((diag[u] && diag[u].name) || '').includes(who));
if (!uids.length) { console.log('no flight data for', who, '— uploaders so far:', Object.keys(all).map(u => (diag[u] && diag[u].name) || u.slice(0, 8)).join(', ') || 'none'); process.exit(0); }
const since = Date.now() - hours * 3600e3;
for (const uid of uids) {
  console.log('==', (diag[uid] && diag[uid].name) || uid, uid.slice(0, 8));
  let lastAuth = null;
  for (const k of Object.keys(all[uid]).map(Number).filter(n => n >= since).sort((a, b) => a - b)) {
    const e = all[uid][k];
    const flip = e.auth && lastAuth && e.auth !== lastAuth ? '   <<<<< PERMISSION ' + lastAuth + ' -> ' + e.auth : '';
    if (e.auth) lastAuth = e.auth;
    const extra = Object.entries(e).filter(([x]) => !['k', 't', 'st', 'lock', 'auth', 'batt', 'chg', 'lowP'].includes(x)).map(([x, v]) => x + '=' + v).join(' ');
    console.log(t(k), (e.k || '').padEnd(9), (e.st || '').padEnd(2), e.lock ? 'locked  ' : 'unlocked', (e.auth || '').padEnd(9), 'batt ' + e.batt + (e.chg ? '+chg' : ''), e.lowP ? 'LOWPWR' : '', extra, flip);
  }
}
process.exit(0);
