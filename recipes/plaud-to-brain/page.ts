/**
 * The plaud-to-brain recipe's meeting page (recipes/plaud-to-brain.md, Step 5): one recording's transcript record →
 * one `meeting` page and its slug, deterministically. The brain owns this shape; a runner in another repo vendors this
 * file byte-for-byte rather than writing its own template, so it is pure and imports nothing.
 *
 * Everything Plaud gives is the person's data, copied, never interpreted: each frontmatter value is a JSON string
 * (valid YAML, so no title can close the frontmatter or add a key), the summary is marked as the recorder's claim,
 * and the transcript is every segment, verbatim, with its time and speaker.
 */

/** One utterance of Plaud's `get_transcript`, in meeting-ingestion's transcript-record names. */
export interface PlaudTranscriptSegment {
  /** Milliseconds from the recording's start (`get_transcript`'s `start_time`). */
  start_time: number;
  /** Milliseconds from the recording's start (`get_transcript`'s `end_time`). */
  end_time: number;
  /** Plaud's speaker as `get_transcript` answers it: a name the person assigned, or a label such as `Speaker 2`. */
  speaker_raw: string;
  /** The utterance, verbatim (`get_transcript`'s `content`, from the raw `transaction` block). */
  text: string;
}

/** The recipe's Step 5 transcript record: one Plaud recording, normalised for meeting-ingestion. */
export interface PlaudMeetingRecord {
  source: 'plaud';
  /** The recording's id (`of_…`). */
  source_id: string;
  /** The recording's name. */
  title: string;
  /** `YYYY-MM-DD`: the local day of Plaud's UTC `start_at` in the person's timezone (`localWhen`). */
  date: string;
  /** `HH:MM ±HH:MM` in the person's timezone (`localWhen`). */
  time: string;
  /** `33m`, `1h05m` (`durationText` of Plaud's milliseconds). */
  duration: string;
  /**
   * The people known to have been there, by person slug only, never an email: what the runner has evidence for (Step 4:
   * the recorder, whose own Plaud made the recording), and what meeting-ingestion Phase 4 confirms from the transcript.
   * GBrain records each as `person --attended--> meeting`; an entry no live person page answers for holds back every
   * link of the page (docs/guides/attendance-evidence.md), so an unresolved person is never listed here.
   */
  attendees: readonly string[];
  /**
   * Step 4's roster: the calendar event's invitees, people slugs where an exact email resolves and emails otherwise.
   * The source's claim (invited ≠ present), kept apart from `attendees`; `[]` when no event overlapped the recording.
   */
  invitees: readonly string[];
  /** The page's tags (GBrain's frontmatter `tags`). `[]` for none. */
  tags: readonly string[];
  /** Step 4's calendar page slug, or `""` when no event overlapped the recording. */
  calendar_event: string;
  /** Every page of `get_transcript`, in order. */
  transcript_segments: readonly PlaudTranscriptSegment[];
  /** The whole transcript, never truncated. The page renders `transcript_segments`; this is the record's evidence. */
  raw_transcript_text: string;
  /** `get_note`'s `auto_sum_note` Markdown: a claim, never a fact. `""` when Plaud has none. */
  source_summary: string;
}

/** The recording's start as a Date (Plaud writes UTC without a `Z`). */
const startOf = (startAt: string): Date => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(startAt) ? startAt : `${startAt}Z`);

/** The record's `date` and `time`: the local day and `HH:MM ±HH:MM` of Plaud's UTC `start_at` in `timeZone`. */
export function localWhen(startAt: string, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
      .formatToParts(startOf(startAt))
      .map((p) => [p.type, p.value]),
  );
  // `longOffset` is "GMT+01:00", or "GMT" at UTC itself.
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : String(parts.timeZoneName).replace('GMT', '');
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute} ${offset}` };
}

/** The record's `duration` from Plaud's milliseconds: `33m`, `1h05m`. */
export function durationText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : `${h}h${String(m).padStart(2, '0')}m`;
}

/** A title as a slug segment: ascii-folded, lowercase, runs of anything else one `-`, at most 80 characters. */
export function titleSlug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return s === '' ? 'recording' : s;
}

/** A slug another recording holds, made this recording's: its id's first eight characters after the `of_`/`f_` prefix. */
export const slugWithId = (slug: string, id: string): string => `${slug}-${id.replace(/^[a-z]+_/, '').slice(0, 8)}`;

const q = (s: string): string => JSON.stringify(s);

/** `[MM:SS]`, or `[H:MM:SS]` from the first hour on. */
function stamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h === 0 ? `${mm}:${ss}` : `${h}:${mm}:${ss}`;
}

/**
 * The meeting page for a record, and its base slug `meetings/<date>-<titleSlug>`. When another recording already
 * holds that slug, the runner files this one at `slugWithId(slug, record.source_id)`.
 */
export function renderMeetingPage(record: PlaudMeetingRecord): { slug: string; content: string } {
  const { date, time, duration, attendees, invitees, tags, calendar_event: calendarEvent, source_summary: summary } = record;
  // A person slug is a path with no `@`: an email (or a bare name) here would be an attendance claim GBrain cannot resolve.
  const notSlug = attendees.find((a) => a.includes('@') || !a.includes('/'));
  if (notSlug !== undefined) throw new Error(`attendees holds people slugs only, not ${q(notSlug)}: an unresolved person is an invitee`);
  const linked = (people: readonly string[]): string => people.map((p) => (p.includes('@') ? p : `[[${p}]]`)).join(', ');
  const fm = [
    '---',
    `type: ${q('meeting')}`,
    `title: ${q(record.title)}`,
    `date: ${q(date)}`,
    `time: ${q(time)}`,
    `duration: ${q(duration)}`,
    `source: ${q(record.source)}`,
    `source_id: ${q(record.source_id)}`,
    `attendees: [${attendees.map(q).join(', ')}]`,
    // A runner may keep the roster but not name its event (one filed where that calendar page does not live).
    ...(calendarEvent === '' && invitees.length === 0 ? [] : [`invitees: [${invitees.map(q).join(', ')}]`]),
    ...(calendarEvent === '' ? [] : [`calendar_event: ${q(calendarEvent)}`]),
    ...(tags.length === 0 ? [] : [`tags: [${tags.map(q).join(', ')}]`]),
    'facts_backstop: false',
    '---',
  ];
  // The Attendees line is GBrain's bare link list (attendance evidence), so it carries exactly the frontmatter's people.
  const present = attendees.length === 0 ? 'Attendees: none confirmed yet.' : `Attendees: ${linked(attendees)}`;
  const invited =
    calendarEvent !== ''
      ? `Invited (from [[${calendarEvent}]], not confirmed present): ${linked(invitees) || 'none listed'}.`
      : invitees.length > 0
        ? `Invited (from the calendar, not confirmed present): ${linked(invitees)}.`
        : 'Invited: unknown (no calendar event overlapped the recording).';
  const body = [
    `# ${record.title}`,
    '',
    `${date} ${time} · ${duration} · recorded with Plaud (\`${record.source_id}\`).`,
    '',
    present,
    '',
    invited,
    '',
    ...(summary === ''
      ? []
      : ["## Plaud's summary", '', "> The recorder's own AI summary: a claim, not checked against the transcript. Quote the transcript, not this.", '', summary, '']),
    '## Transcript',
    '',
    ...record.transcript_segments.map((s) => `[${stamp(s.start_time)}] ${s.speaker_raw}: ${s.text}`),
    '',
  ];
  return { slug: `meetings/${date}-${titleSlug(record.title)}`, content: `${fm.join('\n')}\n${body.join('\n')}` };
}
