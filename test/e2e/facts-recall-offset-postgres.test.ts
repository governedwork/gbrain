/**
 * E2E — recall's `offset` against real Postgres (parity gate).
 *
 * Mirrors the entity, session and refusal cases of test/facts.test.ts
 * (PGLite) on Postgres, whose timestamps carry microseconds: pages of 100 at
 * offsets 0/100/200 give every fact once in the SQL order (ties broken by
 * id), an offset past the end is empty, a bad offset is invalid_params, and a
 * read without offset is the SQL order's first N. Skips gracefully when
 * DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const local = { remote: false, sourceId: 'default' } as const;
const BASE = '2026-06-01T12:00:00Z';

/** `count` world facts `${label}-${i}`, every 5 sharing one valid_from, one created_at per INSERT. */
async function seed(label: string, count: number, entity: string | null, session: string | null, startMin: number): Promise<void> {
  await getEngine().executeRaw(
    `INSERT INTO facts (source_id, entity_slug, source_session, fact, kind, visibility, source, valid_from)
     SELECT 'default', $1, $2, $3 || '-' || g, 'fact', 'world', 'test',
            $4::timestamptz - (($5::int + g / 5) * interval '1 minute')
       FROM generate_series(0, $6::int - 1) g`,
    [entity, session, label, BASE, startMin, count],
  );
}

async function sqlOrder(where: string, params: unknown[], orderBy: string): Promise<string[]> {
  const rows = await getEngine().executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE ${where} ORDER BY ${orderBy}`, params);
  return rows.map((r) => r.fact);
}

async function recallFacts(params: Record<string, unknown>): Promise<string[]> {
  const result = await dispatchToolCall(getEngine(), 'recall', params, local);
  if (result.isError) throw new Error(result.content[0].text);
  return (JSON.parse(result.content[0].text!).facts as Array<{ fact: string }>).map((f) => f.fact);
}

beforeAll(async () => {
  if (!RUN) return;
  await setupDB();
  await seed('ent', 230, 'paging/ent', null, 0);
  await seed('sess', 230, null, 'sess-paging', 5000);
});
afterAll(async () => { if (RUN) await teardownDB(); });

d('recall offset (Postgres)', () => {
  test('the entity arm: pages of 100 at 0/100/200 give every fact once, in the SQL order', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = $1`, ['paging/ent'], 'valid_from DESC, id DESC');
    expect(expected).toHaveLength(230);
    const pages = await Promise.all([0, 100, 200].map((offset) => recallFacts({ entity: 'paging/ent', limit: 100, offset })));
    expect(pages.map((p) => p.length)).toEqual([100, 100, 30]);
    expect(pages.flat()).toEqual(expected);
    expect(await recallFacts({ entity: 'paging/ent', limit: 100, offset: 230 })).toEqual([]);
  });

  test('the session arm pages in its creation-time order', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND source_session = $1`, ['sess-paging'], 'created_at DESC, id DESC');
    expect(expected).toHaveLength(230);
    const pages = await Promise.all([0, 100, 200].map((offset) => recallFacts({ session_id: 'sess-paging', limit: 100, offset })));
    expect(pages.flat()).toEqual(expected);
  });

  test('without offset: the SQL order\'s first 50 and first 100, as before', async () => {
    const expected = await sqlOrder(`source_id = 'default' AND entity_slug = $1`, ['paging/ent'], 'valid_from DESC, id DESC');
    expect(await recallFacts({ entity: 'paging/ent' })).toEqual(expected.slice(0, 50));
    expect(await recallFacts({ entity: 'paging/ent', limit: 100 })).toEqual(expected.slice(0, 100));
  });

  test('offset -1, 1.5 and "x" are invalid_params', async () => {
    for (const offset of [-1, 1.5, 'x']) {
      const result = await dispatchToolCall(getEngine(), 'recall', { entity: 'paging/ent', offset }, local);
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text!);
      expect(err.error).toBe('invalid_params');
      expect(String(err.message)).toContain('offset');
    }
  });
});
