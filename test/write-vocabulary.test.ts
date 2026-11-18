/**
 * #4655 write-time pack vocabulary helpers — the edges the capture / add_link
 * negative-regression tests do not reach:
 *   - loader: a rejecting engine.getConfig never throws (returns null
 *     without selecting a fallback pack); an unresolvable pack name → null, so
 *     the write proceeds (enforcement only where a vocabulary exists).
 *   - previewNames bound (via the suggestion builders): 0 names →
 *     'none declared'; 15 names → the first 12 plus a '(15 total)' tail.
 *   - add_link dry-run previews the rejection — the vocabulary check runs
 *     BEFORE the dry-run return, and a declared / omitted verb still previews.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  loadActivePackForWriteVocabulary,
  packDeclaresLinkType,
  packDeclaresPageType,
  undeclaredLinkTypeSuggestion,
  undeclaredPageTypeSuggestion,
} from '../src/core/schema-pack/write-vocabulary.ts';
import type { ResolvedPack } from '../src/core/schema-pack/registry.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

function fakePack(pageTypes: string[], linkTypes: string[] = []): ResolvedPack {
  return {
    manifest: {
      name: 'fake-pack',
      page_types: pageTypes.map((name) => ({ name })),
      link_types: linkTypes.map((name) => ({ name })),
    },
    identity: 'fake-pack@0.0.0+00000000',
    manifest_sha8: '00000000',
    alias_closure_hash: '0',
    alias_graph: {},
  } as unknown as ResolvedPack;
}

describe('loadActivePackForWriteVocabulary (best-effort loader)', () => {
  test('a rejecting engine.getConfig never throws — no fallback vocabulary is enforced', async () => {
    const engine = { getConfig: async () => { throw new Error('connection lost'); } };
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base' }, async () => {
      const pack = await loadActivePackForWriteVocabulary({ engine, remote: true });
      expect(pack).toBeNull();
    });
  });

  test('an unresolvable pack name → null (no vocabulary to enforce; the write proceeds)', async () => {
    const engine = { getConfig: async () => 'definitely-not-a-real-pack-name' };
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const pack = await loadActivePackForWriteVocabulary({ engine, remote: true });
      expect(pack).toBeNull();
    });
  });

  test('env-tier garbage → null too (loader is never a new way for writes to fail)', async () => {
    const engine = { getConfig: async () => null };
    await withEnv({ GBRAIN_SCHEMA_PACK: 'nope-not-a-pack' }, async () => {
      expect(await loadActivePackForWriteVocabulary({ engine, remote: false })).toBeNull();
    });
  });
});

// Ours (governedwork fork): a brain-resident active pack whose store cannot be read must fail the write
// visibly, not let it through with no vocabulary. The upstream contract above stays: a getConfig failure or an
// unknown pack name still answers null.
describe('L103: a brain-resident active pack whose store cannot be read', () => {
  let engine: import('../src/core/pglite-engine.ts').PGLiteEngine;
  let home: string;

  beforeAll(async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { operationsByName } = await import('../src/core/operations.ts');
    const { SCHEMA_PACK_API_VERSION } = await import('../src/core/schema-pack/manifest-v1.ts');
    home = mkdtempSync(join(tmpdir(), 'gbrain-l103-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await resetOverlay();
    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    await operationsByName.put_schema_pack!.handler(ctx, { name: 'acme-pack', expected_revision: null, manifest: {
      api_version: SCHEMA_PACK_API_VERSION, name: 'acme-pack', version: '0.1.0', description: '', gbrain_min_version: '0.38.0',
      extends: 'gbrain-base', borrow_from: [],
      page_types: [{ name: 'client', primitive: 'entity', path_prefixes: ['clients/'], aliases: [], extractable: false, expert_routing: false }],
      link_types: [], frontmatter_links: [], takes_kinds: ['fact', 'take', 'bet', 'hunch'], enrichable_types: [], filing_rules: [],
    } });
    await engine.setConfig('schema_pack', 'acme-pack');
  }, 60000);

  afterAll(async () => {
    await resetOverlay();
    await engine.disconnect();
    (await import('node:fs')).rmSync(home, { recursive: true, force: true });
  });

  // Each test starts as a fresh process: nothing loaded yet.
  beforeEach(async () => { await resetOverlay(); });

  async function resetOverlay(): Promise<void> {
    (await import('../src/core/schema-pack/db-store.ts'))._resetBrainResidentPacksForTests();
    (await import('../src/core/schema-pack/registry.ts'))._resetPackCacheForTests();
  }

  async function failureCode(promise: Promise<unknown>): Promise<string> {
    try { await promise; } catch (err) { return String((err as { code?: unknown }).code ?? (err as Error).message); }
    return 'resolved';
  }

  test('L103: the write-vocabulary loader rejects with pack_store_unreadable instead of answering null', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // Control: with a readable store the pack resolves and carries its vocabulary.
      const healthy = await loadActivePackForWriteVocabulary({ engine, remote: false });
      expect(healthy?.manifest.name).toBe('acme-pack');
      await resetOverlay();

      // Every read of the pack store fails (connection reset, revoked grant, ...); config still reads.
      const broken = {
        getConfig: (key: string) => engine.getConfig(key),
        executeRaw: (sql: string, params?: unknown[]) => /schema_pack_(heads|revisions)/.test(sql)
          ? Promise.reject(new Error('connection reset by peer'))
          : engine.executeRaw(sql, params),
      } as unknown as BrainEngine;
      expect(await failureCode(loadActivePackForWriteVocabulary({ engine: broken, remote: false }))).toBe('pack_store_unreadable');
    });
  });

  test('L103: add_link is refused with pack_store_unreadable, not previewed with no vocabulary enforced', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const addLink = operations.find((o) => o.name === 'add_link')!;
      const ctx = { engine, config: { engine: 'pglite' } as any, logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: true, remote: false, sourceId: 'default' } as OperationContext;
      const params = { from: 'people/alice-example', to: 'orgs/acme-example', link_type: 'definitely_not_a_link_verb' };
      // Control: with a readable store the active brain-resident pack refuses the undeclared verb.
      await expect(addLink.handler(ctx, params)).rejects.toThrow(/not declared in active schema pack 'acme-pack'/);
      await resetOverlay();

      // The store is present but unreadable (a column the overlay reads is gone): not "no pack".
      await engine.executeRaw('ALTER TABLE schema_pack_heads RENAME COLUMN revision TO revision_moved');
      try {
        expect(await failureCode(addLink.handler(ctx, params) as Promise<unknown>)).toBe('pack_store_unreadable');
      } finally {
        await engine.executeRaw('ALTER TABLE schema_pack_heads RENAME COLUMN revision_moved TO revision');
      }
    });
  });

  test('L103: a stored manifest this build cannot read fails that pack pack_store_unreadable, and the other packs still load', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const { operationsByName } = await import('../src/core/operations.ts');
      const { SCHEMA_PACK_API_VERSION } = await import('../src/core/schema-pack/manifest-v1.ts');
      const { loadResolvedPackByName } = await import('../src/core/schema-pack/load-active.ts');
      const { randomUUID } = await import('node:crypto');
      const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
      const [existing] = await engine.executeRaw<{ revision: string }>("SELECT revision::text AS revision FROM schema_pack_heads WHERE name = 'other-pack'");
      if (!existing) {
        await operationsByName.put_schema_pack!.handler(ctx, { name: 'other-pack', expected_revision: null, manifest: {
          api_version: SCHEMA_PACK_API_VERSION, name: 'other-pack', version: '0.1.0', description: '', gbrain_min_version: '0.38.0',
          extends: 'gbrain-base', borrow_from: [], page_types: [], link_types: [], frontmatter_links: [],
          takes_kinds: ['fact', 'take', 'bet', 'hunch'], enrichable_types: [], filing_rules: [],
        } });
      }
      await resetOverlay();
      // A build this one cannot read (a newer one, before a rollback) published acme-pack's current head.
      const [head] = await engine.executeRaw<{ revision: string }>("SELECT revision::text AS revision FROM schema_pack_heads WHERE name = 'acme-pack'");
      const unreadable = randomUUID();
      await engine.executeRaw(`INSERT INTO schema_pack_revisions (revision, name, source_id, manifest, manifest_hash, parent_revision, published_by)
        VALUES ($1::uuid, 'acme-pack', 'default', $2::text::jsonb, 'x', $3::uuid, 'test')`,
        [unreadable, JSON.stringify({ api_version: SCHEMA_PACK_API_VERSION, name: 'acme-pack', page_types: 'not a list' }), head!.revision]);
      await engine.executeRaw("UPDATE schema_pack_heads SET revision = $1::uuid WHERE name = 'acme-pack'", [unreadable]);
      try {
        expect(await failureCode(loadActivePackForWriteVocabulary({ engine, remote: false }))).toBe('pack_store_unreadable');
        expect((await loadResolvedPackByName('other-pack', engine)).manifest.name).toBe('other-pack');
      } finally {
        await engine.executeRaw("UPDATE schema_pack_heads SET revision = $1::uuid WHERE name = 'acme-pack'", [head!.revision]);
        await engine.executeRaw('DELETE FROM schema_pack_revisions WHERE revision = $1::uuid', [unreadable]);
      }
    });
  });

  test('L103: a database error the caller retries (a lost connection) reaches it unchanged, never as "no pack"', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const lost = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      const flaky = {
        getConfig: (key: string) => engine.getConfig(key),
        executeRaw: (sql: string, params?: unknown[]) => /schema_pack_(heads|revisions)/.test(sql) ? Promise.reject(lost) : engine.executeRaw(sql, params),
      } as unknown as BrainEngine;
      let thrown: unknown = 'resolved';
      try { await loadActivePackForWriteVocabulary({ engine: flaky, remote: false }); } catch (err) { thrown = err; }
      expect(thrown).toBe(lost);
    });
  });

  test('L103: no pack load is swallowed into "no pack" by a catch that does not re-raise a pack-store failure', async () => {
    const ts = (await import('typescript')).default;
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(dir, e.name));
      }
    };
    walk(join(root, 'src'));
    // test-reads-source-ok[structural]: a swallowed pack-store failure has no output of its own to assert on at every call site.
    const LOAD = /^(?:loadActivePack\w*|loadResolvedPackByName|loadDeclaredPackByName|engineSchemaInput|resolveLoadedPack|primeBrainResidentPack|refreshBrainResidentPacks|ensureBrainResidentPacksFresh)$/;
    const has = (node: import('typescript').Node, hit: (n: import('typescript').Node) => boolean): boolean => {
      if (hit(node)) return true;
      return ts.forEachChild(node, (child) => (has(child, hit) ? true : undefined)) === true;
    };
    const loads = (node: import('typescript').Node) => has(node, (n) => ts.isCallExpression(n)
      && LOAD.test(ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ''));
    // A catch keeps the failure when it throws, re-raises through isPackStoreFailure, or names its reviewed reason.
    const keeps = (node: import('typescript').Node) => node.getText().includes('pack-store-failure-ok:')
      || has(node, (n) => ts.isThrowStatement(n) || (ts.isIdentifier(n) && n.text === 'isPackStoreFailure'));
    const offenders: string[] = [];
    for (const file of files) {
      const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const at = (n: import('typescript').Node) => `${relative(root, file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      const visit = (n: import('typescript').Node): void => {
        if (ts.isTryStatement(n) && n.catchClause && loads(n.tryBlock) && !keeps(n.catchClause.block)) offenders.push(at(n));
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch'
          && loads(n.expression.expression) && n.arguments[0] && !keeps(n.arguments[0])) offenders.push(at(n));
        ts.forEachChild(n, visit);
      };
      visit(src);
    }
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});

describe('membership helpers', () => {
  test('packDeclaresPageType / packDeclaresLinkType are exact-name checks', () => {
    const pack = fakePack(['note', 'meeting'], ['works_at']);
    expect(packDeclaresPageType(pack, 'meeting')).toBe(true);
    expect(packDeclaresPageType(pack, 'Meeting')).toBe(false);
    expect(packDeclaresPageType(pack, 'works_at')).toBe(false);
    expect(packDeclaresLinkType(pack, 'works_at')).toBe(true);
    expect(packDeclaresLinkType(pack, 'note')).toBe(false);
  });
});

describe('previewNames bound (via the suggestion builders)', () => {
  test('0 declared names → "(none declared)"', () => {
    expect(undeclaredPageTypeSuggestion(fakePack([]))).toContain('(none declared)');
    expect(undeclaredLinkTypeSuggestion(fakePack([]))).toContain('(none declared)');
  });

  test('15 names → the first 12 (sorted) plus a "(15 total)" tail', () => {
    const names = Array.from({ length: 15 }, (_, i) => `type-${String(i).padStart(2, '0')}`);
    // Declared in reverse to prove the preview sorts before slicing.
    const s = undeclaredPageTypeSuggestion(fakePack([...names].reverse()));
    for (const n of names.slice(0, 12)) expect(s).toContain(n);
    for (const n of names.slice(12)) expect(s).not.toContain(n);
    expect(s).toContain('(15 total)');
  });

  test('12 or fewer names → every name shown, no total suffix', () => {
    const s = undeclaredLinkTypeSuggestion(fakePack([], ['b_verb', 'a_verb']));
    expect(s).toContain('(a_verb, b_verb)');
    expect(s).not.toContain('total');
  });
});

describe('add_link dry-run previews the vocabulary rejection', () => {
  const addLink = operations.find((o) => o.name === 'add_link')!;

  function ctx(): OperationContext {
    // dry_run short-circuits before any real engine call; only getConfig
    // (the pack pin) is consulted.
    const engine = { getConfig: async () => 'gbrain-base' } as unknown as BrainEngine;
    return {
      engine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: true,
      remote: true,
      sourceId: 'default',
    };
  }

  test('an undeclared explicit link_type is rejected BEFORE the dry-run return', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await expect(
        addLink.handler(ctx(), { from: 'people/alice-example', to: 'orgs/acme-example', link_type: 'definitely_not_a_link_verb' }),
      ).rejects.toThrow(/link type 'definitely_not_a_link_verb' is not declared in active schema pack 'gbrain-base'/);
    });
  });

  test('a declared link_type still reaches the dry-run preview', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const pack = await loadActivePackForWriteVocabulary({ engine: ctx().engine, remote: true });
      const declared = pack!.manifest.link_types[0]!.name;
      const result = await addLink.handler(ctx(), { from: 'people/alice-example', to: 'orgs/acme-example', link_type: declared });
      expect(result).toMatchObject({ dry_run: true, action: 'add_link' });
    });
  });

  test('an omitted link_type is the untyped-edge default — never vocabulary-checked', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await addLink.handler(ctx(), { from: 'people/alice-example', to: 'orgs/acme-example' });
      expect(result).toMatchObject({ dry_run: true, action: 'add_link' });
    });
  });
});
