/**
 * L152: revert_version (force) of a segmented page whose live generation does
 * not tile (persistence/untiled-revert.ts) versions that unreadable generation
 * as the page's newest version, so every remote get_versions of the page then
 * failed page_body_rows_unreadable. The version stays (it roots the
 * generation's surviving rows and keeps the pre-revert metadata), and
 * get_versions never fails the whole list on one version whose rows do not
 * tile: that version comes back flagged `body_unreadable: true`, without size
 * fields.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody } from './helpers/conversation-page.ts';
import { openAppendBrain, type AppendBrain } from './helpers/append-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { liveGenerationTiling } from '../src/core/page-body/body-tiling.ts';

const BROKEN = 'notes/l152-untiled';
const POISONED = 'notes/l152-poisoned';
const fm = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n`;
const NEEDLE = 'needleword';
const body = (seed: number) => 'Intro.\n\n' + conversationBody(1_250_000, { seed, needles: [{ at: 0.95, word: NEEDLE }] }) + '\n';

for (const kind of testBackends()) {
  describe(`untiled revert history (L152, ${kind})`, () => {
    let brain: AppendBrain;
    const page = async (slug: string) => (await brain.engine.executeRaw<{ id: number; body_generation: string; body_bytes: string }>(
      "SELECT id, body_generation::text AS body_generation, body_bytes::text AS body_bytes FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
    const revision = async (slug: string) => (await brain.call('get_page', { slug, body: 'none' })).body.revision as string;
    /** One local edit: the page gets a segmented version of its preimage and a new live generation. */
    const edit = async (slug: string, from: string, to: string) => {
      const res = await brain.call('edit_page', { slug, expected_revision: await revision(slug), request_id: randomUUID(), edits: [{ old_text: from, new_text: to }] });
      expect(res.body.error, JSON.stringify(res.body).slice(0, 400)).toBeUndefined();
    };

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await brain.seed(BROKEN, fm('Broken') + body(41));
      await brain.seed(POISONED, fm('Poisoned') + body(42));
      expect((await brain.body(BROKEN)).storage).toBe('segmented');
      expect((await brain.body(POISONED)).storage).toBe('segmented');
    }, 600_000);
    afterAll(() => brain?.close(), 120_000);

    test('L152: an untiled revert keeps its unreadable generation as a version (its surviving rows stay rooted), and remote get_versions flags it instead of failing', async () => {
      // One write with two edits far apart: the new generation publishes rows of its own at both places.
      const both = await brain.call('edit_page', { slug: BROKEN, expected_revision: await revision(BROKEN), request_id: randomUUID(),
        edits: [{ old_text: 'Intro.', new_text: 'Intro, edited.' }, { old_text: NEEDLE, new_text: 'needle-edited' }] });
      expect(both.body.error, JSON.stringify(both.body).slice(0, 400)).toBeUndefined();
      const edited = await page(BROKEN);
      const id = Number(edited.id);
      const bad = Number(edited.body_generation);
      const own = async () => (await brain.engine.executeRaw<{ n: number }>(
        'SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2::bigint', [id, bad]))[0]!.n;
      expect(await own()).toBeGreaterThan(1);
      // The state the flip race left: the generation lost its last own row, so it does not tile; its other rows survive.
      const gone = await brain.engine.executeRaw(`DELETE FROM page_body_manifest WHERE (page_id, occurrence_id, gen_from) IN (
        SELECT page_id, occurrence_id, gen_from FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2::bigint
         ORDER BY region DESC, byte_start DESC LIMIT 1) RETURNING seq`, [id, bad]);
      expect(gone).toHaveLength(1);
      expect((await liveGenerationTiling(brain.engine, id))!.tiles).toBe(false);
      const surviving = await own();
      expect(surviving).toBeGreaterThan(0);

      const versions = (await brain.call('get_versions', { slug: BROKEN, limit: 10 })).body as unknown as Array<{ id: number; body_generation?: number }>;
      const target = versions.find(v => v.body_generation !== undefined && Number(v.body_generation) < bad)!;
      expect(target).toBeDefined();
      const res = await brain.call('revert_version', { slug: BROKEN, version_id: target.id, force: true, request_id: randomUUID() }, { remote: true });
      expect(res.body.error, JSON.stringify(res.body).slice(0, 400)).toBeUndefined();
      expect(res.body.status).toBe('reverted');
      expect((await liveGenerationTiling(brain.engine, id))!.tiles).toBe(true);

      // The revert stored the unreadable generation as a version, so a sweep keeps that generation's surviving rows.
      const archived = await brain.engine.executeRaw<{ id: number }>(
        "SELECT id FROM page_versions WHERE page_id=$1 AND body_storage='segmented' AND body_generation=$2::bigint", [id, bad]);
      expect(archived).toHaveLength(1);
      await brain.engine.sweepSegments({ pageId: id });
      expect(await own()).toBe(surviving);

      // The page's history reads for a remote caller, with that version flagged.
      const history = await brain.call('get_versions', { slug: BROKEN, limit: 10 }, { remote: true });
      expect(history.body.error, JSON.stringify(history.body).slice(0, 400)).toBeUndefined();
      expect(history.isError).toBe(false);
      const rows = history.body as unknown as Array<Record<string, unknown>>;
      expect(rows.find(v => Number(v.id) === Number(archived[0]!.id))?.body_unreadable).toBe(true);
      expect(rows.map(v => Number(v.id))).toContain(Number(target.id));
    }, 600_000);

    test('L152: a stored version whose rows do not tile comes back flagged body_unreadable instead of failing remote get_versions', async () => {
      await edit(POISONED, 'Intro.', 'Intro, edited once.');
      const id = Number((await page(POISONED)).id);
      const [readable] = await brain.engine.executeRaw<{ id: number }>(
        "SELECT id FROM page_versions WHERE page_id=$1 AND body_storage='segmented' ORDER BY id DESC LIMIT 1", [id]);
      expect(readable).toBeDefined();
      // A version row whose generation has no manifest rows: it can never be read (a row an earlier untiled revert stored).
      const [poison] = await brain.engine.executeRaw<{ id: number }>(`INSERT INTO page_versions
          (page_id, body_storage, body_generation, body_bytes, content_hash, frontmatter, knowledge_revision, title, type, tags, is_deleted, source_path)
        SELECT page_id, body_storage, 987654321, body_bytes, content_hash, frontmatter, knowledge_revision, title, type, tags, is_deleted, source_path
          FROM page_versions WHERE id=$1 RETURNING id`, [Number(readable!.id)]);
      const poisonId = Number(poison!.id);

      const history = await brain.call('get_versions', { slug: POISONED, limit: 10 }, { remote: true });
      expect(history.body.error, JSON.stringify(history.body).slice(0, 400)).toBeUndefined();
      expect(history.isError).toBe(false);
      const rows = history.body as unknown as Array<Record<string, unknown>>;
      const flagged = rows.find(v => Number(v.id) === poisonId);
      expect(flagged).toBeDefined();
      expect(flagged!.body_unreadable).toBe(true);
      expect(flagged!.body_bytes).toBeUndefined();
      expect(flagged!.total_bytes).toBeUndefined();
      const other = rows.find(v => Number(v.id) === Number(readable!.id));
      expect(other).toBeDefined();
      expect(other!.body_unreadable).toBeUndefined();
      expect(typeof other!.total_bytes).toBe('number');
    }, 600_000);
  });
}
