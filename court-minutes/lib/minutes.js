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
          'defendant_presence', 'bond', 'proceeding_type', 'minutes', 'rulings',
          'next_setting', 'timestamps', 'match_confidence', 'match_evidence',
          'needs_review', 'review_reason',
        ],
        properties: {
          docket_number: { type: 'string', description: 'Docket/case number exactly as it appears on the docket' },
          defendant: { type: 'string' },
          charges: { type: 'string', description: 'Charges as listed on the docket or stated on the record; "Not reflected in the recording" if neither source has them' },
          state_counsel: { type: 'string', description: 'Prosecutor / State attorney; "Not reflected in the recording" if not identified' },
          defense_counsel: { type: 'string', description: 'Defense attorney; note if public defender or if defendant appeared pro se; "Not reflected in the recording" if not identified' },
          defendant_presence: { type: 'string', description: 'Whether and how the defendant appeared — e.g. "Present", "Present in custody", "Present on bond", "Appeared remotely", "Not present"; "Not reflected in the recording" if the record does not show it' },
          bond: { type: 'string', description: 'Bond status or action taken — e.g. "Continued", "Set at $25,000", "Revoked", "ROR"; "No bond action taken" if none, "Not reflected in the recording" if unclear' },
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
          match_confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'high = two or more independent signals agree (e.g. case number read AND defendant name heard); medium = one strong signal with consistent context; low = inferred from context alone',
          },
          match_evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Each independent signal supporting the match, with a timestamp where possible — e.g. "case number 2026-CF-101 read by the court at 00:14:22", "defendant identified himself as John Doe at 00:14:40", "ASA Jones announced appearance"',
          },
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

Correlate transcript passages to docket entries using multiple independent signals, never a single one when more are available: the case number as read on the record, the defendant's name as spoken, counsel announcing appearances, the charges discussed, and the case's position in the day's sequence. For every entry, list each supporting signal (with its timestamp) in match_evidence and grade match_confidence: high requires at least two independent signals agreeing (e.g. case number read AND defendant name heard); medium is one strong signal with consistent context; low is inference from context alone. Any entry below high confidence must also set needs_review with the reason. If two docket entries could plausibly match the same passage, pick the better-supported one, flag it, and name the alternative in review_reason — never assign silently.

Expect routine day-of differences between the docket and the courtroom: attorneys substitute for one another constantly. A different attorney appearing than the docket lists is NOT evidence of a wrong-case match and is not by itself a reason to flag the entry — weigh the case number and defendant name most heavily for identity, and record in the minutes the counsel who actually appeared per the recording (noting a substitution when the record makes it clear, e.g. "PD White appearing for PD Brown"). If the clerk provides DAY-OF UPDATES, they supersede the docket wherever the two conflict.

Draft minutes in formal clerk-of-court style: past tense, third person, factual, no speculation. Record appearances (State, defense, defendant present/absent/in custody), the nature of the proceeding, pleas, motions and rulings, bond action, sentences pronounced, and the next setting.

Every entry must address every field the same way so the minutes are uniform and complete: the judge, both attorneys, the defendant's presence, bond, and next setting are stated for every case. When the record does not establish a field, write "Not reflected in the recording" for that field rather than leaving it blank or guessing — a visible gap the clerk can fill beats a silent omission.

Accuracy over completeness: if the audio is unclear or a match is uncertain, still draft what you can but set needs_review to true and say why. Never invent a docket number, name, disposition, or date that is not supported by the docket or the recording. Cases on the docket that were never taken up on the record go in not_heard, and audio you cannot tie to a case goes in unmatched_audio.`;

function extractText(message) {
  return message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

async function generateMinutes({ docketText, transcript, meta, updatesText }) {
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
    updatesText ? `=== DAY-OF UPDATES from the clerk (these supersede the docket where they conflict) ===\n${updatesText}` : null,
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
