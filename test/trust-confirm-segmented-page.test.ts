/**
 * The owner confirms a trust-marked page stored in segments (fork patch).
 *
 * confirm_memory on a page carrying the CEO-21 `trust_tier` marker removes the
 * marker through the owner's journaled page write. The write built the page's
 * markdown from its body as one string, so a page stored in segments (a body
 * over 1 MiB) was refused page_body_segmented after its preview bound fine.
 * On a segmented page the marker change is now a frontmatter flip over the
 * live segments (page-prepare.ts prepareSegmentedMetadataMutation, the add_tag
 * flip of spec 6.4): the body is never read whole.
 *
 * Pinned on PGLite, managed brain, through confirm_memory:
 *  - a hosted confirmer (memory_confirm) confirms a marked segmented page: the
 *    tier is user_confirmed, the marker is gone, the body (bytes, generation,
 *    manifest, content_hash) is unchanged, the revision moved, and the write
 *    was the flip (no body staged)
 *  - a binding taken before the page moved still refuses preview_changed and
 *    changes nothing
 *  - an inline marked page confirms as before (marker gone, body unchanged)
 *  - a trust revert of a segmented page refuses as revert_version does
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { readSegmentedBody } from '../src/core/page-body/ingest.ts';
import { segmentedTagWork } from '../src/core/persistence/page-prepare.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { revertPageToVersion } from '../src/core/trust/page-handlers.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-trust-segmented-'));
const quiet = { info() {}, warn() {}, error() {} };
let engine: BrainEngine;
let sourceId: string;
let agent: OperationContext;
let confirmer: OperationContext;

const line = (i: number) => `- ${String(i).padStart(8, '0')} acme-example journal line with enough text to fill a segment quickly\n`;
const bigBody = (bytes: number) => Array.from({ length: Math.ceil(bytes / line(0).length) }, (_, i) => line(i)).join('');
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
async function failure(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { return e as OperationError; }
  throw new Error('expected a refusal');
}

interface Row { id: number; trust_tier: string; frontmatter: Record<string, unknown>; body_storage: string | null; body_generation: string | null;
  body_bytes: string | null; content_hash: string; knowledge_revision: string; compiled_truth: string | null }
async function row(slug: string): Promise<Row> {
  const [r] = await engine.executeRaw<Row>(`SELECT id, trust_tier, frontmatter, body_storage, body_generation::text AS body_generation,
    body_bytes::text AS body_bytes, content_hash, knowledge_revision::text AS knowledge_revision, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
  return r!;
}
/** The stored segmented body's digest and its live manifest, read segment by segment. */
async function segmentedBody(id: number): Promise<{ sha: string; manifest: string }> {
  const hash = createHash('sha256');
  for await (const part of readSegmentedBody(engine, id, sourceId)) hash.update(part.region).update(part.bytes);
  const manifest = await engine.executeRaw<{ seq: number; occurrence_id: string; gen_from: string; gen_to: string | null; region: string; byte_start: string; byte_len: number }>(
    'SELECT seq, occurrence_id::text AS occurrence_id, gen_from::text AS gen_from, gen_to::text AS gen_to, region, byte_start::text AS byte_start, byte_len FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL ORDER BY seq', [id]);
  return { sha: hash.digest('hex'), manifest: JSON.stringify(manifest) };
}
const ref = (slug: string) => `p:${sourceId}/${slug}`;
const preview = async (r: string) => (await run({ ...confirmer, dryRun: true } as OperationContext, 'confirm_memory', { ref: r })).binding as string;

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
  sourceId = `seg-${randomUUID().slice(0, 8)}`;
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

describe('confirm_memory on a trust-marked page stored in segments', () => {
  test('the marker goes and the tier rises; the body stays in its segments, untouched; the revision moves', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/segmented-marked-example';
    await run(agent, 'put_page', { slug, content: page('Segmented marked', bigBody(1_200_000)) });
    const before = await row(slug);
    expect(before.body_storage).toBe('segmented');
    expect(Number(before.body_bytes)).toBeGreaterThan(1024 * 1024);
    expect(before.trust_tier).toBe('agent_written');
    expect(before.frontmatter.trust_tier).toBe('agent_written');
    const body = await segmentedBody(before.id);
    const flips = segmentedTagWork.flips;

    const binding = await preview(ref(slug));
    expect(await run(confirmer, 'confirm_memory', { ref: ref(slug), binding })).toMatchObject({ status: 'confirmed', tier: 'user_confirmed', detail: { marker_removed: true } });

    const after = await row(slug);
    expect(after.trust_tier).toBe('user_confirmed');
    expect(after.frontmatter.trust_tier).toBeUndefined();
    expect(after.frontmatter.title).toBe(before.frontmatter.title);
    expect(after.body_storage).toBe('segmented');
    expect(after.compiled_truth).toBeNull();
    expect({ generation: after.body_generation, bytes: after.body_bytes, hash: after.content_hash }).toEqual({ generation: before.body_generation, bytes: before.body_bytes, hash: before.content_hash });
    expect(await segmentedBody(after.id)).toEqual(body);
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(segmentedTagWork.flips).toBe(flips + 1);
    // Confirming again is a no-op.
    expect(await run(confirmer, 'confirm_memory', { ref: ref(slug) })).toMatchObject({ status: 'unchanged' });
  }), 180_000);

  test('a binding taken before the page moved refuses preview_changed and changes nothing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/segmented-moved-example';
    await run(agent, 'put_page', { slug, content: page('Segmented moved', bigBody(1_100_000)) });
    const binding = await preview(ref(slug));
    await run(agent, 'add_tag', { slug, tag: 'moved-on' });
    const moved = await row(slug);
    expect(moved.body_storage).toBe('segmented');
    expect((await failure(run(confirmer, 'confirm_memory', { ref: ref(slug), binding }))).code).toBe('preview_changed');
    const after = await row(slug);
    expect({ tier: after.trust_tier, marker: after.frontmatter.trust_tier, revision: after.knowledge_revision })
      .toEqual({ tier: moved.trust_tier, marker: 'agent_written', revision: moved.knowledge_revision });
  }), 180_000);

  test('an inline marked page confirms as before: marker gone, tier raised, body unchanged', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/inline-marked-example';
    await run(agent, 'put_page', { slug, content: page('Inline marked', 'Written by an agent, inline.') });
    const before = await row(slug);
    expect(before.body_storage === null || before.body_storage === 'inline').toBe(true);
    expect(before.frontmatter.trust_tier).toBe('agent_written');
    const flips = segmentedTagWork.flips;
    expect(await run(confirmer, 'confirm_memory', { ref: ref(slug), binding: await preview(ref(slug)) })).toMatchObject({ status: 'confirmed', tier: 'user_confirmed', detail: { marker_removed: true } });
    const after = await row(slug);
    expect({ tier: after.trust_tier, marker: after.frontmatter.trust_tier, body: after.compiled_truth }).toEqual({ tier: 'user_confirmed', marker: undefined, body: before.compiled_truth });
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(segmentedTagWork.flips).toBe(flips);
  }), 180_000);

  test('a trust revert of a segmented page refuses as revert_version does, and changes nothing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'notes/segmented-revert-example';
    await run(agent, 'put_page', { slug, content: page('Segmented revert', bigBody(1_100_000)) });
    await run(agent, 'add_tag', { slug, tag: 'versioned' });
    const before = await row(slug);
    const [version] = await engine.executeRaw<{ id: number }>('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id DESC LIMIT 1', [before.id]);
    expect(version).toBeDefined();
    const revision = (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
    const err = await failure(revertPageToVersion(engine, { sourceId, slug, expectedRevision: revision, versionId: Number(version!.id),
      confirmation: { via: 'cli' } as never }));
    expect(err.code).toBe('page_body_segmented');
    expect((await row(slug)).knowledge_revision).toBe(before.knowledge_revision);
  }), 180_000);
});
