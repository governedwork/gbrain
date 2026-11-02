/**
 * Wave B PR 2 (N5): a segmented body is read only when its manifest rows tile it. The rows of a generation must run
 * from byte 0 without a gap and sum to that generation's body_bytes (the page's for the live generation, its
 * segmented version's for a retained one). A role that sees the page row but not its manifest rows, or rows that
 * went missing, would otherwise read as a short or empty body: an export, digest or rewrite of it would succeed and
 * be wrong. Checked from the row metadata before any text is read, so it costs one pass over the rows.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';

export interface RowSpan { byteStart: number; byteLen: number }

/** What to do when every role gets page_body_rows_unreadable: the live generation lost rows, and a revert republishes a readable version's body. */
export const ROWS_UNREADABLE_SUGGESTION = 'Give the role that reads the brain the same access to page_body_manifest and page_segment_texts it has to pages, then read again. '
  + 'If every role gets this answer, the live generation lost rows: revert_version (force: true) to the newest segmented version that reads (get_versions lists them) republishes its body.';

/** Throws page_body_rows_unreadable unless `rows` (in seq order) tile [0, total); a null total checks only a gapless start at 0. */
export function assertRowsTile(rows: readonly RowSpan[], at: { slug: string; sourceId: string; total: number | null }): void {
  let end = 0;
  for (const row of rows) {
    if (row.byteStart !== end) { end = -1; break; }
    end += row.byteLen;
  }
  if (end >= 0 && (at.total === null ? rows.length > 0 : end === at.total)) return;
  throw opError('page_body_rows_unreadable', `Page ${at.slug} (source ${at.sourceId}): the segment rows readable here do not cover its ${at.total ?? 'stored'}-byte body, so nothing was read.`,
    ROWS_UNREADABLE_SUGGESTION,
    { detail: JSON.stringify({ rows: rows.length, covered_bytes: end >= 0 ? end : null, body_bytes: at.total }) });
}

/**
 * body_bytes of generation `generation` of a segmented page: the page's when it is live, else the segmented version
 * that references it (null when none does: nothing records that generation's size).
 */
export async function generationBodyBytes(engine: Pick<BrainEngine, 'executeRaw'>, page: { id: number; body_generation: unknown; body_bytes: unknown },
  generation: number): Promise<number | null> {
  if (generation === Number(page.body_generation)) return Number(page.body_bytes ?? 0);
  const [version] = await engine.executeRaw<{ body_bytes: number | string | null }>(`SELECT body_bytes FROM page_versions
    WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented' AND body_bytes IS NOT NULL ORDER BY id DESC LIMIT 1`, [page.id, generation]);
  return version ? Number(version.body_bytes) : null;
}

/**
 * The live generation of a segmented page read from its rows' extents only (no texts, no row metadata): the generation,
 * its body_bytes and whether its rows tile them. Null when the page is not segmented. revert_version takes its repair
 * path when it is false (persistence/untiled-revert.ts).
 */
export async function liveGenerationTiling(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number):
  Promise<{ slug: string; sourceId: string; generation: number; bodyBytes: number; rows: RowSpan[]; tiles: boolean } | null> {
  const found = await engine.executeRaw<{ slug: string; source_id: string; body_generation: unknown; body_bytes: unknown; byte_start: unknown; byte_len: unknown }>(
    `SELECT p.slug, p.source_id, p.body_generation, p.body_bytes, m.byte_start, m.byte_len FROM pages p
       LEFT JOIN page_body_manifest m ON m.page_id = p.id AND m.staging_id IS NULL AND m.gen_from <= p.body_generation
        AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)
      WHERE p.id = $1 AND p.body_storage = 'segmented' ORDER BY m.seq`, [pageId]);
  if (!found.length) return null;
  const rows = found.filter(row => row.byte_start !== null && row.byte_start !== undefined)
    .map(row => ({ byteStart: Number(row.byte_start), byteLen: Number(row.byte_len) }));
  const bodyBytes = Number(found[0]!.body_bytes ?? 0);
  let end = 0;
  for (const row of rows) { if (row.byteStart !== end) { end = -1; break; } end += row.byteLen; }
  return { slug: found[0]!.slug, sourceId: found[0]!.source_id, generation: Number(found[0]!.body_generation), bodyBytes, rows,
    tiles: rows.length > 0 && end === bodyBytes };
}

/** The tiling check for a reader that read `rows` of `generation` (default live) through readManifest. */
export async function assertGenerationTiles(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, generation: number | undefined, rows: readonly RowSpan[]): Promise<void> {
  const [page] = await engine.executeRaw<{ id: number; slug: string; source_id: string; body_generation: unknown; body_bytes: unknown }>(
    'SELECT id, slug, source_id, body_generation, body_bytes FROM pages WHERE id=$1', [pageId]);
  if (!page) return;
  const at = generation ?? Number(page.body_generation);
  assertRowsTile(rows, { slug: page.slug, sourceId: page.source_id, total: await generationBodyBytes(engine, { ...page, id: pageId }, at) });
}
