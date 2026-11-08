/**
 * A fact or take read by its id (fork patch): `recall {fact_id}`,
 * `takes_list {id}`, and a row contested by a trust proposal naming the
 * proposal's other row (`contested.fact_id` / `contested.take_id`) for a
 * caller that can read it.
 *
 * A reader that was shown a fact or take (a preview before a confirm, the
 * other side of a contested pair) had no remote read of that one row: it
 * paged recall or takes_list until the id turned up, and takes_list orders by
 * created_at alone, so a take tied on created_at across a page edge read as
 * not found.
 *
 * Pinned here on PGLite, through MCP dispatch:
 *  - recall {fact_id} answers the fact in exactly the projection a list read
 *    gives it; an id with no fact answers [] like an empty recall
 *  - every rule recall applies holds on the read by id, each against a
 *    control that does answer the fact: a source the caller is not granted, a
 *    private fact or a private provenance page for a remote caller, an
 *    expired fact (shown with include_expired), the min_trust floor
 *  - takes_list {id} answers that take; an inactive take only with
 *    active: false; a holder outside the token's allow-list and a take in a
 *    source the caller is not granted answer []; two takes sharing created_at
 *    are each found by id
 *  - a pending supersede trust proposal names, on both rows' `contested`,
 *    the other row's id (fact_id for facts, take_id for takes) and the
 *    reader reads that side by it; the text label is unchanged; a caller
 *    that cannot read the other row gets the label without the id: a
 *    private fact for a remote caller, a row outside the caller's granted
 *    sources, a take outside the holder allow-list, a row below the
 *    min_trust floor
 *  - get_page's partial answers (body none, outline, window, auto over the
 *    inline cap) carry the page's created_at and updated_at exactly as a full
 *    read answers them, so a reader paging a large page in windows sees the
 *    same metadata
 *  - refusals: fact_id with question, supersessions, since, entity,
 *    session_id or query; a fact_id or take id that is not a positive
 *    integer (over MCP and at the handler)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { compactTrustLabel, trustFields } from '../src/core/eligibility/labels.ts';

let engine: PGLiteEngine;

const ENTITY = 'companies/acme-example';
const local: DispatchOpts = { remote: false, sourceId: 'default' };
const remote = (...sources: string[]): DispatchOpts =>
  ({ remote: true, sourceId: sources[0], auth: { scopes: ['read'], allowedSources: sources } as never });

interface FactOut { fact_id: string; fact: string; contested?: { proposal_ref: string; role: string; fact_id?: string } }
interface TakeOut { id: number; claim: string; holder: string; contested?: { proposal_ref: string; role: string; take_id?: string } }

async function call<T>(op: string, params: Record<string, unknown>, opts: DispatchOpts): Promise<T> {
  const result = await dispatchToolCall(engine, op, params, opts);
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text!) as T;
}
const recall = (params: Record<string, unknown>, opts: DispatchOpts = local) => call<{ facts: FactOut[]; total: number }>('recall', params, opts);
const recallById = async (id: number | string, opts: DispatchOpts = local, extra: Record<string, unknown> = {}) =>
  (await recall({ fact_id: String(id), ...extra }, opts)).facts;
const takeById = (id: number, opts: DispatchOpts = local, extra: Record<string, unknown> = {}) => call<TakeOut[]>('takes_list', { id, ...extra }, opts);

async function refusal(op: string, params: Record<string, unknown>): Promise<{ error: string; message: string }> {
  const result = await dispatchToolCall(engine, op, params, local);
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0].text!);
}

async function addFact(fact: string, over: { source?: string; entity?: string | null; visibility?: string; expired?: boolean; page?: string } = {}): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from, expired_at, source_markdown_slug)
     VALUES ($1, $2, $3, 'fact', $4, 'test', now() - interval '1 day', $5, $6) RETURNING id`,
    [over.source ?? 'default', over.entity === undefined ? ENTITY : over.entity, fact, over.visibility ?? 'world',
      over.expired ? new Date() : null, over.page ?? null]);
  return Number(row!.id);
}

const setTier = (table: 'facts' | 'takes', id: number, tier: string) =>
  engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE ${table} SET trust_tier = $1 WHERE id = $2`, [tier, id])));

async function propose(action: 'supersede_fact' | 'supersede_take', table: 'facts' | 'takes', target: number, related: number): Promise<string> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO trust_proposals (action, source_id, target_table, target_id, related_table, related_id, proposer)
     VALUES ($1, 'default', $2, $3, $2, $4, 'conflict_slot') RETURNING id`, [action, table, target, related]);
  return `tp${Number(row!.id)}`;
}

const ids: Record<string, number> = {};
const takes: Record<string, number> = {};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['rb-a', 'rb-b']) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);

  ids.first = await addFact('Acme Example was founded in 2019');
  ids.second = await addFact('Acme Example sells grow towers');
  ids.third = await addFact('Acme Example has 40 staff');
  ids.inB = await addFact('Acme Example opened an office in source b', { source: 'rb-b' });
  ids.privateFact = await addFact('Acme Example pays account 11-2222', { visibility: 'private' });
  await engine.putPage('notes/acme-private', { title: 'Private notes', type: 'note', compiled_truth: 'private', frontmatter: { visibility: 'private' } });
  ids.privatePage = await addFact('Acme Example is negotiating with fund-a', { page: 'notes/acme-private' });
  ids.expired = await addFact('Acme Example was based in Oslo', { expired: true });
  ids.confirmed = await addFact('Acme Example is a supplier');
  await setTier('facts', ids.confirmed, 'user_confirmed');

  const page = await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: '## Takes\n' });
  const pageB = await engine.putPage('people/charlie-example', { title: 'Charlie Example', type: 'person', compiled_truth: '## Takes\n' }, { sourceId: 'rb-b' });
  await engine.addTakesBatch([
    { page_id: page.id, row_num: 1, claim: 'Alice Example will raise a seed round', kind: 'bet', holder: 'world', weight: 0.7 },
    { page_id: page.id, row_num: 2, claim: 'Alice Example is a strong operator', kind: 'take', holder: 'dana', weight: 0.8 },
    { page_id: page.id, row_num: 3, claim: 'Alice Example lives in Berlin', kind: 'fact', holder: 'world', weight: 1, active: false },
    { page_id: page.id, row_num: 4, claim: 'Alice Example ships weekly', kind: 'take', holder: 'world', weight: 0.6 },
    { page_id: page.id, row_num: 5, claim: 'Alice Example ships daily', kind: 'take', holder: 'world', weight: 0.6 },
  ]);
  await engine.addTakesBatch([{ page_id: pageB.id, row_num: 1, claim: 'Charlie Example is hiring', kind: 'take', holder: 'world', weight: 0.5 }]);
  const rows = await engine.executeRaw<{ id: number; row_num: number; page_id: number }>('SELECT id, row_num, page_id FROM takes ORDER BY id');
  const byRow = (pageId: number, n: number) => Number(rows.find(r => Number(r.page_id) === pageId && Number(r.row_num) === n)!.id);
  takes.seed = byRow(page.id, 1); takes.dana = byRow(page.id, 2); takes.inactive = byRow(page.id, 3);
  takes.weekly = byRow(page.id, 4); takes.daily = byRow(page.id, 5); takes.inB = byRow(pageB.id, 1);
  await engine.executeRaw(`UPDATE takes SET created_at = '2026-06-01T12:00:00Z' WHERE id = ANY($1::bigint[])`, [[takes.weekly, takes.daily]]);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('recall fact_id', () => {
  test('answers the fact in the projection a list read gives it', async () => {
    const list = (await recall({ entity: ENTITY })).facts;
    const listed = list.find(f => f.fact_id === String(ids.second));
    expect(listed).toBeDefined();
    const answer = await recall({ fact_id: String(ids.second) });
    expect(answer.facts).toEqual([listed!]);
    expect(answer.total).toBe(1);
    for (const id of [ids.first, ids.third]) expect((await recallById(id)).map(f => f.fact_id)).toEqual([String(id)]);
  });

  test('an id with no fact answers an empty list, like an empty recall', async () => {
    const [max] = await engine.executeRaw<{ id: number }>('SELECT max(id) AS id FROM facts');
    const answer = await recall({ fact_id: String(Number(max!.id) + 1000) });
    expect(answer.facts).toEqual([]);
    expect(answer.total).toBe(0);
  });

  test('a fact in a source the caller is not granted answers []', async () => {
    expect(await recallById(ids.inB, remote('rb-a'))).toEqual([]);
    expect(await recallById(ids.inB, remote('default'))).toEqual([]);
    expect((await recallById(ids.inB, remote('rb-b'))).map(f => f.fact_id)).toEqual([String(ids.inB)]);
    expect((await recallById(ids.inB, remote('rb-a', 'rb-b'))).map(f => f.fact_id)).toEqual([String(ids.inB)]);
  });

  test('a private fact and a fact from a private page answer [] to a remote caller', async () => {
    for (const id of [ids.privateFact, ids.privatePage]) {
      expect(await recallById(id, remote('default'))).toEqual([]);
      expect((await recallById(id)).map(f => f.fact_id)).toEqual([String(id)]);
    }
    expect((await recallById(ids.first, remote('default'))).map(f => f.fact_id)).toEqual([String(ids.first)]);
  });

  test('an expired fact answers [] unless include_expired', async () => {
    expect(await recallById(ids.expired)).toEqual([]);
    expect((await recallById(ids.expired, local, { include_expired: true })).map(f => f.fact_id)).toEqual([String(ids.expired)]);
  });

  test('a fact below the min_trust floor answers []', async () => {
    expect(await recallById(ids.first, local, { min_trust: 'user_confirmed' })).toEqual([]);
    expect((await recallById(ids.confirmed, local, { min_trust: 'user_confirmed' })).map(f => f.fact_id)).toEqual([String(ids.confirmed)]);
  });

  test('offset past the one row answers []', async () => {
    expect(await recallById(ids.first, local, { offset: 1 })).toEqual([]);
  });
});

describe('takes_list id', () => {
  test('answers that take', async () => {
    const all = await call<TakeOut[]>('takes_list', { page_slug: 'people/alice-example' }, local);
    const listed = all.find(t => t.id === takes.seed);
    expect(await takeById(takes.seed)).toEqual([listed!]);
  });

  test('an inactive take answers [] unless active: false', async () => {
    expect(await takeById(takes.inactive)).toEqual([]);
    expect((await takeById(takes.inactive, local, { active: false })).map(t => t.id)).toEqual([takes.inactive]);
  });

  test("a holder outside the token's allow-list answers []", async () => {
    const world: DispatchOpts = { remote: true, sourceId: 'default', takesHoldersAllowList: ['world'] };
    expect(await takeById(takes.dana, world)).toEqual([]);
    expect((await takeById(takes.seed, world)).map(t => t.id)).toEqual([takes.seed]);
    expect((await takeById(takes.dana)).map(t => t.holder)).toEqual(['dana']);
  });

  test('a take in a source the caller is not granted answers []', async () => {
    expect(await takeById(takes.inB, remote('default'))).toEqual([]);
    expect((await takeById(takes.inB, remote('rb-b'))).map(t => t.id)).toEqual([takes.inB]);
  });

  test('two takes sharing created_at are each found by id', async () => {
    const [w, d] = await engine.executeRaw<{ created_at: string }>('SELECT created_at::text AS created_at FROM takes WHERE id = ANY($1::bigint[])', [[takes.weekly, takes.daily]]);
    expect(w!.created_at).toBe(d!.created_at);
    expect((await takeById(takes.weekly)).map(t => t.claim)).toEqual(['Alice Example ships weekly']);
    expect((await takeById(takes.daily)).map(t => t.claim)).toEqual(['Alice Example ships daily']);
  });
});

describe('contested names the other row only to a caller that can read it', () => {
  const close = (ref: string) => engine.executeRaw(`UPDATE trust_proposals SET status = 'accepted', decided_at = now() WHERE id = $1`, [Number(ref.slice(2))]);
  const factLabel = async (id: number, opts: DispatchOpts = local, extra: Record<string, unknown> = {}) => (await recallById(id, opts, extra))[0]!.contested;
  const takeLabel = async (id: number, opts: DispatchOpts = local, extra: Record<string, unknown> = {}) => (await takeById(id, opts, extra))[0]!.contested;

  test('a supersede_fact proposal: each side names the other, and the reader reads it by that id', async () => {
    const ref = await propose('supersede_fact', 'facts', ids.first, ids.third);
    const challenger = await factLabel(ids.third);
    expect(challenger).toEqual({ proposal_ref: ref, role: 'challenger', fact_id: String(ids.first) });
    expect(await factLabel(ids.first)).toEqual({ proposal_ref: ref, role: 'challenged', fact_id: String(ids.third) });
    expect((await recallById(challenger!.fact_id!)).map(f => f.fact)).toEqual(['Acme Example was founded in 2019']);
    // The text label still names only the proposal.
    expect(compactTrustLabel({ ...trustFields('agent_written', null), contested: challenger as never })).toBe(`[written by an agent · legacy · contested ${ref}]`);
    await close(ref);
    expect(await factLabel(ids.third)).toBeUndefined();
  });

  test('the other fact private to a remote caller: the label without fact_id', async () => {
    const ref = await propose('supersede_fact', 'facts', ids.privateFact, ids.second);
    expect(await factLabel(ids.second, remote('default'))).toEqual({ proposal_ref: ref, role: 'challenger' });
    expect(await factLabel(ids.second)).toEqual({ proposal_ref: ref, role: 'challenger', fact_id: String(ids.privateFact) });
    await close(ref);
  });

  test('the other fact outside the caller\'s granted sources: the label without fact_id', async () => {
    const ref = await propose('supersede_fact', 'facts', ids.inB, ids.second);
    expect(await factLabel(ids.second, remote('default'))).toEqual({ proposal_ref: ref, role: 'challenger' });
    expect(await factLabel(ids.second, remote('default', 'rb-b'))).toEqual({ proposal_ref: ref, role: 'challenger', fact_id: String(ids.inB) });
    await close(ref);
  });

  test('the other fact below the min_trust floor: the label without fact_id', async () => {
    const ref = await propose('supersede_fact', 'facts', ids.first, ids.confirmed);
    expect(await factLabel(ids.confirmed, local, { min_trust: 'user_confirmed' })).toEqual({ proposal_ref: ref, role: 'challenger' });
    expect(await factLabel(ids.confirmed)).toEqual({ proposal_ref: ref, role: 'challenger', fact_id: String(ids.first) });
    await close(ref);
  });

  test('a supersede_take proposal: each side names the other, and the reader reads it by that id', async () => {
    const ref = await propose('supersede_take', 'takes', takes.weekly, takes.daily);
    const challenger = await takeLabel(takes.daily);
    expect(challenger).toEqual({ proposal_ref: ref, role: 'challenger', take_id: String(takes.weekly) });
    expect(await takeLabel(takes.weekly)).toEqual({ proposal_ref: ref, role: 'challenged', take_id: String(takes.daily) });
    expect((await takeById(Number(challenger!.take_id))).map(t => t.claim)).toEqual(['Alice Example ships weekly']);
    await close(ref);
  });

  test('the other take outside the holder allow-list: the label without take_id', async () => {
    const ref = await propose('supersede_take', 'takes', takes.dana, takes.seed);
    const world: DispatchOpts = { remote: true, sourceId: 'default', takesHoldersAllowList: ['world'] };
    expect(await takeLabel(takes.seed, world)).toEqual({ proposal_ref: ref, role: 'challenger' });
    expect(await takeLabel(takes.seed)).toEqual({ proposal_ref: ref, role: 'challenger', take_id: String(takes.dana) });
    await close(ref);
  });

  test('the other take outside the caller\'s granted sources: the label without take_id', async () => {
    const ref = await propose('supersede_take', 'takes', takes.inB, takes.seed);
    expect(await takeLabel(takes.seed, remote('default'))).toEqual({ proposal_ref: ref, role: 'challenger' });
    expect(await takeLabel(takes.seed, remote('default', 'rb-b'))).toEqual({ proposal_ref: ref, role: 'challenger', take_id: String(takes.inB) });
    await close(ref);
  });

  test('the other take below the min_trust floor: the label without take_id', async () => {
    await setTier('takes', takes.seed, 'user_confirmed');
    const ref = await propose('supersede_take', 'takes', takes.weekly, takes.seed);
    expect(await takeLabel(takes.seed, local, { min_trust: 'user_confirmed' })).toEqual({ proposal_ref: ref, role: 'challenger' });
    expect(await takeLabel(takes.seed)).toEqual({ proposal_ref: ref, role: 'challenger', take_id: String(takes.weekly) });
    await close(ref);
  });
});

describe("get_page's partial answers carry the page's timestamps", () => {
  test('body none, outline, window and auto over the inline cap answer created_at and updated_at as a full read does', async () => {
    const big = Array.from({ length: 6000 }, (_, i) => `Line ${i} of the Acme Example log, long enough to fill the page past the inline cap.`).join('\n');
    await engine.putPage('notes/acme-example-log', { title: 'Acme Example log', type: 'note', compiled_truth: big });
    await engine.executeRaw(`UPDATE pages SET created_at = '2026-01-02T03:04:05.678Z', updated_at = '2026-06-07T08:09:10.123Z' WHERE slug = 'notes/acme-example-log'`);
    const full = await call<Record<string, unknown>>('get_page', { slug: 'notes/acme-example-log' }, local);
    expect(full.updated_at).toBe('2026-06-07T08:09:10.123Z');
    expect(full.created_at).toBe('2026-01-02T03:04:05.678Z');
    for (const params of [{ body: 'none' }, { body: 'outline' }, { body: 'window', lines: { from: 1, count: 20 } }, { body: 'auto' }]) {
      const partial = await call<Record<string, unknown>>('get_page', { slug: 'notes/acme-example-log', ...params }, local);
      expect(partial.body).toBe(params.body === 'auto' ? 'outline' : params.body);
      expect({ created_at: partial.created_at, updated_at: partial.updated_at }).toEqual({ created_at: full.created_at, updated_at: full.updated_at });
    }
  });
});

describe('refusals', () => {
  for (const [name, params] of [
    ['question', { question: 'where is Acme Example based?' }],
    ['supersessions', { supersessions: true }],
    ['since', { since: '2 days ago' }],
    ['entity', { entity: ENTITY }],
    ['session_id', { session_id: 'sess-1' }],
    ['query', { query: 'acme' }],
  ] as const) {
    test(`fact_id with ${name} is invalid_params naming it`, async () => {
      const err = await refusal('recall', { fact_id: String(ids.first), ...params });
      expect(err.error).toBe('invalid_params');
      expect(err.message).toContain('fact_id');
      expect(err.message).toContain(name);
    });
  }

  for (const bad of ['abc', '0', '-1', '1.5', ' 7', '007', '99999999999999999999', 7]) {
    test(`fact_id ${JSON.stringify(bad)} is invalid_params`, async () => {
      const err = await refusal('recall', { fact_id: bad });
      expect(err.error).toBe('invalid_params');
      expect(err.message).toContain('fact_id');
    });
  }

  test('a malformed fact_id is invalid_params at the handler too', async () => {
    const ctx = { engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    for (const bad of ['x', 0, 7, '1e3']) {
      const err = await operationsByName['recall'].handler(ctx, { fact_id: bad }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('invalid_params');
    }
  });

  for (const bad of [0, -1, 1.5, '7']) {
    test(`takes_list id ${JSON.stringify(bad)} is invalid_params`, async () => {
      const err = await refusal('takes_list', { id: bad });
      expect(err.error).toBe('invalid_params');
      expect(err.message).toContain('id');
    });
  }
});
