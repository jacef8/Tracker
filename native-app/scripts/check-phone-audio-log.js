#!/usr/bin/env node
// Pulls the phone's rotating audio-routing debug log (gl/_debug/phoneAudioLog) and prints it
// chronologically. Mirrors GroundLinkWatch/scripts/check-voice-log.js — same idea, applied to
// the "why is PTT audio coming out the earpiece instead of the speaker" question instead of
// the "was this really cellular" one.
//
// Usage: node scripts/check-phone-audio-log.js

const https = require('https');

const DB_URL = 'https://tracker-58b87-default-rtdb.firebaseio.com';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const raw = await fetchJson(`${DB_URL}/gl/_debug/phoneAudioLog.json`);
  if (!raw) { console.log('No phoneAudioLog found yet — run a PTT test on the phone first.'); return; }

  const entries = Object.keys(raw)
    .map((slot) => ({ slot: Number(slot), ...raw[slot] }))
    .sort((a, b) => a.ts - b.ts);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  console.log(`\nphoneAudioLog (${entries.length} entries, oldest first)\n`);
  for (const e of entries) {
    console.log(`${fmt.format(new Date(e.ts))} | slot ${e.slot} | ${e.event}`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
