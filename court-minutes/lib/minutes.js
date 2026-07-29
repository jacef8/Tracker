// Correlates the day's transcript with the docket and drafts per-case minutes
// using Claude (claude-opus-5) with a structured-output JSON schema, so the
// result is always machine-readable and renders cleanly into the Word doc.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

const MINUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session', 'entries', 'unmatched_audio', 'not_heard'],
  properties: {
    session: {
      type: 'object',
      additionalProperties: false,
      required: ['court', 'judge', 'date', 'summary'],
      properties: {
        court: { type: 'string', description: 'Court name/division as provided or heard on the record' },
        judge: { type: 'string', description: 'Presiding judge; empty string if unknown' },
        date: { type: 'string', description: 'Court date; empty string if unknown' },
        summary: { type: 'string', description: 'One or two sentences describing the session overall' },
      },
    },
    entries: {
      type: 'array',
      description: 'One entry per docket case that was actually taken up on the record, in the order heard',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'docket_number', 'defendant', 'charges', 'state_counsel', 'defense_counsel',
          'proceeding_type', 'minutes', 'rulings', 'next_setting', 'timestamps', 'needs_review', 'review_reason',
        ],
        properties: {
          docket_number: { type: 'string', description: 'Docket/case number exactly as it appears on the docket' },
          defendant: { type: 'string' },
          charges: { type: 'string', description: 'Charges if listed on the docket or stated on the record; empty string otherwise' },
          state_counsel: { type: 'string', description: 'Prosecutor / State attorney; empty string if not identified' },
          defense_counsel: { type: 'string', description: 'Defense attorney; note if public defender or if defendant appeared pro se; empty string if not identified' },
          proceeding_type: { type: 'string', description: 'e.g. Arraignment, Plea, Pretrial Conference, Sentencing, Motion Hearing, Violation of Probation' },
          minutes: {
            type: 'string',
            description: 'The minute entry itself: formal, past-tense, third-person clerk-of-court style. Cover appearances, what occurred, pleas entered, motions and outcomes, bond action, and orders of the court. Only state what the record supports.',
          },
          rulings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short bullet list of orders/rulings for quick scanning (may be empty)',
          },
          next_setting: { type: 'string', description: 'Next court date/setting if announced; empty string otherwise' },
          timestamps: { type: 'string', description: 'Approximate audio timestamp range for this case, e.g. "00:14:20-00:22:05"; empty if unknown' },
          needs_review: { type: 'boolean', description: 'True if the match to the docket is uncertain or the audio was unclear' },
          review_reason: { type: 'string', description: 'Why the clerk should double-check this entry; empty string if needs_review is false' },
        },
      },
    },
    unmatched_audio: {
      type: 'array',
      items: { type: 'string' },
      description: 'Portions of the recording (with timestamps) that could not be confidently matched to any docket entry',
    },
    not_heard: {
      type: 'array',
      items: { type: 'string' },
      description: 'Docket entries (number + name) that do not appear anywhere in the recording — e.g. continued, passed, or FTA off the record',
    },
  },
};

const SYSTEM_PROMPT = `You are an assistant to a clerk of court, preparing draft minutes for a felony court day.

You are given (1) the day's docket and (2) a timestamped transcript of the courtroom audio, machine-transcribed and therefore imperfect: names, docket numbers, and legal terms may be garbled. Use the docket as the source of truth for spellings of names, docket numbers, and charges; use the transcript for what actually happened.

Correlate transcript passages to docket entries by docket number when called, by defendant name, and by context (attorney names, charges, sequence). Draft minutes in formal clerk-of-court style: past tense, third person, factual, no speculation. Record appearances (State, defense, defendant present/absent/in custody), the nature of the proceeding, pleas, motions and rulings, bond action, sentences pronounced, and the next setting.

Accuracy over completeness: if the audio is unclear or a match is uncertain, still draft what you can but set needs_review to true and say why. Never invent a docket number, name, disposition, or date that is not supported by the docket or the recording. Cases on the docket that were never taken up on the record go in not_heard, and audio you cannot tie to a case goes in unmatched_audio.`;

function extractText(message) {
  return message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

async function generateMinutes({ docketText, transcript, meta }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set (needed to generate minutes)');
  }
  const client = new Anthropic();

  const metaLines = [];
  if (meta.court) metaLines.push(`Court: ${meta.court}`);
  if (meta.judge) metaLines.push(`Presiding Judge: ${meta.judge}`);
  if (meta.date) metaLines.push(`Court date: ${meta.date}`);

  const userPrompt = [
    metaLines.length ? `Session details provided by the clerk:\n${metaLines.join('\n')}` : null,
    `=== TODAY'S DOCKET ===\n${docketText}`,
    `=== COURTROOM AUDIO TRANSCRIPT (timestamped, machine-generated) ===\n${transcript}`,
    'Produce the minutes for this court day.',
  ].filter(Boolean).join('\n\n');

  // Stream (transcripts and output are long), with server-side refusal
  // fallback enabled so a classifier false-positive on criminal-case content
  // re-runs on the recommended fallback model instead of failing the job.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: MINUTES_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const why = message.stop_details && message.stop_details.explanation;
    throw new Error(`The model declined to process this request${why ? `: ${why}` : '.'}`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The minutes output was truncated (max_tokens). Try splitting the day into smaller audio batches.');
  }

  const raw = extractText(message);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse the generated minutes as JSON: ${e.message}`);
  }
}

module.exports = { generateMinutes };
