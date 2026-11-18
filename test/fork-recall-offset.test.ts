/**
 * Fork: `recall` pages its fact lists with `offset`, over the COLLAPSED order (src/core/facts/recall-page.ts).
 *
 * recall answers at most 100 facts and collapses copies of one claim after each arm reads (#7043), so a caller
 * reading an entity with more facts pages it. A page is a window of the collapsed newest-first order: a group of
 * copies stands at its newest member's place, is shown on exactly one page, and counts every copy there, even a
 * copy far past that page in the raw order. Pinned on PGLite through the real op:
 *  - 230 distinct facts on one entity, paged by 100: each fact exactly once, page one equal to the unpaged read
 *  - copies of one claim spread over raw rows 0, 150 and 220 answer one row with collapsed_count 3 on page one,
 *    and on no other page (the discrimination: a per-page SQL offset shows the claim again on later pages)
 *  - the session and the no-filter arms page the same way
 *  - bad offsets, offset with question and offset with supersessions are invalid_params
 *  - a list past RECALL_PAGED_ROWS_MAX is refused rather than answered short
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { RECALL_PAGED_ROWS_MAX } from '../src/core/facts/recall-page.ts';

let engine: PGLiteEngine;
const ENTITY = 'companies/acme-example';
const CLAIM = 'Acme Example ships on Fridays.';

async function call(params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, 'recall', params, { remote: false, sourceId: 'default' });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}

/** `count` distinct facts `${label}-${g}` one minute apart, newest first by g; `entity`/`session` optional. */
async function seed(label: string, count: number, entity: string | null, session: string | null, base = '2026-06-01T12:00:00Z') {
  await asOwner(engine, tx => tx.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, source_session, fact, kind, visibility, source, valid_from, created_at)
     SELECT 'default', $1, $2, $3 || '-' || g, 'fact', 'world', 'test', $4::timestamptz - g * interval '1 minute', $4::timestamptz - g * interval '1 minute'
       FROM generate_series(0, $5::int - 1) g`, [entity, session, label, base, count]));
}

async function copyAt(minutesBefore: number) {
  await asOwner(engine, tx => tx.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from, created_at)
     VALUES ('default', $1, $2, 'fact', 'world', 'test', $3::timestamptz - $4::int * interval '1 minute' + interval '30 seconds',
             $3::timestamptz - $4::int * interval '1 minute' + interval '30 seconds')`, [ENTITY, CLAIM, '2026-06-01T12:00:00Z', minutesBefore]));
}

async function pageAll(params: Record<string, unknown>, limit: number) {
  const pages: Array<Array<Record<string, any>>> = [];
  for (let offset = 0; ; offset += limit) {
    const { isError, body } = await call({ ...params, limit, offset });
    expect(isError).toBe(false);
    const facts = body.facts as Array<Record<string, any>>;
    if (facts.length === 0) return pages;
    pages.push(facts);
    if (pages.length > 20) throw new Error('pager did not end');
  }
}

describe('recall offset over the collapsed order', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    await dispatchToolCall(engine, 'put_page', { slug: ENTITY, content: '---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nA company.\n' }, { remote: false, sourceId: 'default' });
    await seed('acme', 230, ENTITY, null);
    // Three copies of one claim: just before raw rows 0, 150 and 220 of the entity's order.
    await copyAt(0); await copyAt(150); await copyAt(220);
    await seed('session', 150, null, 'sess-1', '2025-06-01T12:00:00Z');
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('an entity pages every fact once, and a claim\'s copies are one row on one page with every copy counted', async () => {
    const pages = await pageAll({ entity: ENTITY }, 100);
    expect(pages.map(p => p.length)).toEqual([100, 100, 31]);
    const all = pages.flat();
    const texts = all.map(f => f.fact);
    expect(new Set(texts).size).toBe(texts.length);
    for (let g = 0; g < 230; g++) expect(texts).toContain(`acme-${g}`);
    const claim = all.filter(f => f.fact === CLAIM);
    expect(claim).toHaveLength(1);
    expect(claim[0]!.collapsed_count).toBe(3);
    expect(pages[0]!.some(f => f.fact === CLAIM)).toBe(true);
    // Page one is the unpaged read: the same rows in the same order.
    const unpaged = (await call({ entity: ENTITY, limit: 100 })).body.facts as Array<Record<string, any>>;
    expect(pages[0]!.map(f => f.id)).toEqual(unpaged.map(f => f.id));
  });

  test('the session and no-filter arms page the same way', async () => {
    const session = (await pageAll({ session_id: 'sess-1' }, 60)).flat().map(f => f.fact);
    expect(session).toHaveLength(150);
    expect(new Set(session).size).toBe(150);
    const everything = (await pageAll({}, 100)).flat();
    expect(everything).toHaveLength(230 + 1 + 150);
    expect(everything.filter(f => f.fact === CLAIM)[0]!.collapsed_count).toBe(3);
  });

  test('an offset past the end answers no facts', async () => {
    expect((await call({ entity: ENTITY, limit: 100, offset: 1000 })).body.facts).toEqual([]);
  });

  test('bad offsets and offset with question or supersessions are invalid_params', async () => {
    for (const offset of [-1, 1.5, 'x']) {
      const { isError, body } = await call({ entity: ENTITY, offset });
      expect(isError).toBe(true);
      expect(JSON.stringify(body)).toContain('invalid_params');
    }
    for (const extra of [{ question: 'when does acme ship?' }, { supersessions: true }]) {
      const { isError, body } = await call({ ...extra, offset: 0 });
      expect(isError).toBe(true);
      expect(JSON.stringify(body)).toContain('offset cannot be combined');
    }
  });

  test('a list longer than the paged-read bound is refused, never answered short', async () => {
    await seed('bulk', RECALL_PAGED_ROWS_MAX + 1, 'companies/bulk-example', null, '2024-06-01T12:00:00Z');
    const { isError, body } = await call({ entity: 'companies/bulk-example', limit: 100, offset: 0 });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain(`at most ${RECALL_PAGED_ROWS_MAX} rows`);
  }, 120_000);
});
