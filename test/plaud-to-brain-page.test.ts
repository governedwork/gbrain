/**
 * The plaud-to-brain recipe's meeting page (recipes/plaud-to-brain/page.ts): the record's date is the local day of
 * Plaud's UTC `start_at`; the frontmatter is the recipe's, every value quoted so a recording's text never becomes YAML;
 * the summary is marked as the recorder's claim; every transcript segment is on the page; a slug another recording
 * holds takes `-<id8>`.
 *
 * The test lives in test/ rather than beside page.ts because test/ is what the unit lanes collect and what
 * `bun run typecheck` reaches (tsconfig includes src, test and scripts; page.ts is checked through this import).
 */
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
import { extractPageLinks } from '../src/core/link-extraction.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

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
    attendees: ['people/me'],
    invitees: ['people/anna-a', 'bob@example.com'],
    tags: ['plaud'],
    calendar_event: 'calendar/2026/11/2026-11-03-mote-abcd1234',
    transcript_segments: SEGMENTS,
    raw_transcript_text: SEGMENTS.map((s) => `${s.speaker_raw}: ${s.text}`).join('\n'),
    source_summary: '## Sammanfattning\nVi bestämde X.',
    ...over,
  };
}

const frontmatterOf = (content: string): string => content.split('\n---\n')[0] ?? '';

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
    expect(fm).toContain('time: "13:42 +01:00"');
    expect(fm).toContain('duration: "34m"'); // 2 012 000 ms is 33.5 minutes, rounded
    expect(fm).toContain('source: "plaud"');
    expect(fm).toContain(`source_id: "${PLAUD.id}"`);
    expect(fm).toContain('attendees: ["people/me"]');
    expect(fm).toContain('invitees: ["people/anna-a", "bob@example.com"]');
    expect(fm).toContain('tags: ["plaud"]');
    expect(fm).toContain('calendar_event: "calendar/2026/11/2026-11-03-mote-abcd1234"');
    expect(fm).toContain('facts_backstop: false');
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
    const evil = renderMeetingPage(recordOf({ title: 'x"\n---\ntype: person', attendees: [], invitees: [], calendar_event: '', source_summary: '' }));
    const fm = frontmatterOf(evil.content);
    expect(fm).toContain('title: "x\\"\\n---\\ntype: person"');
    expect(fm.match(/^type:/gm)?.length).toBe(1);
  });

  test('no calendar event: no calendar_event key, an empty roster and a line that says so', () => {
    const none = renderMeetingPage(recordOf({ attendees: [], invitees: [], calendar_event: '', source_summary: '' }));
    expect(none.content).not.toContain('calendar_event:');
    expect(none.content).not.toContain('invitees:');
    expect(none.content).toContain('attendees: []');
    expect(none.content).toContain('no calendar event');
    expect(none.content).not.toContain('Plaud\'s summary');
  });
});

// Attendance is GBrain's, by its evidence rules (docs/guides/attendance-evidence.md): frontmatter `attendees` and a
// bare `Attendees:` link list assert that each person attended, and one entry no person page answers for holds back
// every link of the page. So the calendar's invitees are kept apart, and an email is never an attendee.
describe('attendees and invitees', () => {
  test('a calendar invitee is never an attendee: the roster is `invitees`, the confirmed people `attendees`', () => {
    const page = renderMeetingPage(recordOf({ attendees: [], invitees: ['people/anna-a', 'bob@example.com'] }));
    const fm = frontmatterOf(page.content);
    expect(fm).toContain('attendees: []');
    expect(fm).toContain('invitees: ["people/anna-a", "bob@example.com"]');
    expect(page.content).not.toMatch(/^Attendees:.*\[\[/m);
  });

  test('an email or a bare name in attendees is refused, never filed as an attendance claim', () => {
    expect(() => renderMeetingPage(recordOf({ attendees: ['bob@example.com'] }))).toThrow(/people slugs only/);
    expect(() => renderMeetingPage(recordOf({ attendees: ['Anna'] }))).toThrow(/people slugs only/);
  });

  test('the Attendees line is a bare link list of exactly the frontmatter attendees', () => {
    const page = renderMeetingPage(recordOf({ attendees: ['people/me', 'people/anna-a'] }));
    expect(page.content).toContain('\nAttendees: [[people/me]], [[people/anna-a]]\n');
  });

  // GBrain's own link extraction over the rendered page: the page it files is the page its attendance rules read.
  test('GBrain reads the page: the confirmed person attended, an invitee is a mention, an unresolved one blocks nothing', async () => {
    const people = new Set(['people/me', 'people/anna-a']);
    const resolver = {
      async resolve(value: string) { return people.has(value) ? value : null; },
      async resolveAttendance(value: string) { return people.has(value) ? value : null; },
    };
    const linksOf = async (record: PlaudMeetingRecord) => {
      const page = parseMarkdown(renderMeetingPage(record).content, 'meetings/x.md');
      return extractPageLinks('meetings/x', page.compiled_truth, page.frontmatter, 'meeting', resolver,
        { targetType: (slug) => (people.has(slug) ? 'person' : undefined) });
    };
    const filed = await linksOf(recordOf({ attendees: ['people/me'], invitees: ['people/anna-a', 'bob@example.com'], calendar_event: '' }));
    expect(filed.attendanceComplete).toBe(true);
    // A frontmatter row names the person as `fromSlug`, a body row as `targetSlug` (direction set at write).
    const attendedBy = (r: typeof filed) => [...new Set(r.candidates.filter((c) => c.linkType === 'attended')
      .flatMap((c) => [c.fromSlug, c.targetSlug]).filter((x): x is string => typeof x === 'string' && x.startsWith('people/')))];
    expect(attendedBy(filed)).toEqual(['people/me']);
    const invited = await linksOf(recordOf({ attendees: [], invitees: ['people/anna-a', 'bob@example.com'] }));
    expect(invited.attendanceComplete).toBe(true);
    expect(attendedBy(invited)).toEqual([]);
    expect(invited.candidates.some((c) => c.targetSlug === 'people/anna-a' && c.linkType === 'mentions')).toBe(true);
    // The control: an email among the attendance claims is what holds a page's links back.
    const page = parseMarkdown(renderMeetingPage(recordOf({ attendees: [] })).content, 'meetings/x.md');
    const blocked = await extractPageLinks('meetings/x', page.compiled_truth, { ...page.frontmatter, attendees: ['bob@example.com'] }, 'meeting', resolver,
      { targetType: (slug) => (people.has(slug) ? 'person' : undefined) });
    expect(blocked.attendanceComplete).toBe(false);
  });

  test('invitees without a named event are still kept, and said to be the calendar\'s', () => {
    const page = renderMeetingPage(recordOf({ invitees: ['people/anna-a'], calendar_event: '' }));
    expect(frontmatterOf(page.content)).toContain('invitees: ["people/anna-a"]');
    expect(page.content).not.toContain('calendar_event:');
    expect(page.content).toContain('\nInvited (from the calendar, not confirmed present): [[people/anna-a]].\n');
  });

  test('no tags: no tags key', () => {
    expect(frontmatterOf(renderMeetingPage(recordOf({ tags: [] })).content)).not.toContain('tags:');
  });
});

// The whole page, byte for byte (first as Captain's amplifier/ops/connectors/plaud-page.ts rendered these inputs,
// feat/plaud-connector 4f742892; invitees kept apart from attendees since): a change to the page's shape is a
// deliberate edit of these lines.
describe('the whole page, byte for byte', () => {
  const HEAD = [
    '---',
    'type: "meeting"',
    'title: "11-03 Möte: Konfiguration av Google Ads"',
    'date: "2026-11-03"',
    'time: "13:42 +01:00"',
    'duration: "34m"',
    'source: "plaud"',
    'source_id: "of_4f6d3ff675f1a9bac96913943aa125c4"',
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

  test('with a calendar event and a summary', () => {
    expect(renderMeetingPage(recordOf()).content).toBe(
      [
        ...HEAD,
        'attendees: ["people/me"]',
        'invitees: ["people/anna-a", "bob@example.com"]',
        'calendar_event: "calendar/2026/11/2026-11-03-mote-abcd1234"',
        'tags: ["plaud"]',
        'facts_backstop: false',
        '---',
        ...TITLE_LINES,
        'Attendees: [[people/me]]',
        '',
        'Invited (from [[calendar/2026/11/2026-11-03-mote-abcd1234]], not confirmed present): [[people/anna-a]], bob@example.com.',
        '',
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

  test('with no calendar event and no summary', () => {
    expect(renderMeetingPage(recordOf({ attendees: [], invitees: [], tags: [], calendar_event: '', source_summary: '' })).content).toBe(
      [
        ...HEAD,
        'attendees: []',
        'facts_backstop: false',
        '---',
        ...TITLE_LINES,
        'Attendees: none confirmed yet.',
        '',
        'Invited: unknown (no calendar event overlapped the recording).',
        '',
        ...TRANSCRIPT,
      ].join('\n'),
    );
  });
});
