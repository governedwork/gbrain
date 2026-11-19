// A withdrawal mirror keeps the page's trust tier (#5575 ENG-1).
//
// forget_fact commits the withdrawal in the database; the withdrawal-mirror
// effect later persists the struck facts-fence row into the page body with
// materializePageSnapshot. That rewrite authors nothing: the page keeps the
// tier it had. Without a keep scope the rewrite ran under the maintenance
// actor's undeclared tier and stamped the page down to `unknown`. A forget's
// reason is the forgetter's own text in the fact's context cell, written
// under the forgetter's tier, so the fact's tier is not asserted kept here.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { materializePageSnapshot } from '../src/core/page-state/materialize.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'materialize-trust-example';
let engine: PGLiteEngine;
let home: string;

const ctx = () => ({ engine, sourceId: SOURCE, remote: false, dryRun: false, config: { engine: 'pglite', embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} } }) as OperationContext;
const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const call = (name: string, params: Record<string, unknown>) =>
  inHome(async () => await operations.find(o => o.name === name)!.handler(ctx(), params) as Record<string, unknown>);

const pageRow = async (slug: string) => (await engine.executeRaw<{ trust_tier: string; compiled_truth: string }>(
  'SELECT trust_tier, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]))[0];
const factRow = async (id: number) => (await engine.executeRaw<{ trust_tier: string; expired_at: Date | null; context: string | null }>(
  'SELECT trust_tier, expired_at, context FROM facts WHERE id=$1', [id]))[0];

/** A page with one remembered fact in its fence; both agent_written. Returns the fact id. */
async function seedPageWithFact(slug: string, fact: string): Promise<number> {
  const put = await inHome(() => submitPageMutation(ctx(), { operation: 'put_page', waitMs: 30_000,
    params: { request_id: randomUUID(), slug, content: `---\ntitle: ${slug}\ntype: note\n---\n\nBody.\n` } }));
  expect(put.state).toBe('committed');
  const remembered = await call('remember', { entity: slug, fact, provenance: 'materialize trust test fixture', request_id: randomUUID() });
  expect(remembered.status).toBe('inserted');
  const id = Number(remembered.id);
  expect((await pageRow(slug)).trust_tier).toBe('agent_written');
  expect((await pageRow(slug)).compiled_truth).toContain(fact);
  expect((await pageRow(slug)).compiled_truth).not.toContain(`~~${fact}~~`);
  expect((await factRow(id)).trust_tier).toBe('agent_written');
  // The withdrawal-mirror effect is run by hand below; no background consumer may race it.
  await inHome(() => disposePersistenceConsumer(engine));
  return id;
}

/**
 * After the forget: no consumer runs, and the stored body still holds the live
 * row at the page's own tier, so the hand-run materialize below is the only
 * writer that strikes it, and the only one that could change the tier.
 */
async function expectUnmaterialized(slug: string, fact: string): Promise<void> {
  await inHome(() => disposePersistenceConsumer(engine));
  const page = await pageRow(slug);
  expect(page.compiled_truth).toContain(fact);
  expect(page.compiled_truth).not.toContain(`~~${fact}~~`);
  expect(page.trust_tier).toBe('agent_written');
}

/** What the withdrawal-mirror effect does for a page without a worktree: persist the struck overlay. */
async function materialize(slug: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: SOURCE, includeDeleted: true });
  expect(snapshot).not.toBeNull();
  await inHome(() => materializePageSnapshot(engine, snapshot!));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-materialize-trust-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await inHome(async () => {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  });
}, 120_000);

afterAll(async () => {
  await inHome(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

describe('materializePageSnapshot after forget_fact', () => {
  test('L151: the struck fence row is persisted and the page keeps its agent_written tier', async () => {
    const fact = 'Widget-co ships the materialize example.';
    const id = await seedPageWithFact('notes/materialize-a', fact);

    // A forget that does not commit throws; a committed one expires the fact.
    await call('forget_fact', { id, request_id: randomUUID() });
    expect((await factRow(id)).expired_at).not.toBeNull();
    await expectUnmaterialized('notes/materialize-a', fact);

    await materialize('notes/materialize-a');

    const page = await pageRow('notes/materialize-a');
    expect(page.compiled_truth).toContain(`~~${fact}~~`);
    expect(page.trust_tier).toBe('agent_written');
  }, 120_000);

  test('L151: after a forget with a reason, the page keeps its agent_written tier', async () => {
    const fact = 'Widget-co ships the reasoned forget example.';
    const id = await seedPageWithFact('notes/materialize-b', fact);

    await call('forget_fact', { id, reason: 'user asked', request_id: randomUUID() });
    const after = await factRow(id);
    expect(after.expired_at).not.toBeNull();
    expect(after.context).toContain('forgotten: user asked');
    await expectUnmaterialized('notes/materialize-b', fact);

    await materialize('notes/materialize-b');

    const page = await pageRow('notes/materialize-b');
    expect(page.compiled_truth).toContain(`~~${fact}~~`);
    expect(page.trust_tier).toBe('agent_written');
  }, 120_000);
});
