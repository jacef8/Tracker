// Renders the structured minutes into a .docx (via the `docx` package) and
// into plain text per case for the UI's copy-to-clipboard buttons. Formatting
// is deliberately plain — bold labels, ordinary paragraphs — so a paste into
// the court reporting program carries over cleanly.
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
} = require('docx');

function labeled(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: value || '—' }),
    ],
    spacing: { after: 60 },
  });
}

// The fixed field block every entry prints, in this order, every time.
// A field the record didn't establish still appears (the model writes
// "Not reflected in the recording") so gaps are visible, not silent.
function entryFields(entry, session) {
  return [
    ['Date', session && session.date],
    ['Judge', session && session.judge],
    ['Proceeding', entry.proceeding_type],
    ['Charges', entry.charges],
    ['For the State', entry.state_counsel],
    ['For the Defendant', entry.defense_counsel],
    ['Defendant', entry.defendant_presence],
    ['Bond', entry.bond],
  ];
}

function entryParagraphs(entry, session) {
  const paras = [];

  paras.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 120 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: '999999' } },
    children: [new TextRun({ text: `${entry.docket_number}  —  ${entry.defendant}`, bold: true })],
  }));

  for (const [label, value] of entryFields(entry, session)) {
    paras.push(labeled(label, value));
  }

  for (const line of String(entry.minutes || '').split(/\n+/)) {
    if (line.trim()) paras.push(new Paragraph({ text: line.trim(), spacing: { after: 100 } }));
  }

  if (Array.isArray(entry.rulings) && entry.rulings.length) {
    paras.push(new Paragraph({ children: [new TextRun({ text: 'Orders / Rulings:', bold: true })], spacing: { after: 40 } }));
    for (const r of entry.rulings) {
      paras.push(new Paragraph({ text: r, bullet: { level: 0 }, spacing: { after: 40 } }));
    }
  }

  if (entry.next_setting) paras.push(labeled('Next setting', entry.next_setting));

  if (entry.needs_review) {
    paras.push(new Paragraph({
      children: [new TextRun({
        text: `** CLERK REVIEW NEEDED: ${entry.review_reason || 'match or audio uncertain'} ` +
          (entry.timestamps ? `(audio ${entry.timestamps})` : ''),
        bold: true, color: 'B00000',
      })],
      spacing: { before: 60, after: 60 },
    }));
  } else if (entry.timestamps) {
    paras.push(new Paragraph({
      children: [new TextRun({ text: `Audio: ${entry.timestamps}`, italics: true, size: 18, color: '666666' })],
      spacing: { after: 60 },
    }));
  }

  return paras;
}

async function buildDocx(minutes) {
  const s = minutes.session || {};
  const children = [];

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'MINUTES OF COURT — DRAFT', bold: true })],
    spacing: { after: 120 },
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    text: [s.court, s.judge && `Hon. ${s.judge}`.replace('Hon. Hon.', 'Hon.'), s.date].filter(Boolean).join('  •  '),
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({
      text: 'AI-assisted draft prepared from courtroom audio — verify against the record before entry.',
      italics: true, size: 18, color: '666666',
    })],
    spacing: { after: 240 },
  }));
  if (s.summary) children.push(new Paragraph({ text: s.summary, spacing: { after: 200 } }));

  for (const entry of minutes.entries || []) {
    children.push(...entryParagraphs(entry, s));
  }

  if (Array.isArray(minutes.not_heard) && minutes.not_heard.length) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 400, after: 120 },
      children: [new TextRun({ text: 'Docketed but not heard on the record', bold: true })],
    }));
    for (const item of minutes.not_heard) {
      children.push(new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 40 } }));
    }
  }

  if (Array.isArray(minutes.unmatched_audio) && minutes.unmatched_audio.length) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 400, after: 120 },
      children: [new TextRun({ text: 'Audio not matched to a docket entry', bold: true })],
    }));
    for (const item of minutes.unmatched_audio) {
      children.push(new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 40 } }));
    }
  }

  const doc = new Document({
    creator: 'court-minutes',
    title: 'Minutes of Court (Draft)',
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// Plain-text rendering of one entry, for the per-case "Copy" button.
// Includes the session's date and judge so each pasted minute stands alone.
function entryPlainText(entry, session) {
  const lines = [];
  lines.push(`${entry.docket_number}  —  ${entry.defendant}`);
  for (const [label, value] of entryFields(entry, session)) {
    lines.push(`${label}: ${value || '—'}`);
  }
  lines.push('');
  lines.push(entry.minutes || '');
  if (Array.isArray(entry.rulings) && entry.rulings.length) {
    lines.push('');
    lines.push('Orders / Rulings:');
    for (const r of entry.rulings) lines.push(`  - ${r}`);
  }
  if (entry.next_setting) {
    lines.push('');
    lines.push(`Next setting: ${entry.next_setting}`);
  }
  return lines.join('\n');
}

module.exports = { buildDocx, entryPlainText };
