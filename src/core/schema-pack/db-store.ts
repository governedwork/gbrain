// Ours (governedwork fork), not upstream GBrain: brain-resident schema packs.
//
// A custom pack can live in the brain's database instead of
// ~/.gbrain/schema-packs/<name>/pack.json. Revisions are append-only full
// manifests (like shared_skill_revisions.files); a head row points at the
// current one. Rollback is a new revision carrying an older manifest, the
// same convention shared skills use. Which pack is active stays the native
// DB config key `schema_pack` (or `schema_pack.source.<id>`).
//
// The loader consults an in-process overlay of the heads before the disk
// locator, so a brain with an empty disk still resolves its packs. The overlay
// is refreshed from the database whenever the heads' generation changes.
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from '../persistence/model.ts';
import { opError } from '../ops/contract.ts';
import { parseSchemaPackManifest, SchemaPackManifestError, type SchemaPackManifest } from './manifest-v1.ts';
import { AliasCycleError, AliasDepthExceededError } from './closure.ts';
import { isBundledPackName } from './bundled.ts';
import { ExtendsChainTooDeepError, invalidatePackCache, resolveStatTtlMs, UnknownPackError } from './registry.ts';

const overlay = new Map<string, { revision: string; manifest: SchemaPackManifest }>();
let overlayGeneration: string | null = null;

/** The brain-resident manifest for `name`, if the overlay holds one. */
export function brainResidentPack(name: string): SchemaPackManifest | null {
  return overlay.get(name)?.manifest ?? null;
}

/** Reload the overlay from the database when the heads changed since the last load. */
export async function refreshBrainResidentPacks(engine: Pick<SqlEngine, 'executeRaw'>): Promise<void> {
  let generation: string;
  try {
    const [row] = await engine.executeRaw<{ generation: string }>(
      `SELECT COALESCE(max(updated_at)::text,'') || ':' || count(*) AS generation FROM schema_pack_heads`);
    generation = row?.generation ?? ':0';
  } catch { return; } // tables not migrated yet
  if (generation === overlayGeneration) return;
  const rows = await engine.executeRaw<{ name: string; revision: string; manifest: unknown }>(
    `SELECT h.name, h.revision::text AS revision, r.manifest
      FROM schema_pack_heads h JOIN schema_pack_revisions r ON r.revision = h.revision`);
  const changed = new Set<string>([...overlay.keys(), ...rows.map(r => r.name)]);
  overlay.clear();
  for (const row of rows) {
    const manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
    overlay.set(row.name, { revision: row.revision, manifest: parseSchemaPackManifest(manifest, { path: `brain:${row.name}` }) });
  }
  overlayGeneration = generation;
  for (const name of changed) invalidatePackCache(name);
}

let freshnessTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Long-running processes (serve, the jobs worker): re-check the heads every
 * pack stat-TTL (GBRAIN_PACK_STAT_TTL_MS, default 1s), the same window a
 * file-backed pack edited by another process takes to show. Paths that
 * resolve a pack without the engine read only the overlay, so without this a
 * revision published through another process would stay invisible to them.
 */
export function keepBrainResidentPacksFresh(engine: Pick<SqlEngine, 'executeRaw'>): () => void {
  if (freshnessTimer) clearInterval(freshnessTimer);
  const timer = setInterval(() => { refreshBrainResidentPacks(engine).catch(() => {}); }, Math.max(resolveStatTtlMs(), 100));
  timer.unref?.();
  freshnessTimer = timer;
  return () => { clearInterval(timer); if (freshnessTimer === timer) freshnessTimer = null; };
}

/** Errors that mean the submitted manifest (or its extends / borrow_from chain) is wrong, not that GBrain failed. */
function isManifestRejection(err: unknown): err is Error {
  return err instanceof SchemaPackManifestError || err instanceof UnknownPackError
    || err instanceof ExtendsChainTooDeepError || err instanceof AliasCycleError || err instanceof AliasDepthExceededError;
}

/** Test seam: forget the overlay and stop the freshness timer. */
export function _resetBrainResidentPacksForTests(): void {
  if (freshnessTimer) clearInterval(freshnessTimer);
  freshnessTimer = null;
  overlay.clear();
  overlayGeneration = null;
}

function manifestHash(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export interface PutBrainPackInput {
  name: string;
  /** The source that owns the pack; only callers granted it may read or change it. */
  source_id: string;
  manifest: Record<string, unknown>;
  expected_revision: string | null;
  note?: string;
  published_by: string;
}

/**
 * Publish a new revision of a brain-resident pack. Compare-and-swap on the
 * head: `expected_revision` must be the current head (null to create). The
 * manifest must parse and fully resolve (extends + borrow_from) before
 * anything is written; `resolve` is passed in to avoid an import cycle.
 */
export async function putBrainPack(engine: BrainEngine,
  input: PutBrainPackInput, resolve: (manifest: SchemaPackManifest) => Promise<unknown>): Promise<{ name: string; revision: string; parent_revision: string | null }> {
  if (isBundledPackName(input.name)) throw opError('invalid_params', `Pack ${input.name} is bundled with GBrain and cannot be replaced.`, 'Publish under a new name that extends it.');
  if (input.manifest.name !== input.name) throw opError('invalid_params', 'The manifest name must equal the pack name.', `Set manifest.name to ${input.name}.`);
  await refreshBrainResidentPacks(engine);
  try {
    await resolve(parseSchemaPackManifest(input.manifest, { path: `brain:${input.name}` }));
  } catch (err) {
    if (!isManifestRejection(err)) throw err;
    throw opError('invalid_params', `Pack ${input.name} was not published: ${err.message}`,
      'Fix the manifest (and any pack it extends or borrows from) and resubmit; nothing was written.');
  }
  const revision = randomUUID();
  await engine.transaction(async tx => {
    const [head] = await tx.executeRaw<{ revision: string; source_id: string }>('SELECT revision::text AS revision, source_id FROM schema_pack_heads WHERE name=$1 FOR UPDATE', [input.name]);
    if (head && head.source_id !== input.source_id) {
      throw opError('permission_denied', `Pack ${input.name} belongs to another source.`, 'Publish under a pack name your source owns.');
    }
    if ((head?.revision ?? null) !== input.expected_revision) {
      throw opError('revision_conflict', `Pack ${input.name} changed since revision ${input.expected_revision ?? 'null'}.`,
        `Read it again with get_schema_pack (head is ${head?.revision ?? 'absent'}), reapply the change and resubmit.`);
    }
    await tx.executeRaw(`INSERT INTO schema_pack_revisions(revision,name,source_id,manifest,manifest_hash,parent_revision,published_by,note)
      VALUES($1::uuid,$2,$3,$4::text::jsonb,$5,$6::uuid,$7,$8)`,
    [revision, input.name, input.source_id, JSON.stringify(input.manifest), manifestHash(input.manifest), head?.revision ?? null, input.published_by, input.note ?? null]);
    await tx.executeRaw(`INSERT INTO schema_pack_heads(name,revision,source_id) VALUES($1,$2::uuid,$3)
      ON CONFLICT(name) DO UPDATE SET revision=excluded.revision, updated_at=now()`, [input.name, revision, input.source_id]);
  });
  overlayGeneration = null;
  await refreshBrainResidentPacks(engine);
  return { name: input.name, revision, parent_revision: input.expected_revision };
}

/** `readable`: the sources the caller may read (null = trusted local caller, every source). */
export async function getBrainPack(engine: Pick<SqlEngine, 'executeRaw'>, name: string, revision: string | undefined, readable: string[] | null) {
  const history = await engine.executeRaw<{ revision: string; parent_revision: string | null; published_by: string; published_at: string; note: string | null; manifest_hash: string }>(
    `SELECT revision::text AS revision, parent_revision::text AS parent_revision, published_by, published_at::text AS published_at, note, manifest_hash
     FROM schema_pack_revisions WHERE name=$1 ORDER BY published_at, revision`, [name]);
  const [head] = await engine.executeRaw<{ revision: string; source_id: string }>('SELECT revision::text AS revision, source_id FROM schema_pack_heads WHERE name=$1', [name]);
  if (!head || (readable !== null && !readable.includes(head.source_id))) throw opError('not_found', `No brain-resident pack named ${name}.`, 'list_schema_packs shows the packs this brain can resolve.');
  const want = revision ?? head.revision;
  const [row] = await engine.executeRaw<{ manifest: unknown }>('SELECT manifest FROM schema_pack_revisions WHERE name=$1 AND revision=$2::uuid', [name, want]);
  if (!row) throw opError('not_found', `Pack ${name} has no revision ${want}.`, 'Pick a revision from history.');
  return { name, source_id: head.source_id, head: head.revision, revision: want, manifest: typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest, history };
}
