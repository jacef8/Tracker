// Realtime Database rules: show / diff / deploy, with the live rules backed up first.
//   node tools/deploy-rules.mjs            -> is the live copy the same as database.rules.json?
//   node tools/deploy-rules.mjs --apply    -> back up live rules to tools/rules-backups/, then deploy
//   node tools/deploy-rules.mjs --restore <file>  -> put a backup back
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const SA = 'C:/Users/jford/Downloads/tracker-58b87-firebase-adminsdk-fbsvc-b52a441649.json';
const DB = 'https://tracker-58b87-default-rtdb.firebaseio.com';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const cred = admin.credential.cert(JSON.parse(fs.readFileSync(SA, 'utf8')));
const tok = (await cred.getAccessToken()).access_token;

async function live() {
  const r = await fetch(DB + '/.settings/rules.json?access_token=' + tok);
  if (!r.ok) throw new Error('read rules: ' + r.status + ' ' + await r.text());
  return await r.text();
}
async function put(text) {
  const r = await fetch(DB + '/.settings/rules.json?access_token=' + tok, { method: 'PUT', body: text });
  const body = await r.text();
  if (!r.ok) throw new Error('deploy: ' + r.status + ' ' + body);
  return body;
}
// Compare as data, not text — whitespace and comments don't count.
const norm = t => JSON.stringify(JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')));

const args = process.argv.slice(2);
const cur = await live();
if (args[0] === '--restore') {
  const t = fs.readFileSync(args[1], 'utf8');
  console.log(await put(t));
  console.log('restored from', args[1]);
} else {
  const want = fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8');
  const same = norm(cur) === norm(want);
  console.log(same ? 'live rules MATCH database.rules.json' : 'live rules DIFFER from database.rules.json');
  if (args[0] === '--apply' && !same) {
    const dir = path.join(ROOT, 'tools', 'rules-backups');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'live-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(f, cur);
    console.log('backed up live rules to', f);
    console.log(await put(want));
    console.log('deployed. Undo with: node tools/deploy-rules.mjs --restore "' + f + '"');
  }
}
process.exit(0);
