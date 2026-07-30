// End-to-end pipeline test with mocked OpenAI + Anthropic APIs.
// Verifies the whole flow — multipart upload, transcription request shape,
// minutes drafting request shape, docx rendering, copy-text output — without
// real API keys or audio. Run with: npm test
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3421;
const MOCK_PORT = 3422;

const FAKE_TRANSCRIPTION = {
  text: 'State of Florida versus John Doe, case 2026-CF-101.',
  segments: [
    { start: 0, text: 'Court is now in session, Judge Smith presiding.' },
    { start: 12, text: 'State of Florida versus John Doe, case 2026-CF-101, for arraignment.' },
    { start: 30, text: 'Defendant enters a plea of not guilty. Bond continued. Pretrial August 15th.' },
  ],
};

const FAKE_MINUTES = {
  session: { court: 'Test Circuit Court', judge: 'Hon. J. Smith', date: '2026-07-29', summary: 'One case heard.' },
  entries: [{
    docket_number: '2026-CF-101', defendant: 'John Doe', charges: 'Burglary',
    state_counsel: 'ASA Jones', defense_counsel: 'PD Brown',
    defendant_presence: 'Present in custody', bond: 'Continued', proceeding_type: 'Arraignment',
    minutes: 'Defendant appeared with counsel and entered a plea of not guilty. Bond continued.',
    rulings: ['Not guilty plea entered', 'Bond continued'],
    next_setting: 'August 15, 2026 — pretrial', timestamps: '00:00:12-00:00:45',
    needs_review: false, review_reason: '',
  }],
  unmatched_audio: [], not_heard: ['2026-CF-102 — Jane Roe (not called)'],
};

let sawWhisperPrompt = false;
let sawDocketInClaude = false;

// One mock server plays both APIs (paths don't collide).
const mock = http.createServer((req, res) => {
  let body = [];
  req.on('data', c => body.push(c));
  req.on('end', () => {
    body = Buffer.concat(body).toString('latin1');
    if (req.url.includes('/audio/transcriptions')) {
      sawWhisperPrompt = body.includes('2026-CF-101'); // vocabulary hint present?
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FAKE_TRANSCRIPTION));
    } else if (req.url.includes('/messages')) {
      sawDocketInClaude = body.includes('2026-CF-101') && body.includes('Court is now in session');
      // Minimal Anthropic SSE stream: message_start -> text delta -> stop.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(FAKE_MINUTES) } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
});

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
function ok(msg) { console.log('  ok -', msg); }

async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, r));

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: 'test-key',
      OPENAI_BASE_URL: `http://localhost:${MOCK_PORT}/v1`,
      ANTHROPIC_BASE_URL: `http://localhost:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  await new Promise(r => setTimeout(r, 900));

  try {
    // Submit a job: tiny fake mp3 (mock doesn't decode it) + pasted docket.
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('ID3fakeaudio')]), 'felony-day.mp3');
    form.append('docketText', '2026-CF-101  Doe, John — Burglary — ASA Jones / PD Brown\n2026-CF-102  Roe, Jane — Theft');
    form.append('court', 'Test Circuit Court');
    form.append('judge', 'Hon. J. Smith');
    form.append('date', '2026-07-29');

    const submit = await fetch(`http://localhost:${PORT}/api/jobs`, { method: 'POST', body: form });
    const { id, error } = await submit.json();
    if (!submit.ok || !id) fail(`job submit: ${error || submit.status}`);
    ok('job submitted');

    // Poll to completion
    let job;
    for (let i = 0; i < 40; i++) {
      job = await (await fetch(`http://localhost:${PORT}/api/jobs/${id}`)).json();
      if (job.stage === 'done' || job.stage === 'error') break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (job.stage !== 'done') fail(`job ended in stage=${job.stage}: ${job.error}`);
    ok('pipeline completed');

    if (!sawWhisperPrompt) fail('vocabulary hint not sent to transcription API');
    ok('docket vocabulary hint reached the transcription request');
    if (!sawDocketInClaude) fail('docket/transcript not present in drafting request');
    ok('docket + transcript reached the drafting request');

    const entry = job.minutes.entries[0];
    if (entry.docket_number !== '2026-CF-101') fail('minutes entry mismatch');
    for (const line of ['Date: 2026-07-29', 'Judge: Hon. J. Smith', 'For the State: ASA Jones',
                        'Defendant: Present in custody', 'Bond: Continued']) {
      if (!job.copyText[0].text.includes(line)) fail(`copy text missing field: ${line}`);
    }
    ok('minutes JSON and fixed-template copy text look right');

    const docx = await fetch(`http://localhost:${PORT}/api/jobs/${id}/minutes.docx`);
    const buf = Buffer.from(await docx.arrayBuffer());
    if (!docx.ok || buf.length < 2000 || buf[0] !== 0x50 || buf[1] !== 0x4b) fail('docx download invalid'); // PK zip magic
    ok(`docx downloads and is a valid zip container (${buf.length} bytes)`);

    const transcript = await (await fetch(`http://localhost:${PORT}/api/jobs/${id}/transcript.txt`)).text();
    if (!transcript.includes('[00:00:12]')) fail('transcript missing timestamps');
    ok('timestamped transcript downloads');

    console.log('\nE2E: all checks passed');
  } finally {
    server.kill();
    mock.close();
  }
}

main().catch(e => fail(e.stack || e.message));
