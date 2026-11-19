/**
 * L144: a page rewritten in place keeps removed text in its version history,
 * and nothing short of a page purge can drop it. `prune_page_versions` is the
 * owner-only (trusted local CLI, admin scope) prune: by version id or by
 * keeping the newest N. Planned shape:
 *   prune_page_versions { slug, source_id?, version_ids?: number[], keep?: number, dry_run?: boolean, yes: true }
 *   -> { slug, source_id, pruned: <versions deleted>, ... }
 * cliOnly (like purge_fact), so a remote MCP call gets trusted_local_only.
 * In-process PGLite through the MCP dispatcher (local CLI and remote writer).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operations } from '../src/core/operations.ts';
import { openAppendBrain, type AppendBrain } from './helpers/append-brain.ts';
import { conversationBody } from './helpers/conversation-page.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { fillCommitMarks } from '../src/core/belief/coverage-report.ts';
import { preimageGaps } from '../src/core/belief/preimages.ts';
import { PAGE_VERSION_PRUNES_SCHEMA_SQL } from '../src/core/page-state/version-prune-schema.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.generated.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.generated.ts';
import { parseHistoryPruneArgs } from '../src/commands/history-prune.ts';

const SECRET = 'L144 removed secret sentence that must leave history';
const fm = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n`;

let brain: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain?.close(); }, 60_000);

type Version = { id: number; compiled_truth?: string; timeline?: string };
const history = async (slug: string): Promise<Version[]> => {
  const res = await brain.call('get_versions', { slug, include_body: true, limit: 50 });
  expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
  return res.body as unknown as Version[];
};
const put = async (slug: string, body: string) => {
  const res = await brain.call('put_page', { slug, content: fm('Prune') + body, request_id: randomUUID(), force: true });
  expect(res.body.error, JSON.stringify(res.body).slice(0, 400)).toBeUndefined();
};
const carries = (v: Version) => `${v.compiled_truth ?? ''}\n${v.timeline ?? ''}`.includes(SECRET);

/** A page written three times: the first body holds SECRET, later ones do not. Returns the version holding SECRET and all ids. */
async function seededPage(slug: string) {
  await put(slug, `Intro of ${slug}.\n\n${SECRET}\n`);
  await put(slug, `Intro of ${slug}, rewritten without the sentence.\n`);
  await put(slug, `Intro of ${slug}, rewritten a second time.\n`);
  const versions = await history(slug);
  const secret = versions.filter(carries);
  expect(secret).toHaveLength(1);
  return { secretId: Number(secret[0]!.id), ids: versions.map(v => Number(v.id)) };
}

describe('prune_page_versions (L144)', () => {
  test('L144: prune_page_versions is a registered admin, owner-only (cliOnly) operation', () => {
    const op = operations.find(o => o.name === 'prune_page_versions');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('admin');
    expect(op!.mutating).toBe(true);
    expect(op!.cliOnly).toBeDefined();
    // A replay of pruned ids answers not_found, so the op is not idempotent.
    expect(op!.idempotent).toBe(false);
  });

  test('L144: pruning one version removes its text from get_versions history and keeps every other version and the live page', async () => {
    const slug = 'notes/l144-prune-one';
    const { secretId, ids } = await seededPage(slug);
    const liveBefore = await brain.body(slug);

    const res = await brain.call('prune_page_versions', { slug, version_ids: [secretId], yes: true });
    expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
    expect(res.body.pruned).toBe(1);

    const after = await history(slug);
    expect(after.some(carries)).toBe(false);
    expect(after.map(v => Number(v.id))).toEqual(ids.filter(id => id !== secretId));
    const stored = await brain.engine.executeRaw('SELECT 1 FROM page_versions WHERE id = $1', [secretId]);
    expect(stored).toHaveLength(0);
    expect(await brain.body(slug)).toEqual(liveBefore);
  }, 60_000);

  test('L144: a prune marks the pruned history as upstream retention does (successor_pruned, version_history_gap_at)', async () => {
    const slug = 'notes/l144-prune-marks';
    await put(slug, `First body of ${slug}.\n`);
    const { secretId, ids } = await seededPage(slug);
    // Newest first: the version before the secret one (older, kept) loses its successor.
    const before = ids[ids.indexOf(secretId) + 1];
    expect(before).toBeDefined();
    const gap = async () => (await brain.engine.executeRaw<{ gap: unknown }>('SELECT version_history_gap_at AS gap FROM pages WHERE slug = $1', [slug]))[0]!.gap;
    expect(await gap()).toBeNull();

    const res = await brain.call('prune_page_versions', { slug, version_ids: [secretId], yes: true });
    expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
    const kept = await brain.engine.executeRaw<{ id: number; successor_pruned: boolean }>('SELECT id, successor_pruned FROM page_versions WHERE id = ANY($1::int[])', [ids.filter(id => id !== secretId)]);
    expect(kept.filter(v => v.successor_pruned).map(v => Number(v.id))).toEqual([before!]);
    expect(await gap()).not.toBeNull();
  }, 60_000);

  test('L144: keep N prunes all but the newest N versions of the page', async () => {
    const slug = 'notes/l144-prune-keep';
    const { ids } = await seededPage(slug);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const res = await brain.call('prune_page_versions', { slug, keep: 1, yes: true });
    expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
    expect(res.body.pruned).toBe(ids.length - 1);
    const after = await history(slug);
    expect(after.map(v => Number(v.id))).toEqual([ids[0]!]);
    expect(after.some(carries)).toBe(false);
  }, 60_000);

  test('L144: a remote MCP caller is refused trusted_local_only and nothing is pruned', async () => {
    const slug = 'notes/l144-prune-remote';
    const { secretId, ids } = await seededPage(slug);

    const res = await brain.call('prune_page_versions', { slug, version_ids: [secretId], yes: true }, { remote: true });
    expect(res.isError).toBe(true);
    // The fix names the dry run of the form the call used (never the irreversible --yes).
    expect(JSON.stringify(res.body.fix)).toContain('--version');
    expect(JSON.stringify(res.body.fix)).not.toContain('--yes');
    const byKeep = await brain.call('prune_page_versions', { slug, keep: 1, yes: true }, { remote: true });
    expect(JSON.stringify(byKeep.body.fix)).toContain('--keep');
    expect(JSON.stringify(byKeep.body.fix)).not.toContain('--yes');
    // The canonical code; the wire `error` keeps its legacy name (permission_denied) for every cliOnly op (cliOnlyRefusal).
    expect(res.body.code).toBe('trusted_local_only');
    const after = await history(slug);
    expect(after.map(v => Number(v.id))).toEqual(ids);
    expect(after.filter(carries).map(v => Number(v.id))).toEqual([secretId]);
  }, 60_000);
  test('L144: a dry run (no yes) lists what a prune would delete and deletes nothing; an unknown version id refuses the whole prune', async () => {
    const slug = 'notes/l144-prune-dry';
    const { secretId, ids } = await seededPage(slug);
    const dry = await brain.call('prune_page_versions', { slug, keep: 1 });
    expect(dry.isError, JSON.stringify(dry.body).slice(0, 400)).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, pruned: 0, would_prune: ids.length - 1, version_ids: ids.slice(1), kept: 1 });
    const bad = await brain.call('prune_page_versions', { slug, version_ids: [secretId, 987654321], yes: true });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toBe('not_found');
    expect((await history(slug)).map(v => Number(v.id))).toEqual(ids);
  }, 60_000);

  test('L144: a pruned segmented version releases the rows only it held; their text leaves page_segment_texts after the standard grace', async () => {
    const slug = 'notes/l144-prune-segmented';
    const secret = 'L144 segmented secret sentence that must leave segment storage.';
    await brain.seed(slug, fm('Segmented') + `Intro.\n\n${secret}\n\n` + conversationBody(1_250_000, { seed: 44 }) + '\n');
    expect((await brain.body(slug)).storage).toBe('segmented');
    const revision = (await brain.call('get_page', { slug, body: 'none' })).body.revision as string;
    const edit = await brain.call('edit_page', { slug, expected_revision: revision, request_id: randomUUID(), edits: [{ old_text: secret, new_text: 'Replaced.' }] });
    expect(edit.body.error, JSON.stringify(edit.body).slice(0, 400)).toBeUndefined();
    const holding = async () => (await brain.engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM page_segment_texts WHERE source_id = 'default' AND position(convert_to($1, 'UTF8') in body) > 0", [secret]))[0]!.n;
    expect(await holding()).toBeGreaterThan(0);
    const versions = await history(slug);
    expect(versions.length).toBeGreaterThan(0);

    const res = await brain.call('prune_page_versions', { slug, keep: 0, yes: true });
    expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
    expect(res.body.pruned).toBe(versions.length);
    expect(res.body.segment_rows_released).toBeGreaterThan(0);
    // The standard insert grace still protects the released text (another write of the source may have just deduped onto it).
    expect(await holding()).toBeGreaterThan(0);
    await brain.engine.sweepSegments({ sourceId: 'default', now: new Date(Date.now() + 2 * 3_600_000) });
    expect(await holding()).toBe(0);
    expect((await brain.body(slug)).truth).toContain('Replaced.');
  }, 600_000);

  test('L144: both schema blobs carry the prune record, and a pruned history is not a belief preimage gap', async () => {
    expect(SCHEMA_SQL).toContain(PAGE_VERSION_PRUNES_SCHEMA_SQL.trim());
    expect(PGLITE_SCHEMA_SQL).toContain(PAGE_VERSION_PRUNES_SCHEMA_SQL.trim());
    await enableBeliefLedger(brain.engine, 'default');
    const slug = 'notes/l144-prune-ledger';
    await seededPage(slug);
    const gapsOf = async () => { await fillCommitMarks(brain.engine, 'default'); return (await preimageGaps(brain.engine, 'default', { deep: true })).filter(g => g.slug === slug); };
    expect(await gapsOf()).toEqual([]);

    const res = await brain.call('prune_page_versions', { slug, keep: 0, yes: true });
    expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
    expect(await history(slug)).toEqual([]);
    expect(await gapsOf()).toEqual([]);
    // Control: without the prune record the same missing versions read as gaps.
    await brain.engine.executeRaw("DELETE FROM page_version_prunes WHERE page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1)", [slug]);
    expect((await gapsOf()).length).toBeGreaterThan(0);
  }, 120_000);

  test('L144: gbrain history prune parses --keep / --version and is a dry run without --yes', () => {
    expect(parseHistoryPruneArgs(['notes/a', '--keep', '2']).params).toEqual({ slug: 'notes/a', keep: 2, dry_run: true });
    expect(parseHistoryPruneArgs(['notes/a', '--version', '7', '--version=9', '--yes', '--source', 'wiki'])).toEqual({
      params: { slug: 'notes/a', version_ids: [7, 9], yes: true }, source: 'wiki', json: false });
    expect(parseHistoryPruneArgs(['notes/a', '--keep', '1', '--yes', '--dry-run']).params.dry_run).toBe(true);
    // An empty --source is refused, not read as the default source.
    expect(() => parseHistoryPruneArgs(['notes/a', '--keep', '1', '--source='])).toThrow('--source needs a value');
    expect(() => parseHistoryPruneArgs(['notes/a', '--keep', '1', '--source', ''])).toThrow('--source needs a value');
    for (const bad of [['notes/a'], ['notes/a', '--keep', '1', '--version', '2'], ['notes/a', '--keep', 'x'], ['--keep', '1'], ['notes/a', '--keep', '1', '--bogus']]) {
      expect(() => parseHistoryPruneArgs(bad)).toThrow();
    }
  });
  test('L144: a version a pending trust proposal reverts to is kept and listed held, whichever form names it', async () => {
    const slug = 'notes/l144-prune-held';
    const { secretId, ids } = await seededPage(slug);
    const [page] = await brain.engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    const [proposal] = await brain.engine.executeRaw<{ id: number }>(`INSERT INTO trust_proposals (action, source_id, target_table, target_id, before_state, proposer)
      VALUES ('lower_page', 'default', 'pages', $1, jsonb_build_object('slug', $2::text, 'prior_tier', 'owner', 'version_id', $3::int), 'test') RETURNING id`,
    [Number(page!.id), slug, secretId]);
    const res = await brain.call('prune_page_versions', { slug, keep: 0, yes: true });
    expect(res.isError, JSON.stringify(res.body).slice(0, 400)).toBe(false);
    expect(res.body.held).toEqual([{ id: secretId, reason: 'trust_proposal', ref: `tp${proposal!.id}` }]);
    expect(res.body.pruned).toBe(ids.length - 1);
    expect((await history(slug)).map(v => Number(v.id))).toEqual([secretId]);
    const named = await brain.call('prune_page_versions', { slug, version_ids: [secretId], yes: true });
    expect(named.body).toMatchObject({ pruned: 0, held: [{ id: secretId, reason: 'trust_proposal' }] });
    expect((await history(slug)).map(v => Number(v.id))).toEqual([secretId]);
  }, 60_000);

  test('L144: a registration bound to slug prefixes cannot prune a page outside them', async () => {
    const slug = 'people/l144-prune-fenced';
    const { ids } = await seededPage(slug);
    const op = operations.find(o => o.name === 'prune_page_versions')!;
    const ctx = { engine: brain.engine, config: { engine: 'pglite' }, remote: false, dryRun: false, sourceId: 'default',
      auth: { token: '', clientId: 'fenced-cli', scopes: ['read', 'write', 'admin'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
      logger: { info() {}, warn() {}, error() {} } } as unknown as Parameters<typeof op.handler>[0];
    const refused = await Promise.resolve(op.handler(ctx, { slug, keep: 0, yes: true })).then(() => null, (e: { code?: string }) => e.code);
    expect(refused).toBe('permission_denied');
    expect((await history(slug)).map(v => Number(v.id))).toEqual(ids);
  }, 60_000);
});
