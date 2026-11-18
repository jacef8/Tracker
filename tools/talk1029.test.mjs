// 1029: Talk that reaches people. Runs the SHIPPED Talk block (cut out of public/index.html
// between its banner and _showIncomingVoice) against a fake voice module, fake Firebase and fake
// timers, then checks the wiring around it in index.html, server.js, sw.js and the DB rules.
// Usage:  node tools/talk1029.test.mjs [public]
import { readFileSync } from 'node:fs';
const dir = (process.argv[2] || 'public').replace(/\/$/, '');
const idx = readFileSync(dir + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const srv = readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const sw = readFileSync(dir + '/sw.js', 'utf8').replace(/\r\n/g, '\n');
const rules = readFileSync('database.rules.json', 'utf8');

let fails = 0;
const check = (ok, label) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label); if (!ok) fails++; };

const a = idx.indexOf('// ── 1029: TALK THAT REACHES PEOPLE');
const b = idx.indexOf('window._showIncomingVoice = function (room, fromName, isChannel) {');
if (a < 0 || b < 0 || b < a) { console.log('FAIL  Talk block not found'); process.exit(1); }
const block = idx.slice(a, b);

function harness() {
  const pushes = [], writes = [], toasts = [], status = [];
  let remote = [], cur = 'gv_crew_a~b', timer = null;
  const window = {
    _voiceModSync: { remoteIds: () => remote.slice(), currentRoom: () => cur, setStatus: (t) => status.push(t) },
    _fb: { db: {}, ref: (d, p) => p, push: (p) => p + '/new', set: (p, v) => writes.push([p, v]) },
    _evt: () => {},
  };
  const env = {
    window, userId: 'a', userName: 'Jace', db: {},
    toast: (m) => toasts.push(m),
    _pushToUid: (u, t, body, type, talk) => pushes.push({ u: [].concat(u), t, type, talk }),
    setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => {},
    location: { search: '' }, history: {}, document: { getElementById: () => null },
  };
  const names = Object.keys(env);
  new Function(...names, block)(...names.map((n) => env[n]));
  return { window, pushes, writes, toasts, status,
           setRemote: (r) => { remote = r; }, setRoom: (r) => { cur = r; }, fire: () => timer && timer() };
}

// 1. unanswered call -> missed notification + status line
{
  const h = harness();
  h.window._talkStartWatch(['b'], 'Lexi', 'crew', 'gv_crew_a~b');
  h.fire();
  const m = h.pushes.find((p) => p.talk && p.talk.kind === 'missed');
  check(!!m && m.u[0] === 'b' && m.talk.group === 'crew', 'a call nobody answers sends "missed Talk" to that person, with the crew');
  check(h.status.length === 1 && /voice message/.test(h.status[0]), 'the caller is told to leave a voice message');
}
// 2. answered call -> nothing
{
  const h = harness();
  h.window._talkStartWatch(['b'], 'Lexi', 'crew', 'gv_crew_a~b');
  h.setRemote(['b']);
  h.fire();
  check(!h.pushes.length && !h.status.length, 'an answered call sends no missed notification');
}
// 3. caller hung up before the timer -> nothing
{
  const h = harness();
  h.window._talkStartWatch(['b'], 'Lexi', 'crew', 'gv_crew_a~b');
  h.setRoom(null);
  h.fire();
  check(!h.pushes.length, 'hanging up before 45 s sends nothing');
}
// 4. a clip while they're not on the call becomes their voice message
{
  const h = harness();
  h.window._talkStartWatch(['b', 'c'], '2 people', 'crew', 'gv_crew_gx');
  h.setRoom('gv_crew_gx');
  h.setRemote(['c']);
  const saved = h.window._talkSaveVoiceMsg('data:audio/webm;base64,AAAA', { durMs: 2300, mime: 'audio/webm' });
  check(saved === true, 'a clip with someone missing is kept as a voice message');
  check(h.writes.length === 1 && h.writes[0][0] === 'gl/crew/voicemail/b/new', 'only the person who is not on the call gets it');
  check(h.writes[0][1].from === 'a' && h.writes[0][1].dur === 2.3, 'the message records who sent it and how long it is');
  const vm = h.pushes.find((p) => p.talk && p.talk.kind === 'vm');
  check(!!vm && vm.u.join() === 'b', 'they get a "voice message" notification');
  h.window._talkSaveVoiceMsg('data:audio/webm;base64,BBBB', { durMs: 1000 });
  check(h.pushes.filter((p) => p.talk && p.talk.kind === 'vm').length === 1, 'a second clip right after does not notify again');
}
// 5. everyone is on the call -> clip is not a voice message
{
  const h = harness();
  h.window._talkStartWatch(['b'], 'Lexi', 'crew', 'gv_crew_a~b');
  h.setRemote(['b']);
  check(h.window._talkSaveVoiceMsg('data:x', {}) === false && !h.writes.length, 'a clip they heard live is not saved');
}
// 6. no call in progress -> not a voice message
{
  const h = harness();
  check(h.window._talkSaveVoiceMsg('data:x', {}) === false, 'a clip outside a call is left alone');
}

// Wiring
const fnBody = (marker) => { const i = idx.indexOf(marker); return i < 0 ? '' : idx.slice(i, idx.indexOf('\n};', i)); };
check(/_talkStartWatch\(\[uid\], name, groupName, roomId\)/.test(fnBody('window._openVoiceTo = async function')), 'Talk from the map rings and watches for an answer');
check(/_talkStartWatch\(\[uid\], name, roomKey, roomId\)/.test(fnBody('window._talkToPerson = async function')), 'Talk from the home screen rings and watches');
check(/kind: 'call'/.test(idx.slice(idx.indexOf('async function _openVoiceToSelected'), idx.indexOf('async function _openVoiceToSelected') + 2500)), 'Talk to picked people now sends a notification');
const tx = fnBody('window._onVoiceTx = function');
check(/kind: 'channel'/.test(tx) && /skipUids: _talkConnectedIds\(\)/.test(tx), 'HOLD on the channel notifies the crew, skipping people already listening');
check(!/pushNotify\('voice', \(userName \|\| 'Someone'\) \+ ' is talking 🔊'/.test(tx), 'a private call no longer tells the whole crew someone is talking');
check(/_talkSaveVoiceMsg\(dataUrl, meta\)/.test(fnBody('window._onVoiceClip = function')), 'recorded clips go through the voice-message check first');
check(/window\._openTalkNotif\(data\)/.test(fnBody('window._handleNotifOpen = function')), 'tapping a Talk notification opens the answer / messages');
check(/window\._listenVoiceMsgs\(_rk\)/.test(idx), 'voice messages are watched in every crew');
check(/findAllSubsForUid\(uid\)/.test(srv.slice(srv.indexOf("app.post('/pushTo'"), srv.indexOf("app.post('/voip'"))), 'the server tries every phone on file, not just the first');
check(/'apns-priority': '10'/.test(srv.slice(srv.indexOf("app.post('/pushTo'"), srv.indexOf("app.post('/voip'"))), 'direct Talk pushes go out at high priority on iPhone');
check(/_skip\.has\(uid\)/.test(srv), 'the crew push can skip people already listening');
check(/vtalk=/.test(sw) && /data\.kind === 'call'/.test(sw), 'web notifications open the answer prompt and stay up for calls');
check(/"voicemail"\s*:\s*\{\s*"\$to"/.test(rules), 'the database allows voice messages');

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
