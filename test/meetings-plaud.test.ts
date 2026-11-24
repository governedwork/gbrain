/**
 * Plaud meeting provider: Plaud's answers → MeetingStub / MeetingRecord, the window listing over whole-date filters,
 * an untranscribed recording deferred, and the rendered page's transcript in gbrain's own speaker format.
 */
import { describe, expect, test } from 'bun:test';
import {
  parsePlaudList, parsePlaudTranscriptPage, plaudInstant, plaudProvider, plaudSummaryNote, splitPlaudSummary, unwrapPlaudText,
} from '../src/core/meetings/providers/plaud.ts';
import { renderMeetingPage } from '../src/core/meetings/render.ts';
import { pickHeadPattern } from '../src/core/conversation-parser/parse.ts';
import { MeetingShapeDriftError } from '../src/core/meetings/types.ts';

const NOW = Date.parse('2026-11-24T15:00:00Z');

describe('Plaud answers', () => {
  test('the JSON inside an untrusted-data block, or the whole text', () => {
    expect(unwrapPlaudText('<untrusted-user-data-ab12 source="x">\n{"a":1}\n</untrusted-user-data-ab12>')).toEqual({ a: 1 });
    expect(unwrapPlaudText('{"b":2}')).toEqual({ b: 2 });
  });

  test('start_at is UTC with no zone designator', () => {
    expect(plaudInstant('2026-11-24T08:20:06')).toBe('2026-11-24T08:20:06.000Z');
    expect(plaudInstant('2026-11-24T08:20:06+01:00')).toBe('2026-11-24T07:20:06.000Z');
    expect(plaudInstant('yesterday')).toBeNull();
  });

  test('a listing row without an id or start is shape drift, never skipped', () => {
    expect(parsePlaudList({ data: [{ id: 'f_1', name: 'A', start_at: '2026-11-24T08:20:06', duration: 1 }] }))
      .toEqual([{ id: 'f_1', startedAt: '2026-11-24T08:20:06.000Z', title: 'A' }]);
    expect(() => parsePlaudList({ data: [{ name: 'A' }] })).toThrow(MeetingShapeDriftError);
    expect(() => parsePlaudList({})).toThrow(MeetingShapeDriftError);
  });

  test('the summary note: action items split out, app-only cards dropped', () => {
    const md = '## Overview\nWe met.[](plaud://image?type=card)\n\n## Action Items\n- [ ] Send the plan\n- Book Wednesday\n\n## Notes\nMore.';
    expect(splitPlaudSummary(md)).toEqual({ summary: '## Overview\nWe met.\n\n## Notes\nMore.', actionItems: ['Send the plan', 'Book Wednesday'] });
    expect(splitPlaudSummary(null)).toEqual({ summary: null, actionItems: [] });
    expect(plaudSummaryNote([{ data_type: 'other', data_content: 'x' }, { data_type: 'auto_sum_note', data_content: 'S' }])).toBe('S');
  });

  test('a first transcript page of [] is unfinished; segments carry speaker and seconds', () => {
    expect(parsePlaudTranscriptPage([], true)).toEqual({ unfinished: true });
    expect(parsePlaudTranscriptPage({ segments: [{ start_time: 1500, end_time: 2000, speaker: 'Speaker 1', content: 'Hej' }, { start_time: 2000, content: ' ' }], next_cursor: 'c2' }, true))
      .toEqual({ sentences: [{ speaker: 'Speaker 1', startSec: 1.5, text: 'Hej' }], next: 'c2' });
    expect(() => parsePlaudTranscriptPage({ segments: [{ content: 'x' }] }, false)).toThrow(MeetingShapeDriftError);
  });
});

/** A fake Plaud: tool name → answer. */
function fakePlaud(files: Array<{ id: string; name: string; start_at: string; duration: number }>, transcripts: Record<string, unknown[]>, notes: Record<string, string>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'get_current_user') return { id: 'u1', email: 'Owner@Example.com', nickname: 'Owner' };
    if (name === 'list_files') {
      const from = String(args.date_from), to = String(args.date_to);
      const rows = files.filter(f => f.start_at.slice(0, 10) >= from && f.start_at.slice(0, 10) <= to);
      const size = Number(args.page_size), page = Number(args.page);
      return { data: rows.slice((page - 1) * size, page * size) };
    }
    if (name === 'get_file') {
      const f = files.find(x => x.id === args.file_id)!;
      return { ...f, note_list: notes[f.id] ? [{ data_type: 'auto_sum_note', data_content: notes[f.id] }] : [] };
    }
    if (name === 'get_transcript') {
      const all = transcripts[String(args.file_id)] ?? [];
      if (all.length === 0) return [];
      const start = args.cursor ? Number(args.cursor) : 0;
      const limit = Number(args.limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return { segments: all.slice(start, start + limit), next_cursor: next };
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { calls, provider: plaudProvider({ callTool, userAgent: 't', now: () => NOW }) };
}

describe('plaudProvider', () => {
  test('lists exactly [from, to), newest first, served in offset pages from one listing', async () => {
    const files = [
      { id: 'a', name: 'Before', start_at: '2026-11-19T23:59:59', duration: 1000 },
      { id: 'b', name: 'In 1', start_at: '2026-11-20T00:00:00', duration: 1000 },
      { id: 'c', name: 'In 2', start_at: '2026-11-21T10:00:00', duration: 1000 },
      { id: 'd', name: 'After', start_at: '2026-11-22T00:00:00', duration: 1000 },
    ];
    const { provider, calls } = fakePlaud(files, {}, {});
    const window = { fromDate: '2026-11-20T00:00:00.000Z', toDate: '2026-11-22T00:00:00.000Z' };
    expect((await provider.listMeetings({ ...window, limit: 1, skip: 0 })).map(s => s.id)).toEqual(['c']);
    expect((await provider.listMeetings({ ...window, limit: 1, skip: 1 })).map(s => s.id)).toEqual(['b']);
    expect(await provider.listMeetings({ ...window, limit: 1, skip: 2 })).toEqual([]);
    expect(calls.filter(c => c.name === 'list_files')).toHaveLength(1);
  });

  test('a transcribed recording with a summary is final; the owner is its organizer and attendee', async () => {
    const files = [{ id: 'f1', name: 'Workshop', start_at: '2026-11-24T08:20:06', duration: 3135620 }];
    const segs = Array.from({ length: 700 }, (_, i) => ({ start_time: i * 1000, end_time: i * 1000 + 900, speaker: `Speaker ${1 + (i % 2)}`, content: `line ${i}` }));
    const { provider } = fakePlaud(files, { f1: segs }, { f1: '## Overview\nOK\n## Action Items\n- Send it' });
    const account = await provider.probe();
    expect(account).toEqual({ userId: 'u1', email: 'owner@example.com', name: 'Owner' });
    const rec = (await provider.fetchMeeting('f1', { transcript: true }))!;
    expect(rec.isFinal).toBe(true);
    expect(rec.durationSec).toBe(3136);
    expect(rec.organizerEmail).toBe('owner@example.com');
    expect(rec.attendees).toEqual([{ name: 'Owner', email: 'owner@example.com' }]);
    expect(rec.actionItems).toEqual(['Send it']);
    expect(rec.transcript).toHaveLength(700);

    const page = renderMeetingPage(rec, { cfg: { provider: 'plaud', privateOnly: false }, account });
    expect(page).toContain('**Speaker 1** (00:00:00): line 0');
    expect(page).not.toContain('visibility: private');
    // gbrain's own transcript reader recognizes the page's turns (Plaud's own `[00:00] Speaker 1:` lines it does not).
    expect(pickHeadPattern(page.split('## Transcript')[1]!.trim())).toBe('bold-paren-time');
  });

  test('a recording Plaud has not transcribed yet is deferred, then published as it is after 48 h', async () => {
    const files = [{ id: 'f2', name: 'Fresh', start_at: '2026-11-24T14:00:00', duration: 60000 }];
    const { provider } = fakePlaud(files, {}, {});
    await provider.probe();
    expect((await provider.fetchMeeting('f2', { transcript: true }))!.isFinal).toBe(false);
    const late = plaudProvider({ callTool: async (name) => (name === 'get_file' ? { ...files[0], note_list: [] } : []), userAgent: 't', now: () => NOW + 49 * 3600_000 });
    expect((await late.fetchMeeting('f2', { transcript: true }))!.isFinal).toBe(true);
  });
});
