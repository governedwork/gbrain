/**
 * L152 (ours, governedwork fork): one stored segmented version whose rows do not tile (a version an older build's
 * untiled revert stored, before this line's untiled revert stopped versioning the unreadable generation) used to fail
 * every remote get_versions of the page with page_body_rows_unreadable. get_versions now flags that version
 * `body_unreadable: true`, without size fields or body_ref, and lists the rest. The untiled revert itself is pinned in
 * test/large-pages/segmented-untiled-repair.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody } from './helpers/conversation-page.ts';
import { openAppendBrain, type AppendBrain } from './helpers/append-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

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
      await brain.seed(POISONED, fm('Poisoned') + body(42));
      expect((await brain.body(POISONED)).storage).toBe('segmented');
    }, 600_000);
    afterAll(() => brain?.close(), 120_000);

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

      // The body listing (include_body) flags it the same way, with no body_ref to a body nothing can read.
      const bodies = await brain.call('get_versions', { slug: POISONED, limit: 10, include_body: true }, { remote: true });
      expect(bodies.body.error, JSON.stringify(bodies.body).slice(0, 400)).toBeUndefined();
      const withBody = (bodies.body as unknown as Array<Record<string, unknown>>).find(v => Number(v.id) === poisonId);
      expect(withBody?.body_unreadable).toBe(true);
      expect(withBody?.body_ref).toBeUndefined();
    }, 600_000);
  });
}
