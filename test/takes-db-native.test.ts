/**
 * DB-native takes: the full takes lifecycle on a brain whose source has NO
 * markdown repo (`sources.local_path` null, how hosted brains run), driven
 * through the remote MCP path by an OAuth client that carries a per-client
 * takes-holder grant (`oauth_clients.takes_holders`).
 *
 * Protects (authoring gate):
 *  1. Contract — the five takes verbs commit database-only (the fence lives in
 *     the page's stored body, the `takes` rows are projected from it), the
 *     holder grant is enforced for every mutating verb, and the rows survive a
 *     restart, the takes reconcile (`extractTakes`, `gbrain takes rebuild`), the
 *     dream extract/extract_facts/consolidate phases and a remote put_page.
 *  2. Regressions — a writer that needs a markdown home again
 *     (`takes_mirror_unavailable`), a holder check that slips for one verb, a
 *     reconcile that rewrites `superseded_by` (it did: extract-takes.ts
 *     projected `superseded_by: null` and the upsert wrote it), a put_page that
 *     drops or duplicates fence rows.
 *  3. Existing coverage — test/takes-write-ops.test.ts and
 *     test/e2e/takes-write-ops-postgres.test.ts drive file-backed sources or
 *     local principals; nothing pins the OAuth-client + local_path-null path
 *     verb by verb, nor the reconcile's superseded_by column.
 *  4. No production seam: the OAuth client row is a real `oauth_clients` row and
 *     the hand-built `DispatchOpts` mirror what `gbrain serve --http` passes to
 *     `dispatchToolCall` after `verifyAccessToken` (src/commands/serve-http-mcp.ts).
 *
 * Arms: PGLite always; Postgres under DATABASE_URL (laned by
 * test/e2e/takes-db-native-postgres.test.ts, which also runs the
 * pg_dump/pg_restore round trip). Each arm runs unmanaged and managed
 * (persistence_brain.enabled), the two modes a hosted brain can be in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import { runCycle } from '../src/core/cycle.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SRC = 'hosted-example';
export const SLUG = 'people/alice-example';
export const HOLDER = 'people/holder-example';
const GRANTED_CLIENT = 'cl-granted-example';
const WORLD_CLIENT = 'cl-world-example';

interface TakeRow { id: number; row_num: number; claim: string; holder: string; active: boolean; superseded_by: number | null;
  resolved_quality: string | null; resolved_by: string | null; weight: number }
/** What the two engines hand back before normalization: Postgres returns bigint/numeric columns as strings. */
type RawTakeRow = Omit<TakeRow, 'id' | 'row_num' | 'weight' | 'superseded_by'> & { id: number | string; row_num: number | string; weight: number | string | null; superseded_by: number | string | null };

/** The dispatch options `gbrain serve --http` builds for a bearer token of this OAuth client. */
function clientOpts(engine: BrainEngine, clientId: string, holders: string[]): DispatchOpts {
  const auth: AuthInfo = { token: 'synthetic', clientId, principal: { kind: 'oauth_client', id: clientId }, sourceId: SRC, allowedSources: [SRC], scopes: ['read', 'write'] };
  return { remote: true, transport: 'http', sourceId: SRC, takesHoldersAllowList: holders, config: { engine: engine.kind, embedding_disabled: true }, auth };
}

/** The parsed tool result: the op's own reply, or its error envelope marked `isError`. */
export async function call(engine: BrainEngine, op: string, params: Record<string, unknown>, opts: DispatchOpts): Promise<Record<string, any>> {
  const result = await dispatchToolCall(engine, op, { request_id: randomUUID(), ...params }, opts);
  const body = JSON.parse(result.content[0].text);
  return result.isError ? { ...body, isError: true } : body;
}

/** A call the fixture needs to have succeeded: a refusal fails at its cause, not in a later assertion. */
export async function callOk(engine: BrainEngine, op: string, params: Record<string, unknown>, opts: DispatchOpts): Promise<Record<string, any>> {
  const body = await call(engine, op, params, opts);
  if (body.isError) throw new Error(`${op} refused: ${body.error}: ${body.message}`);
  return body;
}

function numeric(label: string, value: number | string | null): number {
  const n = value === null ? NaN : Number(value);
  if (!Number.isFinite(n)) throw new Error(`takes.${label} is not a number: ${String(value)}`);
  return n;
}

export async function takeRows(engine: BrainEngine): Promise<TakeRow[]> {
  const rows = await engine.executeRaw<RawTakeRow>(
    `SELECT t.id,t.row_num,t.claim,t.holder,t.active,t.superseded_by,t.resolved_quality,t.resolved_by,t.weight
       FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND p.source_id=$2 ORDER BY t.row_num`, [SLUG, SRC]);
  return rows.map(r => ({ ...r, id: numeric('id', r.id), row_num: numeric('row_num', r.row_num), weight: numeric('weight', r.weight),
    superseded_by: r.superseded_by == null ? null : numeric('superseded_by', r.superseded_by) }));
}

const PAGE = (body: string) => `---\ntitle: Alice Example\ntype: person\n---\n\n${body}\n`;
const FORGED_FENCE = ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
  '|---|-------|------|-----|--------|-------|--------|', '| 1 | Forged claim | take | world | 0.5 | 2026-01 | |', '<!--- gbrain:takes:end -->'].join('\n');

/** A local_path-null source, a holder page, the subject page and two OAuth clients: one granted the private holder, one world-only. */
export async function seedBrain(engine: BrainEngine, managed: boolean): Promise<{ granted: DispatchOpts; world: DispatchOpts }> {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SRC]);
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  for (const [id, holders] of [[GRANTED_CLIENT, ['world', HOLDER]], [WORLD_CLIENT, null]] as const) {
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,takes_holders) VALUES($1,$1,'read write',$2,$3)`, [id, SRC, holders]);
  }
  const granted = clientOpts(engine, GRANTED_CLIENT, ['world', HOLDER]);
  const world = clientOpts(engine, WORLD_CLIENT, ['world']);
  await callOk(engine, 'put_page', { slug: HOLDER, content: '---\ntitle: Holder Example\ntype: person\n---\n\nThe holder.\n' }, granted);
  await callOk(engine, 'put_page', { slug: SLUG, content: PAGE('Alice is an example person.') }, granted);
  return { granted, world };
}

const arms = [false, true].flatMap(managed => testBackends().map(kind => ({ kind, managed })));

for (const arm of arms) {
  describe(`${arm.kind} ${arm.managed ? 'managed' : 'unmanaged'} brain, source without a markdown repo`, () => {
    let engine: BrainEngine;
    let reopen: () => Promise<BrainEngine>;
    let close: () => Promise<void>;
    let granted: DispatchOpts;
    let world: DispatchOpts;
    /** The granted client's lifecycle, run once per brain so every named test below can run alone (`bun test -t`). */
    let life: { add: Record<string, any>; mine: Record<string, any>; theirs: Record<string, any>; update: Record<string, any>;
      supersede: Record<string, any>; resolve: Record<string, any> };
    let privateRow: number;
    let replacementRow: number;
    beforeAll(async () => {
      if (arm.kind === 'pglite') {
        const dir = mkdtempSync(join(tmpdir(), 'gbrain-takes-db-native-'));
        const pglite = new PGLiteEngine();
        await pglite.connect({ database_path: dir });
        await pglite.initSchema();
        engine = pglite;
        // A restart is a second engine on the same data directory, after the first let go of it.
        reopen = async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); engine = new PGLiteEngine(); await engine.connect({ database_path: dir }); return engine; };
        close = async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); };
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        const extra: BrainEngine[] = [];
        engine = pg.engine;
        reopen = async () => { const fresh = new PostgresEngine(); await fresh.connect({ database_url: pg.databaseUrl, poolSize: 2 }); extra.push(fresh); return fresh; };
        close = async () => { for (const e of extra) { await disposePersistenceConsumer(e); await e.disconnect(); } await disposePersistenceConsumer(pg.engine); await pg.close(); };
      }
      ({ granted, world } = await seedBrain(engine, arm.managed));
      const add = await callOk(engine, 'takes_add', { slug: SLUG, claim: 'Alice ships weekly', kind: 'take', holder: HOLDER, weight: 0.7 }, granted);
      privateRow = add.row_num;
      const mine = await callOk(engine, 'takes_list', { page_slug: SLUG }, granted);
      const theirs = await callOk(engine, 'takes_list', { page_slug: SLUG }, world);
      const update = await callOk(engine, 'takes_update', { slug: SLUG, row_num: privateRow, weight: 0.9 }, granted);
      const supersede = await callOk(engine, 'takes_supersede', { slug: SLUG, row_num: privateRow, claim: 'Alice ships daily' }, granted);
      replacementRow = supersede.new_row;
      const resolve = await callOk(engine, 'takes_resolve', { slug: SLUG, row_num: replacementRow, quality: 'correct', evidence: 'observed' }, granted);
      life = { add, mine, theirs, update, supersede, resolve };
    }, 120_000);
    afterAll(async () => { await close(); });

    test('granted client: takes_add commits a private-holder take with no file written', async () => {
      expect(life.add.isError).toBeUndefined();
      expect(life.add).toMatchObject({ status: 'created_or_updated', row_num: 1, holder: HOLDER, mirror_written: false });
      expect((await takeRows(engine))[0]).toMatchObject({ row_num: 1, claim: 'Alice ships weekly', holder: HOLDER });
    });

    test('granted client: takes_list reads the take back; the world-only client sees nothing', async () => {
      expect(life.mine).toMatchObject([{ row_num: 1, claim: 'Alice ships weekly', holder: HOLDER, weight: 0.7 }]);
      expect(life.theirs).toEqual([]);
    });

    test('granted client: takes_update changes the weight in place', async () => {
      expect(life.update).toMatchObject({ status: 'created_or_updated', row_num: 1 });
      expect((await takeRows(engine))[0]).toMatchObject({ row_num: 1, weight: 0.9 });
    });

    test('granted client: takes_supersede strikes the old row and appends the replacement', async () => {
      expect(life.supersede).toMatchObject({ old_row: 1, new_row: 2 });
      expect((await takeRows(engine)).slice(0, 2)).toMatchObject([
        { row_num: 1, active: false, superseded_by: 2 },
        { row_num: 2, claim: 'Alice ships daily', holder: HOLDER, active: true, superseded_by: null },
      ]);
    });

    test('granted client: takes_resolve records the verdict, resolved_by stamped with the client', async () => {
      expect(life.resolve).toMatchObject({ row_num: 2, quality: 'correct', resolved_by: `mcp:${GRANTED_CLIENT}` });
      expect((await takeRows(engine))[1]).toMatchObject({ row_num: 2, resolved_quality: 'correct', resolved_by: `mcp:${GRANTED_CLIENT}` });
    });

    test('without the holder grant: takes_add with the private holder is refused', async () => {
      const before = await takeRows(engine);
      expect(await call(engine, 'takes_add', { slug: SLUG, claim: 'Not mine', kind: 'take', holder: HOLDER }, world)).toMatchObject({ isError: true, error: 'permission_denied' });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('without the holder grant: takes_update of the private row is refused as not found', async () => {
      const before = await takeRows(engine);
      expect(await call(engine, 'takes_update', { slug: SLUG, row_num: replacementRow, weight: 0.1 }, world)).toMatchObject({ isError: true, error: 'not_found' });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('without the holder grant: takes_supersede of the private row is refused as not found', async () => {
      const before = await takeRows(engine);
      expect(await call(engine, 'takes_supersede', { slug: SLUG, row_num: replacementRow, claim: 'hijack' }, world)).toMatchObject({ isError: true, error: 'not_found' });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('without the holder grant: takes_resolve of the private row is refused as not found', async () => {
      const before = await takeRows(engine);
      expect(await call(engine, 'takes_resolve', { slug: SLUG, row_num: replacementRow, quality: 'incorrect' }, world)).toMatchObject({ isError: true, error: 'not_found' });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('without the holder grant: takes_supersede with a holder override onto the private holder is refused', async () => {
      const own = await call(engine, 'takes_add', { slug: SLUG, claim: 'World claim', kind: 'fact', holder: 'world' }, world);
      expect(own).toMatchObject({ status: 'created_or_updated', holder: 'world' });
      const before = await takeRows(engine);
      expect(await call(engine, 'takes_supersede', { slug: SLUG, row_num: own.row_num, claim: 'steal', holder: HOLDER }, world)).toMatchObject({ isError: true, error: 'permission_denied' });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('put_page: a remote body without the fence keeps every take row', async () => {
      const before = await takeRows(engine);
      const page = await call(engine, 'get_page', { slug: SLUG, include_content: true }, granted);
      expect(page.compiled_truth).not.toContain('gbrain:takes'); // remote reads hide the fence
      const out = await call(engine, 'put_page', { slug: SLUG, expected_revision: page.revision, content: PAGE('Alice is an example person, revised.') }, granted);
      expect(out.status).toBe('created_or_updated');
      expect(await takeRows(engine)).toEqual(before);
      const after = await call(engine, 'get_page', { slug: SLUG, include_content: true }, granted);
      expect(after.compiled_truth).toContain('revised');
      expect(after.compiled_truth).not.toContain('gbrain:takes');
    });

    test('put_page: a forged takes fence is refused and leaves the rows alone', async () => {
      const before = await takeRows(engine);
      const page = await call(engine, 'get_page', { slug: SLUG, include_content: true }, granted);
      const out = await call(engine, 'put_page', { slug: SLUG, expected_revision: page.revision, content: PAGE(`Forged.\n\n${FORGED_FENCE}`) }, granted);
      expect(out).toMatchObject({ isError: true, error: 'permission_denied' });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('reconcile: extractTakes from the database, plain and rebuild, keeps ids, resolutions and superseded_by', async () => {
      const before = await takeRows(engine);
      expect(before.slice(0, 2).map(r => r.superseded_by)).toEqual([2, null]);
      expect(await extractTakes(engine, { source: 'db', sourceId: SRC, slugs: [SLUG] })).toMatchObject({ pagesWithTakes: 1, warnings: [] });
      expect(await takeRows(engine)).toEqual(before);
      expect(await extractTakes(engine, { source: 'db', sourceId: SRC, slugs: [SLUG], rebuild: true })).toMatchObject({ pagesWithTakes: 1, warnings: [] });
      expect(await takeRows(engine)).toEqual(before);
    });

    test('reconcile: the dream extract, extract_facts and consolidate phases leave the rows intact', async () => {
      const before = await takeRows(engine);
      const report = await runCycle(engine, { brainDir: null, sourceId: SRC, phases: ['extract', 'extract_facts', 'consolidate'] });
      expect(report.phases.map(p => [p.phase, p.status])).toEqual([['extract', 'ok'], ['extract_facts', 'ok'], ['consolidate', 'ok']]);
      expect(await takeRows(engine)).toEqual(before);
    }, 60_000);

    test('restart: a fresh engine on the same database reads the same takes', async () => {
      const before = await takeRows(engine);
      expect(before.length).toBeGreaterThanOrEqual(2);
      const fresh = await reopen();
      expect(await takeRows(fresh)).toEqual(before);
      engine = fresh;
    }, 60_000);
  });
}
