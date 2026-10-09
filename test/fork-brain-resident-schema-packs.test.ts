// Ours (governedwork fork): brain-resident schema packs (src/core/schema-pack/db-store.ts).
//
// A pack published into the brain resolves with no file on disk, keeps every
// revision, refuses a stale write, is owned by one source, and rejects a bad
// manifest as the caller's error. A second process sees a new revision within
// the pack stat-TTL.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  _resetBrainResidentPacksForTests, brainResidentPack, keepBrainResidentPacksFresh,
} from '../src/core/schema-pack/db-store.ts';

let engine: PGLiteEngine;
let home: string;

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
      type Report = { error?: string; errors?: Array<{ rule: string }> };
      const lint = (ctx: OperationContext) => operationsByName.schema_lint!.handler(ctx, { pack: 'acme-pack' }) as Promise<Report>;
      const own = await lint(reader('acme'));
      expect(own.error).toBeUndefined();
      expect(own.errors!.map(e => e.rule)).toEqual(['borrow_drops_frontmatter_links']);
      // Another source's pack answers exactly like a missing one.
      expect(await lint(reader('globex'))).toEqual({ error: 'pack_not_found', pack: 'acme-pack' });
      expect(await operationsByName.schema_lint!.handler(reader('acme'), { pack: 'no-such-pack' })).toEqual({ error: 'pack_not_found', pack: 'no-such-pack' });
    });
  });

  test('another process sees a new revision within the stat-TTL', async () => {
    const r1 = await put(local(), { name: 'acme-pack', manifest: manifest('acme-pack', ['client']), expected_revision: null });
    // Simulate a second process: its overlay was loaded at r1, then another
    // process publishes r2 straight into the tables.
    const publishElsewhere = async () => {
      await engine.executeRaw(`INSERT INTO schema_pack_revisions(revision,name,source_id,manifest,manifest_hash,parent_revision,published_by)
        VALUES('00000000-0000-4000-8000-000000000002','acme-pack','acme',$1::text::jsonb,'h',$2::uuid,'test')`,
      [JSON.stringify(manifest('acme-pack', ['client', 'deal'])), r1.revision]);
      await engine.executeRaw(`UPDATE schema_pack_heads SET revision='00000000-0000-4000-8000-000000000002', updated_at=now() + interval '1 second' WHERE name='acme-pack'`);
    };
    await publishElsewhere();
    await Bun.sleep(150);
    // Control: with no refresher the overlay still holds r1.
    expect(brainResidentPack('acme-pack')?.page_types.map(t => t.name)).toEqual(['client']);

    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '50' }, async () => {
      const stop = keepBrainResidentPacksFresh(engine);
      try {
        await Bun.sleep(300);
        expect(brainResidentPack('acme-pack')?.page_types.map(t => t.name)).toEqual(['client', 'deal']);
      } finally { stop(); }
    });
  });
});
