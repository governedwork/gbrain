/**
 * Fork patch (2026-11-02): `revert_version` as the native repair of a segmented page whose live
 * generation does not tile its body. Such a page answers page_body_rows_unreadable to every reader, and the ordinary
 * paths cannot write it: put_page and edit_page read the current body first, and revert_version refuses segmented
 * pages (segmentedRevertRefusal). Here a revert takes the current body as unread and publishes a new generation from a
 * segmented version's body, streamed from the version's own generation (whose rows must tile its recorded body_bytes),
 * one segment batch at a time. The page takes the version's title, type, frontmatter and tags, as a revert does.
 *
 * Nothing is re-projected: the write versions the page (a reference to the unreadable generation, kept as history),
 * flips the generation, sets the tags and reseals. Facts, takes, links and timeline rows stay as they are, so a fact,
 * take or timeline row the version's fences do not show stays in the database, as the database-canonical record.
 * Refused: a version of the unreadable generation itself, an inline version, a core-marked page or version, a page with
 * a canonical file (its file is the repair: sync or import it), and an external_untrusted writer under the write gate.
 * Null when the page is not a live segmented page whose generation does not tile: the caller takes the ordinary path.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageType, PageKind } from '../types.ts';
import type { PageVersion } from '../page-state/version-types.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { assertGenerationTiles, liveGenerationTiling } from '../page-body/body-tiling.ts';
import { prepareSegmentedBody, segmentWriteScope } from '../page-body/ingest.ts';
import { buildSegmentedProjection } from '../page-body/projection.ts';
import { splicePage } from '../page-body/splice.ts';
import { readPageBodyPolicy, STAGE_BATCH_BYTES } from '../page-body/limits.ts';
import { isSegmentedPage, pageBodySegmentedError } from '../page-body/page-shape.ts';
import type { BodyRegion, JsonObject, ManifestRow } from '../page-body/types.ts';
import { stepFenceWalk, type FenceWalk } from '../fence-scan.ts';
import { isQuarantined } from '../quarantine.ts';
import { loadImportSanityConfig } from '../import-screen.ts';
import { DEFAULT_WRITE_GATE_CONFIG, writeGateApplies } from '../write-gate.ts';
import { pageGateTrust, pageWriteTrust, recordAgentPageLowering, stampPageTrustMarker, storedPageTier } from '../trust/page-write.ts';
import { sizeStateField } from '../page-embedding-budget.ts';
import { applySegmentedBody, sealSegmentedPage, segmentedLivePage, type SegmentedApplied } from './segmented-apply.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { pageRefusal, pageDatabaseOnlyPublication } from './page-prepare.ts';
import { remoteLinkHint } from './page-advisories.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const coreMarked = (frontmatter: Record<string, unknown> | null | undefined) => frontmatter?.always_load !== undefined || frontmatter?.core_priority !== undefined;

/** One region of a retained generation's stored stream, read one segment batch at a time. */
async function* generationRegion(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[], region: BodyRegion): AsyncIterable<Uint8Array> {
  const mine = rows.filter(row => row.region === region);
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  for (let at = 0; at < mine.length;) {
    let to = at, bytes = 0;
    while (to < mine.length && (to === at || bytes + mine[to]!.byteLen <= batchBytes)) bytes += mine[to++]!.byteLen;
    const batch = mine.slice(at, to);
    const texts = await engine.readSegmentTexts(sourceId, batch.map(row => row.sha256));
    for (const row of batch) {
      const text = texts.get(hex(row.sha256));
      if (!text) throw new Error(`Segment text ${hex(row.sha256)} of page ${row.pageId} is missing.`);
      yield text;
    }
    at = to;
  }
}

/** ingest.ts regionFenceTrust over a region streamed from its segments: the same line walk, carried across segment edges. */
async function streamedFenceTrust(stream: AsyncIterable<Uint8Array>): Promise<'trusted' | 'void'> {
  const walk: FenceWalk = { opener: null, mispaired: false };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let carry = '';
  const step = (line: string) => { for (const part of line.split('\r')) stepFenceWalk(walk, part); };
  for await (const bytes of stream) {
    const lines = (carry + decoder.decode(bytes, { stream: true })).split('\n');
    carry = lines.pop()!;
    for (const line of lines) step(line);
  }
  step(carry + decoder.decode());
  return walk.opener || walk.mispaired ? 'void' : 'trusted';
}

export async function prepareUntiledRevert(engine: BrainEngine, row: WriteRequest, stored: PageSnapshot): Promise<PreparedMutation | null> {
  if (stored.page.deleted_at || !isSegmentedPage(stored.page) || stored.page.id !== row.page_id) return null;
  const pageId = Number(stored.page.id);
  const live = await liveGenerationTiling(engine, pageId);
  if (!live || live.tiles) return null;
  const p = row.intent!;
  assertPageRevision(stored, engineMutationPrecondition(parseMutationPrecondition(p)));
  const [version] = await engine.executeRaw<PageVersion>('SELECT * FROM page_versions WHERE id=$1 AND page_id=$2', [p.version_id, pageId]);
  if (!version) throw pageRefusal('not_found', 'Version not found for this page.', row,
    `Version ${String(p.version_id)} is not in the history of page ${row.slug}, so nothing was reverted. List the page's versions (get_versions; CLI: gbrain history) and revert to one of them.`);
  const generation = Number(version.body_generation);
  if (version.body_storage !== 'segmented' || generation === live.generation) {
    throw pageRefusal('page_body_rows_unreadable', 'The version cannot repair the unreadable generation.', row,
      `Page ${row.slug}'s live generation ${live.generation} does not tile its ${live.bodyBytes}-byte body, and version ${version.id} ${version.body_storage === 'segmented'
        ? 'references that same generation' : 'is not stored in segments'}, so nothing was changed. Revert to an older segmented version (get_versions lists them).`);
  }
  if (coreMarked(stored.page.frontmatter) || coreMarked(version.frontmatter)) {
    throw pageBodySegmentedError(stored.page, 'revert_version repair of an always-loaded core page (its budget renders the whole body)');
  }
  if (row.worktree_id) throw pageBodySegmentedError(stored.page, 'revert_version repair of a page with a canonical file (sync or import the file instead)');
  const frontmatter: Record<string, unknown> = { ...(version.frontmatter ?? {}) };
  const storedTier = await storedPageTier(engine, row.source_id, row.slug);
  const trust = pageWriteTrust(row, frontmatter);
  const gateTrust = pageGateTrust(row, trust, storedTier);
  if (gateTrust?.tier === 'external_untrusted' && writeGateApplies(gateTrust.tier, (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG)) {
    throw pageBodySegmentedError(stored.page, 'revert_version repair (the write gate scans the whole body of an external_untrusted write)');
  }
  stampPageTrustMarker(row, frontmatter, trust, storedTier);
  // The version's generation must tile its recorded body_bytes before a byte of it is staged.
  const rows = await engine.readManifest(pageId, { generation });
  await assertGenerationTiles(engine, pageId, generation, rows);
  const title = version.title ?? stored.page.title;
  const type = (version.type ?? stored.page.type) as PageType;
  const tags = [...new Set(version.tags ?? stored.tags)].sort();
  const quarantined = isQuarantined(frontmatter);
  const [shape, policy, livePage, truthTrust, timelineTrust] = await Promise.all([splicePage(engine, pageId), readPageBodyPolicy(engine), segmentedLivePage(engine, pageId),
    streamedFenceTrust(generationRegion(engine, row.source_id, rows, 'truth')), streamedFenceTrust(generationRegion(engine, row.source_id, rows, 'timeline'))]);
  if (!shape || livePage.generation !== live.generation) return null;
  const prepared = await prepareSegmentedBody(engine, { sourceId: row.source_id, slug: row.slug, live: livePage, title, type, frontmatter: frontmatter as JsonObject, tags,
    truth: generationRegion(engine, row.source_id, rows, 'truth'), timeline: generationRegion(engine, row.source_id, rows, 'timeline'),
    hasTimeline: rows.some(r => r.region === 'timeline'), flags: { fence_trust: truthTrust, timeline_fence_trust: timelineTrust },
    declaredBytes: rows.reduce((n, r) => n + r.byteLen, 0),
    owner: { kind: 'edit', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: stored.revision },
    chunking: { quarantined, tier: shape.crTier, corpusGeneration: shape.corpusGeneration } });
  const abort = () => engine.setBodyStagingState(prepared.stagingId, 'aborted').catch(() => undefined);
  let applied: SegmentedApplied | null = null;
  try {
    return { observedRevision: stored.revision, noop: false, ...await pageDatabaseOnlyPublication(engine, row, undefined), ...(trust ? { trust } : {}),
      apply: async tx => {
        // The version records the unreadable generation as it is (O(1): a reference), before the flip retires it.
        await tx.createVersion(row.slug, { sourceId: row.source_id });
        applied = await applySegmentedBody(tx, { slug: row.slug, sourceId: row.source_id, pageId, prepared, promotion: false, retireMaxRows: policy.flipRetireMaxRows,
          meta: { title, type, frontmatter: frontmatter as JsonObject, page_kind: shape.pageKind as PageKind } });
        for (const tag of stored.tags) if (!tags.includes(tag)) await tx.removeTag(row.slug, tag, { sourceId: row.source_id });
        for (const tag of tags) if (!stored.tags.includes(tag)) await tx.addTag(row.slug, tag, { sourceId: row.source_id });
        const lowered = storedTier ? await recordAgentPageLowering(tx, row, { tier: storedTier, revision: stored.revision }) : null;
        if (applied.complete) await sealSegmentedPage(tx, pageId);
        return { ...remoteLinkHint(row), status: 'reverted', slug: row.slug, source_id: row.source_id, noop: false, chunks: prepared.rows.chunks,
          repaired: { unreadable_generation: live.generation, body_bytes: live.bodyBytes, covered_bytes: live.rows.reduce((n, r) => n + r.byteLen, 0),
            from_version: Number(version.id), body_bytes_now: prepared.body.body_bytes },
          searchable: quarantined ? false : applied.complete ? true : 'pending', ...(applied.complete ? {} : { projection: 'pending' }),
          ...(lowered ? { trust_lowered: lowered } : {}),
          ...await sizeStateField(tx, row.source_id, row.slug, { body_storage: 'segmented', body_bytes: prepared.body.body_bytes, frontmatter }) };
      },
      afterCommit: async target => {
        if (!applied) { await abort(); return; }
        if (!applied.complete) await buildSegmentedProjection(target, { sourceId: row.source_id, slug: row.slug }).catch(() => undefined);
        await segmentWriteScope(target, row.source_id).then(writes => writes(exec => exec.sweepSegments({ pageId }))).catch(() => undefined);
      } };
  } catch (error) {
    await abort();
    throw error;
  }
}
