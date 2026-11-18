/**
 * recall's fact pages (fork patch): the `offset` param and the page it cuts.
 *
 * recall collapses copies of one claim after each arm reads (#7043,
 * collapseFactReads): a group stands at its first member's place in the
 * arm's newest-first order and carries `collapsed_count`. A page is therefore
 * a window of the COLLAPSED order, never of the raw rows: an SQL offset per
 * arm would split a group across two pages (its copies shown twice, each with
 * a partial count) and shift every later page. So a paged read takes the
 * arm's whole list (every granted source, every slug an entity's facts are
 * saved under), merges it in one fixed order, collapses it once and cuts
 * [offset, offset + limit). Each page is cut from the same collapsed order,
 * so a group appears on exactly one page with every copy counted.
 *
 * The whole list is bounded: past RECALL_PAGED_ROWS_MAX raw rows the read is
 * refused (never a silently short page, which a pager reads as the end).
 */

import { MAX_SEARCH_LIMIT } from '../engine.ts';
import { verbError } from '../ops/contract.ts';

/** One engine read of an arm's ordered list; `page` overrides the list opts' limit/offset. */
export type FactRead<R> = (page: { limit: number; offset?: number }) => Promise<R[]>;

/** The most raw rows a paged recall reads to collapse its whole list. */
export const RECALL_PAGED_ROWS_MAX = 10_000;

/**
 * recall's `offset`: null when absent (recall reads as upstream does), else the
 * number of collapsed facts to skip. Anything but a non-negative safe integer is
 * refused rather than read as 0, so a pager never gets page one back as if it
 * were the next page. The two arms that are not a newest-first list refuse it.
 */
export function parseRecallOffset(p: Record<string, unknown>, question: string | null): number | null {
  const raw = p.offset;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw verbError('invalid_params',
      `offset must be a non-negative integer (the number of facts to skip), got ${typeof raw === 'number' ? String(raw) : typeof raw}.`,
      'Pass offset as a whole number >= 0 with limit, e.g. offset: 100 and limit: 100 for the second page of 100.');
  }
  if (question !== null) {
    throw verbError('invalid_params',
      'offset cannot be combined with question: question ranks a bounded candidate pool by relevance, so its order has no stable pages.',
      'Drop question to page the facts newest first, or drop offset to read the best-ranked facts.');
  }
  if (p.supersessions === true) {
    throw verbError('invalid_params',
      'offset cannot be combined with supersessions: the supersession log is not a collapsed fact list.',
      'Drop offset and read the log with limit (up to 100), or drop supersessions to page the active facts.');
  }
  return raw || 0; // folds -0 into 0
}

/**
 * The cross-list merge, newest first by `keyOf` (each arm's engine ORDER BY
 * key), stable: ties keep list order. Lists past the first are merged only
 * when there are several; `cut` bounds the result (recall's per-arm read).
 */
export function mergeNewest<R>(lists: R[][], keyOf: (rec: Record<string, unknown>) => unknown, cut = MAX_SEARCH_LIMIT): R[] {
  if (lists.length === 1) return lists[0];
  const toTime = (v: unknown): number => {
    const t = v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
  };
  const decorated = lists.flat().map(r => ({ r, k: toTime(keyOf(r as unknown as Record<string, unknown>)) }));
  decorated.sort((a, b) => b.k - a.k);
  return decorated.slice(0, cut).map(d => d.r);
}

/** Every row of one engine-ordered list, in capped reads, counted against the shared budget. */
async function readWhole<R>(read: FactRead<R>, budget: { left: number }): Promise<R[]> {
  const rows: R[] = [];
  for (;;) {
    const page = await read(rows.length > 0 ? { limit: MAX_SEARCH_LIMIT, offset: rows.length } : { limit: MAX_SEARCH_LIMIT });
    rows.push(...page);
    budget.left -= page.length;
    if (budget.left < 0) {
      throw verbError('invalid_params',
        `offset pages a fact list of at most ${RECALL_PAGED_ROWS_MAX} rows, and this one is longer.`,
        'Narrow the list with entity, session_id or since (or source_id), or drop offset to read the newest facts.');
    }
    if (page.length < MAX_SEARCH_LIMIT) return rows;
  }
}

/**
 * Rows [offset, offset + limit) of the arm's collapsed order: every list read
 * whole (in order: sources, then slugs), merged by `keyOf` (stable), collapsed
 * once by `collapse`, then cut.
 */
export async function readRecallPage<R, C>(reads: FactRead<R>[], keyOf: (rec: Record<string, unknown>) => unknown,
  page: { offset: number; limit: number }, collapse: (rows: R[]) => Promise<C[]>): Promise<C[]> {
  const budget = { left: RECALL_PAGED_ROWS_MAX };
  const lists: R[][] = [];
  for (const read of reads) lists.push(await readWhole(read, budget));
  const merged = lists.length === 0 ? [] : mergeNewest(lists, keyOf, Number.POSITIVE_INFINITY);
  return (await collapse(merged)).slice(page.offset, page.offset + page.limit);
}
