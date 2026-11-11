/**
 * confirm_memory on a page answers the revision the confirm left the page at (fork patch).
 *
 * A caller that reads a confirmed page back could not tell the page the confirm wrote from one edited right after:
 * the answer named no revision. A page confirm now answers `detail.revision`, the page's knowledge_revision read in
 * the confirm's own transaction (on a managed brain, the publication receipt's revision, which the coordinator reads
 * in the publication transaction after apply).
 *
 * Pinned on PGLite:
 *  - managed, a page without the CEO-21 marker (tier only): the revision is the one before and after the confirm
 *  - managed, a page carrying `trust_tier: unknown`, and an agent page carrying `trust_tier: agent_written`: the
 *    revision is the page's after the confirm, not the one before; a later agent edit moves the page past it
 *  - managed, already confirmed (unchanged): the current revision
 *  - managed, a large (windowed, inline) page with a `## Facts` fence row at agent_written: the revision moves to the
 *    answered one and the fence row keeps its tier
 *  - managed, a marked page stored in segments (the frontmatter flip): the answered revision is the page's after
 *  - unmanaged (importFromContent / tier only): the same two answers through confirmPage
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { confirmPage } from '../src/core/trust/page-handlers.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-trust-confirm-revision-'));
const quiet = { info() {}, warn() {}, error() {} };
let engine: BrainEngine;
let sourceId: string;
let agent: OperationContext;
let confirmer: OperationContext;

const line = (i: number) => `- ${String(i).padStart(8, '0')} acme-example journal line with enough text to fill a page quickly\n`;
const bigBody = (bytes: number) => Array.from({ length: Math.ceil(bytes / line(0).length) }, (_, i) => line(i)).join('');
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
const FACTS = ['## Facts', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Acme-example ships widgets | fact | 1.0 | world | medium | 2017-01-01 |  | chat |  |', '<!--- gbrain:facts:end -->', ''].join('\n');
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const ref = (slug: string) => `p:${sourceId}/${slug}`;
const preview = async (r: string) => (await run({ ...confirmer, dryRun: true } as OperationContext, 'confirm_memory', { ref: r })).binding as string;
async function row(slug: string) {
  const [r] = await engine.executeRaw<{ id: number; trust_tier: string; frontmatter: Record<string, unknown>; knowledge_revision: string; body_storage: string | null }>(
    `SELECT id, trust_tier, frontmatter, knowledge_revision::text AS knowledge_revision, body_storage FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
  return r!;
}
const rawEdit = (sql: string, params: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const confirm = async (slug: string) => run(confirmer, 'confirm_memory', { ref: ref(slug), binding: await preview(ref(slug)) });
async function unmanaged<T>(fn: () => Promise<T>): Promise<T> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
  sourceId = `rev-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const agentTok = await mintLegacyToken(engine, { name: `agent-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  const confirmTok = await mintLegacyToken(engine, { name: `confirm-${sourceId}`, scopes: ['read', 'write', 'memory_confirm'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await readLocalWriter(engine, 'cli');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  const remote = (id: string, scopes: string[]) => ({ ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
    auth: { token: '', clientId: id, principal: { kind: 'legacy_token', id } as Principal, sourceId, allowedSources: [sourceId], scopes } }) as unknown as OperationContext;
  agent = remote(agentTok.id, ['read', 'write']);
  confirmer = remote(confirmTok.id, ['read', 'write', 'memory_confirm']);
  __setConfirmationIoForTests({ probe: { stdinIsTTY: false, stdoutIsTTY: false, env: {} } });
}), 180_000);

afterAll(async () => {
  resetGateway();
  __setConfirmationIoForTests(null);
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('confirm_memory answers the revision the page confirm left', () => {
  test('a page without the marker (tier only): the answered revision is the page\'s before and after', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/plain-revision-example';
    await run(agent, 'put_page', { slug, content: page('Plain', 'No marker here.') });
    await rawEdit(`UPDATE pages SET frontmatter = frontmatter - 'trust_tier' WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
    const before = await row(slug);
    expect(before.frontmatter.trust_tier).toBeUndefined();
    expect(before.trust_tier).not.toBe('user_confirmed');
    const result = await confirm(slug);
    expect(result).toMatchObject({ status: 'confirmed', tier: 'user_confirmed', detail: { marker_removed: false } });
    const after = await row(slug);
    expect(after.trust_tier).toBe('user_confirmed');
    expect(result.detail.revision).toBe(before.knowledge_revision);
    expect(result.detail.revision).toBe(after.knowledge_revision);
    // Already confirmed, no marker: unchanged answers the current revision.
    const again = await confirm(slug);
    expect(again).toMatchObject({ status: 'unchanged', detail: { revision: after.knowledge_revision } });
  }), 180_000);

  test('a page carrying trust_tier: unknown, and an agent page carrying its marker: the answered revision is the page\'s after, not before', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const unknown = 'notes/unknown-marker-revision-example';
    await run(agent, 'put_page', { slug: unknown, content: page('Unknown marker', 'Marked unknown.') });
    await rawEdit(`UPDATE pages SET trust_tier='unknown', frontmatter = jsonb_set(frontmatter, '{trust_tier}', '"unknown"') WHERE source_id=$1 AND slug=$2`, [sourceId, unknown]);
    const agentSlug = 'notes/agent-marker-revision-example';
    await run(agent, 'put_page', { slug: agentSlug, content: page('Agent marker', 'Written by an agent.') });
    for (const [slug, marker] of [[unknown, 'unknown'], [agentSlug, 'agent_written']] as const) {
      const before = await row(slug);
      expect(before.frontmatter.trust_tier, slug).toBe(marker);
      const result = await confirm(slug);
      expect(result, slug).toMatchObject({ status: 'confirmed', tier: 'user_confirmed', detail: { marker_removed: true } });
      const after = await row(slug);
      expect({ tier: after.trust_tier, marker: after.frontmatter.trust_tier }, slug).toEqual({ tier: 'user_confirmed', marker: undefined });
      expect(after.knowledge_revision, slug).not.toBe(before.knowledge_revision);
      expect(result.detail.revision, slug).toBe(after.knowledge_revision);
      // A later edit moves the page past the answered revision: the caller can tell the two apart.
      await run(agent, 'put_page', { slug, content: page('Edited', 'Edited after the confirm.'), force: true });
      expect((await row(slug)).knowledge_revision, slug).not.toBe(result.detail.revision);
    }
  }), 180_000);

  test('a large windowed page with a ## Facts fence row at agent_written: the revision moves to the answered one; the fence row keeps its tier', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/windowed-facts-revision-example';
    await run(agent, 'put_page', { slug, content: page('Windowed facts', `${FACTS}\n${bigBody(400_000)}`) });
    const before = await row(slug);
    expect(before.body_storage === null || before.body_storage === 'inline', String(before.body_storage)).toBe(true);
    expect(before.frontmatter.trust_tier).toBe('agent_written');
    const facts = async () => engine.executeRaw<{ id: number; trust_tier: string }>('SELECT id, trust_tier FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id', [sourceId, slug]);
    const factsBefore = await facts();
    expect(factsBefore.length).toBeGreaterThan(0);
    expect(factsBefore.every(f => f.trust_tier === 'agent_written'), JSON.stringify(factsBefore)).toBe(true);
    const result = await confirm(slug);
    expect(result).toMatchObject({ status: 'confirmed', detail: { marker_removed: true } });
    const after = await row(slug);
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(result.detail.revision).toBe(after.knowledge_revision);
    expect(await facts()).toEqual(factsBefore);
  }), 180_000);

  test('a marked page stored in segments (the frontmatter flip): the answered revision is the page\'s after', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/segmented-revision-example';
    await run(agent, 'put_page', { slug, content: page('Segmented', bigBody(1_200_000)) });
    const before = await row(slug);
    expect(before.body_storage).toBe('segmented');
    expect(before.frontmatter.trust_tier).toBe('agent_written');
    const result = await confirm(slug);
    expect(result).toMatchObject({ status: 'confirmed', detail: { marker_removed: true } });
    const after = await row(slug);
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(result.detail.revision).toBe(after.knowledge_revision);
  }), 180_000);

  test('unmanaged: importFromContent answers the revision it wrote; a tier-only confirm the unchanged one', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const marked = 'notes/unmanaged-marked-revision-example';
    const plain = 'notes/unmanaged-plain-revision-example';
    await run(agent, 'put_page', { slug: marked, content: page('Unmanaged marked', 'Agent text.') });
    await run(agent, 'put_page', { slug: plain, content: page('Unmanaged plain', 'No marker.') });
    await rawEdit(`UPDATE pages SET frontmatter = frontmatter - 'trust_tier' WHERE source_id=$1 AND slug=$2`, [sourceId, plain]);
    await unmanaged(async () => {
      for (const slug of [marked, plain]) {
        const before = await row(slug);
        const result = await confirmPage(engine, { sourceId, slug, expectedRevision: before.knowledge_revision, confirmation: { via: 'cli' } as never });
        const after = await row(slug);
        expect({ status: result.status, marker_removed: result.marker_removed, tier: after.trust_tier }, slug)
          .toEqual({ status: 'confirmed', marker_removed: slug === marked, tier: 'user_confirmed' });
        expect(result.revision, slug).toBe(after.knowledge_revision);
        if (slug === marked) expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
        else expect(after.knowledge_revision).toBe(before.knowledge_revision);
      }
    });
  }), 180_000);
});
