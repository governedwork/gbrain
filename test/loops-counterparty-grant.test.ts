/**
 * Fork: open_loops names a counterparty page only when the caller may read that page (governedwork/gbrain).
 *
 * Sync resolves a mail correspondent to a person page across sources (src/core/google/counterparty.ts: an email
 * alias or an identity twin in ANY other source) and records that page's slug and source on the loop. A remote
 * caller must not learn of a page it cannot read: one outside its grant, or one inside it that its page read access
 * closes (readable_by naming someone else). Such a loop comes back by its email alone (slug and source withheld, the
 * loop never dropped, count unchanged), and a `counterparty` slug filter matches only a readable page. Trusted local
 * reads keep every name. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;
const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
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
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter) VALUES
       ('daily', 'people/alice-private', 'person', 'Alice', 'x', '{}'::jsonb),
       ('biz', 'people/bob', 'person', 'Bob', 'x', '{}'::jsonb),
       ('biz', 'people/dana', 'person', 'Dana', 'x', '{"readable_by": ["erin-example"]}'::jsonb)`,
  );
  // alice's page sits in `daily` (outside the grant), bob's in `biz` (inside, open), dana's in `biz` (inside, but its
  // readers name only erin), carol has none.
  await upsertOpenLoop(engine, loop('01', 'alice@example.com', 'people/alice-private', 'daily'));
  await upsertOpenLoop(engine, loop('02', 'bob@example.com', 'people/bob', 'biz'));
  await upsertOpenLoop(engine, loop('03', 'carol@example.com', null, null));
  await upsertOpenLoop(engine, loop('04', 'dana@example.com', 'people/dana', 'biz'));
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

type Flat = { loops: Array<{ counterparty_slug: string | null; counterparty_email: string | null }>; count: number };
type Grouped = { groups: Array<{ counterparty: string; counterparty_slug: string | null; counterparty_source_id: string | null; counterparty_email: string | null }> };
const slugOf = (r: Flat, email: string) => r.loops.find(l => l.counterparty_email === email)?.counterparty_slug;

describe('open_loops counterparty fence', () => {
  test('flat: a page outside the grant or closed by its readers is withheld; the loop stays', async () => {
    const r = await openLoopsOp.handler(ctx(), { group_by: 'none', source_id: 'g1' }) as Flat;
    expect(r.count).toBe(4);
    expect(slugOf(r, 'alice@example.com')).toBeNull();
    expect(slugOf(r, 'dana@example.com')).toBeNull();
    expect(slugOf(r, 'bob@example.com')).toBe('people/bob');
  });

  test('grouped: withheld pages group by email and carry no slug or source', async () => {
    const r = await openLoopsOp.handler(ctx(), { source_id: 'g1', limit: 10 }) as Grouped;
    const json = JSON.stringify(r);
    expect(json).not.toContain('alice-private');
    expect(json).not.toContain('people/dana');
    expect(json).not.toContain('daily');
    const bob = r.groups.find(g => g.counterparty_email === 'bob@example.com');
    expect(bob?.counterparty_slug).toBe('people/bob');
    expect(bob?.counterparty_source_id).toBe('biz');
  });

  test('a counterparty slug filter matches only a readable page; the email arm still matches', async () => {
    for (const slug of ['people/alice-private', 'people/dana']) {
      const r = await openLoopsOp.handler(ctx(), { group_by: 'none', source_id: 'g1', counterparty: slug }) as Flat;
      expect(r.count).toBe(0);
    }
    const bob = await openLoopsOp.handler(ctx(), { group_by: 'none', source_id: 'g1', counterparty: 'people/bob' }) as Flat;
    expect(bob.count).toBe(1);
    const byEmail = await openLoopsOp.handler(ctx(), { group_by: 'none', source_id: 'g1', counterparty: 'dana@example.com' }) as Flat;
    expect(byEmail.count).toBe(1);
    expect(byEmail.loops[0]?.counterparty_slug).toBeNull();
  });

  test('a member the page readers name reads its slug', async () => {
    const r = await withCallerAccess({ identity: ['member:erin-example'] },
      () => openLoopsOp.handler(ctx(), { group_by: 'none', source_id: 'g1' })) as Flat;
    expect(slugOf(r, 'dana@example.com')).toBe('people/dana');
    expect(slugOf(r, 'alice@example.com')).toBeNull();
  });

  test('a trusted local read keeps every name', async () => {
    const r = await openLoopsOp.handler(ctx({ remote: false, auth: undefined }), { group_by: 'none', all_sources: true }) as Flat;
    expect(slugOf(r, 'alice@example.com')).toBe('people/alice-private');
    expect(slugOf(r, 'dana@example.com')).toBe('people/dana');
  });
});
