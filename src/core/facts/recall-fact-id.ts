/**
 * recall's `fact_id` (fork patch): one fact by the id recall and remember answer as `fact_id`, so a caller can re-read
 * a fact it was shown (a preview before a confirm, the other fact of a contested pair) without paging a list until the
 * id turns up.
 *
 * The read is recall's own list read narrowed to that id (RecallFactReadOpts.factId, engine-sql/facts.ts
 * recallNarrowing) with the arm's list opts, so every filter recall's lists apply holds by construction: the granted
 * sources, the visibility list (world only for remote callers, widened only to the caller's own member-page facts),
 * the private-provenance and entity-page read access (privateProvenanceFilterUnderPolicy: readers, folder and page
 * rules, labelled-only grants, held rows on holding pages), the trust floor, quarantine, audit rows and active rows
 * unless include_expired. A fact the caller may not read answers `facts: []`, exactly like an id that does not exist.
 *
 * The same read gates the contested label's other fact for a pending trust proposal (tp<id>, supersede_fact):
 * `contested.fact_id` (upstream's field, set for decide proposals by facts/contested-claims.ts) names that fact only
 * when this read answers it for the caller.
 */

import type { BrainEngine, FactRow, RecallFactReadOpts } from '../engine.ts';
import type { Contested } from '../eligibility/labels.ts';
import { verbError } from '../ops/contract.ts';

/** The params that choose another arm of recall; fact_id refuses each one rather than ignore it. */
const OTHER_ARMS = ['question', 'supersessions', 'since', 'entity', 'session_id', 'query', 'offset'] as const;

const given = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== '';

/**
 * recall's `fact_id`: null when absent, else the id. A value that is not a positive whole number in a string, and
 * fact_id with a param that picks another arm, are invalid_params.
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

type ListRead = Pick<BrainEngine, 'listFactsSince'>;

/** Fact `id` in the granted `sources` under recall's list opts, as a list of at most one row. */
export async function readFactById(engine: ListRead, sources: readonly string[], id: number, opts: RecallFactReadOpts): Promise<FactRow[]> {
  const found = await Promise.all(sources.map(src => engine.listFactsSince(src, new Date(0), { ...opts, factId: id, entitySlug: undefined, sessionId: undefined, limit: 1, offset: 0 })));
  return found.flat().slice(0, 1);
}

/**
 * Names the other fact of a row's pending supersede_fact trust proposal as `contested.fact_id`, only when the caller
 * reads it by id (readFactById over its sources with `opts`, active rows). Rows already naming one keep it. One
 * batched proposal read, then one by-id read per contested row; a failed read fails the call, never reads as "none".
 */
export async function withTrustContestedFacts<T extends { id: number; contested?: Contested }>(engine: ListRead & Pick<BrainEngine, 'executeRaw'>,
  rows: T[], sources: readonly string[], opts: RecallFactReadOpts): Promise<T[]> {
  const labeled = rows.flatMap(r => {
    const ref = r.contested && r.contested.fact_id === undefined ? /^tp(\d+)$/.exec(r.contested.proposal_ref) : null;
    return ref && Number.isSafeInteger(Number(r.id)) ? [{ id: Number(r.id), proposal: Number(ref[1]) }] : [];
  });
  if (labeled.length === 0) return rows;
  const found = await engine.executeRaw<{ delivered: number | string; other: number | string | null }>(
    'SELECT x.id AS delivered, CASE WHEN p.related_id = x.id THEN p.target_id ELSE p.related_id END AS other\n'
    + '  FROM unnest($1::bigint[], $2::bigint[]) AS x(id, proposal_id)\n'
    + "  JOIN trust_proposals p ON p.id = x.proposal_id AND p.status = 'pending' AND p.action = 'supersede_fact'\n"
    + "   AND p.target_table = 'facts' AND p.related_table = 'facts' AND (p.related_id = x.id OR p.target_id = x.id)",
    [labeled.map(l => l.id), labeled.map(l => l.proposal)]);
  const other = new Map<number, string>();
  for (const f of found) {
    const id = Number(f.other);
    if (f.other === null || !Number.isSafeInteger(id)) continue;
    if ((await readFactById(engine, sources, id, { ...opts, activeOnly: true, grep: undefined })).length > 0) other.set(Number(f.delivered), String(id));
  }
  return rows.map(r => (r.contested && other.has(Number(r.id)) ? { ...r, contested: { ...r.contested, fact_id: other.get(Number(r.id))! } } : r));
}
