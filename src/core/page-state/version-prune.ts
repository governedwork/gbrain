/**
 * Ours (governedwork fork, ledger L144): the owner prune of a page's version history, `prune_page_versions`.
 * A page rewritten in place keeps the removed text in its versions; this deletes chosen versions short of a page
 * purge and leaves the live page as it is. The op is `cliOnly` and refuses any caller but the trusted local CLI
 * before it gets here.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { enforceClientSlugFence } from '../ops/context.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { scanOverwrittenEdits } from '../persistence/overwritten-edits.ts';
import { markPrunedHistory } from './versions.ts';

/** A version a prune keeps because something open still needs it. */
export interface HeldVersion {
  id: number;
  /** `trust_proposal`: a pending lower_page proposal reverts to it; `overwritten_edit`: it is the only copy of a database edit a sync overwrote. */
  reason: 'trust_proposal' | 'overwritten_edit';
  /** The proposal (`tp<id>`) or the overwriting import request. */
  ref: string;
}

/** What `prunePageVersions` removed (or, on a dry run, would remove). */
export interface PageVersionPrune {
  /** The versions pruned, newest first (on a dry run, the ones a real run would prune). */
  versionIds: number[];
  /** Targeted versions kept because an open trust proposal or overwritten-edit restore still needs them. */
  held: HeldVersion[];
  /** The versions the page keeps afterwards (on a dry run, would keep). */
  kept: number;
  /** Manifest rows the pruned segmented versions alone held, released; their texts go in the regular sweep after its grace window. */
  segmentRowsReleased: number;
}

/**
 * The versions of the page something open still needs: the prior version a pending lower_page trust proposal reverts to
 * (trust/page-handlers.ts revertLoweredPage), and the archived version holding a database edit a managed sync
 * overwrote (persistence/overwritten-edits.ts: the edit survives only there; a restore reverts to it).
 */
async function heldVersions(tx: BrainEngine, pageId: number, slug: string, sourceId: string): Promise<Map<number, HeldVersion>> {
  const held = new Map<number, HeldVersion>();
  const proposals = await tx.executeRaw<{ id: number; version_id: number }>(`SELECT id, (before_state->>'version_id')::int AS version_id FROM trust_proposals
    WHERE status = 'pending' AND action = 'lower_page' AND target_table = 'pages' AND target_id = $1 AND before_state->>'version_id' ~ '^[0-9]+$'`, [pageId]);
  for (const p of proposals) held.set(Number(p.version_id), { id: Number(p.version_id), reason: 'trust_proposal', ref: `tp${p.id}` });
  for (const edit of (await scanOverwrittenEdits(tx, sourceId, { slugs: [slug] })).edits) {
    if (edit.page_id === pageId && !held.has(edit.version_id)) held.set(edit.version_id, { id: edit.version_id, reason: 'overwritten_edit', ref: edit.import_request_id });
  }
  return held;
}

/**
 * Prunes the versions named by id, or all but the newest `keep` (newest by snapshot_at, then id, as get_versions
 * lists them). An id that is not one of the page's versions refuses the whole prune; a targeted version an open trust
 * proposal or overwritten-edit restore still needs is kept and returned in `held`. Runs under the page's key lock, so
 * no write versions the page meanwhile. The prune is marked as upstream's retention marks its own (markPrunedHistory:
 * successor_pruned on the kept version before it, pages.version_history_gap_at), and each pruned knowledge revision is
 * recorded in page_version_prunes (identifiers only), because the belief ledger's preimage scan needs the revision itself
 * to read its missing version as pruned, not as a gap; upstream's marks name no revision. A pruned segmented
 * version releases the manifest rows only it referenced; the page-scoped sweep deletes them, and the segment texts
 * nothing else references then leave page_segment_texts in the regular sweep once the standard grace window passed (the
 * grace protects a text another write of the source just staged or deduped onto). On a managed brain that sweep runs as
 * a coordinated write of the page's source, as the writer guard requires. Returns null when the page does not exist.
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
    let targeted: number[];
    if ('keep' in target) targeted = all.slice(target.keep);
    else {
      const named = new Set(target.versionIds);
      const missing = [...named].filter(id => !all.includes(id));
      if (missing.length) {
        throw opError('not_found', `Page ${slug} (source ${sourceId}) has no version ${missing.join(', ')}; nothing was pruned.`,
          `List the page's versions with gbrain history ${slug} --source ${sourceId} and pass ids from it.`);
      }
      targeted = all.filter(id => named.has(id));
    }
    const holds = targeted.length ? await heldVersions(tx, pageId, slug, sourceId) : new Map<number, HeldVersion>();
    const held = targeted.filter(id => holds.has(id)).map(id => holds.get(id)!);
    const versionIds = targeted.filter(id => !holds.has(id));
    if (dryRun || !versionIds.length) return { versionIds, held, kept: all.length - versionIds.length, segmentRowsReleased: 0 };
    const deleted = await tx.executeRaw<{ id: number; revision: string | null; segmented: boolean }>(`DELETE FROM page_versions WHERE page_id = $1 AND id = ANY($2::int[])
      RETURNING id, knowledge_revision::text AS revision, body_storage = 'segmented' AS segmented`, [pageId, versionIds]);
    // Upstream's own record of pruned history, as its retention prunes write it: the kept version before each pruned one is
    // flagged successor_pruned and the page's version_history_gap_at is stamped, so history and valid-time reads say so.
    await markPrunedHistory(tx, pageId, deleted.map(r => Number(r.id)));
    const revisions = [...new Set(deleted.map(r => r.revision).filter((r): r is string => !!r))];
    if (revisions.length) {
      await tx.executeRaw(`INSERT INTO page_version_prunes (page_id, knowledge_revision) SELECT $1, r FROM unnest($2::uuid[]) AS r
        ON CONFLICT (page_id, knowledge_revision) DO UPDATE SET pruned_at = now()`, [pageId, revisions]);
    }
    let segmentRowsReleased = 0;
    if (deleted.some(r => r.segmented)) {
      // The standard grace window: a text another write of the source just staged or deduped onto keeps its insert grace.
      const sweep = () => tx.sweepSegments({ pageId });
      const swept = await readManagedMode(tx) ? await withCoordinatedWrite(tx, [sourceId], sweep, await maintenanceAttribution(tx)) : await sweep();
      segmentRowsReleased = swept.manifestRowsDeleted;
    }
    return { versionIds, held, kept: all.length - deleted.length, segmentRowsReleased };
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
  // The same write fence revert_version enforces: a registration bound to slug prefixes prunes only under them.
  enforceClientSlugFence(ctx, slug, 'prune_page_versions');
  const target = ids !== undefined ? { versionIds: ids as number[] } : { keep: p.keep as number };
  const result = await prunePageVersions(ctx.engine, slug, sourceId, target, dryRun);
  if (!result) throw opError('not_found', `No page ${slug} in source ${sourceId}; nothing was pruned.`, 'Check the slug and --source.');
  const n = result.versionIds.length;
  return {
    slug, source_id: sourceId, dry_run: dryRun, pruned: dryRun ? 0 : n, version_ids: result.versionIds, kept: result.kept, held: result.held,
    ...(dryRun ? { would_prune: n } : { segment_rows_released: result.segmentRowsReleased }),
    next: dryRun
      ? (n ? `Would prune ${n} version(s); run again with yes: true (gbrain history prune ... --yes) to delete them.` : 'Nothing to prune.')
      : `Pruned ${n} version(s) of ${slug}; ${result.kept} remain. The live page is unchanged; pruned versions cannot be restored.`,
  };
}
