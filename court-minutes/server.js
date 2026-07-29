// court-minutes — upload felony-day courtroom audio + docket, get AI-drafted
// per-case minutes as a Word document and copy/paste-ready text.
//
// Pipeline per job: transcribe audio (Whisper, chunked) -> correlate with the
// docket and draft minutes (Claude) -> render .docx. Jobs run in-process and
// are tracked in memory; the browser polls /api/jobs/:id.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { transcribeFile } = require('./lib/transcribe');
const { generateMinutes } = require('./lib/minutes');
const { buildDocx, entryPlainText } = require('./lib/document');

const PORT = process.env.PORT || 3100;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 12 },
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map(); // id -> job

function setStage(job, stage, detail) {
  job.stage = stage;
  job.detail = detail || '';
  job.updatedAt = Date.now();
}

async function runJob(job, audioFiles, docketText, meta) {
  try {
    // 1. Transcribe every recording in order (morning/afternoon sessions etc.)
    const parts = [];
    for (let i = 0; i < audioFiles.length; i++) {
      const f = audioFiles[i];
      setStage(job, 'transcribing', `Transcribing ${f.originalname} (file ${i + 1} of ${audioFiles.length})…`);
      const text = await transcribeFile(f.path, f.originalname, (done, total) => {
        setStage(job, 'transcribing',
          `Transcribing ${f.originalname} (file ${i + 1} of ${audioFiles.length}) — segment ${done}/${total}`);
      });
      parts.push(`--- Recording: ${f.originalname} ---\n${text}`);
    }
    job.transcript = parts.join('\n\n');
    if (!job.transcript.trim()) throw new Error('Transcription produced no text — check the audio files.');

    // 2. Draft the minutes against the docket
    setStage(job, 'drafting', 'Correlating transcript with the docket and drafting minutes…');
    const minutes = await generateMinutes({ docketText, transcript: job.transcript, meta });
    job.minutes = minutes;

    // 3. Build the Word document
    setStage(job, 'rendering', 'Building the Word document…');
    job.docx = await buildDocx(minutes);
    job.copyText = (minutes.entries || []).map(e => ({
      docket_number: e.docket_number,
      text: entryPlainText(e),
    }));

    setStage(job, 'done', '');
  } catch (err) {
    job.error = err.message || String(err);
    setStage(job, 'error', job.error);
  } finally {
    for (const f of audioFiles) fs.promises.unlink(f.path).catch(() => {});
  }
}

app.post('/api/jobs', upload.fields([
  { name: 'audio', maxCount: 12 },
  { name: 'docketFile', maxCount: 1 },
]), async (req, res) => {
  try {
    const audioFiles = (req.files && req.files.audio) || [];
    if (!audioFiles.length) return res.status(400).json({ error: 'Upload at least one audio file.' });

    let docketText = (req.body.docketText || '').trim();
    const docketUpload = req.files && req.files.docketFile && req.files.docketFile[0];
    if (docketUpload) {
      const fileText = (await fs.promises.readFile(docketUpload.path, 'utf8')).trim();
      fs.promises.unlink(docketUpload.path).catch(() => {});
      docketText = [docketText, fileText].filter(Boolean).join('\n\n');
    }
    if (!docketText) return res.status(400).json({ error: 'Provide the docket (paste it or upload a text/CSV file).' });

    const meta = {
      court: (req.body.court || '').trim(),
      judge: (req.body.judge || '').trim(),
      date: (req.body.date || '').trim(),
    };

    const id = crypto.randomUUID();
    const job = { id, stage: 'queued', detail: '', error: null, createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    runJob(job, audioFiles, docketText, meta); // fire and forget; browser polls

    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json({
    id: job.id,
    stage: job.stage,
    detail: job.detail,
    error: job.error,
    minutes: job.stage === 'done' ? job.minutes : undefined,
    copyText: job.stage === 'done' ? job.copyText : undefined,
  });
});

app.get('/api/jobs/:id/minutes.docx', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.docx) return res.status(404).send('Not ready');
  const date = (job.minutes && job.minutes.session && job.minutes.session.date) || 'draft';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="court-minutes-${date.replace(/[^\w-]+/g, '_')}.docx"`);
  res.send(job.docx);
});

app.get('/api/jobs/:id/transcript.txt', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.transcript) return res.status(404).send('Not ready');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="courtroom-transcript.txt"');
  res.send(job.transcript);
});

app.listen(PORT, () => {
  console.log(`court-minutes running at http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) console.warn('WARNING: OPENAI_API_KEY not set — transcription will fail.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set — minutes generation will fail.');
});
