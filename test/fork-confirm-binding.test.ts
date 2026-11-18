/**
 * governedwork fork (F14): confirm_memory takes an expected binding, and a row's binding covers every field.
 *
 * A hosted door previews a row for a person (a dry run of confirm_memory, which answers the row's binding) and confirms
 * bound to it, so the confirm applies only to what the person saw. Built on upstream's preview binding (#7657): the op
 * refuses a binding that already moved, and applyOwnerAction re-checks it inside its write. A fact's binding covers the
 * columns that say what it asserts, how it is qualified and who reads it (visibility; its provenance page's readers);
 * a take's its weight, dates, source and resolution.
 *
 * Pinned (PGLite, and Postgres when DATABASE_URL is set): a dry run answers the binding and a call bound to it confirms;
 * a fact edited after its preview in any bound column, a fact whose provenance page gained readers, a take whose weight
 * moved and a page edited since are refused preview_changed with nothing raised; a binding that is not a string is
 * invalid_params.
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
import type { Principal } from '../src/core/persistence/model.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-fork-binding-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };

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

interface Brain { engine: BrainEngine; sourceId: string; agent: OperationContext; confirmer: OperationContext }
async function brain(engine: BrainEngine): Promise<Brain> {
  const sourceId = `bind-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const agent = await mintLegacyToken(engine, { name: `agent-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  const confirmer = await mintLegacyToken(engine, { name: `confirm-${sourceId}`, scopes: ['read', 'write', 'memory_confirm'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await readLocalWriter(engine, 'cli');
  const remote = (id: string, scopes: string[]) => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet,
    remote: true, transport: 'http', takesHoldersAllowList: ['world'],
    auth: { token: '', clientId: id, principal: { kind: 'legacy_token', id } as Principal, sourceId, allowedSources: [sourceId], scopes } }) as unknown as OperationContext;
  return { engine, sourceId, agent: remote(agent.id, ['read', 'write']), confirmer: remote(confirmer.id, ['read', 'write', 'memory_confirm']) };
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
async function failure(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { return e as OperationError; }
  throw new Error('expected a refusal');
}
const factTier = async (b: Brain, id: number) => (await b.engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM facts WHERE id=$1', [id]))[0]!.trust_tier;
async function agentFact(b: Brain, fact: string, entity = 'people/alice-example'): Promise<number> {
  return Number((await run(b.agent, 'remember', { fact, provenance: 'chat', entity })).id);
}
async function preview(b: Brain, ref: string): Promise<string> {
  const dry = await run({ ...b.confirmer, dryRun: true } as OperationContext, 'confirm_memory', { ref });
  expect(dry).toMatchObject({ dry_run: true, ref });
  expect(typeof dry.binding).toBe('string');
  return dry.binding as string;
}
const edit = (b: Brain, sql: string, params: unknown[]) =>
  b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));

describe('fork F14: confirm_memory bound to the preview the user approved', () => {
  test('a dry run answers the binding; a call bound to it confirms only that exact row', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const kept = await agentFact(b, 'Alice prefers green tea');
      expect(await run(b.confirmer, 'confirm_memory', { ref: `f${kept}`, binding: await preview(b, `f${kept}`) })).toMatchObject({ status: 'confirmed' });
      expect(await factTier(b, kept)).toBe('user_confirmed');
      // A fact edited after its preview, in columns recall does not answer and in one it does: refused, its tier unchanged.
      for (const [column, value] of [['visibility', 'private'], ['notability', 'low'], ['confidence', 0.2], ['valid_until', '2030-01-01T00:00:00Z'],
        ['attributed_to', 'assistant'], ['source_session', 'session-example'], ['claim_value', 42], ['fact', 'Alice prefers black tea']] as const) {
        const id = await agentFact(b, `Alice prefers tea number ${column}`);
        const bound = await preview(b, `f${id}`);
        const [was] = await engine.executeRaw<Record<string, unknown>>(`SELECT ${column} AS v FROM facts WHERE id = $1`, [id]);
        await edit(b, `UPDATE facts SET ${column} = $2 WHERE id = $1`, [id, value]);
        const [now] = await engine.executeRaw<Record<string, unknown>>(`SELECT ${column} AS v FROM facts WHERE id = $1`, [id]);
        expect(String(now!.v), `${column} was ${String(was!.v)}`).not.toBe(String(was!.v));
        const edited = await factTier(b, id);
        expect(edited, column).not.toBe('user_confirmed');
        expect((await failure(run(b.confirmer, 'confirm_memory', { ref: `f${id}`, binding: bound }))).code, column).toBe('preview_changed');
        expect(await factTier(b, id), column).toBe(edited);
        // Control: unbound, the same call confirms the row as it now is.
        expect(await run(b.confirmer, 'confirm_memory', { ref: `f${id}` }), column).toMatchObject({ status: 'confirmed' });
      }
      expect((await failure(run(b.confirmer, 'confirm_memory', { ref: `f${kept}`, binding: 7 }))).code).toBe('invalid_params');
    }
  }), 180_000);

  test('a fact whose provenance page gained readers since its preview is refused', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      await run(b.agent, 'put_page', { slug: 'people/carol-example', content: page('Carol-example', 'Leads a team.') });
      const id = await agentFact(b, 'Carol-example leads the widget team', 'people/carol-example');
      // The fact's provenance page: the entity page its fence row lives on (placed by hand when this brain keeps it database-only).
      await edit(b, `UPDATE facts SET source_markdown_slug = COALESCE(source_markdown_slug, 'people/carol-example') WHERE id = $1`, [id]);
      const bound = await preview(b, `f${id}`);
      await edit(b, `UPDATE pages SET frontmatter = jsonb_set(frontmatter, '{readable_by}', '["member:carol-example"]') WHERE source_id=$1 AND slug=$2`, [b.sourceId, 'people/carol-example']);
      expect((await failure(run(b.confirmer, 'confirm_memory', { ref: `f${id}`, binding: bound }))).code).toBe('preview_changed');
      expect(await factTier(b, id)).not.toBe('user_confirmed');
    }
  }), 180_000);

  test('a take whose weight moved and a page edited since their previews are refused', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'notes/take-binding-example';
      await run(b.agent, 'put_page', { slug, content: page('Takes', 'A page that holds a take.') });
      await run(b.agent, 'takes_add', { slug, claim: 'Acme-example ships in Q3', kind: 'bet', holder: 'world', weight: 0.6 });
      const [take] = await engine.executeRaw<{ id: number }>('SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = $2', [b.sourceId, slug]);
      const takeBound = await preview(b, `t${take!.id}`);
      await edit(b, 'UPDATE takes SET weight = 0.1 WHERE id = $1', [take!.id]);
      expect((await failure(run(b.confirmer, 'confirm_memory', { ref: `t${take!.id}`, binding: takeBound }))).code).toBe('preview_changed');
      const pslug = 'notes/page-binding-example';
      await run(b.agent, 'put_page', { slug: pslug, content: page('Bound', 'First text.') });
      const ref = `p:${b.sourceId}/${pslug}`;
      const pageBound = await preview(b, ref);
      await run(b.agent, 'put_page', { slug: pslug, content: page('Bound', 'Second text.'), force: true });
      expect((await failure(run(b.confirmer, 'confirm_memory', { ref, binding: pageBound }))).code).toBe('preview_changed');
      const [row] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, pslug]);
      expect(row!.trust_tier).toBe('agent_written');
      expect(await run(b.confirmer, 'confirm_memory', { ref, binding: await preview(b, ref) })).toMatchObject({ status: 'confirmed' });
    }
  }), 180_000);
});
