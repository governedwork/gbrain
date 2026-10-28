/**
 * `recall` pages its fact lists with `offset` (fork patch).
 *
 * recall answers at most 100 facts (limit cap) and had no offset, so a caller
 * could not read an entity (or session) with more facts than that whole: the
 * brain move's applier and its check stopped at RecallCapped on a page with
 * 170 facts. The engine reads already page (ORDER BY ... DESC, id DESC
 * LIMIT ... OFFSET ...); the op now takes `offset` and every fact-list arm
 * honours it.
 *
 * Pinned here on PGLite, through the real op:
 *  - 230 facts on one entity read in pages of 100 at offsets 0/100/200 give
 *    every fact exactly once, in the unpaged (SQL) order, ties broken by id
 *  - an offset past the end answers an empty list
 *  - offset -1, 1.5 and "x" are invalid_params, through MCP dispatch and the
 *    handler alike; offset with question or supersessions is refused
 *  - the session arm, since + entity and the no-filter arm page the same way
 *  - several lists merged into one answer page right: an entity whose facts
 *    sit under two slugs (the page slug and its bare subject slug), and a
 *    federated grant over two sources (no-filter and session arms; an
 *    entity in two unlinked sources answers ambiguous_entity instead), ties
 *    across sources included
 *  - no offset answers what it answered before: the SQL order's first N,
 *    and the same facts as offset 0
 *  - `offset` is advertised on the full surface and left out of the starter
 *    list (its size budget), yet a starter caller that passes it gets its page
 *    (dispatch validates against the whole op), never page one again
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations, operationsByName, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { allowedOpNames, filterOpsForSurface } from '../src/mcp/surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

let engine: PGLiteEngine;

const BASE = new Date('2026-06-01T12:00:00Z');
const CREATED = new Date('2026-06-02T12:00:00Z');

interface Where { source?: string; entity?: string | null; session?: string | null }
interface Spacing { startMin?: number; tie?: number; step?: number }

/**
 * `count` world facts `${label}-${i}`. Every `tie` consecutive rows share one
 * valid_from (so the id tiebreak decides their order), groups `step` minutes
 * apart, the first `startMin` minutes before BASE. created_at is one fixed
 * instant for the whole batch.
 */
async function seed(label: string, count: number, where: Where, spacing: Spacing = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, source_session, fact, kind, visibility, source, valid_from, created_at)
     SELECT $1, $2, $3, $4 || '-' || g, 'fact', 'world', 'test',
            $5::timestamptz - (($6::int + (g / $7::int) * $8::int) * interval '1 minute'), $9::timestamptz
       FROM generate_series(0, $10::int - 1) g`,
    [where.source ?? 'default', where.entity ?? null, where.session ?? null, label, BASE.toISOString(),
      spacing.startMin ?? 0, spacing.tie ?? 5, spacing.step ?? 1, CREATED.toISOString(), count],
  );
}

/** The fact texts SQL lists for `where`, in `orderBy` order: what an unpaged read would answer. */
async function sqlOrder(where: string, params: unknown[], orderBy: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE ${where} ORDER BY ${orderBy}`, params);
  return rows.map((r) => r.fact);
}

const local = { remote: false, sourceId: 'default' } as const;

async function recallPayload(params: Record<string, unknown>): Promise<{ facts: Array<Record<string, unknown> & { fact: string }>; total: number }> {
  const result = await dispatchToolCall(engine, 'recall', params, local);
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text!);
}

async function recallFacts(params: Record<string, unknown>): Promise<string[]> {
  return (await recallPayload(params)).facts.map((f) => f.fact);
}

/**
 * Pages of `limit` at offsets 0, limit, 2*limit ... until a short page. A
 * read that ignores offset answers full pages forever, so it stops at
 * MAX_PAGES and the caller's order check fails instead of the test hanging.
 */
const MAX_PAGES = 20;
async function readAllPages(read: (offset: number) => Promise<string[]>, limit: number): Promise<{ all: string[]; pages: number }> {
  const all: string[] = [];
  let pages = 0;
  for (let offset = 0; pages < MAX_PAGES; offset += limit) {
    const page = await read(offset);
    pages++;
    all.push(...page);
    if (page.length < limit) break;
  }
  return { all, pages };
}

function remoteCtx(over: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    ...over,
  } as unknown as OperationContext;
}

/** A remote caller granted both paging sources. */
const federated = () => remoteCtx({ remote: true, sourceId: 'paging-a', auth: { allowedSources: ['paging-a', 'paging-b'] } });

async function federatedFacts(params: Record<string, unknown>): Promise<string[]> {
  const res = await operationsByName['recall'].handler(federated(), params) as { facts: Array<{ fact: string }> };
  return res.facts.map((f) => f.fact);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['paging-a', 'paging-b']) {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
  }

  await seed('ent', 230, { entity: 'paging/ent' });
  await seed('sess', 230, { session: 'sess-paging' }, { startMin: 5000 });
  await seed('win-in', 180, { entity: 'paging/window' }, { startMin: 0 });
  await seed('win-out', 40, { entity: 'paging/window' }, { startMin: 10_000 });

  // Two slugs, one entity: the page slug and the bare subject slug its title gives.
  await importFromContent(engine, 'companies/acme-paging',
    serializeMarkdown({}, 'Acme Paging is a test company.', '', { type: 'company', title: 'Acme Paging', tags: [] }),
    { noEmbed: true, forceRechunk: true });
  await seed('acme-page', 120, { entity: 'companies/acme-paging' }, { startMin: 0, tie: 3, step: 2 });
  await seed('acme-bare', 120, { entity: 'acme-paging' }, { startMin: 1, tie: 3, step: 2 });

  // Two granted sources, one session in both: the even minutes in both, so
  // event-time ties cross sources, and one created_at, so every session-arm
  // row ties across sources.
  await seed('fed-a', 120, { source: 'paging-a', session: 'fed-sess' }, { startMin: 0, tie: 4, step: 1 });
  await seed('fed-b', 120, { source: 'paging-b', session: 'fed-sess' }, { startMin: 0, tie: 4, step: 2 });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('recall offset: the entity arm', () => {
  test('230 facts in pages of 100 at offsets 0/100/200: every fact once, in the unpaged order', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = $1`, ['paging/ent'], 'valid_from DESC, id DESC');
    expect(expected).toHaveLength(230);
    const pages = await Promise.all([0, 100, 200].map((offset) => recallFacts({ entity: 'paging/ent', limit: 100, offset })));
    expect(pages.map((p) => p.length)).toEqual([100, 100, 30]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(230);
    expect(all).toEqual(expected);
  });

  test('an offset past the end answers an empty list', async () => {
    for (const offset of [230, 231, 10_000]) {
      const payload = await recallPayload({ entity: 'paging/ent', limit: 100, offset });
      expect(payload.facts).toEqual([]);
      expect(payload.total).toBe(0);
    }
  });

  test('a page that is not a multiple of the limit lines up with its neighbours', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = $1`, ['paging/ent'], 'valid_from DESC, id DESC');
    expect(await recallFacts({ entity: 'paging/ent', limit: 7, offset: 13 })).toEqual(expected.slice(13, 20));
  });
});

describe('recall offset: refused values and combinations', () => {
  for (const offset of [-1, 1.5, 'x', Number.MAX_SAFE_INTEGER + 2]) {
    test(`offset ${JSON.stringify(offset)} is invalid_params over MCP`, async () => {
      const result = await dispatchToolCall(engine, 'recall', { entity: 'paging/ent', offset }, local);
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text!);
      expect(err.error).toBe('invalid_params');
      expect(String(err.message)).toContain('offset');
    });

    test(`offset ${JSON.stringify(offset)} is invalid_params at the handler`, async () => {
      const call = operationsByName['recall'].handler(remoteCtx({ remote: false, sourceId: 'default' }), { entity: 'paging/ent', offset });
      const err = await call.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('invalid_params');
      expect((err as OperationError).message).toContain('offset');
    });
  }

  for (const [name, params] of [
    ['question', { question: 'what does paging do?', entity: 'paging/ent' }],
    ['supersessions', { supersessions: true }],
  ] as const) {
    test(`offset with ${name} is refused with the reason`, async () => {
      for (const offset of [0, 100]) {
        const result = await dispatchToolCall(engine, 'recall', { ...params, offset }, local);
        expect(result.isError).toBe(true);
        const err = JSON.parse(result.content[0].text!);
        expect(err.error).toBe('invalid_params');
        expect(String(err.message)).toContain('offset');
        expect(String(err.message)).toContain(name);
      }
    });
  }
});

describe('recall offset: the other fact-list arms', () => {
  test('the session arm pages in its creation-time order', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND source_session = $1`, ['sess-paging'], 'created_at DESC, id DESC');
    expect(expected).toHaveLength(230);
    const { all, pages } = await readAllPages((offset) => recallFacts({ session_id: 'sess-paging', limit: 100, offset }), 100);
    expect(pages).toBe(3);
    expect(all).toEqual(expected);
  });

  test('since + entity pages through the window only', async () => {
    const since = new Date(BASE.getTime() - 500 * 60_000);
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = $1 AND COALESCE(valid_from, created_at) >= $2`,
      ['paging/window', since.toISOString()], 'COALESCE(valid_from, created_at) DESC, id DESC');
    expect(expected).toHaveLength(180);
    const { all } = await readAllPages((offset) => recallFacts({ entity: 'paging/window', since: since.toISOString(), limit: 100, offset }), 100);
    expect(all).toEqual(expected);
    expect(await recallFacts({ entity: 'paging/window', since: since.toISOString(), limit: 100, offset: 200 })).toEqual([]);
  });

  test('since alone (no entity) pages', async () => {
    const since = new Date(BASE.getTime() - 500 * 60_000);
    const expected = await sqlOrder(`source_id = 'default' AND COALESCE(valid_from, created_at) >= $1`,
      [since.toISOString()], 'COALESCE(valid_from, created_at) DESC, id DESC');
    const { all } = await readAllPages((offset) => recallFacts({ since: since.toISOString(), limit: 100, offset }), 100);
    expect(all).toEqual(expected);
  });

  test('the no-filter arm pages through the whole source', async () => {
    const expected = await sqlOrder(`source_id = 'default'`, [], 'COALESCE(valid_from, created_at) DESC, id DESC');
    const { all } = await readAllPages((offset) => recallFacts({ limit: 100, offset }), 100);
    expect(all).toEqual(expected);
  });
});

describe('recall offset: pages across merged lists', () => {
  test('an entity read under two slugs pages across both', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = ANY($1::text[])`,
      [['companies/acme-paging', 'acme-paging']], 'valid_from DESC, id DESC');
    expect(expected).toHaveLength(240);
    const unpaged = await recallFacts({ entity: 'companies/acme-paging', limit: 100 });
    expect(unpaged.some((f) => f.startsWith('acme-bare-'))).toBe(true); // both slugs are read
    const { all } = await readAllPages((offset) => recallFacts({ entity: 'companies/acme-paging', limit: 100, offset }), 100);
    expect(all).toEqual(expected);
  });

  // The merge keeps each source's own order and sorts by the arm's time key,
  // stable: a tie across sources goes to the source granted first.
  const grantOrder = `array_position(ARRAY['paging-a','paging-b']::text[], source_id)`;
  const fedWhere = `source_id = ANY($1::text[])`;
  const fedSources = [['paging-a', 'paging-b']];
  for (const [arm, params, orderBy] of [
    ['no-filter', {}, `COALESCE(valid_from, created_at) DESC, ${grantOrder}, id DESC`],
    ['session', { session_id: 'fed-sess' }, `created_at DESC, ${grantOrder}, id DESC`],
  ] as const) {
    test(`a federated grant pages the ${arm} arm across both sources, ties in grant order`, async () => {
      const expected = await sqlOrder(fedWhere, fedSources, orderBy);
      expect(expected).toHaveLength(240);
      expect(await federatedFacts({ ...params, limit: 100 })).toEqual(expected.slice(0, 100));
      const { all, pages } = await readAllPages((offset) => federatedFacts({ ...params, limit: 100, offset }), 100);
      expect(pages).toBe(3);
      expect(new Set(all).size).toBe(240);
      expect(all.filter((f) => f.startsWith('fed-b-'))).toHaveLength(120);
      expect(all).toEqual(expected);
      expect(await federatedFacts({ ...params, limit: 100, offset: 240 })).toEqual([]);
      expect(await federatedFacts({ ...params, limit: 30, offset: 115 })).toEqual(expected.slice(115, 145));
    });
  }

  test('a federated entity in two unlinked sources stays ambiguous at any offset', async () => {
    await engine.executeRaw(`UPDATE facts SET entity_slug = 'shared/thing' WHERE source_session = 'fed-sess' AND fact IN ('fed-a-0', 'fed-b-0')`);
    try {
      for (const offset of [undefined, 0, 100]) {
        const res = await operationsByName['recall'].handler(federated(), { entity: 'shared/thing', ...(offset === undefined ? {} : { offset }) }) as
          { facts: unknown[]; ambiguous_entity?: { candidates: unknown[] } };
        expect(res.facts).toEqual([]);
        expect(res.ambiguous_entity?.candidates).toHaveLength(2);
      }
    } finally {
      await engine.executeRaw(`UPDATE facts SET entity_slug = NULL WHERE source_session = 'fed-sess'`);
    }
  });
});

describe('recall without offset answers what it did before', () => {
  const cases: Array<[string, Record<string, unknown>, string, unknown[], string]> = [
    ['entity', { entity: 'paging/ent' }, `source_id = 'default' AND entity_slug = $1`, ['paging/ent'], 'valid_from DESC, id DESC'],
    ['session', { session_id: 'sess-paging' }, `source_id = 'default' AND source_session = $1`, ['sess-paging'], 'created_at DESC, id DESC'],
    ['no filter', {}, `source_id = 'default'`, [], 'COALESCE(valid_from, created_at) DESC, id DESC'],
  ];
  for (const [name, params, where, args, orderBy] of cases) {
    test(`${name}: the SQL order's first 50 by default and first 100 at limit 100, the same facts as offset 0`, async () => {
      const expected = await sqlOrder(where, args, orderBy);
      expect(await recallFacts(params)).toEqual(expected.slice(0, 50));
      const unpaged = await recallPayload({ ...params, limit: 100 });
      expect(unpaged.facts.map((f) => f.fact)).toEqual(expected.slice(0, 100));
      expect((await recallPayload({ ...params, limit: 100, offset: 0 })).facts).toEqual(unpaged.facts);
    });
  }

  test('a federated read without offset is the merged first 100', async () => {
    const expected = await sqlOrder(`source_id = ANY($1::text[])`, [['paging-a', 'paging-b']],
      `COALESCE(valid_from, created_at) DESC, array_position(ARRAY['paging-a','paging-b']::text[], source_id), id DESC`);
    expect(await federatedFacts({ limit: 100 })).toEqual(expected.slice(0, 100));
    expect(await federatedFacts({})).toEqual(expected.slice(0, 50));
  });
});

describe('recall offset on the MCP surfaces', () => {
  const recallSchema = (surface: 'full' | 'starter') =>
    buildToolDefs(filterOpsForSurface(operations, surface)).find((t) => t.name === 'recall')!.inputSchema as { properties: Record<string, unknown> };

  test('advertised on the full surface, not in the starter list', () => {
    expect(recallSchema('full').properties.offset).toMatchObject({ type: 'number', default: 0 });
    expect(recallSchema('starter').properties.offset).toBeUndefined();
  });

  test('a starter-surface caller that passes offset gets its page', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = $1`, ['paging/ent'], 'valid_from DESC, id DESC');
    const result = await dispatchToolCall(engine, 'recall', { entity: 'paging/ent', limit: 100, offset: 100 },
      { ...local, allowedOps: allowedOpNames(operations, 'starter') });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text!).facts.map((f: { fact: string }) => f.fact)).toEqual(expected.slice(100, 200));
  });
});
