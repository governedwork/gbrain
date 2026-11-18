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
// locator, so a brain with an empty disk still resolves its packs. The loader
// (load-active.ts) re-checks the heads before it reads the overlay for a pack
// GBrain does not bundle, at most once per pack stat-TTL and one check at a
// time, and the overlay reloads whenever the heads' generation changed. A
// brain on a bundled pack never queries the heads.
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from '../persistence/model.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { viewedEngine } from '../persistence/switches.ts';
import { parseSchemaPackManifest, SchemaPackManifestError, type SchemaPackManifest } from './manifest-v1.ts';
import { AliasCycleError, AliasDepthExceededError } from './closure.ts';
import { isBundledPackName } from './bundled.ts';
import { ExtendsChainTooDeepError, invalidatePackCache, resolveStatTtlMs, UnknownPackError } from './registry.ts';

/** The database a brain-resident pack lookup reads: an engine, or a transaction's. */
export type PackStore = Pick<SqlEngine, 'executeRaw'>;
/** A store a process binds: an engine, which says when it disconnects. */
type BindableStore = PackStore & Partial<Pick<BrainEngine, 'registerBeforeDisconnect'>>;

/** A stored pack: its manifest, or why this build cannot read it (a manifest it rejects, e.g. one a newer build wrote). */
type OverlayEntry = { source_id: string; manifest: SchemaPackManifest } | { source_id: string; unreadable: OperationError };

let overlay = new Map<string, OverlayEntry>();
let overlayGeneration: string | null = null;
let boundStore: PackStore | null = null;
/** Checks are keyed by the engine a store reads through (a write's bounded-reads view is a new object per write). */
let lastCheck: { key: object; at: number } | null = null;
let inFlight: { key: object; done: Promise<void> } | null = null;
/** Errors the store raised that are not about its shape (a lost connection, a cancel, a deadline): passed on as they are. */
const passedThrough = new WeakSet<object>();
/** The last check found the brain without the pack tables (its migrations have not run): no brain-resident packs. */
let storeAbsent = false;

const PACK_TABLES = ['schema_pack_heads', 'schema_pack_revisions'] as const;

/**
 * The brain's stored packs could not be read (`pack_store_unreadable`, retryable). A pack GBrain does not
 * bundle may live there, so resolution fails rather than answer "no pack": a write must not go ahead
 * without the vocabulary and typing of the pack the brain holds.
 */
function packStoreUnreadable(cause: unknown): OperationError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return opError('pack_store_unreadable', `The brain's stored schema packs could not be read (${reason}).`,
    'Retry the command. If it keeps failing, check the database connection and schema with `gbrain doctor --json`.');
}

/**
 * A failure reading the brain's stored packs: `pack_store_unreadable`, or a database error passed on unchanged so its
 * caller can classify it (retry a lost connection, release on a deadline). Never to be read as "no pack".
 */
export function isPackStoreFailure(err: unknown): boolean {
  return (err instanceof OperationError && err.code === 'pack_store_unreadable') || (typeof err === 'object' && err !== null && passedThrough.has(err));
}

/** A store error about the store's shape or contents (SQLSTATE class 42 or 22, or no code at all) reads as unreadable. */
function storeShapeError(err: unknown): boolean {
  const { code, name } = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; name?: unknown };
  if (typeof code === 'string') return /^(42|22)[0-9A-Z]{3}$/.test(code);
  return name !== 'AbortError';
}

/** Whether the last check found this brain without the brain-resident pack tables (apply-migrations creates them). */
export function brainResidentPackStoreAbsent(): boolean {
  return storeAbsent;
}

/** The brain-resident manifest for `name`, if the overlay holds one; throws `pack_store_unreadable` when this build cannot read it. */
export function brainResidentPack(name: string): SchemaPackManifest | null {
  const entry = overlay.get(name);
  if (!entry) return null;
  if ('unreadable' in entry) throw entry.unreadable;
  return entry.manifest;
}

/** The source that owns the brain-resident pack `name`, if the overlay holds one. */
export function brainResidentPackSource(name: string): string | null {
  return overlay.get(name)?.source_id ?? null;
}

/**
 * The heads' generation: a hash of every (name, head revision) pair. Each publish writes a fresh random
 * revision, so any head change changes it whatever order transactions commit in; a timestamp would not
 * (a transaction that began earlier but commits later leaves the newest updated_at unchanged).
 */
const HEADS_GENERATION_SQL = `SELECT COALESCE(md5(string_agg(name || '=' || revision::text, ',' ORDER BY name)), '') AS generation
  FROM schema_pack_heads`;

/**
 * Reload the overlay from the database when the heads changed since the last load. A brain without the pack
 * tables holds no brain-resident packs (a resolution that needs one says how to create them). A failure about the
 * store's shape throws `pack_store_unreadable`; any other database error (connection, cancel, deadline) is thrown
 * unchanged for its caller to classify. Either way the overlay and the last check stay as they were. A stored
 * manifest this build rejects marks only that pack unreadable.
 */
export async function refreshBrainResidentPacks(engine: PackStore): Promise<void> {
  let generation: string;
  let rows: Array<{ name: string; revision: string; source_id: string; manifest: unknown }> = [];
  try {
    const [row] = await engine.executeRaw<{ generation: string }>(HEADS_GENERATION_SQL);
    generation = row?.generation ?? '';
    if (generation === overlayGeneration && !storeAbsent) { lastCheck = { key: viewedEngine(engine), at: performance.now() }; return; }
    rows = await engine.executeRaw<{ name: string; revision: string; source_id: string; manifest: unknown }>(
      `SELECT h.name, h.revision::text AS revision, h.source_id, r.manifest
        FROM schema_pack_heads h JOIN schema_pack_revisions r ON r.revision = h.revision`);
    storeAbsent = false;
  } catch (err) {
    if (!isMissingSchemaObject(err, 'table', PACK_TABLES)) {
      if (storeShapeError(err)) throw packStoreUnreadable(err);
      if (typeof err === 'object' && err !== null) passedThrough.add(err);
      throw err;
    }
    generation = '';
    storeAbsent = true;
  }
  const next = new Map<string, OverlayEntry>();
  for (const row of rows) {
    try {
      const manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
      next.set(row.name, { source_id: row.source_id, manifest: parseSchemaPackManifest(manifest, { path: `brain:${row.name}` }) });
    } catch (err) {
      next.set(row.name, { source_id: row.source_id, unreadable: packStoreUnreadable(err) });
    }
  }
  const changed = new Set<string>([...overlay.keys(), ...next.keys()]);
  overlay = next;
  overlayGeneration = generation;
  for (const name of changed) invalidatePackCache(name);
  lastCheck = { key: viewedEngine(engine), at: performance.now() };
}

/**
 * The store a pack lookup reads when its caller passes none: the connected
 * brain (the CLI's connect, serve, the jobs worker). Binding runs no query.
 * Returns a function that restores the previous binding.
 */
export function bindBrainResidentPackStore(store: BindableStore | null): () => void {
  const previous = boundStore;
  boundStore = store;
  lastCheck = null;
  // An engine that disconnects stops being the store its process resolves packs from: a later engine (the next
  // brain a process opens, graduation's target) must not be read through a closed one.
  const unhook = store?.registerBeforeDisconnect?.(async () => { if (boundStore === store) { boundStore = null; lastCheck = null; } });
  return () => { unhook?.(); if (boundStore === store) { boundStore = previous; lastCheck = null; } };
}

/**
 * Re-check the heads of `store` (omitted: the bound store; null: none) unless that store was
 * checked within the pack stat-TTL (GBRAIN_PACK_STAT_TTL_MS, default 1s), the
 * window a file-backed pack edited by another process takes to show.
 * Concurrent lookups share one check. With no store, the overlay stands.
 */
export async function ensureBrainResidentPacksFresh(store?: PackStore | null): Promise<void> {
  const target = store === undefined ? boundStore : store;
  if (!target) return;
  const key = viewedEngine(target);
  if (lastCheck?.key === key && performance.now() - lastCheck.at < resolveStatTtlMs()) return;
  if (inFlight?.key === key) return inFlight.done;
  const done = refreshBrainResidentPacks(target).finally(() => { if (inFlight?.done === done) inFlight = null; });
  inFlight = { key, done };
  return done;
}

/** Errors that mean the submitted manifest (or its extends / borrow_from chain) is wrong, not that GBrain failed. */
function isManifestRejection(err: unknown): err is Error {
  return err instanceof SchemaPackManifestError || err instanceof UnknownPackError
    || err instanceof ExtendsChainTooDeepError || err instanceof AliasCycleError || err instanceof AliasDepthExceededError;
}

/** Test seam: forget the overlay, the last check and the bound store. */
export function _resetBrainResidentPacksForTests(): void {
  overlay = new Map();
  overlayGeneration = null;
  boundStore = null;
  lastCheck = null;
  inFlight = null;
  storeAbsent = false;
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
  if (storeAbsent) {
    throw opError('migrations_pending', `This brain has no tables for stored schema packs yet, so ${input.name} was not published.`,
      'Run `gbrain apply-migrations --yes` (it creates them), then publish again.', { reason: 'schema_behind' });
  }
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
