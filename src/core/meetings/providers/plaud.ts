/**
 * Plaud meeting provider: Plaud's hosted MCP server (`https://mcp.plaud.ai/mcp`), reached with the MCP SDK's own
 * client under the login `gbrain connectors auth plaud` saved (connectors/mcp-oauth.ts; the SDK refreshes it).
 *
 * Tools: `get_current_user` (the account pin), `list_files` (recordings by display date, paged), `get_file` (one
 * recording and its notes, among them the recorder's AI summary `auto_sum_note` with its action items) and
 * `get_transcript` (the `transaction` block: speaker + timestamps, paged by cursor). Answers are JSON text, sometimes
 * inside an untrusted-data block. The audio links `get_file` also answers are never read.
 *
 * Plaud records; it has no invitees. A recording is the account owner's own, so the owner is its organizer, and the
 * people present are the transcript's speakers once someone names them (enrichment's job, not this leaf's).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ConnectorAuthError } from '../../connectors/client.ts';
import { ConnectorMcpOAuthProvider, McpLoginRequiredError } from '../../connectors/mcp-oauth.ts';
import { MeetingProviderError, MeetingShapeDriftError, type MeetingAccount, type MeetingProvider, type MeetingRecord, type MeetingSentence, type MeetingStub } from '../types.ts';

export const PLAUD_MCP_URL = 'https://mcp.plaud.ai/mcp';
/** Recordings asked for per `list_files` page. */
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 200;
/** Utterances asked for per `get_transcript` page (the tool's maximum). */
const TRANSCRIPT_PAGE = 500;
const MAX_TRANSCRIPT_PAGES = 200;
/** A recording with no transcript or summary this long after it started is published as it is. */
export const PLAUD_PROCESSING_WAIT_MS = 48 * 3600_000;
const DAY_MS = 86_400_000;

/** The JSON a Plaud tool answered: inside its untrusted-data block, or the whole text. Exported for tests. */
export function unwrapPlaudText(text: string): unknown {
  const m = /<(untrusted-user-data-[0-9a-f]+)[^>]*>\n([\s\S]*)\n<\/\1>/.exec(text);
  return JSON.parse(m === null ? text : (m[2] as string));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Plaud's `start_at` is UTC with no zone designator (`2026-11-24T08:20:06`). */
export function plaudInstant(value: unknown): string | null {
  const s = str(value);
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return null;
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A `list_files` page's recordings. Exported for tests. */
export function parsePlaudList(data: unknown): MeetingStub[] {
  const list = isRecord(data) ? data.data : undefined;
  if (!Array.isArray(list)) throw new MeetingShapeDriftError('plaud', 'list_files.data');
  return list.map(row => {
    const r = isRecord(row) ? row : {};
    const id = str(r.id);
    const startedAt = plaudInstant(r.start_at);
    if (!id || !startedAt) throw new MeetingShapeDriftError('plaud', 'list_files.data[].id or start_at');
    return { id, startedAt, title: str(r.name) ?? 'Untitled recording' };
  });
}

/** The recorder's AI summary split into its prose and its action items. Exported for tests. */
export function splitPlaudSummary(markdown: string | null): { summary: string | null; actionItems: string[] } {
  if (!markdown) return { summary: null, actionItems: [] };
  // Plaud's app-only cards (`[](plaud://…)`) carry nothing outside the app.
  const lines = markdown.replace(/\[\]\(plaud:\/\/[^)]*\)/g, '').split('\n');
  const actionItems: string[] = [];
  const kept: string[] = [];
  let inActions = false;
  let actionLevel = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = heading[1]!.length;
      if (/action items?|next steps|åtgärd|att göra/i.test(heading[2]!)) { inActions = true; actionLevel = level; continue; }
      if (inActions && level <= actionLevel) inActions = false;
    }
    if (inActions) {
      const item = /^\s*(?:[-*•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line);
      if (item && item[1]!.trim()) actionItems.push(item[1]!.trim());
      continue;
    }
    kept.push(line);
  }
  const summary = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { summary: summary || null, actionItems };
}

/** The `auto_sum_note` among a recording's notes, or null. Exported for tests. */
export function plaudSummaryNote(data: unknown): string | null {
  const notes: readonly unknown[] = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : [];
  for (const n of notes) if (isRecord(n) && n.data_type === 'auto_sum_note') return str(n.data_content);
  return null;
}

/** One `get_transcript` page; `unfinished` is Plaud's `[]` on a first page (not transcribed yet). Exported for tests. */
export function parsePlaudTranscriptPage(data: unknown, first: boolean): { unfinished: true } | { sentences: MeetingSentence[]; next: string | null } {
  if (first && Array.isArray(data) && data.length === 0) return { unfinished: true };
  const page = isRecord(data) ? data : {};
  if (!Array.isArray(page.segments)) throw new MeetingShapeDriftError('plaud', 'get_transcript.segments');
  const sentences = page.segments.map(row => {
    const s = isRecord(row) ? row : {};
    const startMs = num(s.start_time);
    const text = typeof s.content === 'string' ? s.content : null;
    if (startMs === null || text === null) throw new MeetingShapeDriftError('plaud', 'get_transcript.segments[].start_time or content');
    return { speaker: str(s.speaker) ?? 'Unknown speaker', startSec: startMs / 1000, text };
  }).filter(s => s.text.trim());
  return { sentences, next: str(page.next_cursor) };
}

export interface PlaudOpts {
  serverUrl?: string;
  /** Test seam: the MCP client to call tools through. */
  callTool?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
  userAgent: string;
}

/** An MCP tool call through the SDK client, answering Plaud's JSON; auth failures become the connector's typed error. */
function mcpCaller(serverUrl: string, userAgent: string, now: () => number) {
  let client: Client | null = null;
  const connect = async () => {
    if (client) return client;
    const authProvider = new ConnectorMcpOAuthProvider({ provider: 'plaud', serverUrl, mode: 'headless', now });
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider, requestInit: { headers: { 'user-agent': userAgent } } });
    const c = new Client({ name: 'gbrain', version: '1' });
    await c.connect(transport);
    client = c;
    return c;
  };
  return async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    let result;
    try {
      result = await (await connect()).callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
    } catch (e) {
      if (e instanceof McpLoginRequiredError || e instanceof UnauthorizedError) throw new ConnectorAuthError(`plaud: ${e.message}`);
      throw e;
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.find((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string')?.text;
    if (result.isError) throw new MeetingProviderError('plaud', `${name}_error`, (text ?? 'tool error').slice(0, 200));
    if (text === undefined) throw new MeetingShapeDriftError('plaud', `${name} text content`);
    try { return unwrapPlaudText(text); } catch { throw new MeetingShapeDriftError('plaud', `${name} JSON answer`); }
  };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function plaudProvider(opts: PlaudOpts): MeetingProvider {
  const now = opts.now ?? Date.now;
  const call = opts.callTool ?? mcpCaller(opts.serverUrl ?? PLAUD_MCP_URL, opts.userAgent, now);
  let account: MeetingAccount | null = null;
  /** One listing per window: Plaud filters by whole display dates, the source pages by offset over [from, to). */
  const listings = new Map<string, MeetingStub[]>();

  async function windowStubs(fromDate: string, toDate: string, signal?: AbortSignal): Promise<MeetingStub[]> {
    const key = `${fromDate}|${toDate}`;
    const hit = listings.get(key);
    if (hit) return hit;
    const from = Date.parse(fromDate);
    const to = Date.parse(toDate);
    // A day of slack each side: Plaud's dates are in the server's timezone, the window is UTC.
    const args = { date_from: ymd(from - DAY_MS), date_to: ymd(to + DAY_MS), page_size: LIST_PAGE_SIZE };
    const all = new Map<string, MeetingStub>();
    for (let page = 1; ; page++) {
      if (page > MAX_LIST_PAGES) throw new MeetingProviderError('plaud', 'listing_unbounded', `list_files did not end after ${MAX_LIST_PAGES} pages`);
      const rows = parsePlaudList(await call('list_files', { ...args, page }, signal));
      for (const r of rows) all.set(r.id, r);
      if (rows.length < LIST_PAGE_SIZE) break;
    }
    const stubs = [...all.values()]
      .filter(s => { const t = Date.parse(s.startedAt); return t >= from && t < to; })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
    listings.set(key, stubs);
    return stubs;
  }

  return {
    name: 'plaud',
    async probe(signal) {
      const user = await call('get_current_user', {}, signal);
      const r = isRecord(user) ? user : {};
      const userId = str(r.id);
      if (!userId) throw new MeetingShapeDriftError('plaud', 'get_current_user.id');
      account = { userId, email: str(r.email)?.toLowerCase() ?? null, name: str(r.nickname) };
      return account;
    },
    async listMeetings({ fromDate, toDate, limit, skip, signal }) {
      return (await windowStubs(fromDate, toDate, signal)).slice(skip, skip + limit);
    },
    async fetchMeeting(id, { transcript, signal }) {
      const file = await call('get_file', { file_id: id }, signal).catch(e => {
        if (e instanceof MeetingProviderError && /not.?found|404/i.test(e.message)) return null;
        throw e;
      });
      if (file === null) return null;
      const f = isRecord(file) ? (isRecord(file.data) ? file.data : file) : {};
      const startedAt = plaudInstant(f.start_at);
      if (!startedAt) throw new MeetingShapeDriftError('plaud', 'get_file.start_at');
      const durationMs = num(f.duration);
      // get_file carries the notes too (`note_list`); get_note is only a narrower view of the same list.
      const { summary, actionItems } = splitPlaudSummary(plaudSummaryNote(f.note_list));
      let sentences: MeetingSentence[] | null = null;
      let transcribed = true;
      if (transcript) {
        sentences = [];
        let cursor: string | null = null;
        for (let page = 0; ; page++) {
          if (page >= MAX_TRANSCRIPT_PAGES) throw new MeetingProviderError('plaud', 'transcript_unbounded', `get_transcript did not end after ${MAX_TRANSCRIPT_PAGES} pages`);
          const answer = parsePlaudTranscriptPage(
            await call('get_transcript', { file_id: id, limit: TRANSCRIPT_PAGE, ...(cursor ? { cursor } : {}) }, signal), page === 0);
          if ('unfinished' in answer) { transcribed = false; break; }
          sentences.push(...answer.sentences);
          if (!answer.next) break;
          cursor = answer.next;
        }
      }
      const owner = account?.email ?? null;
      const ready = (transcribed || !transcript) && (summary !== null || actionItems.length > 0);
      return {
        id,
        title: str(f.name) ?? 'Untitled recording',
        startedAt,
        durationSec: durationMs === null ? null : Math.round(durationMs / 1000),
        attendees: owner ? [{ name: account?.name ?? null, email: owner }] : [],
        organizerEmail: owner,
        summary,
        actionItems,
        keywords: [],
        transcript: transcript ? sentences : null,
        url: null,
        isFinal: ready || now() - Date.parse(startedAt) >= PLAUD_PROCESSING_WAIT_MS,
      } satisfies MeetingRecord;
    },
  };
}
