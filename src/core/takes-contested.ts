/**
 * takes_list's contested label names the other take of its pending
 * supersede_take trust proposal (tp<id>, eligibility/sql.ts contestedRefSql)
 * as `take_id`, so a reader can read that side with takes_list `id`.
 *
 * Set only when the caller can read the other take: listTakes under the
 * caller's read policy (source scope, private pages, the holder allow-list,
 * the trust floor and quarantine, active rows) answers it, so a label never
 * reveals the id of a take the caller cannot see; without it the label still
 * names the proposal. One batched proposal read, then one by-id read per
 * contested row.
 */
import type { BrainEngine, TakesListOpts } from './engine.ts';
import type { Contested } from './eligibility/labels.ts';

/** The read policy part of a takes_list call: scope, privacy, holders and eligibility, without its narrowing filters. */
export type TakeReadPolicy = Pick<TakesListOpts, 'sourceId' | 'sourceIds' | 'excludePrivate' | 'takesHoldersAllowList' | 'eligibility'>;

export async function withContestedTakeIds<T extends { id: number; contested?: Contested }>(engine: Pick<BrainEngine, 'executeRaw' | 'listTakes'>,
  rows: T[], policy: TakeReadPolicy): Promise<T[]> {
  const labeled = rows.flatMap(r => {
    const ref = r.contested && !r.contested.take_id ? /^tp(\d+)$/.exec(r.contested.proposal_ref) : null;
    return ref && Number.isSafeInteger(Number(r.id)) ? [{ id: Number(r.id), proposal: Number(ref[1]) }] : [];
  });
  if (labeled.length === 0) return rows;
  const found = await engine.executeRaw<{ delivered: number | string; other: number | string }>(
    'SELECT x.id AS delivered, CASE WHEN p.related_id = x.id THEN p.target_id ELSE p.related_id END AS other\n'
    + '  FROM unnest($1::bigint[], $2::bigint[]) AS x(id, proposal_id)\n'
    + "  JOIN trust_proposals p ON p.id = x.proposal_id AND p.status = 'pending' AND p.action = 'supersede_take'\n"
    + "   AND p.target_table = 'takes' AND p.related_table = 'takes' AND (p.related_id = x.id OR p.target_id = x.id)",
    [labeled.map(l => l.id), labeled.map(l => l.proposal)]);
  const other = new Map<number, string>();
  for (const f of found) {
    const id = Number(f.other);
    if ((await engine.listTakes({ ...policy, id, limit: 1 })).length === 1) other.set(Number(f.delivered), String(id));
  }
  return rows.map(r => (r.contested && other.has(Number(r.id)) ? { ...r, contested: { ...r.contested, take_id: other.get(Number(r.id))! } } : r));
}
