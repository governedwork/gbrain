/**
 * recall's fact pages (fork patch): the `offset` param, the window each
 * granted source reads, the capped engine reads that fill a window, and the
 * cross-source merge that cuts the page.
 *
 * Every fact-list arm of recall reads newest first in a fixed total order:
 * each engine query orders by its key DESC, id DESC (engine-sql/facts.ts), and
 * the merges (readEntityFacts across an entity's slugs, mergeNewest across
 * granted sources) are stable sorts over lists in a fixed order, so a tie
 * keeps source order, then slug order, then list order. That order is the
 * same on every call, and its first offset+limit rows come only from each
 * list's first offset+limit rows: one list reads its page in SQL (LIMIT ...
 * OFFSET ...); several read those prefixes and the merge slices
 * [offset, offset + limit).
 */

import { MAX_SEARCH_LIMIT } from '../engine.ts';
import { verbError } from '../ops/contract.ts';

/** A window of one arm's ordered fact list: rows [offset, offset + limit). */
export interface FactWindow { offset: number; limit: number }
/** One engine read's page; offset is left out at 0, as every read was before recall paged. */
export type FactPage = { limit: number; offset?: number };

/**
 * recall's `offset`: how many facts of the arm's order to skip. Absent
 * (undefined, or null — the MCP absent idiom) is 0. Anything but a
 * non-negative safe integer is refused rather than read as 0, so a pager with
 * a bad offset never gets page one back as if it were the next page. The two
 * arms that are not a newest-first list refuse it, with the reason.
 */
export function parseRecallOffset(p: Record<string, unknown>, question: string | null): number {
  const raw = p.offset;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw verbError('invalid_params',
      `offset must be a non-negative integer (the number of facts to skip), got ${typeof raw === 'number' ? String(raw) : typeof raw}.`,
      'Pass offset as a whole number >= 0 with limit, e.g. offset: 100 and limit: 100 for the second page of 100; omit it for the first page.');
  }
  if (question !== null) {
    throw verbError('invalid_params',
      'offset cannot be combined with question: question ranks a bounded candidate pool by relevance (approximate vector search and an admission floor), so its order has no stable pages.',
      'Drop question to page the facts newest first, or drop offset to read the best-ranked facts.');
  }
  if (p.supersessions === true) {
    throw verbError('invalid_params',
      'offset cannot be combined with supersessions: the supersession log applies grep after its LIMIT and its engine read takes no offset, so a page would skip or repeat rows.',
      'Drop offset and read the log with limit (up to 100), or drop supersessions to page the active facts.');
  }
  return raw || 0; // folds -0 into 0
}

/** What each of `sources` granted sources reads for `page`: the page itself when it is the only one, else its first offset+limit rows. */
export function recallSourceWindow(sources: number, page: FactWindow): FactWindow {
  return sources === 1 ? page : { offset: 0, limit: page.offset + page.limit };
}

/**
 * Rows [offset, offset + limit) of one engine-ordered fact list. The engine
 * caps one read at MAX_SEARCH_LIMIT rows and a merged page needs offset+limit
 * rows of every list, so the window is read in capped pages until it is full
 * or the list ends. A window of at most MAX_SEARCH_LIMIT at offset 0 (every
 * read without offset) is one read with the same opts as before.
 */
export async function readFactWindow<R>(read: (page: FactPage) => Promise<R[]>, window: FactWindow): Promise<R[]> {
  const rows: R[] = [];
  while (rows.length < window.limit) {
    const want = Math.min(window.limit - rows.length, MAX_SEARCH_LIMIT);
    const at = window.offset + rows.length;
    const page = await read(at > 0 ? { limit: want, offset: at } : { limit: want });
    rows.push(...page);
    if (page.length < want) break;
  }
  return rows;
}

/**
 * The cross-source merge: `page` of the granted sources' lists, newest first.
 * Per-arm merge key: each arm's engine query ORDERs by a different column
 * (supersessions by COALESCE(expired_at, valid_until) — #3014, entity by
 * valid_from, the rest by created_at) — the merge must sort by the SAME key
 * or the truncation at `limit` silently drops the wrong rows.
 * Decorate-sort-undecorate: the key is computed once per row. One list is
 * already the page (recallSourceWindow).
 */
export function mergeNewest<R>(lists: R[][], keyOf: (rec: Record<string, unknown>) => unknown, page: FactWindow): R[] {
  if (lists.length === 1) return lists[0];
  const toTime = (v: unknown): number => {
    const t = v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
  };
  const decorated = lists.flat().map((r: R) => ({
    r,
    k: toTime(keyOf(r as unknown as Record<string, unknown>)),
  }));
  decorated.sort((a, b) => b.k - a.k);
  return decorated.slice(page.offset, page.offset + page.limit).map(d => d.r);
}
