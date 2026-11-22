/**
 * The plaud-to-brain recipe's meeting page (recipes/plaud-to-brain/page.ts): the record's date is the local day of
 * Plaud's UTC `start_at`; the frontmatter is the collector contract's and nothing more (captain
 * docs/amplifier/meeting-enrichment.spec.md §4.1: no attendees, invitees, calendar_event or tags, which the brain's own
 * enrichment writes), every value quoted so a recording's text never becomes YAML; the summary is marked as the
 * recorder's claim; every transcript segment is on the page; a slug another recording holds takes `-<id8>`.
 *
 * The test lives in test/ rather than beside page.ts because test/ is what the unit lanes collect and what
 * `bun run typecheck` reaches (tsconfig includes src, test and scripts; page.ts is checked through this import).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  durationText,
  localWhen,
  type PlaudMeetingRecord,
  type PlaudTranscriptSegment,
  renderMeetingPage,
  slugWithId,
  titleSlug,
} from '../recipes/plaud-to-brain/page.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseRecipe } from '../src/commands/integrations.ts';

const TZ = 'Europe/Stockholm';
// Plaud's list_files answer for one recording: `start_at` is UTC with no offset written, `duration` milliseconds.
const PLAUD = { id: 'of_4f6d3ff675f1a9bac96913943aa125c4', name: '11-03 Möte: Konfiguration av Google Ads', start_at: '2026-11-03T12:42:05', duration: 2_012_000 };
const SEGMENTS: readonly PlaudTranscriptSegment[] = [
  { start_time: 0, end_time: 4_000, speaker_raw: 'Speaker 1', text: 'Hej, ska vi börja?' },
  { start_time: 65_000, end_time: 70_000, speaker_raw: 'Anna', text: 'Ja: vi tar annonserna först.' },
  { start_time: 3_725_000, end_time: 3_730_000, speaker_raw: 'Anna', text: 'Klart.' },
];

/** The recipe's Step 5 record for PLAUD, as a runner normalises it. */
function recordOf(over: Partial<PlaudMeetingRecord> = {}): PlaudMeetingRecord {
  const { date, time } = localWhen(PLAUD.start_at, TZ);
  return {
    source: 'plaud',
    source_id: PLAUD.id,
    title: PLAUD.name,
    date,
    time,
    duration: durationText(PLAUD.duration),
    transcript_segments: SEGMENTS,
    raw_transcript_text: SEGMENTS.map((s) => `${s.speaker_raw}: ${s.text}`).join('\n'),
    source_summary: '## Sammanfattning\nVi bestämde X.',
    recorded_by: 'me@example.com',
    ...over,
  };
}

const frontmatterOf = (content: string): string => content.split('\n---\n')[0] ?? '';

/** The collector contract's frontmatter keys (spec §4.1), in the page's order: every key a collector page carries. */
const CONTRACT_KEYS = ['type', 'title', 'date', 'effective_date', 'time', 'duration', 'source', 'source_id', 'recorded_by', 'facts_backstop'];

describe('the local day and time', () => {
  test('a UTC start in the afternoon is the same day, with the zone\'s offset', () => {
    expect(localWhen('2026-11-03T12:42:05', TZ)).toEqual({ date: '2026-11-03', time: '13:42 +01:00' });
  });
  test('a late-evening UTC start is the next local day', () => {
    expect(localWhen('2026-11-03T23:30:00', TZ)).toEqual({ date: '2026-11-04', time: '00:30 +01:00' });
  });
  test('summer time carries its own offset', () => {
    expect(localWhen('2026-07-01T08:00:00', TZ)).toEqual({ date: '2026-07-01', time: '10:00 +02:00' });
  });
});

describe('the slug', () => {
  test('is the local date and the title, folded to ascii', () => {
    expect(titleSlug('11-09 Planering: Klinikens rekryteringsannonser för sjuksköterskor')).toBe('11-09-planering-klinikens-rekryteringsannonser-for-sjukskoterskor');
  });
  test('a title of punctuation alone is `recording`', () => {
    expect(titleSlug('—!?')).toBe('recording');
  });
  test('a taken slug takes the recording id\'s first eight characters after its prefix', () => {
    expect(slugWithId('meetings/2026-11-03-mote', PLAUD.id)).toBe('meetings/2026-11-03-mote-4f6d3ff6');
  });
});

describe('the page', () => {
  const page = renderMeetingPage(recordOf());

  test('slug and recipe frontmatter, each value quoted', () => {
    expect(page.slug).toBe('meetings/2026-11-03-11-03-mote-konfiguration-av-google-ads');
    const fm = frontmatterOf(page.content);
    expect(fm).toContain('type: "meeting"');
    expect(fm).toContain('title: "11-03 Möte: Konfiguration av Google Ads"');
    expect(fm).toContain('date: "2026-11-03"');
    expect(fm).toContain('effective_date: "2026-11-03"');
    expect(fm).toContain('recorded_by: "me@example.com"');
    expect(fm).toContain('time: "13:42 +01:00"');
    expect(fm).toContain('duration: "34m"'); // 2 012 000 ms is 33.5 minutes, rounded
    expect(fm).toContain('source: "plaud"');
    expect(fm).toContain(`source_id: "${PLAUD.id}"`);
    expect(fm).toContain('facts_backstop: false');
  });

  test('effective_date is the local date, recorded_by the connection owner\'s email, on every page', () => {
    const bare = renderMeetingPage(recordOf({ source_summary: '', recorded_by: 'owner@example.org' }));
    const fm = frontmatterOf(bare.content);
    expect(fm).toContain('effective_date: "2026-11-03"');
    expect(fm).toContain('recorded_by: "owner@example.org"');
    expect(parseMarkdown(bare.content, `${bare.slug}.md`).frontmatter).toMatchObject({ effective_date: '2026-11-03', recorded_by: 'owner@example.org' });
  });

  test('a recorded_by that is not an email is refused, never written', () => {
    expect(() => renderMeetingPage(recordOf({ recorded_by: '' }))).toThrow('recorded_by');
    expect(() => renderMeetingPage(recordOf({ recorded_by: 'people/me' }))).toThrow('recorded_by');
  });

  test('the summary is marked as the recorder\'s claim and kept verbatim', () => {
    expect(page.content).toContain('a claim');
    expect(page.content).toContain('## Sammanfattning\nVi bestämde X.');
  });

  test('every segment is on the page, with its time and speaker', () => {
    expect(page.content).toContain('[00:00] Speaker 1: Hej, ska vi börja?');
    expect(page.content).toContain('[01:05] Anna: Ja: vi tar annonserna först.');
    expect(page.content).toContain('[1:02:05] Anna: Klart.');
  });

  test('a title that tries to close the frontmatter stays a quoted value', () => {
    const evil = renderMeetingPage(recordOf({ title: 'x"\n---\ntype: person', source_summary: '' }));
    const fm = frontmatterOf(evil.content);
    expect(fm).toContain('title: "x\\"\\n---\\ntype: person"');
    expect(fm.match(/^type:/gm)?.length).toBe(1);
  });

  test('no summary: no summary section', () => {
    expect(renderMeetingPage(recordOf({ source_summary: '' })).content).not.toContain('Plaud\'s summary');
  });
});

// The collector writes only what its source knows (spec §4.1). Who attended, who was invited, the calendar event and
// the meeting's tags are the brain's own enrichment (Amplifier's `meeting.enrich`, their single writer): a collector
// page that carried them would be a second writer, and one that named an attendee would be an attendance claim the
// collector has no evidence for.
describe('the collector contract: the page carries spec §4.1 and nothing more', () => {
  const page = renderMeetingPage(recordOf());
  const { frontmatter } = parseMarkdown(page.content, `${page.slug}.md`);

  test('the frontmatter keys are exactly the contract\'s', () => {
    // Read off the written lines: GBrain's parser lifts `type` and `title` out of its frontmatter object.
    const keys = frontmatterOf(page.content).split('\n').slice(1).map((line) => line.slice(0, line.indexOf(':')));
    expect(keys).toEqual(CONTRACT_KEYS);
  });

  test('no attendees, invitees, calendar_event or tags, in the frontmatter or the body', () => {
    for (const key of ['attendees', 'invitees', 'calendar_event', 'tags']) expect(frontmatter).not.toHaveProperty(key);
    expect(page.content).not.toMatch(/^(attendees|invitees|calendar_event|tags):/m);
    expect(page.content).not.toMatch(/^(Attendees|Invited|Calendar)\b/m);
  });

  test('a record that still carries enrichment fields writes none of them', () => {
    const stale = { ...recordOf(), attendees: ['people/me'], invitees: ['people/anna-a', 'bob@example.com'], tags: ['plaud'], calendar_event: 'calendar/2026/11/2026-11-03-mote-abcd1234' };
    const filed = renderMeetingPage(stale as PlaudMeetingRecord);
    expect(filed.content).toBe(page.content);
  });
});

// The recipe's runner files a collector page as rendered (meeting-enrichment M9: Amplifier's `meeting.enrich` is the one
// writer of attendees). meeting-ingestion's phases rewrite a meeting page's attendees and body, so a recipe that sends
// the page through them makes a second writer; these hold the recipe to filing the rendered page and nothing more.
describe('the recipe files the rendered page, never through meeting-ingestion', () => {
  const text = readFileSync(new URL('../recipes/plaud-to-brain.md', import.meta.url), 'utf8');
  const recipe = parseRecipe(text, 'plaud-to-brain.md');

  test('the recipe sends no page through meeting-ingestion, nor any of its phases', () => {
    expect(recipe).not.toBeNull();
    expect(text).not.toMatch(/meeting-ingestion/);
    expect(text).not.toMatch(/\bPhase \d/);
  });

  test('what capture files is renderMeetingPage(record).content, with nothing added', () => {
    expect(text).toMatch(/^ {2}content: renderMeetingPage\(record\)\.content,$/m);
  });

  test('it writes meeting pages only: no transcript sidecar under sources/', () => {
    expect(recipe?.frontmatter.output_paths).toEqual(['meetings/']);
  });
});

// The whole page, byte for byte (first as Captain's amplifier/ops/connectors/plaud-page.ts rendered these inputs,
// feat/plaud-connector 4f742892; cut to the collector contract since): a change to the page's shape is a deliberate
// edit of these lines.
describe('the whole page, byte for byte', () => {
  const HEAD = [
    '---',
    'type: "meeting"',
    'title: "11-03 Möte: Konfiguration av Google Ads"',
    'date: "2026-11-03"',
    'effective_date: "2026-11-03"',
    'time: "13:42 +01:00"',
    'duration: "34m"',
    'source: "plaud"',
    'source_id: "of_4f6d3ff675f1a9bac96913943aa125c4"',
    'recorded_by: "me@example.com"',
  ];
  const TITLE_LINES = [
    '# 11-03 Möte: Konfiguration av Google Ads',
    '',
    '2026-11-03 13:42 +01:00 · 34m · recorded with Plaud (`of_4f6d3ff675f1a9bac96913943aa125c4`).',
    '',
  ];
  const TRANSCRIPT = [
    '## Transcript',
    '',
    '[00:00] Speaker 1: Hej, ska vi börja?',
    '[01:05] Anna: Ja: vi tar annonserna först.',
    '[1:02:05] Anna: Klart.',
    '',
  ];

  test('with a summary', () => {
    expect(renderMeetingPage(recordOf()).content).toBe(
      [
        ...HEAD,
        'facts_backstop: false',
        '---',
        ...TITLE_LINES,
        '## Plaud\'s summary',
        '',
        '> The recorder\'s own AI summary: a claim, not checked against the transcript. Quote the transcript, not this.',
        '',
        '## Sammanfattning',
        'Vi bestämde X.',
        '',
        ...TRANSCRIPT,
      ].join('\n'),
    );
  });

  test('with no summary', () => {
    expect(renderMeetingPage(recordOf({ source_summary: '' })).content).toBe(
      [
        ...HEAD,
        'facts_backstop: false',
        '---',
        ...TITLE_LINES,
        ...TRANSCRIPT,
      ].join('\n'),
    );
  });
});
