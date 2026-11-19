/**
 * Ours (governedwork fork), not upstream GBrain: derived mentions a person
 * removed (`mention_suppressions`, suppression-schema.ts).
 *
 * `remove_link` reads, before its delete and in the same transaction, the page
 * pair of a derived mention edge (`link_source='mentions'`) its filters match
 * when the removal takes the pair's plain mention (`derivedMentionPair`: no
 * `link_type` filter, or the plain mention's own type), and records it once the
 * delete removed an edge (`recordMentionSuppression`). Removing only a typed
 * edge (`link_type: works_at`) records nothing, so the plain mention stays
 * derivable. Every derive path leaves a recorded pair out: the mention pass's
 * reconcile (`suppressedMentionKeys`), `extract links --by-mention` (with
 * `--rebuild`) and `extract links --ner` (`dropSuppressedMentions`), and
 * `extract mentions --explain` reports it (`isMentionSuppressed`). A twin merge
 * moves a twin's pairs to its survivor (`moveMentionSuppressions`). Writing a
 * suppression touches no page row, so a page's knowledge revision does not move.
 */
import type { BrainEngine } from '../engine.ts';

export interface MentionPair { from_page_id: number; to_page_id: number }

/** The `link_type` of a plain mention edge (the mention pass and `extract links --by-mention` write it). */
export const PLAIN_MENTION_LINK_TYPE = 'mentions';

/** `<from page id>\0<target source>\0<target slug>`: the key a derived mention and its suppression share. */
export function mentionKey(fromPageId: number, sourceId: string, slug: string): string {
  return `${fromPageId}\0${sourceId}\0${slug}`;
}

/**
 * The page pair of a derived mention edge from `from` to `to` that a `remove_link` with these filters deletes, when
 * that removal takes the pair's plain mention; null when its filters match no derived mention (a manual or markdown
 * edge only, or no edge) or name another link type (a typed edge only).
 */
export async function derivedMentionPair(engine: Pick<BrainEngine, 'executeRaw'>, link: { from: string; to: string; fromSourceId: string; toSourceId: string;
  linkType?: string; linkSource?: string }): Promise<MentionPair | null> {
  if (link.linkSource !== undefined && link.linkSource !== 'mentions') return null;
  if (link.linkType !== undefined && link.linkType !== PLAIN_MENTION_LINK_TYPE) return null;
  const [row] = await engine.executeRaw<MentionPair>(
    `SELECT l.from_page_id, l.to_page_id FROM links l
       JOIN pages f ON f.id = l.from_page_id AND f.slug = $1 AND f.source_id = $2
       JOIN pages t ON t.id = l.to_page_id AND t.slug = $3 AND t.source_id = $4
      WHERE l.link_source = 'mentions' AND ($5::text IS NULL OR l.link_type = $5)
      LIMIT 1`,
    [link.from, link.fromSourceId, link.to, link.toSourceId, link.linkType ?? null]);
  return row ? { from_page_id: Number(row.from_page_id), to_page_id: Number(row.to_page_id) } : null;
}

/** Record that no derive path may produce `pair` again (idempotent). */
export async function recordMentionSuppression(engine: Pick<BrainEngine, 'executeRaw'>, pair: MentionPair): Promise<void> {
  await engine.executeRaw('INSERT INTO mention_suppressions (from_page_id, to_page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [pair.from_page_id, pair.to_page_id]);
}

/** `mentionKey` of every suppressed pair from `fromPageIds`. */
export async function suppressedMentionKeys(engine: Pick<BrainEngine, 'executeRaw'>, fromPageIds: number[]): Promise<Set<string>> {
  if (!fromPageIds.length) return new Set();
  const rows = await engine.executeRaw<{ from_page_id: number; source_id: string; slug: string }>(
    `SELECT s.from_page_id, t.source_id, t.slug FROM mention_suppressions s JOIN pages t ON t.id = s.to_page_id
      WHERE s.from_page_id = ANY($1::int[])`, [fromPageIds]);
  return new Set(rows.map(r => mentionKey(Number(r.from_page_id), r.source_id, r.slug)));
}

/** `mentions` of page `fromPageId` without the pairs a person removed: what a derive path may write. */
export async function dropSuppressedMentions<T extends { slug: string; source_id: string }>(engine: Pick<BrainEngine, 'executeRaw'>,
  fromPageId: number, mentions: T[]): Promise<T[]> {
  if (!mentions.length) return mentions;
  const suppressed = await suppressedMentionKeys(engine, [fromPageId]);
  return suppressed.size ? mentions.filter(m => !suppressed.has(mentionKey(fromPageId, m.source_id, m.slug))) : mentions;
}

/** Whether a person removed the mention from page `fromPageId` to any of `slugs` in `sourceId`. */
export async function isMentionSuppressed(engine: Pick<BrainEngine, 'executeRaw'>, fromPageId: number, sourceId: string, slugs: string[]): Promise<boolean> {
  const suppressed = await suppressedMentionKeys(engine, [fromPageId]);
  return slugs.some(slug => suppressed.has(mentionKey(fromPageId, sourceId, slug)));
}

/**
 * A twin merge (persistence/twin-merge.ts): re-point the twin's suppressed pairs, either end, at the survivor; a pair
 * the survivor already holds, or one that would point a page at itself, is dropped.
 */
export async function moveMentionSuppressions(tx: Pick<BrainEngine, 'executeRaw'>, twinPageId: number, survivorPageId: number): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO mention_suppressions (from_page_id, to_page_id, created_at)
     SELECT m.from_page_id, m.to_page_id, m.created_at FROM (
       SELECT CASE WHEN from_page_id = $1 THEN $2 ELSE from_page_id END AS from_page_id,
              CASE WHEN to_page_id = $1 THEN $2 ELSE to_page_id END AS to_page_id, created_at
         FROM mention_suppressions WHERE from_page_id = $1 OR to_page_id = $1) m
      WHERE m.from_page_id <> m.to_page_id
     ON CONFLICT (from_page_id, to_page_id) DO NOTHING`, [twinPageId, survivorPageId]);
  await tx.executeRaw('DELETE FROM mention_suppressions WHERE from_page_id = $1 OR to_page_id = $1', [twinPageId]);
}
