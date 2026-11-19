/**
 * Ours (governedwork fork), not upstream GBrain: derived mention edges a person
 * removed (`mention_suppressions`, suppression-schema.ts), keyed by page pair and
 * link type.
 *
 * `remove_link` reads, before its delete and in the same transaction, every
 * derived mention edge (`link_source='mentions'`) its filters match
 * (`derivedMentionEdges`) and records each one's (from, to, link_type) once the
 * delete removed an edge (`recordMentionSuppressions`): removing the plain
 * mention records type `mentions`, removing a typed NER edge records its verb.
 * Each derive path leaves out only the edge type it writes, from one read per
 * run or batch (`loadMentionSuppressions`): the mention pass and `extract links
 * --by-mention` the plain mention (`--rebuild` keeps a typed edge whose own type
 * is not suppressed), `extract links --ner` the verb, the meeting timeline
 * projection the plain mention; `extract mentions --explain` reports a
 * suppressed plain mention (`isMentionSuppressed`). A page id that moves (a twin
 * merge, a rename's add fallback) carries its suppressions and drops the derived
 * edges they now cover (`moveMentionSuppressions`). Writing a suppression
 * touches no page row, so a page's knowledge revision does not move.
 */
import type { BrainEngine } from '../engine.ts';
import type { RelationshipKey } from '../link-relationships.ts';

export interface MentionSuppression { from_page_id: number; to_page_id: number; link_type: string }

/** The `link_type` of a plain mention edge (the mention pass and `extract links --by-mention` write it). */
export const PLAIN_MENTION_LINK_TYPE = 'mentions';

/**
 * The derived mention edges from `from` to `to` (one per link type) that a `remove_link` with these filters deletes;
 * none when a `link_source` filter names another producer.
 */
export async function derivedMentionEdges(engine: Pick<BrainEngine, 'executeRaw'>, link: { from: string; to: string; fromSourceId: string; toSourceId: string;
  linkType?: string; linkSource?: string }): Promise<MentionSuppression[]> {
  if (link.linkSource !== undefined && link.linkSource !== 'mentions') return [];
  const rows = await engine.executeRaw<MentionSuppression>(
    `SELECT DISTINCT l.from_page_id, l.to_page_id, l.link_type FROM links l
       JOIN pages f ON f.id = l.from_page_id AND f.slug = $1 AND f.source_id = $2
       JOIN pages t ON t.id = l.to_page_id AND t.slug = $3 AND t.source_id = $4
      WHERE l.link_source = 'mentions' AND ($5::text IS NULL OR l.link_type = $5)`,
    [link.from, link.fromSourceId, link.to, link.toSourceId, link.linkType ?? null]);
  return rows.map(r => ({ from_page_id: Number(r.from_page_id), to_page_id: Number(r.to_page_id), link_type: r.link_type }));
}

/** Record that no derive path may write these edges again (idempotent). */
export async function recordMentionSuppressions(engine: Pick<BrainEngine, 'executeRaw'>, edges: MentionSuppression[]): Promise<void> {
  if (!edges.length) return;
  await engine.executeRaw(
    `INSERT INTO mention_suppressions (from_page_id, to_page_id, link_type)
     SELECT f, t, k FROM unnest($1::int[], $2::int[], $3::text[]) AS x(f, t, k) ON CONFLICT DO NOTHING`,
    [edges.map(e => e.from_page_id), edges.map(e => e.to_page_id), edges.map(e => e.link_type)]);
}

/** The suppressed edges of a run or batch, by source page id, target page and link type. */
export interface MentionSuppressions {
  has(fromPageId: number, target: { source_id: string; slug: string }, linkType: string): boolean;
}

/** One read of the suppressed edges from `fromPageIds` (every page when omitted), for a whole run or batch. */
export async function loadMentionSuppressions(engine: Pick<BrainEngine, 'executeRaw'>, fromPageIds?: number[]): Promise<MentionSuppressions> {
  const key = (fromPageId: number, sourceId: string, slug: string, linkType: string) => `${fromPageId}\0${sourceId}\0${slug}\0${linkType}`;
  const rows = fromPageIds && !fromPageIds.length ? [] : await engine.executeRaw<{ from_page_id: number; source_id: string; slug: string; link_type: string }>(
    `SELECT s.from_page_id, t.source_id, t.slug, s.link_type FROM mention_suppressions s JOIN pages t ON t.id = s.to_page_id
      ${fromPageIds ? 'WHERE s.from_page_id = ANY($1::int[])' : ''}`, fromPageIds ? [fromPageIds] : []);
  const keys = new Set(rows.map(r => key(Number(r.from_page_id), r.source_id, r.slug, r.link_type)));
  return { has: (fromPageId, target, linkType) => keys.has(key(fromPageId, target.source_id, target.slug, linkType)) };
}

/** Whether a person removed the plain mention from page `fromPageId` to any of `slugs` in `sourceId`. */
export async function isMentionSuppressed(engine: Pick<BrainEngine, 'executeRaw'>, fromPageId: number, sourceId: string, slugs: string[]): Promise<boolean> {
  const suppressed = await loadMentionSuppressions(engine, [fromPageId]);
  return slugs.some(slug => suppressed.has(fromPageId, { source_id: sourceId, slug }, PLAIN_MENTION_LINK_TYPE));
}

/**
 * A page id that moves onto another (a twin merge, a rename's add fallback), after its link rows moved: re-point its
 * suppressions, either end, at `toPageId` (one the destination already holds, or one that would point a page at
 * itself, is dropped), then delete the derived mention edges of `toPageId` those suppressions now cover. Returns the
 * deleted edges' keys, for the caller's relationship refresh.
 */
export async function moveMentionSuppressions(tx: Pick<BrainEngine, 'executeRaw'>, fromPageId: number, toPageId: number): Promise<RelationshipKey[]> {
  await tx.executeRaw(
    `INSERT INTO mention_suppressions (from_page_id, to_page_id, link_type, created_at)
     SELECT m.from_page_id, m.to_page_id, m.link_type, m.created_at FROM (
       SELECT CASE WHEN from_page_id = $1 THEN $2 ELSE from_page_id END AS from_page_id,
              CASE WHEN to_page_id = $1 THEN $2 ELSE to_page_id END AS to_page_id, link_type, created_at
         FROM mention_suppressions WHERE from_page_id = $1 OR to_page_id = $1) m
      WHERE m.from_page_id <> m.to_page_id
     ON CONFLICT (from_page_id, to_page_id, link_type) DO NOTHING`, [fromPageId, toPageId]);
  await tx.executeRaw('DELETE FROM mention_suppressions WHERE from_page_id = $1 OR to_page_id = $1', [fromPageId]);
  const dropped = await tx.executeRaw<RelationshipKey>(
    `DELETE FROM links l USING mention_suppressions s
      WHERE l.link_source = 'mentions' AND l.from_page_id = s.from_page_id AND l.to_page_id = s.to_page_id AND l.link_type = s.link_type
        AND (s.from_page_id = $1 OR s.to_page_id = $1)
      RETURNING l.from_page_id, l.to_page_id, l.link_type`, [toPageId]);
  return dropped.map(r => ({ from_page_id: Number(r.from_page_id), to_page_id: Number(r.to_page_id), link_type: r.link_type }));
}
