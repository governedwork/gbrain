/**
 * open_loops names a counterparty only by a page inside the caller's grant (fork patch, governedwork/gbrain).
 *
 * Sync resolves a mail correspondent to a person page across sources (src/core/google/counterparty.ts: an email
 * alias or an identity twin in ANY other source) and records that page's slug and source on the loop. A remote
 * caller granted the mail source but not the source that page sits in must not learn the page exists: the loop
 * comes back by its email alone (slug and source withheld, the loop never dropped), and a `counterparty` slug
 * filter matches only a page inside the grant. Trusted local reads keep every name. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';

let engine: PGLiteEngine;
const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at) VALUES
       ('g1', 'g1', '{"kind":"google"}'::jsonb, now()),
       ('biz', 'biz', '{}'::jsonb, now()),
       ('daily', 'daily', '{}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
  );
  // alice's page sits in `daily` (outside the grant), bob's in `biz` (inside), carol has none.
  await upsertOpenLoop(engine, loop('01', 'alice@example.com', 'people/alice-private', 'daily'));
  await upsertOpenLoop(engine, loop('02', 'bob@example.com', 'people/bob', 'biz'));
  await upsertOpenLoop(engine, loop('03', 'carol@example.com', null, null));
});

function loop(n: string, email: string, slug: string | null, slugSource: string | null): OpenLoopUpsert {
  const threadId = `18c2f4a9b3d21e${n}`;
  return {
    sourceId: 'g1',
    dedupKey: `thread:${threadId}:unanswered_inbound`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: email,
    counterpartySlug: slug,
    counterpartySourceId: slugSource,
    summary: `Reply owed to ${email} (2d)`,
    evidence: [{ message_id: threadId, quote: 'Can you review the plan?' }],
    threadId,
    detector: 'deterministic_thread',
  };
}

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: undefined,
    auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['g1', 'biz'] },
    ...over,
  } as OperationContext;
}

type Row = Record<string, unknown>;
const grouped = (c: OperationContext, extra: Row = {}) =>
  openLoopsOp.handler(c, { limit: 50, ...extra }) as Promise<{ groups: Array<Row & { loops: Row[] }>; count: number }>;
const flat = (c: OperationContext, extra: Row = {}) =>
  openLoopsOp.handler(c, { group_by: 'none', ...extra }) as Promise<{ loops: Row[]; count: number }>;

describe('open_loops counterparty inside the grant', () => {
  test('remote grouped: a page outside the grant is withheld, the loop kept under its email', async () => {
    const res = await grouped(ctx());
    expect(res.count).toBe(3);
    const alice = res.groups.find((g) => g.counterparty_email === 'alice@example.com')!;
    expect(alice.counterparty).toBe('alice@example.com');
    expect(alice.counterparty_slug).toBeNull();
    expect(alice.counterparty_source_id).toBe('g1');
    expect(alice.loops[0]!.counterparty_slug).toBeNull();
    const bob = res.groups.find((g) => g.counterparty_email === 'bob@example.com')!;
    expect(bob.counterparty_slug).toBe('people/bob');
    expect(bob.counterparty_source_id).toBe('biz');
    expect(JSON.stringify(res)).not.toContain('alice-private');
    expect(JSON.stringify(res)).not.toContain('daily');
  });

  test('remote flat: the same', async () => {
    const res = await flat(ctx());
    expect(res.count).toBe(3);
    expect(JSON.stringify(res)).not.toContain('alice-private');
    expect(res.loops.find((l) => l.counterparty_email === 'bob@example.com')!.counterparty_slug).toBe('people/bob');
  });

  test('remote narrowed by source_id: a page in another granted source still shows, the grant decides', async () => {
    const res = await grouped(ctx(), { source_id: 'g1' });
    expect(res.groups.find((g) => g.counterparty_email === 'bob@example.com')!.counterparty_slug).toBe('people/bob');
    expect(JSON.stringify(res)).not.toContain('alice-private');
  });

  test('remote counterparty filter: a slug outside the grant matches nothing; inside it and by email match', async () => {
    expect((await flat(ctx(), { counterparty: 'people/alice-private' })).count).toBe(0);
    expect((await flat(ctx(), { counterparty: 'people/bob' })).count).toBe(1);
    const byEmail = await flat(ctx(), { counterparty: 'alice@example.com' });
    expect(byEmail.count).toBe(1);
    expect(JSON.stringify(byEmail)).not.toContain('alice-private');
  });

  test('remote scalar grant: only the bound source counts as inside', async () => {
    const res = await grouped(ctx({ sourceId: 'g1', auth: { token: 't', clientId: 'c', scopes: ['read'] } as OperationContext['auth'] }));
    expect(res.groups.every((g) => g.counterparty_slug === null)).toBe(true);
    expect(res.count).toBe(3);
  });

  test('trusted local keeps every name', async () => {
    const res = await grouped(ctx({ remote: false, sourceId: 'g1', auth: undefined }), { include_context: false });
    expect(res.groups.find((g) => g.counterparty_email === 'alice@example.com')!.counterparty_slug).toBe('people/alice-private');
    expect((await flat(ctx({ remote: false, sourceId: 'g1', auth: undefined }), { counterparty: 'people/alice-private' })).count).toBe(1);
  });
});
