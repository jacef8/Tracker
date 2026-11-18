// 1030: answering a Talk call shows the Talk bar, and two connects can never run at once.
// Usage:  node tools/talk1030.test.mjs [public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const vj = readFileSync(dir + '/voice.js', 'utf8').replace(/\r\n/g, '\n');
let fails = 0;
const check = (ok, label) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label); if (!ok) fails++; };
const body = (src, marker) => { const i = src.indexOf(marker); return i < 0 ? '' : src.slice(i, src.indexOf('\n}', i)); };

const acc = body(idx, 'window._acceptIncomingVoice = async function');
check(/listen: true, show: true/.test(acc), 'tapping the incoming-call banner opens the Talk bar, not a hidden listener');
check(/_answeringVoice = Date\.now\(\)/.test(acc), 'answering holds off the crew channel join');
const inv = idx.slice(idx.indexOf("fbOnValue(fbRef(db, 'gl/' + _rk + '/voice/' + userId)"), idx.indexOf("fbOnValue(fbRef(db, 'gl/' + _rk + '/voiceAll')"));
check(/listen: true, show: true/.test(inv), 'an auto-answered 1:1 call (Android) also shows the Talk bar');
check((idx.match(/_pendingChannelJoin && !\(window\._callBlocksChannel && window\._callBlocksChannel\(\)\)/g) || []).length === 2,
  'both automatic channel joins wait while a call is ringing or live');
check(/window\._callBlocksChannel = function/.test(idx), 'the call-beats-channel rule exists');

const ov = body(vj, 'export function openVoice(opts)');
check(/_connGen\+\+/.test(ov), 'a new call cancels any connect still in flight');
check(/session\.listen && !session\.show && barEl/.test(ov), 'only hidden listeners hide the bar');
check(/session\._connecting/.test(ov), 'a second open of the same room while connecting does not connect twice');
const cv = vj.slice(vj.indexOf('async function connectVoice()'), vj.indexOf('// Push-to-talk: HOLD to transmit'));
check(/_gen !== _connGen \|\| session !== _sess/.test(cv), 'a stale connect gives up before building a room');
check(/room !== _thisRoom \|\| session !== _sess\) \{[^}]*_thisRoom\.disconnect\(\)/.test(cv), 'a room replaced mid-connect is hung up');
check(/_connGen\+\+/.test(body(vj, 'export function leaveVoice()')), 'hanging up cancels a connect in flight');
check(/Tap here to hear them/.test(vj), 'the blocked-audio prompt is plain');

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
