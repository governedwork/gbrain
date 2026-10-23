/**
 * One reader for the `superseded by #N` strike citation, shared by the canonical
 * projection, the takes_remove guard and the fence-repair renumber (driver
 * review R1). The fence writer appends the citation after the row's own
 * provenance, so the LAST citation is the live pointer, case-insensitively.
 *
 * Protects, on a managed brain (PGLite always, Postgres under DATABASE_URL):
 *  - a takes_add whose Tier-1 normalisation rewrites a struck row re-indexes
 *    that row through the canonical projection, so its superseded_by survives
 *    (it did not: the re-index went through toBatchInput(…, null));
 *  - takes_remove guards the row the LAST citation names, whatever its case
 *    (it read the first citation, case-sensitively: "Superseded by #2" let row 2
 *    go and left a dangling pointer; "#2; #3" guarded 2 and let 3 go);
 *  - an uncited struck row and a chain project the pointers the fence says, and
 *    the managed reconcile keeps them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SRC = 'citation-example';
const HEADER = ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |', '|---|-------|------|-----|--------|-------|--------|'];
const fence = (rows: string[]) => [...HEADER, ...rows, '<!--- gbrain:takes:end -->'].join('\n');
const struck = (n: number, claim: string, holder: string, source: string) => `| ${n} | ~~${claim}~~ | take | ${holder} | 0.5 | 2026-01 | ${source} |`;
const live = (n: number, claim: string) => `| ${n} | ${claim} | take | world | 0.5 | 2026-01 | |`;

interface Row { row_num: number; holder: string; active: boolean; superseded_by: number | null }

const PAGES: Record<string, string[]> = {
  'notes/normalized': [struck(1, 'Old claim', 'brain', 'superseded by #2'), live(2, 'New claim')],
  'notes/capitalised': [struck(1, 'Old claim', 'world', 'Superseded by #2'), live(2, 'New claim')],
  'notes/chain': [struck(1, 'Old claim', 'world', 'superseded by #2; superseded by #3'), live(2, 'Mid claim'), live(3, 'New claim')],
  'notes/uncited': [struck(1, 'Old claim', 'world', 'deck'), live(2, 'New claim')],
};

for (const kind of testBackends()) {
  describe(`${kind} managed brain: the strike citation reader`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-takes-citation-'));
      if (kind === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close;
      }
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SRC]);
      // Pages as an older writer left them (no normalisation), stored before the brain becomes managed, projected the way a page write projects them.
      for (const [slug, rows] of Object.entries(PAGES)) await store(slug, rows);
      // The struck row's holder as an older writer spelled it: a cell Tier 1 normalises to `brain` on the next coordinated write.
      await engine.executeRaw(`UPDATE pages SET compiled_truth = replace(compiled_truth, '| 1 | ~~Old claim~~ | take | brain |', '| 1 | ~~Old claim~~ | take | Assistant |') WHERE source_id=$1 AND slug='notes/normalized'`, [SRC]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect(await managedPersistenceEnabled(engine)).toBe(true);
    }, 120_000);
    afterAll(async () => {
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      await close();
      rmSync(home, { recursive: true, force: true });
    });

    const ctx = (): OperationContext => ({ engine, sourceId: SRC, remote: false, dryRun: false, config: { engine: kind, embedding_disabled: true } as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} } });
    /** The trusted local CLI path, where takes_remove is allowed; errors come back as their code. */
    const call = (op: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, async () => {
      try { return await operationsByName[op]!.handler(ctx(), { request_id: randomUUID(), ...params }) as Record<string, unknown>; }
      catch (e) { const err = e as { code?: string; message: string }; return { error: err.code ?? 'thrown', message: err.message }; }
    });
    async function store(slug: string, rows: string[]): Promise<void> {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: fence(rows), timeline: '', frontmatter: {} }, { sourceId: SRC });
      const page = (await engine.getPage(slug, { sourceId: SRC }))!;
      const parsed = parseMarkdown(serializePageToMarkdown(page, []), `${slug}.md`);
      const project = await prepareCanonicalProjections(engine, parsed, slug, SRC, null, 'editing');
      await engine.transaction(tx => project(tx));
    }
    const rows = async (slug: string): Promise<Row[]> => (await engine.executeRaw<Row & { row_num: number | string; superseded_by: number | string | null }>(
      'SELECT t.row_num,t.holder,t.active,t.superseded_by FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND p.source_id=$2 ORDER BY t.row_num', [slug, SRC]))
      .map(r => ({ row_num: Number(r.row_num), holder: r.holder, active: r.active, superseded_by: r.superseded_by == null ? null : Number(r.superseded_by) }));
    const pointers = async (slug: string) => (await rows(slug)).map(r => r.superseded_by);

    test('takes_add after a Tier-1 normalisation of a struck row keeps its superseded_by', async () => {
      const slug = 'notes/normalized';
      expect(await pointers(slug)).toEqual([2, null]);
      expect(await call('takes_add', { slug, claim: 'Third claim', kind: 'take', holder: 'world' })).toMatchObject({ row_num: 3 });
      const after = await rows(slug);
      expect(after[0]!.holder).toBe('brain'); // Tier 1 rewrote the struck row, so this write re-indexed it
      expect(after.map(r => r.superseded_by)).toEqual([2, null, null]);
    }, 60_000);

    test('takes_remove refuses the row a capitalised citation names', async () => {
      const slug = 'notes/capitalised';
      expect(await pointers(slug)).toEqual([2, null]);
      expect(await call('takes_remove', { slug, row_num: 2 })).toMatchObject({ error: 'invalid_params', message: expect.stringContaining('replaces row #1') });
      expect(await pointers(slug)).toEqual([2, null]);
    }, 60_000);

    test('takes_remove follows the last citation of a chain and the managed reconcile keeps the chain', async () => {
      const slug = 'notes/chain';
      expect(await pointers(slug)).toEqual([3, null, null]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await extractTakes(engine, { source: 'db', sourceId: SRC, slugs: [slug], rebuild: true })).toMatchObject({ pagesWithTakes: 1, warnings: [] });
      });
      expect(await pointers(slug)).toEqual([3, null, null]);
      expect(await call('takes_remove', { slug, row_num: 3 })).toMatchObject({ error: 'invalid_params', message: expect.stringContaining('replaces row #1') });
      expect(await call('takes_remove', { slug, row_num: 2 })).toMatchObject({ removed: true });
      expect((await rows(slug)).map(r => [r.row_num, r.superseded_by])).toEqual([[1, 3], [3, null]]);
    }, 60_000);

    test('an uncited struck row projects no pointer and the managed reconcile keeps it that way', async () => {
      const slug = 'notes/uncited';
      expect(await pointers(slug)).toEqual([null, null]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await extractTakes(engine, { source: 'db', sourceId: SRC, slugs: [slug] })).toMatchObject({ pagesWithTakes: 1, warnings: [] });
      });
      expect(await pointers(slug)).toEqual([null, null]);
    }, 60_000);
  });
}
