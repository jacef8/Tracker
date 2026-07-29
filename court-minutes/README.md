# Court Minutes Builder

Upload the felony-day courtroom audio and the day's docket; get back AI-drafted
minutes correlated to every docket number — as a Word document and as
copy/paste-ready text for your court reporting program.

**How it works**

1. **Transcribe** — audio is re-encoded and split into ~10-minute chunks with
   ffmpeg, then transcribed with the OpenAI Whisper API (timestamped).
2. **Correlate & draft** — Claude (`claude-opus-5`) reads the docket and the
   transcript together, matches proceedings to docket numbers/defendants/
   attorneys, and drafts formal per-case minute entries. The docket is treated
   as the source of truth for names and numbers; anything uncertain is flagged
   **Review needed** instead of guessed.
3. **Deliver** — a `.docx` you can download, plus a per-case **Copy** button in
   the browser for pasting straight into your reporting program. Cases on the
   docket that never came up on the record, and audio that couldn't be matched
   to any case, are listed separately so nothing slips through.

## Setup

Requirements: Node.js 18+, [ffmpeg](https://ffmpeg.org) on your PATH
(needed for recordings over ~25 MB — i.e., almost any full court day).

```sh
cd court-minutes
npm install

export ANTHROPIC_API_KEY=sk-ant-...   # console.anthropic.com — minutes drafting
export OPENAI_API_KEY=sk-...          # platform.openai.com — audio transcription

npm start
# open http://localhost:3100
```

On Windows (PowerShell): `$env:ANTHROPIC_API_KEY="sk-ant-..."` etc.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3100` | Web server port |
| `CLAUDE_MODEL` | `claude-opus-5` | Model used to draft minutes |
| `WHISPER_MODEL` | `whisper-1` | Transcription model |

## Using it

1. Fill in court/judge/date (optional but improves the header and matching).
2. Add the audio file(s) for the day, in order (e.g. morning, afternoon).
3. Paste the docket (or upload it as `.txt`/`.csv`). Include docket numbers,
   defendant names, and — if you have them — charges and attorneys of record;
   the more that's on the docket, the better the matching and spellings.
4. Click **Build Minutes**. A full court day takes several minutes to process;
   progress is shown per stage.
5. Review each entry (anything flagged ⚠ first), copy entries into your
   reporting program, or download the `.docx` / raw transcript.

## Important notes

- **This produces a draft, not the record.** Machine transcription mishears
  names, numbers, and dispositions. Every entry — flagged or not — should be
  verified against the recording before it becomes part of the official
  minutes. The document header and UI say so on purpose.
- **Data handling:** audio is sent to OpenAI for transcription and the
  transcript + docket are sent to Anthropic for drafting, under your own API
  accounts. Confirm this is acceptable under your office's policies for court
  records before using it on real hearings. Uploaded audio files are deleted
  from the server after processing; jobs are held in memory and vanish on
  restart.
- **Cost:** roughly $0.36/hour of audio for transcription, plus a few dollars
  per court day for drafting, depending on transcript length.
