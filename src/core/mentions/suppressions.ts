/**
 * Ours (governedwork fork), not upstream GBrain: derived mentions a person
 * removed (`mention_suppressions`, suppression-schema.ts).
 *
 * `remove_link` reads, before its delete and in the same transaction, the page
 * pair of a derived mention edge (`link_source='mentions'`) its filters match
 * (`derivedMentionPair`), and records it once the delete removed an edge
 * (`recordMentionSuppression`). The mention pass leaves a recorded pair out of
 * the mentions it wants (`suppressedMentionKeys`), so its rescans never derive
 * the pair again and drop a plain mention row of it. Writing a suppression
 * touches no page row, so a page's knowledge revision does not move.
 */
import type { BrainEngine } from '../engine.ts';

export interface MentionPair { from_page_id: number; to_page_id: number }

/**
 * The page pair of a derived mention edge from `from` to `to` that a `remove_link` with these filters deletes, or null
 * when its filters match none (a manual or markdown edge only, or no edge).
 */
export async function derivedMentionPair(engine: Pick<BrainEngine, 'executeRaw'>, link: { from: string; to: string; fromSourceId: string; toSourceId: string;
  linkType?: string; linkSource?: string }): Promise<MentionPair | null> {
  if (link.linkSource !== undefined && link.linkSource !== 'mentions') return null;
  const [row] = await engine.executeRaw<MentionPair>(
    `SELECT l.from_page_id, l.to_page_id FROM links l
       JOIN pages f ON f.id = l.from_page_id AND f.slug = $1 AND f.source_id = $2
       JOIN pages t ON t.id = l.to_page_id AND t.slug = $3 AND t.source_id = $4
      WHERE l.link_source = 'mentions' AND ($5::text IS NULL OR l.link_type = $5)
      LIMIT 1`,
    [link.from, link.fromSourceId, link.to, link.toSourceId, link.linkType ?? null]);
  return row ? { from_page_id: Number(row.from_page_id), to_page_id: Number(row.to_page_id) } : null;
}

/** Record that the mention pass must not derive `pair` again (idempotent). */
export async function recordMentionSuppression(engine: Pick<BrainEngine, 'executeRaw'>, pair: MentionPair): Promise<void> {
  await engine.executeRaw('INSERT INTO mention_suppressions (from_page_id, to_page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [pair.from_page_id, pair.to_page_id]);
}

/** `<from page id>\0<target source>\0<target slug>` of every suppressed pair from `fromPageIds`: the mention pass's want-set key. */
export async function suppressedMentionKeys(engine: Pick<BrainEngine, 'executeRaw'>, fromPageIds: number[]): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ from_page_id: number; source_id: string; slug: string }>(
    `SELECT s.from_page_id, t.source_id, t.slug FROM mention_suppressions s JOIN pages t ON t.id = s.to_page_id
      WHERE s.from_page_id = ANY($1::int[])`, [fromPageIds]);
  return new Set(rows.map(r => `${r.from_page_id}\0${r.source_id}\0${r.slug}`));
}
