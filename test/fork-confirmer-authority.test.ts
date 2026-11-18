/**
 * governedwork fork (F13): the hosted confirmer's authority on a managed brain.
 *
 * A hosted door confirms through a connection granted exactly `confirm_memory`, writing the brain's own source and
 * reading every other. A marked page's confirm publishes as the journaled owner write `trust_owner_page`, which no grant
 * can name, in the page's own source, which may not be the connection's write source. Two exceptions carry it, each
 * on 737's own mechanism:
 *  - persistence/authority.ts GRANTED_BY: trust_owner_page is checked as confirm_memory (the `granted` mapping an
 *    attested write uses for its attestedOp);
 *  - access/attest-sources.ts ownerPageReadSource / storedOwnerPageReadSource: the owner page write may target a
 *    source the grant reads, live at submission and re-checked against the live grant at publication.
 * And confirm_memory holds a page to what the caller reads (ops/trust.ts, callerAccessAllowedSql), not only its source.
 *
 * Pinned (PGLite, and Postgres when DATABASE_URL is set):
 *  - a confirm_memory-only token confirms a marked page; a grant naming neither operation is refused, nothing raised
 *  - a federated confirm_memory-only token confirms a marked page in its second source; a source it does not read is
 *    not_found, nothing raised
 *  - a page in a source it reads, but naming readers it does not meet, is not_found (marked and unmarked), nothing raised
 *  - authorizeWrite: the source exception holds only for trust_owner_page and only while the live grant reads the source
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { authorizeWrite } from '../src/core/persistence/authority.ts';
import type { Principal, WriteAuthority } from '../src/core/persistence/model.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-fork-confirmer-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };
const SCOPES = ['read', 'write', 'memory_confirm'];

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  __setConfirmationIoForTests({ probe: { stdinIsTTY: false, stdoutIsTTY: false, env: {} } });
}), 120_000);
afterAll(async () => {
  resetGateway();
  __setConfirmationIoForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Source { engine: BrainEngine; sourceId: string; agent: OperationContext }
async function source(engine: BrainEngine): Promise<Source> {
  const sourceId = `conf-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const agent = await mintLegacyToken(engine, { name: `agent-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await readLocalWriter(engine, 'cli');
  return { engine, sourceId, agent: remote(engine, agent.id, [sourceId], ['read', 'write']) };
}
function remote(engine: BrainEngine, id: string, sources: string[], scopes: string[], allowedOperations?: string[]): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: sources[0], dryRun: false, logger: quiet, remote: true, transport: 'http',
    takesHoldersAllowList: ['world'], auth: { token: '', clientId: id, principal: { kind: 'legacy_token', id } as Principal, sourceId: sources[0], allowedSources: sources, scopes,
      ...(allowedOperations ? { allowedOperations } : {}) } } as unknown as OperationContext;
}
/** A token granted exactly `operations`, writing sources[0] and reading every one of `sources`. */
async function token(engine: BrainEngine, sources: string[], operations: string[]): Promise<{ id: string; ctx: OperationContext }> {
  const t = await mintLegacyToken(engine, { name: `tok-${randomUUID().slice(0, 8)}`, scopes: SCOPES, sourceGrant: sources, takesHolders: ['world'], allowedOperations: operations });
  return { id: t.id, ctx: remote(engine, t.id, sources, SCOPES, operations) };
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
async function tier(s: Source, slug: string): Promise<{ tier: string; marker: unknown }> {
  const [r] = await s.engine.executeRaw<{ trust_tier: string; frontmatter: Record<string, unknown> }>('SELECT trust_tier, frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [s.sourceId, slug]);
  return { tier: r!.trust_tier, marker: r!.frontmatter.trust_tier };
}
async function agentPage(s: Source, slug: string): Promise<string> {
  await run(s.agent, 'put_page', { slug, content: page('Marked', `Written by an agent in ${s.sourceId}.`) });
  expect(await tier(s, slug)).toEqual({ tier: 'agent_written', marker: 'agent_written' });
  return `p:${s.sourceId}/${slug}`;
}
async function failure(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { return e as OperationError; }
  throw new Error('expected a refusal');
}

describe('fork F13: the hosted confirmer confirms marked pages on a managed brain', () => {
  test('a confirm_memory-only grant confirms a marked page; a grant naming neither operation is refused', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const s = await source(engine);
      const ref = await agentPage(s, 'notes/only-confirm-example');
      const only = await token(engine, [s.sourceId], ['confirm_memory']);
      expect(await run(only.ctx, 'confirm_memory', { ref })).toMatchObject({ status: 'confirmed', tier: 'user_confirmed', detail: { marker_removed: true } });
      expect(await tier(s, 'notes/only-confirm-example')).toEqual({ tier: 'user_confirmed', marker: undefined });
      const control = await agentPage(s, 'notes/search-only-example');
      const search = await token(engine, [s.sourceId], ['search']);
      expect((await failure(run(search.ctx, 'confirm_memory', { ref: control }))).code).toBe('permission_denied');
      expect(await tier(s, 'notes/search-only-example')).toEqual({ tier: 'agent_written', marker: 'agent_written' });
    }
  }), 120_000);

  test('a federated confirmer confirms a marked page in a source it reads; a source it does not read is not_found', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const own = await source(engine);
      const agents = await source(engine);
      const ref = await agentPage(agents, 'notes/agents-source-example');
      const confirmer = await token(engine, [own.sourceId, agents.sourceId], ['confirm_memory']);
      expect(await run(confirmer.ctx, 'confirm_memory', { ref })).toMatchObject({ status: 'confirmed', tier: 'user_confirmed', detail: { marker_removed: true } });
      expect(await tier(agents, 'notes/agents-source-example')).toEqual({ tier: 'user_confirmed', marker: undefined });
      const third = await source(engine);
      const unread = await agentPage(third, 'notes/agents-source-example');
      expect((await failure(run(confirmer.ctx, 'confirm_memory', { ref: unread }))).code).toBe('not_found');
      expect(await tier(third, 'notes/agents-source-example')).toEqual({ tier: 'agent_written', marker: 'agent_written' });
    }
  }), 120_000);

  test('a page naming readers the confirmer does not meet is not_found, marked or not, though its source is read', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const own = await source(engine);
      const agents = await source(engine);
      const confirmer = await token(engine, [own.sourceId, agents.sourceId], ['confirm_memory']);
      // The unmarked page first: its tier-only confirm runs no journaled write, so only confirm_memory's own check refuses it.
      for (const [slug, marked] of [['notes/readers-plain-example', false], ['notes/readers-marked-example', true]] as const) {
        const ref = await agentPage(agents, slug);
        await engine.transaction(tx => withCoordinatedWrite(tx, [agents.sourceId], () => tx.executeRaw(
          `UPDATE pages SET frontmatter = jsonb_set(${marked ? 'frontmatter' : "frontmatter - 'trust_tier'"}, '{readable_by}', '["member:alice-example"]') WHERE source_id=$1 AND slug=$2`,
          [agents.sourceId, slug]), TEST_WRITE_ATTRIBUTION));
        const before = await tier(agents, slug);
        expect((await failure(run(confirmer.ctx, 'confirm_memory', { ref }))).code, slug).toBe('not_found');
        expect(await tier(agents, slug), slug).toEqual(before);
      }
    }
  }), 120_000);

  test('authorizeWrite: the read-source exception holds only for trust_owner_page, and only while the live grant reads the source', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const own = await source(engine);
      const agents = await source(engine);
      const slug = 'notes/stored-authority-example';
      const [incarnation] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [agents.sourceId]);
      const authority = (id: string, operations = ['confirm_memory']): WriteAuthority => ({ version: 1, principal: { kind: 'legacy_token', id }, remote: true,
        sourceId: agents.sourceId, sourceIncarnation: incarnation!.incarnation, scopes: SCOPES, operations, slugPrefixes: null, takesHolders: ['world'] });
      const reads = await token(engine, [own.sourceId, agents.sourceId], ['confirm_memory', 'put_page']);
      await authorizeWrite(engine, authority(reads.id), 'trust_owner_page', slug);
      // Every other write keeps its one write source: the same grant, granted put_page, may not put a page in a source it only reads.
      const putDenied = await failure(authorizeWrite(engine, authority(reads.id, ['put_page']), 'put_page', slug));
      expect(putDenied.message).toContain('no longer permits this source write');
      const narrowed = await token(engine, [own.sourceId], ['confirm_memory']);
      expect((await failure(authorizeWrite(engine, authority(narrowed.id), 'trust_owner_page', slug))).code).toBe('permission_denied');
    }
  }), 120_000);
});
