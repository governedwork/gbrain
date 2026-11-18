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
