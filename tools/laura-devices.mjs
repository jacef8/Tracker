import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const gl = (await admin.database().ref('gl').get()).val() || {};
const ago = t => !t ? '—' : (d => d < 60 ? d + 'm' : d < 1440 ? (d/60).toFixed(1) + 'h' : (d/1440).toFixed(1) + 'd')((Date.now() - t) / 60000);
const ids = ['5mRi0bHJDshnJhWkBG1UnqPfqsf1','BUIq0Y7ORJOWATZpMr2F4uOfmv22','EuVKju9G0vforUKhOxLONsMi1Nu1','z1gGJRKAf2bwymun9EW13dhaDxq1'];
for (const uid of ids) {
  console.log('\n══ ' + uid + (uid === 'z1gGJRKAf2bwymun9EW13dhaDxq1' ? '   ←← THE ONE NOTIFY TARGETS' : ''));
  for (const r of Object.keys(gl).filter(k => k[0] !== '_')) {
    const u = gl[r].users?.[uid];
    if (u) console.log(`   roster ${r}: name=${u.name} dev=${u.dev||'?'} lastFix=${ago(u.ts)} ago  ua=${(u.ua||'').slice(0,50)}`);
    for (const b of ['pushSubs','favSubs']) {
      const rec = gl[r][b]?.[uid];
      if (rec) console.log(`   ${b} ${r}: fcm=${rec.fcm?'yes':'no'} web=${rec.sub?'yes':'no'} written=${ago(rec.ts||rec.updated)} ago  platform=${rec.platform||rec.plat||'?'}  keys=[${Object.keys(rec).join(',')}]`);
    }
  }
}
process.exit(0);
