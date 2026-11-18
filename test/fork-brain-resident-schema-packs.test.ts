// Ours (governedwork fork): brain-resident schema packs (src/core/schema-pack/db-store.ts).
//
// A pack published into the brain resolves with no file on disk, keeps every
// revision, refuses a stale write, is owned by one source, and rejects a bad
// manifest as the caller's error. A second process sees a new revision within
// the pack stat-TTL, and a brain on a bundled pack never reads the heads.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { SCHEMA_PACK_API_VERSION } from '../src/core/schema-pack/manifest-v1.ts';
import {
  _resetBrainResidentPacksForTests, bindBrainResidentPackStore, brainResidentPack, refreshBrainResidentPacks,
} from '../src/core/schema-pack/db-store.ts';
import { loadActivePack } from '../src/core/schema-pack/load-active.ts';
import { BRAIN_PACK_SCHEMA_SQL } from '../src/core/schema-pack/brain-pack-schema.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.generated.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.generated.ts';

let engine: PGLiteEngine;
let home: string;

describe('fresh-install schema', () => {
  test('both engine blobs carry the brain-resident pack DDL fragment verbatim', () => {
    const fragment = BRAIN_PACK_SCHEMA_SQL.trim();
    expect(fragment).toContain('CREATE TABLE IF NOT EXISTS schema_pack_revisions');
    expect(fragment).toContain('CREATE TABLE IF NOT EXISTS schema_pack_heads');
    expect(SCHEMA_SQL).toContain(fragment);
    expect(PGLITE_SCHEMA_SQL).toContain(fragment);
  });
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw('DELETE FROM schema_pack_heads');
  await engine.executeRaw('DELETE FROM schema_pack_revisions');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2) ON CONFLICT DO NOTHING', ['acme', 'globex']);
  _resetBrainResidentPacksForTests();
  _resetPackCacheForTests();
  home = mkdtempSync(join(tmpdir(), 'gbrain-brain-packs-'));
});

afterEach(() => {
  _resetBrainResidentPacksForTests();
  rmSync(home, { recursive: true, force: true });
});

function manifest(name: string, types: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: SCHEMA_PACK_API_VERSION, name, version: '0.1.0', description: '', gbrain_min_version: '0.38.0',
    extends: 'gbrain-base', borrow_from: [],
    page_types: types.map(t => ({ name: t, primitive: 'entity', path_prefixes: [`${t}s/`], aliases: [], extractable: false, expert_routing: false })),
    link_types: [], frontmatter_links: [], takes_kinds: ['fact', 'take', 'bet', 'hunch'], enrichable_types: [], filing_rules: [],
    ...over,
  };
}

/** Trusted local caller writing as `sourceId`, with no writer registered yet (as a fresh host CLI). */
function local(sourceId = 'acme'): OperationContext {
  return { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId } as unknown as OperationContext;
}

/** Remote caller bound to one source with read scope. */
function reader(sourceId: string): OperationContext {
  return { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId,
    auth: { clientId: `reader-${sourceId}`, scopes: ['read'], sourceId, principal: { kind: 'oauth_client', id: `reader-${sourceId}` } } } as unknown as OperationContext;
}

const put = (ctx: OperationContext, p: Record<string, unknown>) =>
  operationsByName.put_schema_pack!.handler(ctx, p) as Promise<{ revision: string; parent_revision: string | null }>;
const get = (ctx: OperationContext, p: Record<string, unknown>) =>
  operationsByName.get_schema_pack!.handler(ctx, p) as Promise<{ revision: string; manifest: { page_types: Array<{ name: string }> }; history: Array<{ revision: string }> }>;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (err) { if (err instanceof OperationError) return err.code; throw err; }
  return 'ok';
}

describe('brain-resident schema packs', () => {
  test('publish, revise, roll back by republishing; every revision stays readable', async () => {
    const r1 = await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
    expect(r1.parent_revision).toBeNull();
    const r2 = await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client', 'deal']), expected_revision: r1.revision });
    const r3 = await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: r2.revision, note: 'rollback to r1' });

    const head = await get(local(), { name: 'acme-pack' });
    expect(head.revision).toBe(r3.revision);
    expect(head.manifest.page_types.map(t => t.name)).toEqual(['client']);
    expect(head.history.map(h => h.revision)).toEqual([r1.revision, r2.revision, r3.revision]);
    const old = await get(local(), { name: 'acme-pack', revision: r2.revision });
    expect(old.manifest.page_types.map(t => t.name)).toEqual(['client', 'deal']);
  });

  test('a stale expected_revision is refused and writes nothing', async () => {
    const r1 = await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
    await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client', 'deal']), expected_revision: r1.revision });
    expect(await codeOf(put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['x']), expected_revision: r1.revision }))).toBe('revision_conflict');
    expect(await codeOf(put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['x']), expected_revision: null }))).toBe('revision_conflict');
    expect((await get(local(), { name: 'acme-pack' })).history).toHaveLength(2);
  });

  test('a bad manifest or a missing parent is invalid_params and writes nothing', async () => {
    expect(await codeOf(put(local(), { name: 'acme-pack', manifest: { ...manifest('acme-pack', ['client']), api_version: 'nope' }, expected_revision: null }))).toBe('invalid_params');
    expect(await codeOf(put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client'], { extends: 'no-such-pack' }), expected_revision: null }))).toBe('invalid_params');
    expect(await codeOf(put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client'], { borrow_from: [{ pack: 'no-such-pack', types: ['x'] }] }), expected_revision: null }))).toBe('invalid_params');
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM schema_pack_revisions');
    expect(n).toBe(0);
  });

  test('a bundled pack name cannot be replaced', async () => {
    expect(await codeOf(put(local(), { name: 'gbrain-base', manifest: manifest('gbrain-base', ['client'], { extends: null }), expected_revision: null }))).toBe('invalid_params');
  });

  test('a pack belongs to the source that published it', async () => {
    const r1 = await put(local('acme'), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
    expect(await codeOf(put(local('globex'), { name: 'acme-pack', manifest: manifest('acme-pack', ['x']), expected_revision: r1.revision }))).toBe('permission_denied');
    expect((await get(reader('acme'), { name: 'acme-pack' })).revision).toBe(r1.revision);
    expect(await codeOf(get(reader('globex'), { name: 'acme-pack' }))).not.toBe('ok');
  });

  test('a remote caller cannot publish into a source outside its grant', async () => {
    const ctx = { ...reader('globex'), auth: { clientId: 'pub', scopes: ['admin', 'skill_publisher'], sourceId: 'globex', allowedOperations: ['put_schema_pack'], principal: { kind: 'oauth_client', id: 'pub' } } } as unknown as OperationContext;
    expect(await codeOf(put(ctx, { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null, source_id: 'acme' }))).toBe('permission_denied');
    const noGrant = { ...ctx, auth: { ...(ctx.auth as object), allowedOperations: [] } } as unknown as OperationContext;
    expect(await codeOf(put(noGrant, { name: 'globex-pack', manifest: manifest('globex-pack', ['client']), expected_revision: null }))).not.toBe('ok');
  });

  test('the per-source active pack resolves from the database with no file on disk', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
      await engine.setConfig('schema_pack.source.acme', 'acme-pack');
      const acme = await operationsByName.get_active_schema_pack!.handler(reader('acme'), {}) as { pack_name: string; page_types_count: number };
      expect(acme.pack_name).toBe('acme-pack');
      const globex = await operationsByName.get_active_schema_pack!.handler(reader('globex'), {}) as { pack_name: string };
      expect(globex.pack_name).not.toBe('acme-pack');
    });
  });

  // 0.60.737: the overlay load rides upstream's engineSchemaInput (#7942's per-source resolution), the one input every
  // engine-bound resolution builds (get_active_schema_pack, schema_graph, schema_lint, page writes).
  test('an engine-bound resolution loads the overlay when a tier names an unbundled pack, and only then', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'schema_pack%'`);
      await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
      const { loadActivePackForEngine } = await import('../src/core/schema-pack/engine-resolution.ts');
      const overlayReads: string[] = [];
      const counting = {
        getConfig: (key: string) => engine.getConfig(key),
        executeRaw: (sql: string, params?: unknown[]) => {
          if (/schema_pack_heads/.test(sql)) overlayReads.push(sql);
          return engine.executeRaw(sql, params);
        },
      } as unknown as PGLiteEngine;
      // A fresh process on the bundled default pays no overlay query.
      _resetBrainResidentPacksForTests();
      _resetPackCacheForTests();
      expect((await loadActivePackForEngine(counting, { remote: true, sourceId: 'acme' })).manifest.name).not.toBe('acme-pack');
      expect(overlayReads).toEqual([]);
      // Named for the source: the same fresh process resolves it from the database.
      await engine.setConfig('schema_pack.source.acme', 'acme-pack');
      expect((await loadActivePackForEngine(counting, { remote: true, sourceId: 'acme' })).manifest.name).toBe('acme-pack');
      expect(overlayReads.length).toBeGreaterThan(0);
    });
  });

  test('schema_lint by name lints a brain-resident pack as declared, for callers that can read it', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await put(local(), { name: 'acme-area', expected_revision: null, manifest: manifest('acme-area', ['bet'], {
        link_types: [{ name: 'amends' }],
        frontmatter_links: [{ page_type: 'bet', fields: ['amends'], link_type: 'amends' }],
      }) });
      await put(local(), { name: 'acme-pack', expected_revision: null, manifest: manifest('acme-pack', [], {
        link_types: [{ name: 'amends' }], borrow_from: [{ pack: 'acme-area', types: ['bet'] }],
      }) });
      // A fresh process: the overlay is loaded from the database by the op itself.
      _resetBrainResidentPacksForTests();
      _resetPackCacheForTests();
      type Report = { error?: string; pack?: string; errors?: Array<{ rule: string }> };
      const lint = (ctx: OperationContext) => operationsByName.schema_lint!.handler(ctx, { pack: 'acme-pack' }) as Promise<Report>;
      const own = await lint(reader('acme'));
      expect(own.error).toBeUndefined();
      expect(own.errors!.map(e => e.rule)).toEqual(['borrow_drops_frontmatter_links']);
      // Another source's pack answers exactly like a missing one.
      expect(await lint(reader('globex'))).toEqual({ error: 'pack_not_found', pack: 'acme-pack' });
      expect(await operationsByName.schema_lint!.handler(reader('acme'), { pack: 'no-such-pack' })).toEqual({ error: 'pack_not_found', pack: 'no-such-pack' });
    });
  });

  // acme's pack carries content only acme may read. Packs a globex caller CAN read reach it
  // through borrow_from or extends; resolving them for the lint must not hand acme's types,
  // fields or links to that caller.
  async function seedCrossSourceChain(): Promise<void> {
    const secretLink = { link_types: [{ name: 'amends' }], frontmatter_links: [{ page_type: 'secretdeal', fields: ['secret_field'], link_type: 'amends' }] };
    await put(local('acme'), { name: 'acme-secret', expected_revision: null, manifest: manifest('acme-secret', ['secretdeal'], secretLink) });
    await put(local('globex'), { name: 'globex-borrows', expected_revision: null, manifest: manifest('globex-borrows', [], {
      link_types: [{ name: 'amends' }], borrow_from: [{ pack: 'acme-secret', types: ['secretdeal'] }],
    }) });
    await put(local('globex'), { name: 'globex-extends', expected_revision: null, manifest: manifest('globex-extends', [], { extends: 'acme-secret' }) });
    const dir = join(home, '.gbrain', 'schema-packs', 'disk-borrows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(manifest('disk-borrows', [], {
      link_types: [{ name: 'amends' }], borrow_from: [{ pack: 'acme-secret', types: ['secretdeal'] }],
    })));
    _resetBrainResidentPacksForTests();
    _resetPackCacheForTests();
  }

  type LintAnswer = { error?: string; pack?: string; errors?: Array<{ rule: string; message: string }>; warnings?: Array<{ rule: string }> };
  const lintAs = (ctx: OperationContext, p: Record<string, unknown>) => operationsByName.schema_lint!.handler(ctx, p) as Promise<LintAnswer>;
  const federated = { ...reader('globex'), auth: { ...(reader('globex').auth as object), allowedSources: ['acme', 'globex'] } } as unknown as OperationContext;

  test('schema_lint by name refuses a pack whose extends or borrow_from reaches a source the caller cannot read', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedCrossSourceChain();
      // Baseline: get_schema_pack shows globex its own manifest, never what acme-secret declares.
      expect(JSON.stringify(await get(reader('globex'), { name: 'globex-borrows' }))).not.toContain('secret_field');
      for (const name of ['globex-borrows', 'globex-extends', 'disk-borrows']) {
        expect(await lintAs(reader('globex'), { pack: name })).toEqual({ error: 'pack_not_found', pack: name });
      }
      // Control: a caller granted both sources lints the same pack and sees the dropped link.
      const both = await lintAs(federated, { pack: 'globex-borrows' });
      expect(both.errors!.map(e => e.rule)).toEqual(['borrow_drops_frontmatter_links']);
      expect(both.errors![0]!.message).toContain('secret_field');
    });
  });

  test('schema_lint of the active pack skips the borrow rules rather than read a source the caller cannot', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'disk-borrows' }, async () => {
      await seedCrossSourceChain();
      // The active pack's RESOLVED form is already every reader's: schema_graph hands it out
      // (it reads the overlay a serving process keeps loaded, so load it as serve does).
      await refreshBrainResidentPacks(engine);
      const graph = await operationsByName.schema_graph!.handler(reader('globex'), {}) as { nodes: Array<{ name: string }> };
      expect(graph.nodes.map(n => n.name)).toContain('secretdeal');
      // What acme-secret declares beyond that (the link borrow_from drops) stays acme's.
      const active = await lintAs(reader('globex'), {});
      expect(JSON.stringify(active)).not.toContain('secret_field');
      expect(active.warnings!.map(w => w.rule)).toContain('borrow_checks_skipped');
      // Control: a caller granted acme gets the borrow rules on the same active pack.
      const both = await lintAs(federated, {});
      expect(both.errors!.map(e => e.rule)).toEqual(['borrow_drops_frontmatter_links']);
    });
  });

  test('another process sees a new revision within the stat-TTL', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined, GBRAIN_PACK_STAT_TTL_MS: '500' }, async () => {
      const r1 = await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
      // A connected process: the store is bound at connect, and a resolution with no engine at hand reads it.
      bindBrainResidentPackStore(engine);
      const declares = async (type: string) => (await loadActivePack({ cfg: { schema_pack: 'acme-pack' } as never, remote: false }))
        .manifest.page_types.some(t => t.name === type);
      expect(await declares('client')).toBe(true);
      expect(await declares('retainer')).toBe(false);
      // Another process publishes r2 straight into the tables.
      await engine.executeRaw(`INSERT INTO schema_pack_revisions(revision,name,source_id,manifest,manifest_hash,parent_revision,published_by)
        VALUES('00000000-0000-4000-8000-000000000002','acme-pack','acme',$1::text::jsonb,'h',$2::uuid,'test')`,
      [JSON.stringify(manifest('acme-pack', ['client', 'retainer'])), r1.revision]);
      await engine.executeRaw(`UPDATE schema_pack_heads SET revision='00000000-0000-4000-8000-000000000002', updated_at=now() WHERE name='acme-pack'`);
      // Inside the stat-TTL the last check stands: no query per resolution.
      expect(await declares('retainer')).toBe(false);
      // Past it, the next resolution re-checks the heads and sees r2.
      await Bun.sleep(600);
      expect(await declares('retainer')).toBe(true);
    });
  });

  test('L101: a head revised by a transaction that commits after a faster one is still picked up', async () => {
    // acme-other first, acme-pack second: acme-pack's head carries the newest updated_at.
    const other1 = await put(local(), { name: 'acme-other', manifest: manifest('acme-other', ['client']), expected_revision: null });
    await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
    await refreshBrainResidentPacks(engine);
    expect(brainResidentPack('acme-other')?.page_types.map(t => t.name)).toEqual(['client']);
    const heads = async () => (await engine.executeRaw<{ max: string; n: number }>(
      'SELECT max(updated_at)::text AS max, count(*)::int AS n FROM schema_pack_heads'))[0];
    const before = await heads();

    // On Postgres a slower transaction revising acme-other began before acme-pack's and commits after it:
    // its updated_at (now() = its start) is older than the newest head, and the head count is unchanged.
    // PGLite cannot interleave two transactions, so build that committed end state directly.
    await engine.executeRaw(`INSERT INTO schema_pack_revisions(revision,name,source_id,manifest,manifest_hash,parent_revision,published_by)
      VALUES('00000000-0000-4000-8000-000000000003','acme-other','acme',$1::text::jsonb,'h',$2::uuid,'test')`,
    [JSON.stringify(manifest('acme-other', ['client', 'deal'])), other1.revision]);
    await engine.executeRaw(`UPDATE schema_pack_heads SET revision='00000000-0000-4000-8000-000000000003',
      updated_at=(SELECT updated_at FROM schema_pack_heads WHERE name='acme-pack') - interval '1 millisecond' WHERE name='acme-other'`);
    expect(await heads()).toEqual(before);

    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '50' }, async () => {
      await Bun.sleep(100);
      await refreshBrainResidentPacks(engine);
    });
    expect(brainResidentPack('acme-other')?.page_types.map(t => t.name)).toEqual(['client', 'deal']);
  });

  test('L100: a bundled active pack reads no brain-resident pack heads, even when a shadowed tier names an unbundled pack', async () => {
    const { loadActivePackForEngine } = await import('../src/core/schema-pack/engine-resolution.ts');
    await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
    _resetBrainResidentPacksForTests();
    _resetPackCacheForTests();
    const original = engine.executeRaw.bind(engine);
    const headReads: string[] = [];
    (engine as unknown as { executeRaw: (...args: unknown[]) => unknown }).executeRaw = (...args: unknown[]) => {
      if (/schema_pack_heads/.test(String(args[0]))) headReads.push(String(args[0]));
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      // The env tier (2) names the bundled base; the per-source (3) and brain-wide (4) keys name acme-pack but lose.
      await engine.setConfig('schema_pack', 'acme-pack');
      await engine.setConfig('schema_pack.source.acme', 'acme-pack');
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'gbrain-base' }, async () => {
        const pack = await loadActivePackForEngine(engine, { remote: false, sourceId: 'acme' });
        expect(pack.manifest.name).toBe('gbrain-base');
      });
      expect(headReads).toEqual([]);

      // A remote caller's per-call pack is dropped by the trust gate, so it is not what resolves either.
      await engine.executeRaw("DELETE FROM config WHERE key = 'schema_pack' OR key LIKE 'schema_pack.source.%'");
      headReads.length = 0;
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
        const pack = await loadActivePackForEngine(engine, { remote: true, perCall: 'acme-pack', sourceId: 'acme' });
        expect(pack.manifest.name).toBe('gbrain-base');
      });
      expect(headReads).toEqual([]);
    } finally {
      delete (engine as unknown as { executeRaw?: unknown }).executeRaw;
      await engine.executeRaw("DELETE FROM config WHERE key = 'schema_pack' OR key LIKE 'schema_pack.source.%'");
    }
  });

  test('L100: a bound engine that disconnects is no longer read: a later resolution misses the pack, not the store', async () => {
    const { UnknownPackError } = await import('../src/core/schema-pack/registry.ts');
    _resetBrainResidentPacksForTests();
    _resetPackCacheForTests();
    const other = new PGLiteEngine();
    await other.connect({});
    await other.initSchema();
    // The process binds the brain it opened (CLI connect, serve, the worker), then that engine closes.
    bindBrainResidentPackStore(other);
    await other.disconnect();
    let thrown: unknown = null;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      try { await loadActivePack({ cfg: null, remote: false, dbConfig: 'pack-nobody-published' }); } catch (err) { thrown = err; }
    });
    expect(thrown).toBeInstanceOf(UnknownPackError);
    _resetBrainResidentPacksForTests();
  });

  test('L100: an engine that cannot be read for stored packs reads none, never the process\'s bound store', async () => {
    const { loadActivePackForEngineOrNull } = await import('../src/core/schema-pack/engine-resolution.ts');
    _resetBrainResidentPacksForTests();
    _resetPackCacheForTests();
    let boundReads = 0;
    bindBrainResidentPackStore({ executeRaw: async () => { boundReads++; throw new Error('another brain'); }, registerBeforeDisconnect: () => () => {} } as never);
    const configOnly = { getConfig: async (key: string) => (key === 'schema_pack' ? 'pack-nobody-published' : null) } as never;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'pack-nobody-published' }, async () => {
      expect(await loadActivePackForEngineOrNull(configOnly, { remote: false })).toBeNull();
      // No engine at all reads none either.
      expect(await loadActivePackForEngineOrNull(null, { remote: false })).toBeNull();
    });
    expect(boundReads).toBe(0);
    _resetBrainResidentPacksForTests();
  });

  test('L100: a stand-in that cannot report its disconnect is never bound, so no later lookup reads it', async () => {
    const { UnknownPackError } = await import('../src/core/schema-pack/registry.ts');
    _resetBrainResidentPacksForTests();
    _resetPackCacheForTests();
    let reads = 0;
    bindBrainResidentPackStore({ executeRaw: async () => { reads++; throw new Error('a stand-in'); } } as never);
    let thrown: unknown = null;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      try { await loadActivePack({ cfg: null, remote: false, dbConfig: 'pack-nobody-published' }); } catch (err) { thrown = err; }
    });
    expect(thrown).toBeInstanceOf(UnknownPackError);
    expect(reads).toBe(0);
    _resetBrainResidentPacksForTests();
  });

  test('L100: binding the degraded engine (async methods that refuse while its brain is down) raises no unhandled rejection', async () => {
    _resetBrainResidentPacksForTests();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const restore = bindBrainResidentPackStore({
        executeRaw: async () => { throw new Error('brain unreachable'); },
        registerBeforeDisconnect: async () => { throw new Error('brain unreachable'); },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      restore();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    _resetBrainResidentPacksForTests();
  });

  test('L100: write preparations reading through their own view of one engine share its heads re-check within the stat-TTL', async () => {
    const { ensureBrainResidentPacksFresh } = await import('../src/core/schema-pack/db-store.ts');
    const { registerEngineView } = await import('../src/core/persistence/switches.ts');
    await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null }).catch(() => undefined);
    _resetBrainResidentPacksForTests();
    _resetPackCacheForTests();
    let headReads = 0;
    // Each write preparation reads through a new view of the engine (bounded-reads.ts), registered as viewing it.
    const view = () => registerEngineView(new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[]) => { if (/schema_pack_heads/.test(sql)) headReads++; return target.executeRaw(sql, params); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } }), engine);
    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '60000' }, async () => {
      await ensureBrainResidentPacksFresh(view());
      const afterFirst = headReads;
      expect(afterFirst).toBeGreaterThan(0);
      await ensureBrainResidentPacksFresh(view());
      expect(headReads).toBe(afterFirst);
    });
    _resetBrainResidentPacksForTests();
  });
});
