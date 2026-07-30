// Audio transcription via the OpenAI audio API (Whisper).
// Courtroom recordings routinely run for hours, well past the API's 25 MB
// per-request limit, so anything big is re-encoded and split into ~10-minute
// mp3 chunks with ffmpeg before upload.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const MAX_DIRECT_BYTES = 24 * 1024 * 1024; // stay under the 25 MB API cap
const CHUNK_SECONDS = 600;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`)));
  });
}

async function hasFfmpeg() {
  try { await run('ffmpeg', ['-version']); return true; } catch { return false; }
}

// Split (and re-encode to mono 64k mp3, which shrinks typical courtroom audio
// well under the cap) into CHUNK_SECONDS pieces. Returns ordered chunk paths.
async function chunkAudio(inputPath, workDir) {
  const outPattern = path.join(workDir, 'chunk-%04d.mp3');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    outPattern,
  ]);
  return fs.readdirSync(workDir)
    .filter(f => f.startsWith('chunk-') && f.endsWith('.mp3'))
    .sort()
    .map(f => path.join(workDir, f));
}

// Build a vocabulary hint from the docket for Whisper's `prompt` parameter —
// it biases the model toward the correct spellings of names, attorneys, and
// case numbers, which is where courtroom transcription errs most. Whisper
// keeps only the last ~224 tokens of the prompt, so the hint is kept short
// and recent conversational context (prevTail) goes last.
function buildVocabularyHint(docketText) {
  if (!docketText) return '';
  const words = docketText.match(/\b(?:[A-Z][a-zA-Z'’-]+|\d{2,4}-[A-Z]{1,3}-?\d+)\b/g) || [];
  const seen = new Set();
  const vocab = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (!seen.has(key)) { seen.add(key); vocab.push(w); }
  }
  return vocab.join(', ').slice(0, 400);
}

async function transcribeChunk(filePath, promptHint) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (needed for audio transcription)');

  const form = new FormData();
  const bytes = await fs.promises.readFile(filePath);
  form.append('file', new Blob([bytes]), path.basename(filePath));
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('language', 'en');
  if (promptHint) form.append('prompt', promptHint);

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

// Transcribe one uploaded recording. onProgress(done, total) reports chunk
// progress; docketText (optional) seeds a spelling-bias vocabulary hint.
// Returns timestamped transcript text like "[00:14:32] ...".
async function transcribeFile(inputPath, originalName, onProgress, docketText) {
  const stat = await fs.promises.stat(inputPath);
  let chunks;
  let workDir = null;

  const ffmpegAvailable = await hasFfmpeg();
  if (ffmpegAvailable) {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'court-audio-'));
    chunks = await chunkAudio(inputPath, workDir);
    if (chunks.length === 0) throw new Error(`ffmpeg produced no audio chunks for ${originalName}`);
  } else if (stat.size <= MAX_DIRECT_BYTES) {
    chunks = [inputPath];
  } else {
    throw new Error(
      `${originalName} is ${(stat.size / 1024 / 1024).toFixed(0)} MB, over the transcription API limit, ` +
      'and ffmpeg is not installed to split it. Install ffmpeg (ffmpeg.org) and try again.'
    );
  }

  const vocabHint = buildVocabularyHint(docketText);
  const lines = [];
  let prevTail = '';
  try {
    for (let i = 0; i < chunks.length; i++) {
      // Vocabulary first, running context last — Whisper keeps the prompt's tail.
      const promptHint = [vocabHint, prevTail].filter(Boolean).join('\n');
      const result = await transcribeChunk(chunks[i], promptHint);
      const offset = i * CHUNK_SECONDS;
      const chunkText = Array.isArray(result.segments)
        ? result.segments.map(s => (s.text || '').trim()).join(' ')
        : (result.text || '');
      prevTail = chunkText.slice(-300);
      if (Array.isArray(result.segments) && result.segments.length) {
        for (const seg of result.segments) {
          const text = (seg.text || '').trim();
          if (text) lines.push(`[${fmtTime(offset + (seg.start || 0))}] ${text}`);
        }
      } else if (result.text) {
        lines.push(`[${fmtTime(offset)}] ${result.text.trim()}`);
      }
      if (onProgress) onProgress(i + 1, chunks.length);
    }
  } finally {
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  return lines.join('\n');
}

module.exports = { transcribeFile };
