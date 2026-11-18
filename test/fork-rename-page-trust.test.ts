// Ours (governedwork fork): rename_page keeps trust tiers.
//
// A rename moves no content: the page keeps its id and body, and its
// slug-keyed facts move with it. The trust triggers count `slug` and
// `entity_slug` as content columns, so without a keep scope a rename would
// stamp the page and its facts down to the renamer's undeclared tier
// (agent_written -> unknown). The move to a new brain renames pages, and a
// rename must not drift trust.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import type { WriteAttribution } from '../src/core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'rename-trust-example';
let engine: PGLiteEngine;
let home: string;

const ctx = () => ({ engine, sourceId: SOURCE, remote: false, dryRun: false, config: { engine: 'pglite', embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} } }) as OperationContext;
const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const call = (name: string, params: Record<string, unknown>) =>
  inHome(async () => await operations.find(o => o.name === name)!.handler(ctx(), params) as Record<string, unknown>);

const pageTier = async (slug: string) => (await engine.executeRaw<{ trust_tier: string }>(
  'SELECT trust_tier FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]))[0]?.trust_tier;
const factTiers = async (slug: string) => (await engine.executeRaw<{ trust_tier: string }>(
  'SELECT trust_tier FROM facts WHERE source_id=$1 AND entity_slug=$2 ORDER BY id', [SOURCE, slug])).map(r => r.trust_tier);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-rename-trust-'));
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

describe('rename_page and trust tiers', () => {
  test('a local rename keeps the page tier and the tier of the facts it moves', async () => {
    const put = await inHome(() => submitPageMutation(ctx(), { operation: 'put_page', waitMs: 30_000,
      params: { request_id: randomUUID(), slug: 'notes/trust-a', content: '---\ntitle: A\ntype: note\n---\n\nBody.\n' } }));
    expect(put.state).toBe('committed');
    const remembered = await call('remember', { entity: 'notes/trust-a', fact: 'Widget-co ships the trust example.',
      provenance: 'rename trust test fixture', request_id: randomUUID() });
    expect(remembered.status).toBe('inserted');

    const pageBefore = await pageTier('notes/trust-a');
    const factsBefore = await factTiers('notes/trust-a');
    expect(pageBefore).toBe('agent_written');
    expect(factsBefore).toEqual(['agent_written']);

    const snapshot = (await engine.readPageSnapshot('notes/trust-a', { sourceId: SOURCE }))!;
    const renamed = await call('rename_page', { slug: 'notes/trust-a', new_slug: 'notes/trust-b',
      expected_revision: snapshot.revision, request_id: randomUUID() });
    expect(renamed.status).toBe('renamed');

    expect(await pageTier('notes/trust-b')).toBe(pageBefore);
    expect(await factTiers('notes/trust-b')).toEqual(factsBefore);
  }, 120_000);
});

// Every slug move outside rename_page (sync renames, rename-identity and file
// repair, the rename-collision and sync-hold moves) runs engine.updateSlug
// inside its caller's writer scope. The move authors nothing, so the page and
// the facts it re-keys keep their tier whatever tier the mover declares: an
// owner-tier sync must not raise them, an undeclared mover must not lower them.
describe('slug moves outside rename_page and trust tiers', () => {
  const seedPageWithFact = async (slug: string, fact: string): Promise<number> => {
    const put = await inHome(() => submitPageMutation(ctx(), { operation: 'put_page', waitMs: 30_000,
      params: { request_id: randomUUID(), slug, content: `---\ntitle: ${slug}\ntype: note\n---\n\nBody.\n` } }));
    expect(put.state).toBe('committed');
    const remembered = await call('remember', { entity: slug, fact, provenance: 'slug move trust test fixture', request_id: randomUUID() });
    expect(remembered.status).toBe('inserted');
    expect(await pageTier(slug)).toBe('agent_written');
    expect(await factTiers(slug)).toEqual(['agent_written']);
    return (await engine.readPageSnapshot(slug, { sourceId: SOURCE }))!.page.id;
  };
  const moveSlug = (from: string, to: string, trust?: WriteAttribution['trust']) => inHome(() => engine.transaction(tx =>
    withCoordinatedWrite(tx, [SOURCE], () => tx.updateSlug(from, to, { sourceId: SOURCE }),
      { requestId: null, principal: { kind: 'local_cli', id: 'slug-move-trust-test' }, ...(trust ? { trust } : {}) })));
  const pageIdsAt = async (slug: string) => (await engine.executeRaw<{ id: number }>(
    'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug])).map(r => Number(r.id));

  test('L107: an owner-tier (operator_curated) slug move keeps the page and its facts agent_written', async () => {
    const pageId = await seedPageWithFact('notes/trust-c', 'Widget-co ships the owner move example.');
    expect(await moveSlug('notes/trust-c', 'notes/trust-d', { tier: 'operator_curated', origin: null })).toBe(1);
    expect(await pageIdsAt('notes/trust-c')).toEqual([]);
    expect(await pageIdsAt('notes/trust-d')).toEqual([pageId]);
    expect(await pageTier('notes/trust-d')).toBe('agent_written');
    expect(await factTiers('notes/trust-d')).toEqual(['agent_written']);
  }, 120_000);

  test('L107: a slug move with no declared tier keeps the page and its facts agent_written', async () => {
    const pageId = await seedPageWithFact('notes/trust-e', 'Widget-co ships the undeclared move example.');
    expect(await moveSlug('notes/trust-e', 'notes/trust-f')).toBe(1);
    expect(await pageIdsAt('notes/trust-e')).toEqual([]);
    expect(await pageIdsAt('notes/trust-f')).toEqual([pageId]);
    expect(await pageTier('notes/trust-f')).toBe('agent_written');
    expect(await factTiers('notes/trust-f')).toEqual(['agent_written']);
  }, 120_000);
});
