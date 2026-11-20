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
import { maintenanceTransaction, type WriteAttribution } from '../src/core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { moveSlugBindings } from '../src/core/page-state/rename-alias.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { mergeTwinInto } from '../src/core/persistence/twin-merge.ts';
import { movePhantomFacts } from '../src/core/cycle/phantom-redirect.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';
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

// The other slug moves (an unmanaged brain, so the maintenance writers run as
// they do there): the slug bindings a sync rename carries (moveSlugBindings,
// called by updateSlug, carryRenameIdentity and the tombstone merge), the
// tombstone a rename onto an occupied slug re-keys, a twin merged into its
// survivor, and a phantom's facts redirected to its canonical page. Each moves
// rows to a new slug and authors nothing, so an owner-tier row keeps its tier
// whether the mover declares no tier or a lower one.
describe('L107: slug bindings, tombstone re-key, twin merge and phantom redirect keep trust', () => {
  const SRC = 'slug-move-unmanaged-example';
  const OWNER: WriteTrust = { tier: 'operator_curated', origin: null };
  const MOVERS: ReadonlyArray<[string, WriteTrust | undefined]> = [['no declared tier', undefined], ['a lower declared tier', { tier: 'agent_written', origin: null }]];
  let plain: PGLiteEngine;
  beforeAll(async () => {
    plain = new PGLiteEngine();
    await plain.connect({});
    await plain.initSchema();
    await plain.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SRC]);
  }, 120_000);
  afterAll(async () => { await plain.disconnect(); });

  const asOwner = <T>(fn: (tx: PGLiteEngine) => Promise<T>) => maintenanceTransaction(plain, tx => fn(tx as PGLiteEngine), OWNER);
  const seedPage = (slug: string) => asOwner(async tx => {
    await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Body.' }, { sourceId: SRC });
    return Number((await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]))[0].id);
  });
  const seedFact = (fact: string, entity: string, markdown: string | null, rowNum: number | null = null) => asOwner(async tx => Number((await tx.executeRaw<{ id: number }>(
    'INSERT INTO facts (source_id, fact, source, entity_slug, source_markdown_slug, row_num) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [SRC, fact, 'slug move trust fixture', entity, markdown, rowNum]))[0].id));
  const factRow = async (id: number) => (await plain.executeRaw<{ trust_tier: string; entity_slug: string; source_markdown_slug: string | null }>(
    'SELECT trust_tier, entity_slug, source_markdown_slug FROM facts WHERE id=$1', [id]))[0];
  const pageRow = async (id: number) => (await plain.executeRaw<{ trust_tier: string; slug: string; deleted_at: Date | null }>(
    'SELECT trust_tier, slug, deleted_at FROM pages WHERE id=$1', [id]))[0];

  for (const [label, mover] of MOVERS) {
    test(`L107: moveSlugBindings by a mover with ${label} keeps an operator_curated fact's tier`, async () => {
      const slug = `notes/bind-${randomUUID().slice(0, 8)}`;
      const id = await seedFact('Widget-co moves its bindings.', slug, slug, 1);
      expect((await factRow(id)).trust_tier).toBe('operator_curated');
      await maintenanceTransaction(plain, tx => moveSlugBindings(tx, SRC, slug, `${slug}-moved`), mover);
      expect(await factRow(id)).toEqual({ trust_tier: 'operator_curated', entity_slug: `${slug}-moved`, source_markdown_slug: `${slug}-moved` });
    }, 60_000);

    test(`L107: a twin merge by a mover with ${label} keeps the operator_curated tier of the facts it moves`, async () => {
      const key = randomUUID().slice(0, 8);
      const survivor = { page_id: await seedPage(`notes/survivor-${key}`), slug: `notes/survivor-${key}` };
      const twin = { page_id: await seedPage(`notes/twin-${key}`), slug: `notes/twin-${key}` };
      const id = await seedFact('Widget-co merges its twin.', twin.slug, null);
      const [source] = await plain.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [SRC]);
      const merged = await maintenanceTransaction(plain, tx => mergeTwinInto(tx, { sourceId: SRC, incarnation: source.incarnation, survivor, twin }), mover);
      expect(merged.facts_moved).toEqual([id]);
      expect(await factRow(id)).toEqual({ trust_tier: 'operator_curated', entity_slug: survivor.slug, source_markdown_slug: null });
    }, 60_000);

    test(`L107: a phantom redirect by a mover with ${label} keeps the operator_curated tier of the facts it moves`, async () => {
      const key = randomUUID().slice(0, 8);
      const phantom = `notes/phantom-${key}`, canonical = `notes/canonical-${key}`;
      const id = await seedFact('Widget-co redirects its phantom.', phantom, phantom, 1);
      expect(await maintenanceTransaction(plain, tx => movePhantomFacts(tx, SRC, phantom, canonical, new Map([[1, 1]])), mover)).toBe(1);
      expect(await factRow(id)).toEqual({ trust_tier: 'operator_curated', entity_slug: canonical, source_markdown_slug: canonical });
    }, 60_000);
  }

  test('L107: a sync rename onto a tombstone keeps the tier of the tombstone it re-keys, the page it moves and the page\'s facts', async () => {
    const key = randomUUID().slice(0, 8);
    const from = `notes/rename-from-${key}`, to = `notes/rename-to-${key}`;
    const moving = await seedPage(from);
    const tombstone = await seedPage(to);
    await asOwner(tx => tx.softDeletePage(to, { sourceId: SRC }));
    const fact = await seedFact('Widget-co renames onto a tombstone.', from, null);
    expect((await pageRow(tombstone)).trust_tier).toBe('operator_curated');
    expect(await renamePageOntoSlug(plain, { sourceId: SRC, oldSlug: from, newSlug: to, to: `${to}.md` })).toBe('renamed');
    expect(await pageRow(tombstone)).toMatchObject({ trust_tier: 'operator_curated', slug: `${to}~purged-${tombstone}` });
    expect(await pageRow(moving)).toMatchObject({ trust_tier: 'operator_curated', slug: to, deleted_at: null });
    expect(await factRow(fact)).toMatchObject({ trust_tier: 'operator_curated', entity_slug: to });
  }, 60_000);
});
