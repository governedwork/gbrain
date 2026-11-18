/**
 * Ours (governedwork fork, ledger L144): the owner prune of a page's version history, `prune_page_versions`.
 * A page rewritten in place keeps the removed text in its versions; this deletes chosen versions short of a page
 * purge and leaves the live page as it is. The op is `cliOnly` and refuses any caller but the trusted local CLI
 * before it gets here.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';

/** What `prunePageVersions` removed (or, on a dry run, would remove). */
export interface PageVersionPrune {
  /** The versions pruned, newest first (on a dry run, the ones a real run would prune). */
  versionIds: number[];
  /** The versions the page keeps afterwards. */
  kept: number;
  /** Segment texts the pruned segmented versions alone held, deleted with them. */
  segmentTextsDeleted: number;
}

/**
 * Prunes the versions named by id, or all but the newest `keep` (newest by snapshot_at, then id, as get_versions
 * lists them). An id that is not one of the page's versions refuses the whole prune. Runs under the page's key
 * lock, so no write versions the page meanwhile. Each pruned knowledge revision is recorded in page_version_prunes
 * (identifiers only), so the belief ledger's preimage scan reads its missing version as pruned, not as a gap. A
 * pruned segmented version releases the manifest rows only it referenced; the page-scoped sweep deletes them and,
 * without the usual grace window, the segment texts nothing else references (live stagings still protect theirs),
 * so the pruned text leaves page_segment_texts too. On a managed brain that sweep runs as a coordinated write of
 * the page's source, as the writer guard requires. Returns null when the page does not exist.
 */
export async function prunePageVersions(engine: BrainEngine, slug: string, sourceId: string,
  target: { versionIds: readonly number[] } | { keep: number }, dryRun: boolean): Promise<PageVersionPrune | null> {
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const [page] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
    if (!page) return null;
    const pageId = Number(page.id);
    const all = (await tx.executeRaw<{ id: number }>('SELECT id FROM page_versions WHERE page_id = $1 ORDER BY snapshot_at DESC, id DESC', [pageId]))
      .map(r => Number(r.id));
    let versionIds: number[];
    if ('keep' in target) versionIds = all.slice(target.keep);
    else {
      const named = new Set(target.versionIds);
      const missing = [...named].filter(id => !all.includes(id));
      if (missing.length) {
        throw opError('not_found', `Page ${slug} (source ${sourceId}) has no version ${missing.join(', ')}; nothing was pruned.`,
          `List the page's versions with gbrain history ${slug} --source ${sourceId} and pass ids from it.`);
      }
      versionIds = all.filter(id => named.has(id));
    }
    if (dryRun || !versionIds.length) return { versionIds, kept: all.length - (dryRun ? 0 : versionIds.length), segmentTextsDeleted: 0 };
    const deleted = await tx.executeRaw<{ revision: string | null; segmented: boolean }>(`DELETE FROM page_versions WHERE page_id = $1 AND id = ANY($2::int[])
      RETURNING knowledge_revision::text AS revision, body_storage = 'segmented' AS segmented`, [pageId, versionIds]);
    const revisions = [...new Set(deleted.map(r => r.revision).filter((r): r is string => !!r))];
    if (revisions.length) {
      await tx.executeRaw(`INSERT INTO page_version_prunes (page_id, knowledge_revision) SELECT $1, r FROM unnest($2::uuid[]) AS r
        ON CONFLICT (page_id, knowledge_revision) DO UPDATE SET pruned_at = now()`, [pageId, revisions]);
    }
    let segmentTextsDeleted = 0;
    if (deleted.some(r => r.segmented)) {
      const sweep = () => tx.sweepSegments({ pageId, graceMs: 0 });
      const swept = await readManagedMode(tx) ? await withCoordinatedWrite(tx, [sourceId], sweep, await maintenanceAttribution(tx)) : await sweep();
      segmentTextsDeleted = swept.textsDeleted;
    }
    return { versionIds, kept: all.length - deleted.length, segmentTextsDeleted };
  });
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The `prune_page_versions` handler body: validates the target and the confirmation, then prunes. */
export async function runPrunePageVersions(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const slug = typeof p.slug === 'string' ? p.slug.trim() : '';
  if (!slug) throw opError('invalid_params', 'prune_page_versions needs a slug.', 'Pass the slug of the page whose history to prune.');
  const sourceId = typeof p.source_id === 'string' && p.source_id ? p.source_id : ctx.sourceId ?? 'default';
  const ids = p.version_ids;
  if ((ids === undefined) === (p.keep === undefined)) {
    throw opError('invalid_params', 'prune_page_versions needs exactly one of version_ids or keep; nothing was pruned.',
      `Pass version_ids (ids from gbrain history ${slug}) or keep (how many of the newest versions to keep).`);
  }
  if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => isCount(id) && id > 0))) {
    throw opError('invalid_params', 'version_ids must be a non-empty list of version ids; nothing was pruned.', `Pass ids from gbrain history ${slug}.`);
  }
  if (p.keep !== undefined && !isCount(p.keep)) {
    throw opError('invalid_params', 'keep must be a whole number of versions, 0 or more; nothing was pruned.', 'Pass keep: 0 to prune the whole history, or the number of newest versions to keep.');
  }
  const dryRun = ctx.dryRun === true || p.dry_run === true || (p.dry_run === undefined && p.yes !== true);
  if (!dryRun && p.yes !== true) {
    throw opError('invalid_params', 'Pruning versions deletes them for good, so it needs yes: true; nothing was pruned.',
      'Run it as a dry run first to see the version ids, then again with yes: true.');
  }
  const target = ids !== undefined ? { versionIds: ids as number[] } : { keep: p.keep as number };
  const result = await prunePageVersions(ctx.engine, slug, sourceId, target, dryRun);
  if (!result) throw opError('not_found', `No page ${slug} in source ${sourceId}; nothing was pruned.`, 'Check the slug and --source.');
  const n = result.versionIds.length;
  return {
    slug, source_id: sourceId, dry_run: dryRun, pruned: dryRun ? 0 : n, version_ids: result.versionIds, kept: result.kept,
    ...(dryRun ? { would_prune: n } : { segment_texts_removed: result.segmentTextsDeleted }),
    next: dryRun
      ? (n ? `Would prune ${n} version(s); run again with yes: true (gbrain history prune ... --yes) to delete them.` : 'Nothing to prune.')
      : `Pruned ${n} version(s) of ${slug}; ${result.kept} remain. The live page is unchanged; pruned versions cannot be restored.`,
  };
}
