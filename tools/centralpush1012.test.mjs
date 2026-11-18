// Build 1012: a phone's push address is filed centrally on every app open, so person-aimed pushes
// (invites, Nudge, Notify) reach someone who has not joined any room yet.
//
// Usage:  node tools/centralpush1012.test.mjs [path/to/public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const srv = readFileSync('server.js', 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL —', m); } };
ok(idx.includes("window._glFetch('/push/register'"), 'page files the address');
ok(idx.includes("try { window._fileCentralPush(); } catch (e) {}   // 1012"), 'filed whenever FCM hands over a token');
ok(idx.includes("localStorage.setItem('gl_push_asked', '1');") && idx.includes("if (st === 'denied' || asked) return;"), 'asks for permission once, never nags');
ok(idx.includes("var FM = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.FirebaseMessaging;"), 'phone app only');
ok(srv.includes("app.post('/push/register', rateLimit(20, 60000), requireUser,"), 'register needs a sign-in');
const fs = srv.indexOf('async function findSubsForUid'), central = srv.indexOf("_dbGet('gl/_pushTokens/' + uid)", fs), roomLoop = srv.indexOf("for (const branch of ['pushSubs', 'favSubs'])", fs);
ok(fs > 0 && roomLoop > fs && central > roomLoop, 'central address is the last resort, after room subscriptions');
console.log(fails ? `${fails} of ${n} checks FAILED` : `all ${n} checks pass`);
process.exit(fails ? 1 : 0);
