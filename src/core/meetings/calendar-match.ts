/**
 * The calendar event a meeting happened in, from the brain's own calendar pages (the google source's `type: meeting`
 * pages that carry `event_id`, `start`, `end`, `account` and `attendees`): the event in any other source of this brain
 * that overlaps the meeting's span the most, a tie going to the shorter event; all-day and deleted events never match.
 *
 * What the meeting page gets from it (render.ts): `calendar_event` (the event's slug, which the fork's frontmatter link
 * makes an edge across sources), `invitees` (the event's attendee addresses less rooms and the recorder) and, for a
 * provider that records on the owner's own device (Plaud), the recorder: the account that owns that calendar, since
 * such a provider knows its user by its own account, not by the address their meetings use.
 */
import type { BrainEngine } from '../engine.ts';
import type { MeetingRecord } from './types.ts';

/** Rooms and resources are never invitees. */
const ROOM = /@resource\.calendar\.google\.com$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 86_400_000;

export interface CalendarEvidence {
  /** The event page's slug. */
  slug: string;
  /** The address of the calendar the event is in (the google source's account). */
  account: string | null;
  /** The event's attendee addresses, lowercased, rooms left out. */
  attendees: string[];
}

interface EventRow { slug: string; start: string | null; end: string | null; all_day: string | null; account: string | null; attendees: unknown }

/** The overlapping event with the most overlap (tie: the shorter), or null. Exported for tests. */
export function bestEvent(span: { start: number; end: number }, rows: readonly EventRow[]): EventRow | null {
  let best: { row: EventRow; overlap: number; length: number } | null = null;
  for (const row of rows) {
    if (row.all_day === 'true') continue;
    const start = Date.parse(row.start ?? '');
    const end = Date.parse(row.end ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const overlap = Math.min(end, span.end) - Math.max(start, span.start);
    if (overlap <= 0) continue;
    const length = end - start;
    if (!best || overlap > best.overlap || (overlap === best.overlap && (length < best.length || (length === best.length && row.slug < best.row.slug)))) {
      best = { row, overlap, length };
    }
  }
  return best?.row ?? null;
}

function addresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(v => EMAIL.test(v) && !ROOM.test(v)))];
}

/** The calendar evidence for one meeting, read from every source of the brain but the meeting's own. */
export async function calendarEvidence(engine: BrainEngine, meetingSourceId: string, record: Pick<MeetingRecord, 'startedAt' | 'durationSec'>): Promise<CalendarEvidence | null> {
  const start = Date.parse(record.startedAt);
  if (!Number.isFinite(start)) return null;
  // A meeting with no length is taken as a point in time: the event it falls in.
  const end = start + Math.max(1, record.durationSec ?? 0) * 1000;
  // Prefilter by day (an event's `start` is ISO with any offset): a day either side, then exact overlap in code.
  const from = new Date(start - DAY_MS).toISOString().slice(0, 10);
  const to = new Date(end + DAY_MS).toISOString().slice(0, 10);
  const rows = await engine.executeRaw<EventRow>(
    `SELECT slug, frontmatter->>'start' AS start, frontmatter->>'end' AS "end", frontmatter->>'all_day' AS all_day,
            frontmatter->>'account' AS account, frontmatter->'attendees' AS attendees
       FROM pages
      WHERE type = 'meeting' AND deleted_at IS NULL AND source_id <> $1
        AND frontmatter ? 'event_id'
        AND substr(frontmatter->>'start', 1, 10) BETWEEN $2 AND $3`,
    [meetingSourceId, from, to]);
  const event = bestEvent({ start, end }, rows);
  if (!event) return null;
  const account = typeof event.account === 'string' && EMAIL.test(event.account.trim()) ? event.account.trim().toLowerCase() : null;
  return { slug: event.slug, account, attendees: addresses(event.attendees) };
}
