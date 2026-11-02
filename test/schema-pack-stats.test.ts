// v0.40.6.0 — stats.ts contract tests.
//
// Multi-source aware, soft-delete exclusion, dead-prefix detection,
// PGLite parity. Phase 3 of the schema cathedral v3 plan.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runStatsCore } from '../src/core/schema-pack/stats.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-stats-test-'));
});

function ctxOf(remote = false): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
  } as unknown as OperationContext;
}

async function ensureSource(id: string): Promise<void> {
  if (id === 'default') return;  // seeded by schema bootstrap
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedPage(slug: string, opts: { type?: string; sourceId?: string; sourcePath?: string | null; deleted?: boolean } = {}): Promise<void> {
  // pages.type is NOT NULL; use empty string for "untyped".
  // pages.title is NOT NULL.
  // pages.source_id FKs sources(id) — seed source first.
  const sourceId = opts.sourceId ?? 'default';
  await ensureSource(sourceId);
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, '', '', '', $6)`,
    [slug, sourceId, opts.sourcePath === undefined ? `${slug}.md` : opts.sourcePath, opts.type ?? '', slug, opts.deleted ? new Date() : null],
  );
}

function seedTinyPack(packName: string, types: Array<{ name: string; prefix: string }>): void {
  const dir = join(tmpDir, packName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  let body = `api_version: gbrain-schema-pack-v1\nname: ${packName}\nversion: 1.0.0\ndescription: ""\ngbrain_min_version: 0.38.0\nextends: null\nborrow_from: []\npage_types:\n`;
  for (const t of types) {
    body += `  - name: ${t.name}\n    primitive: entity\n    path_prefixes:\n      - ${JSON.stringify(t.prefix)}\n    aliases: []\n    extractable: false\n    expert_routing: false\n`;
  }
  body += `link_types: []\nfrontmatter_links: []\ntakes_kinds:\n  - fact\n  - take\n  - bet\n  - hunch\nenrichable_types: []\nfiling_rules: []\n`;
  writeFileSync(path, body, 'utf-8');
  __setPackLocatorForTests((name) => (name === packName ? path : null));
}

describe('runStatsCore — empty brain', () => {
  it('reports coverage:1.0 (vacuous truth)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(0);
      expect(result.aggregate.coverage).toBe(1.0);
      expect(result.per_source).toEqual([]);
    });
  });
});

describe('runStatsCore — single source', () => {
  it('counts typed + untyped pages and computes coverage', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person' });
      await seedPage('b', { type: 'person' });
      await seedPage('c', { type: 'company' });
      await seedPage('d');  // untyped
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(4);
      expect(result.aggregate.typed_pages).toBe(3);
      expect(result.aggregate.untyped_pages).toBe(1);
      expect(result.aggregate.coverage).toBe(0.75);
      expect(result.aggregate.by_type).toEqual([
        { type: 'person', count: 2 },
        { type: 'company', count: 1 },
      ]);
    });
  });

  it('excludes soft-deleted pages', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person' });
      await seedPage('b', { type: 'person', deleted: true });
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(1);
    });
  });

  it('respects sourceId scoping', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-a' });
      await seedPage('b', { type: 'person', sourceId: 'src-b' });
      const result = await runStatsCore(ctxOf(), { sourceId: 'src-a' });
      expect(result.aggregate.total_pages).toBe(1);
      expect(result.per_source.length).toBe(1);
      expect(result.per_source[0]!.source_id).toBe('src-a');
    });
  });
});

describe('runStatsCore — federated', () => {
  it('aggregates across sourceIds array', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-a' });
      await seedPage('b', { type: 'person', sourceId: 'src-b' });
      await seedPage('c', { type: 'person', sourceId: 'src-c' });
      const result = await runStatsCore(ctxOf(), { sourceIds: ['src-a', 'src-b'] });
      expect(result.aggregate.total_pages).toBe(2);
      expect(result.per_source.length).toBe(2);
      const sources = result.per_source.map((s) => s.source_id).sort();
      expect(sources).toEqual(['src-a', 'src-b']);
    });
  });

  it('per-source breakdown sorted alphabetically', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-zzz' });
      await seedPage('b', { type: 'person', sourceId: 'src-aaa' });
      const result = await runStatsCore(ctxOf());
      expect(result.per_source.map((s) => s.source_id)).toEqual(['src-aaa', 'src-zzz']);
    });
  });
});

describe('runStatsCore — dead-prefix detection', () => {
  it('flags pack-declared prefixes with zero matching pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'person', prefix: 'people/' },
        { name: 'company', prefix: 'companies/' },
      ]);
      await seedPage('people/alice', { type: 'person', sourcePath: 'people/alice.md' });
      // No companies/* pages → dead prefix.
      const result = await runStatsCore(ctxOf());
      expect(result.pack_identity).not.toBeNull();
      expect(result.dead_prefixes).toEqual([{ type: 'company', prefix: 'companies/' }]);
    });
  });

  it('no dead-prefix hints when every declared prefix has pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [{ name: 'person', prefix: 'people/' }]);
      await seedPage('people/alice', { type: 'person', sourcePath: 'people/alice.md' });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([]);
    });
  });

  it('matches declared prefixes by slug even when source_path is NULL (#2664)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [{ name: 'ops', prefix: 'ops/' }]);
      await seedPage('ops/tasks', { type: 'ops', sourcePath: null });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([]);
    });
  });

  // A prefix is live when GBrain's own type inference would match it: the
  // lower-cased '/' + path CONTAINS '/' + prefix (case-insensitive, anywhere
  // in the path, a leading '/' on the prefix allowed), not "slug starts with".
  it('a prefix nested under a project (projects/x/decisions/...) is live, not dead', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'decision', prefix: 'decisions/' },
        { name: 'bet', prefix: 'bets/' },
      ]);
      await seedPage('projects/x/decisions/0001-a', { sourcePath: 'projects/x/decisions/0001-a.md' });
      const result = await runStatsCore(ctxOf());
      // decisions/ is live (inference types the page), bets/ has no page.
      expect(result.dead_prefixes).toEqual([{ type: 'bet', prefix: 'bets/' }]);
    });
  });

  it('matches a prefix case-insensitively, as inference does', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'analysis', prefix: 'Wiki/Analysis/' },
        { name: 'concept', prefix: 'wiki/concepts/' },
      ]);
      await seedPage('wiki/analysis/q3', { sourcePath: 'wiki/analysis/q3.md' });
      await seedPage('WIKI/Concepts/Idea', { sourcePath: 'WIKI/Concepts/Idea.md' });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([]);
    });
  });

  it('a prefix with a leading slash matches a nested path, as inference does', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'decision', prefix: '/decisions/' },
        { name: 'deal', prefix: '/deals/' },
      ]);
      await seedPage('projects/x/decisions/0001-a', { sourcePath: 'projects/x/decisions/0001-a.md' });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([{ type: 'deal', prefix: '/deals/' }]);
    });
  });

  it("an underscore in a prefix is a literal character, not a LIKE wildcard", async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'snake', prefix: 'a_c/' },
        { name: 'under', prefix: 'x_y/' },
      ]);
      // 'abc/page' does NOT contain '/a_c/': inference would not type it, and
      // `_` must not stand in for 'b'.
      await seedPage('abc/page', { sourcePath: 'abc/page.md' });
      // A real underscore still matches.
      await seedPage('notes/x_y/page', { sourcePath: 'notes/x_y/page.md' });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([{ type: 'snake', prefix: 'a_c/' }]);
    });
  });

  it("a percent sign in a prefix is a literal character, not a LIKE wildcard", async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'pct', prefix: '100%/' },
        { name: 'lit', prefix: '5%/' },
      ]);
      // '1000/x' does NOT contain '/100%/': `%` must not match '0'.
      await seedPage('1000/x', { sourcePath: '1000/x.md' });
      // A real percent sign still matches.
      await seedPage('rates/5%/y', { sourcePath: 'rates/5%/y.md' });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([{ type: 'pct', prefix: '100%/' }]);
    });
  });

  it('agrees with inferTypeFromPack: a prefix is dead exactly when no page path infers its type', async () => {
    const slugs = [
      'projects/x/decisions/0001-a',
      'people/alice',
      'Wiki/Analysis/Q3',
      'abc/page',
      'rates/5%/y',
      'peoplex/bob',
    ];
    const prefixes = [
      'decisions/', 'bets/', 'people/', '/people/', 'wiki/analysis/', 'a_c/', '100%/', '5%/', 'xpeople/', 'people', 'x/dec',
    ];
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', prefixes.map((prefix, i) => ({ name: `t${i}`, prefix })));
      for (const slug of slugs) await seedPage(slug, { sourcePath: `${slug}.md` });
      const result = await runStatsCore(ctxOf());
      const reportedDead = new Set(result.dead_prefixes.map((d) => d.prefix));
      for (const prefix of prefixes) {
        // One-type pack: inference answers 't' iff this prefix alone matches the path.
        const solo = { page_types: [{ name: 't', path_prefixes: [prefix] }] };
        const live = slugs.some((slug) => inferTypeFromPack(`${slug}.md`, solo) === 't');
        expect({ prefix, dead: reportedDead.has(prefix) }).toEqual({ prefix, dead: !live });
      }
    });
  });

  it('keeps a prefix live only for pages in scope, and ignores soft-deleted pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [{ name: 'decision', prefix: 'decisions/' }]);
      await seedPage('projects/x/decisions/0001-a', { sourceId: 'src-a' });
      await seedPage('projects/y/decisions/0002-b', { sourceId: 'src-b', deleted: true });
      await seedPage('projects/z/notes/n', { sourceId: 'src-c' });
      const dead = [{ type: 'decision', prefix: 'decisions/' }];
      expect((await runStatsCore(ctxOf())).dead_prefixes).toEqual([]);
      expect((await runStatsCore(ctxOf(), { sourceId: 'src-a' })).dead_prefixes).toEqual([]);
      expect((await runStatsCore(ctxOf(), { sourceId: 'src-b' })).dead_prefixes).toEqual(dead);
      expect((await runStatsCore(ctxOf(), { sourceId: 'src-c' })).dead_prefixes).toEqual(dead);
      expect((await runStatsCore(ctxOf(), { sourceIds: ['src-b', 'src-c'] })).dead_prefixes).toEqual(dead);
      expect((await runStatsCore(ctxOf(), { sourceIds: ['src-a', 'src-c'] })).dead_prefixes).toEqual([]);
    });
  });

  it('returns empty dead_prefixes when pack load fails', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'never-installed' }, async () => {
      __setPackLocatorForTests(() => null);
      const result = await runStatsCore(ctxOf());
      expect(result.pack_identity).toBeNull();
      expect(result.dead_prefixes).toEqual([]);
    });
  });
});

describe('runStatsCore — JSON envelope shape', () => {
  it('schema_version stays 1 (stable contract)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await runStatsCore(ctxOf());
      expect(result.schema_version).toBe(1);
    });
  });

  it('aggregate fields match the per-source merge', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-a' });
      await seedPage('b', { sourceId: 'src-b' });  // untyped
      const result = await runStatsCore(ctxOf());
      const totalFromPer = result.per_source.reduce((acc, s) => acc + s.total_pages, 0);
      expect(result.aggregate.total_pages).toBe(totalFromPer);
    });
  });

  it('by_type sorted by count desc, ties by name asc', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'company' });
      await seedPage('b', { type: 'person' });
      await seedPage('c', { type: 'person' });
      await seedPage('d', { type: 'person' });
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.by_type[0]!.type).toBe('person');
      expect(result.aggregate.by_type[1]!.type).toBe('company');
    });
  });
});

describe('runStatsCore — #2466 catch-narrowing (real count + error surfacing)', () => {
  // #2466: `gbrain schema stats` reported "Total pages: 0" on a populated
  // PGLite brain. The bug was a bare `catch {}` in fetchCountRows (and a
  // sibling in detectDeadPrefixes) that converted ANY engine error into 0
  // rows. The COUNT query itself is valid on PGLite (proven below), so the
  // regression pins two things: (a) a populated brain reports the real,
  // non-zero count through the full runStatsCore path; (b) a non-missing-
  // table engine error is rethrown, not masked into a fake zero.

  it('reports the real non-zero count on a populated PGLite brain (no false 0)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // Seed a realistic mix: typed, untyped, multiple types — like the
      // 169-page brain in the bug report (scaled down).
      for (let i = 0; i < 12; i++) {
        const type = i % 3 === 0 ? '' : (i % 3 === 1 ? 'person' : 'company');
        await seedPage(`notes/p${i}`, { type, sourcePath: `notes/p${i}.md` });
      }
      const result = await runStatsCore(ctxOf());
      // The core regression: NOT zero.
      expect(result.aggregate.total_pages).toBe(12);
      expect(result.aggregate.typed_pages).toBe(8);
      expect(result.aggregate.untyped_pages).toBe(4);
      // And coverage is the honest ratio, not the vacuous 1.0 a 0/0 prints.
      expect(result.aggregate.coverage).not.toBe(1.0);
    });
  });

  it('fetchCountRows rethrows a non-missing-table engine error instead of masking it as 0 pages', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // No pack → detectDeadPrefixes is skipped, isolating the throw to the
      // fetchCountRows catch we narrowed. The count query (the GROUP BY one)
      // throws a column-level error (SQLSTATE 42703) — the exact class the
      // old bare `catch {}` swallowed into 0 rows; everything else succeeds.
      __setPackLocatorForTests(() => null);
      const boom = Object.assign(new Error('column "type" does not exist'), { code: '42703' });
      const stubEngine = {
        executeRaw: async (sql: string) => {
          if (/GROUP BY source_id/.test(sql)) throw boom;  // the fetchCountRows query
          return [];
        },
      } as unknown as PGLiteEngine;
      const ctx = { ...ctxOf(), engine: stubEngine } as unknown as OperationContext;
      await expect(runStatsCore(ctx)).rejects.toThrow('column "type" does not exist');
    });
  });

  it('fetchCountRows still degrades to empty (no throw) on a genuine missing pages table', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // Pre-init brain shape: the count query hits a missing pages table
      // (SQLSTATE 42P01). This is the ONLY case the narrowed catch swallows.
      __setPackLocatorForTests(() => null);
      const missing = Object.assign(new Error('relation "pages" does not exist'), { code: '42P01' });
      const stubEngine = {
        executeRaw: async (sql: string) => {
          if (/GROUP BY source_id/.test(sql)) throw missing;
          return [];
        },
      } as unknown as PGLiteEngine;
      const ctx = { ...ctxOf(), engine: stubEngine } as unknown as OperationContext;
      const result = await runStatsCore(ctx);
      expect(result.aggregate.total_pages).toBe(0);
      expect(result.per_source).toEqual([]);
    });
  });

  it('detectDeadPrefixes rethrows a non-missing-table error (sibling catch)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [{ name: 'person', prefix: 'people/' }]);
      // fetchCountRows (the GROUP BY query) succeeds → []; the per-prefix
      // dead-prefix LIKE query then throws a non-missing-table error, which
      // must surface through the narrowed sibling catch.
      const stubEngine = {
        getConfig: async () => null,
        executeRaw: async (sql: string) => {
          if (/GROUP BY source_id/.test(sql)) return [];        // count query: empty brain, fine
          throw Object.assign(new Error('division by zero'), { code: '22012' });  // the LIKE query
        },
      } as unknown as PGLiteEngine;
      const ctx = { ...ctxOf(), engine: stubEngine } as unknown as OperationContext;
      await expect(runStatsCore(ctx)).rejects.toThrow('division by zero');
    });
  });
});

describe('runStatsCore — type/untyped split', () => {
  it('treats empty-string type as untyped (not its own bucket)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // Some legacy rows might have type='' rather than NULL.
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
         VALUES ('a', 'default', 'a.md', '', 'a', '', '', '')`,
      );
      await seedPage('b', { type: 'person' });
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.untyped_pages).toBe(1);
      expect(result.aggregate.typed_pages).toBe(1);
      // empty-string type does NOT appear as its own type bucket.
      expect(result.aggregate.by_type.find((t) => t.type === '')).toBeUndefined();
    });
  });
});

describe('runStatsCore — #4653 DB-plane schema_pack tier', () => {
  it('pack_identity follows the brain-wide DB config schema_pack (tier 4)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      const result = await runStatsCore(ctxOf());
      // Pre-fix: loadActivePackBestEffort never read the engine → 'gbrain-base@1.0.0+…'.
      expect(result.pack_identity).toStartWith('gbrain-base-v2@1.5.0');
    });
  });
});
