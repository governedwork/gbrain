/**
 * recall's `fact_id` (fork patch): one fact by the id recall and remember
 * answer as `fact_id`, so a caller can re-read a fact it was shown (a preview
 * before a confirm, the other row of a contested pair) without paging a list
 * until the id turns up.
 *
 * The read is one more fact-list arm: each granted source reads the id with
 * the arm's own FactListOpts, applied in SQL by the engine (engine.getFact),
 * so a fact outside the caller's sources, private to a remote caller, below
 * its trust floor, quarantined, an audit row, or expired without
 * include_expired is simply not there, the same `facts: []` as an id that
 * does not exist. Its list has at most one row (ids are unique across
 * sources) and recall's page window cuts it like any other list.
 */

import type { BrainEngine, FactListOpts, FactRow } from '../engine.ts';
import { verbError } from '../ops/contract.ts';
import type { FactWindow } from './recall-page.ts';

/** The params that choose another arm of recall; fact_id refuses each one rather than ignore it. */
const OTHER_ARMS = ['question', 'supersessions', 'since', 'entity', 'session_id', 'query'] as const;

const given = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== '';

/**
 * recall's `fact_id`: null when absent (undefined, or null, the MCP absent
 * idiom), else the id. A value that is not a positive integer in a string,
 * and fact_id with a param that picks another arm, are invalid_params.
 */
export function parseRecallFactId(p: Record<string, unknown>): number | null {
  const raw = p.fact_id;
  if (raw === undefined || raw === null) return null;
  const id = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    throw verbError('invalid_params',
      `fact_id must be a fact's id as recall answers it: a positive whole number in a string, got ${typeof raw === 'string' ? 'a string that is not one' : typeof raw}.`,
      'Pass facts[].fact_id from a recall or remember answer, e.g. fact_id: "345"; omit fact_id to list facts.');
  }
  const others = OTHER_ARMS.filter(k => given(p[k]));
  if (others.length > 0) {
    throw verbError('invalid_params',
      `fact_id cannot be combined with ${others.join(', ')}: fact_id reads one fact by its id, and ${others.length === 1 ? 'that param chooses' : 'those params choose'} another list.`,
      `Drop ${others.join(', ')} to read the fact by its id, or drop fact_id to read that list.`);
  }
  return id;
}

/** Fact `id` in the granted `sources` as a list of at most one row, cut to `page`; `opts` are the arm's list opts. */
export async function readFactById(engine: Pick<BrainEngine, 'getFact'>, sources: readonly string[], id: number,
  opts: FactListOpts, page: FactWindow): Promise<FactRow[]> {
  const found = await Promise.all(sources.map(src => engine.getFact(src, id, opts)));
  return found.filter((row): row is FactRow => row !== null).slice(page.offset, page.offset + page.limit);
}
