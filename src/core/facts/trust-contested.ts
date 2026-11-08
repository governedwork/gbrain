/**
 * recall's contested label names the other fact of its pending supersede_fact
 * trust proposal (tp<id>, eligibility/sql.ts contestedRefSql) as `fact_id`,
 * so a reader can read that side with recall `fact_id`.
 *
 * Set only when the caller can read the other fact: recall's own read by id
 * (engine.getFact over the granted sources with recall's list opts: world
 * only for remote callers, private provenance, the trust floor and
 * quarantine, active rows) answers it, so a label never reveals the id of a
 * fact the caller cannot see; without it the label still names the proposal.
 * One batched proposal read, then one by-id read per contested row.
 */
import type { BrainEngine, FactListOpts } from '../engine.ts';
import type { Contested } from '../eligibility/labels.ts';

export async function withTrustContestedFacts<T extends { id: number; contested?: Contested }>(engine: Pick<BrainEngine, 'executeRaw' | 'getFact'>,
  rows: T[], sources: readonly string[], opts: FactListOpts): Promise<T[]> {
  const labeled = rows.flatMap(r => {
    const ref = r.contested && !r.contested.fact_id ? /^tp(\d+)$/.exec(r.contested.proposal_ref) : null;
    return ref && Number.isSafeInteger(Number(r.id)) ? [{ id: Number(r.id), proposal: Number(ref[1]) }] : [];
  });
  if (labeled.length === 0) return rows;
  const found = await engine.executeRaw<{ delivered: number | string; other: number | string }>(
    'SELECT x.id AS delivered, CASE WHEN p.related_id = x.id THEN p.target_id ELSE p.related_id END AS other\n'
    + '  FROM unnest($1::bigint[], $2::bigint[]) AS x(id, proposal_id)\n'
    + "  JOIN trust_proposals p ON p.id = x.proposal_id AND p.status = 'pending' AND p.action = 'supersede_fact'\n"
    + "   AND p.target_table = 'facts' AND p.related_table = 'facts' AND (p.related_id = x.id OR p.target_id = x.id)",
    [labeled.map(l => l.id), labeled.map(l => l.proposal)]);
  const other = new Map<number, string>();
  for (const f of found) {
    const id = Number(f.other);
    const readable = await Promise.all(sources.map(src => engine.getFact(src, id, opts)));
    if (readable.some(row => row !== null)) other.set(Number(f.delivered), String(id));
  }
  return rows.map(r => (r.contested && other.has(Number(r.id)) ? { ...r, contested: { ...r.contested, fact_id: other.get(Number(r.id))! } } : r));
}
