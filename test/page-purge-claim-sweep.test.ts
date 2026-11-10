/**
 * A page purge's claim sweep (deletePageWithSegments, LPH h3) on a source with many unreferenced segment texts.
 *
 * 1. Protects: the sweep deletes the source's unreferenced segment texts that hold one of the purged page's claims
 *    (plain or as a facts-fence cell stores it), up to CLAIM_FORMS_BATCH forms per pass. It ran as one statement per
 *    pass that recomputed lower(convert_from(body)) for every (text, form) pair: 512 forms over a few MB of unreferenced
 *    text took longer than the publication transaction's 5 s statement_timeout, so `delete_page purge:true` of a page
 *    with many claims ended `write_interrupted` (SQLSTATE 57014) on every attempt. Each text is now lowered once per
 *    statement, and one statement covers at most CLAIM_SWEEP_CHUNK_BYTES of unreferenced text.
 * 2. Fails when: on Postgres, the sweep under the publication's own settings (declarePublication: statement_timeout
 *    5 s) is cancelled with 57014; on either engine, the deleted set differs from the old statement's: an unreferenced
 *    text holding a claim (lowered, escaped, or in the second pass of forms) is left, or a referenced text, a text a
 *    live staging holds, or a text holding no claim is deleted.
 * 3. A source with filler texts of 256 KB (referenced by another page's manifest, and unreferenced holding no claim)
 *    and small texts that hold claims, and a page with 600 claims (601 forms: two passes). Postgres (DATABASE_URL)
 *    carries the timing proof (40 unreferenced fillers: the old statement needs about 9 s on an M-series Mac); PGLite
 *    enforces no statement_timeout, so its arm checks the deleted set over more than one chunk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { escapeFenceCell } from '../src/core/fence-shared.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { deletePageWithSegments } from '../src/core/persistence/page-purge.ts';
import { declarePublication } from '../src/core/persistence/publication-deadline.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'default';
const CLAIMS = Array.from({ length: 599 }, (_, i) => `Claim ${i + 1} of the moved project holds marker q${i + 1}zz`);
const PIPE_CLAIM = 'The gate marker is quill|pipe8842';
const ALL_CLAIMS = [...CLAIMS, PIPE_CLAIM];
/** The claim texts the fixture plants (small texts: what the sweep must find among the fillers). */
const HELD = {
  /** Unreferenced, the claim upper-cased: the sweep lowers the text. Deleted. */
  lowered: `Notes before. ${CLAIMS[6]!.toUpperCase()} and after.`,
  /** Unreferenced, the pipe claim as a fence cell stores it (`\|`). Deleted. */
  escaped: `| 1 | ${escapeFenceCell(PIPE_CLAIM)} | fact |`,
  /** Unreferenced, a claim of the last pass of forms. Deleted. */
  lastPass: `Tail: ${CLAIMS[598]}.`,
  /** Referenced by the other page's manifest. Kept. */
  referenced: `Live body: ${CLAIMS[10]}.`,
  /** Unreferenced, but a live staging of another write recorded it. Kept. */
  staged: `Staged body: ${CLAIMS[11]}.`,
};
const DELETED: Array<keyof typeof HELD> = ['escaped', 'lastPass', 'lowered'];

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

for (const backend of testBackends()) describe(`a page purge's claim sweep over many unreferenced texts (${backend})`, () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-claim-sweep-'));
  homes.push(home);
  const env = () => ({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  const fillers = backend === 'postgres' ? { referenced: 40, unreferenced: 40 } : { referenced: 6, unreferenced: 18 };
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const sha = new Map<keyof typeof HELD, string>();
  let fillerShas: string[] = [];

  beforeAll(async () => withEnv(env(), async () => {
    if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.transaction(tx => withCoordinatedWrite(tx, [SOURCE], async () => {
      await tx.executeRaw(`INSERT INTO pages (source_id, slug, type, title) VALUES ($1,'notes/claim-sweep-keeper','note','Keeper'),($1,'notes/claim-sweep-purged','note','Purged')`, [SOURCE]);
      // Fillers of 256 KB holding no claim: md5 lines, generated in the database.
      await tx.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
        SELECT $1, sha256(b), octet_length(b), 1, b FROM (SELECT convert_to((SELECT string_agg(md5(i::text || '-' || j::text) || CASE WHEN j % 9 = 0 THEN E'\\n' ELSE ' ' END, '')
          FROM generate_series(1, 7900) j), 'UTF8') AS b FROM generate_series(1, $2::int) i) s`, [SOURCE, fillers.referenced + fillers.unreferenced]);
      fillerShas = (await tx.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_segment_texts WHERE source_id=$1 ORDER BY sha256`, [SOURCE])).map(r => r.sha);
      for (const [name, text] of Object.entries(HELD) as Array<[keyof typeof HELD, string]>) {
        const [row] = await tx.executeRaw<{ sha: string }>(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
          SELECT $1, sha256(b), octet_length(b), 1, b FROM (SELECT convert_to($2::text,'UTF8') AS b) s RETURNING encode(sha256,'hex') AS sha`, [SOURCE, text]);
        sha.set(name, row!.sha);
      }
      // The keeper page's manifest references the first fillers and the `referenced` text.
      await tx.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, seq, region, source_id, sha256, byte_start, byte_len, line_start,
          line_count, cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
        SELECT (SELECT id FROM pages WHERE source_id=$1 AND slug='notes/claim-sweep-keeper'), n, 1, n, 'truth', $1, decode(h,'hex'), n * 1048576, 1, 0, 1, 'forced',
          '{}'::jsonb, 0, 0, '\\x00'::bytea
        FROM unnest($2::text[]) WITH ORDINALITY AS u(h, n)`, [SOURCE, [...fillerShas.slice(0, fillers.referenced), sha.get('referenced')!]]);
      // A live (open) staging of another page's write recorded the `staged` text.
      const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SOURCE]);
      const staging = randomUUID();
      await tx.openBodyStaging({ id: staging, kind: 'put', principalKind: 'application', principalId: 'test:fixture', clientRequestId: randomUUID(),
        sourceId: SOURCE, sourceIncarnation: source!.incarnation, slug: 'notes/claim-sweep-unpublished', pageId: null, mode: 'create', baseRevision: null, baseGeneration: null,
        declaredBytes: 16, declaredSha256: null, reservedBytes: 0, idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) });
      await tx.executeRaw(`INSERT INTO page_body_staging_texts (staging_id, source_id, sha256) VALUES ($1::uuid, $2, decode($3,'hex'))`, [staging, SOURCE, sha.get('staged')!]);
    }, TEST_WRITE_ATTRIBUTION));
  }), 300_000);
  afterAll(async () => withEnv(env(), async () => { await disposePersistenceConsumer(engine); await close?.(); }), 120_000);

  const texts = async () => new Set((await engine.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_segment_texts WHERE source_id=$1`, [SOURCE])).map(r => r.sha));

  test('the sweep runs inside the publication statement budget and deletes exactly the unreferenced texts holding a claim', async () => withEnv(env(), async () => {
    const before = await texts();
    expect(before.size).toBe(fillers.referenced + fillers.unreferenced + Object.keys(HELD).length);
    const [page] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id=$1 AND slug='notes/claim-sweep-purged'`, [SOURCE]);
    const started = performance.now();
    const result = await engine.transaction(async tx => {
      // The publication's opening statement: statement_timeout 5 s and lock_timeout 1 s, transaction-local (Postgres enforces them).
      await declarePublication(tx);
      return withCoordinatedWrite(tx, [SOURCE], () => deletePageWithSegments(tx, SOURCE, 'notes/claim-sweep-purged', Number(page!.id), ALL_CLAIMS), TEST_WRITE_ATTRIBUTION);
    });
    const elapsedMs = performance.now() - started;
    const after = await texts();
    const removed = [...before].filter(s => !after.has(s)).sort();
    expect(removed).toEqual(DELETED.map(name => sha.get(name)!).sort());
    expect(result.page_segment_texts).toBe(DELETED.length);
    for (const name of DELETED) expect(result.shas).toContain(sha.get(name)!);
    for (const filler of fillerShas) expect(after.has(filler)).toBe(true);
    expect(after.has(sha.get('referenced')!)).toBe(true);
    expect(after.has(sha.get('staged')!)).toBe(true);
    console.log(`[claim-sweep ${backend}] ${fillers.unreferenced} unreferenced fillers of 256 KB, ${ALL_CLAIMS.length} claims: ${Math.round(elapsedMs)} ms`);
  }), 300_000);
});
