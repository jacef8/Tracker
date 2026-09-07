// One REAL send to Laura's current device token. validate_only never touches Apple, so this is
// the only way to see the APNs leg. Body is written to be obviously a test.
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync('C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json','utf8'))),
  databaseURL: 'https://tracker-58b87-default-rtdb.firebaseio.com',
});
const UID = 'z1gGJRKAf2bwymun9EW13dhaDxq1';
const rec = (await admin.database().ref('gl/our_crew/pushSubs/' + UID).get()).val();
if (!rec?.fcm) { console.log('no token'); process.exit(1); }
console.log('sending to', rec.name, '·', rec.dev, '· token', rec.fcm.slice(0, 16) + '…\n');
try {
  const id = await admin.messaging().send({
    token: rec.fcm,
    notification: { title: 'GroundLink test', body: 'Jace is testing notifications — nothing is wrong, you can ignore this.' },
    data: { type: 'info', url: '/' },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'groundlink' } },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
  });
  console.log('ACCEPTED by FCM — message id:', id);
  console.log('The Firebase→Apple leg did NOT reject it. If her phone shows nothing, the failure');
  console.log('is on the handset: notification settings, Focus mode, or delivery silently dropped.');
} catch (e) {
  console.log('REJECTED');
  console.log('  code:   ', e.errorInfo?.code || e.code);
  console.log('  message:', e.errorInfo?.message || e.message);
}
process.exit(0);
