/**
 * Ours (governedwork fork, 2026-11-02; rebuilt on v0.60.737.0): a segmented page whose live generation does not tile its body, and its repair.
 *
 * 1. Protects: revert_version of a segmented page whose live generation does not tile republishes the version's body as
 *    a new generation, the current body taken as unread (persistence/untiled-revert.ts): every reader opens the page again, its body is the
 *    version's byte for byte, and its facts, takes, links and timeline rows keep their ids and counts; a later edit
 *    works; reverting to the unreadable generation's own version refuses; a revert of a page that tiles is still
 *    refused as before (segmentedRevertRefusal).
 * 2. Fails when: revert_version reads the current body first (it then refuses page_body_rows_unreadable like every
 *    other path), or the repair re-projects the page's fences and timeline.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). The unreadable page is the state
 *    a pre-#8729 race left on Postgres (a version's in-transaction sweep deleted the rows and chunks the flip had just
 *    published), made here directly: the race is fixed upstream, the damaged pages it left are not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody } from '../helpers/conversation-page.ts';
import { FACTS_BLOCK } from '../helpers/segment-bodies.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { segmentedLivePage } from '../../src/core/persistence/segmented-apply.ts';
import { untiledSegmentedPages } from '../../src/core/page-body/body-tiling.ts';

const PAGE = 'notes/untiled-repair';
const TILED = 'notes/untiled-tiled';
const OTHER = 'notes/untiled-other';
const OVERLAID = 'notes/untiled-overlaid';
const TEA = 'Overlaid Example drinks green tea daily';
const SECRET = 'Overlaid Example keeps a spare key under the mat';
const STALE = 'Overlaid Example once shared a door code';
const fm = (title: string) => `---\ntitle: ${title}\ntype: note\nmoved_from:\n  - slug: old/a\n    brain: zz\n---\n\n`;
const timeline = Array.from({ length: 200 }, (_, i) => `- **2024-0${1 + (i % 9)}-1${i % 10}** | src — entry ${i}`).join('\n');
const body = (seed: number) => 'Intro.\n\nSee [[notes/untiled-other]].\n\n' + FACTS_BLOCK + '\n' + conversationBody(1_250_000, { seed }) + '\n\n<!-- timeline -->\n\n' + timeline + '\n';

for (const kind of testBackends()) {
  describe(`a segmented page whose generation does not tile (${kind})`, () => {
    let brain: AppendBrain;
    const page = async (slug: string) => (await brain.engine.executeRaw<{ id: number; body_generation: string; body_bytes: string; content_hash: string }>(
      "SELECT id, body_generation::text AS body_generation, body_bytes::text AS body_bytes, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
    const ids = async (sql: string, id: number) => (await brain.engine.executeRaw<{ id: number }>(sql, [id])).map(r => Number(r.id)).sort((a, b) => a - b);
    /** Every fact, take, link and timeline row of the page, by id (with each fact's and take's state). */
    const records = async () => {
      const id = Number((await page(PAGE)).id);
      return {
        facts: (await brain.engine.executeRaw<{ id: number; expired_at: unknown; row_num: unknown }>(
          `SELECT id, expired_at::text AS expired_at, row_num FROM facts WHERE source_id='default' AND (entity_slug=$1 OR source_markdown_slug=$1) ORDER BY id`, [PAGE]))
          .map(r => `${r.id}:${r.expired_at ?? ''}:${r.row_num ?? ''}`),
        takes: (await brain.engine.executeRaw<{ id: number; active: unknown; row_num: number }>('SELECT id, active, row_num FROM takes WHERE page_id=$1 ORDER BY id', [id]))
          .map(r => `${r.id}:${String(r.active)}:${r.row_num}`),
        links: await ids('SELECT id FROM links WHERE from_page_id=$1 OR to_page_id=$1', id),
        timeline: await ids('SELECT id FROM timeline_entries WHERE page_id=$1', id),
      };
    };
    /** Upstream's tiling test (doctor segmented_tiling): the page's untiled row, or undefined when it tiles. */
    const untiled = async () => (await untiledSegmentedPages(brain.engine, { sourceIds: ['default'], slugs: [PAGE] }))[0];
    const readable = async (slug: string, remote = false) => (await brain.call('get_page', { slug, body: 'none' }, { remote })).body;

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await brain.seed(OTHER, fm('Other') + 'The other page.\n');
      await brain.seed(PAGE, fm('Repair') + body(31));
      await brain.seed(TILED, fm('Tiled') + body(32));
      await brain.seed(OVERLAID, fm('Overlaid') + body(33));
      expect((await brain.body(PAGE)).storage).toBe('segmented');
      for (let i = 0; i < 3; i++) {
        expect((await brain.call('remember', { fact: `repair fact ${i}`, provenance: 'test', entity: PAGE, request_id: randomUUID() })).isError).toBe(false);
      }
      const take = await brain.call('takes_add', { slug: PAGE, claim: 'the repair keeps this take', kind: 'take', holder: 'brain', weight: 0.6, request_id: randomUUID() });
      expect(take.body.error, JSON.stringify(take.body).slice(0, 400)).toBeUndefined();
      const link = await brain.call('add_link', { from: PAGE, to: OTHER, context: 'repair test' });
      expect(link.body.error, JSON.stringify(link.body).slice(0, 500)).toBeUndefined();
      expect((await brain.call('add_timeline_entry', { slug: PAGE, date: '2025-01-02', summary: 'a timeline row the repair keeps', request_id: randomUUID() })).isError).toBe(false);
      const id = Number((await page(PAGE)).id);
      await brain.engine.executeRaw(`INSERT INTO timeline_entries (page_id,date,source,summary,detail) VALUES ($1,'2025-03-04'::date,'db','a database-only row','')`, [id]);
    }, 600_000);
    afterAll(() => brain?.close(), 120_000);

    test('revert_version republishes a readable version over an unreadable generation, keeping every fact, take, link and timeline row', async () => {
      // A remote edit that changes the frontmatter and writes the database-only row back at the timeline's end: the tail row is staged.
      const versionBody = await brain.body(PAGE);
      const rev = (await readable(PAGE, true)).revision as string;
      const edit = await brain.call('edit_page', { slug: PAGE, expected_revision: rev, request_id: randomUUID(),
        edits: [{ old_text: 'slug: old/a\n', new_text: 'slug: old/b\n' }] }, { remote: true });
      expect(edit.body.error).toBeUndefined();
      const edited = await page(PAGE);
      const id = Number(edited.id);
      // The state the race left: the rows and chunks the flip published at the new generation are gone; the kept prefix stays.
      const gone = await brain.engine.executeRaw(`DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2::bigint RETURNING seq`,
        [id, Number(edited.body_generation)]);
      expect(gone.length).toBeGreaterThan(0);
      await brain.engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND body_generation=$2::bigint', [id, Number(edited.body_generation)]);
      const broken = (await untiled())!;
      expect(broken).toBeDefined();
      expect(broken.page_id).toBe(id);
      expect((await readable(PAGE)).error).toBe('page_body_rows_unreadable');
      expect((await readable(PAGE, true)).error).toBe('page_body_rows_unreadable');
      const kept = await records();
      expect(kept.facts.length).toBeGreaterThanOrEqual(3);
      expect(kept.takes.length).toBeGreaterThanOrEqual(1);
      expect(kept.links.length).toBeGreaterThanOrEqual(1);
      expect(kept.timeline.length).toBeGreaterThan(200);
      // Any other write still refuses: it reads the current body first.
      const blocked = await brain.call('edit_page', { slug: PAGE, expected_revision: rev, request_id: randomUUID(), edits: [{ old_text: 'Intro.', new_text: 'Intro!' }] });
      expect(blocked.isError).toBe(true);

      // The newest version that does not reference the live generation is the edit's preimage.
      const versions = (await brain.call('get_versions', { slug: PAGE, limit: 10 })).body as Array<{ id: number; body_generation?: number }>;
      const target = versions.find(v => v.body_generation !== undefined && Number(v.body_generation) !== Number(edited.body_generation))!;
      expect(target).toBeDefined();
      // Reverting to a version that references the unreadable generation refuses and changes nothing.
      const own = versions.find(v => Number(v.body_generation) === Number(edited.body_generation));
      if (own) expect((await brain.call('revert_version', { slug: PAGE, version_id: own.id, force: true, request_id: randomUUID() }, { remote: true })).body.error).toBe('page_body_rows_unreadable');

      // No reader can return the page's revision, so the repair asserts the overwrite with force (a stale expected_revision refuses).
      expect((await brain.call('revert_version', { slug: PAGE, version_id: target.id, expected_revision: rev, request_id: randomUUID() }, { remote: true })).body.error)
        .toBe('revision_conflict');
      const res = await brain.call('revert_version', { slug: PAGE, version_id: target.id, force: true, request_id: randomUUID() }, { remote: true });
      expect(res.body.error).toBeUndefined();
      expect(res.body).toMatchObject({ status: 'reverted', repaired: { unreadable_generation: Number(edited.body_generation), body_bytes: Number(edited.body_bytes),
        rows: broken.rows, covered_bytes: broken.covered_bytes, from_version: target.id } });

      // No version keeps the unreadable generation: a purge_fact scanning the page's versions would refuse on it.
      expect(await brain.engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 AND body_generation=$2::bigint', [id, Number(edited.body_generation)])).toEqual([]);
      const repaired = await page(PAGE);
      expect(Number(repaired.body_generation)).toBe(Number(edited.body_generation) + 1);
      expect(await untiled()).toBeUndefined();
      expect((await readable(PAGE)).error).toBeUndefined();
      expect((await readable(PAGE, true)).error).toBeUndefined();
      const after = await brain.body(PAGE);
      expect(after.truth === versionBody.truth).toBe(true);
      expect(after.timeline === versionBody.timeline).toBe(true);
      expect(Number(repaired.body_bytes)).toBe(Buffer.byteLength(versionBody.truth) + Buffer.byteLength(versionBody.timeline));
      // The revert re-projected nothing: every record keeps its id and state.
      expect(await records()).toEqual(kept);
      // The page takes writes again.
      const next = await brain.call('edit_page', { slug: PAGE, expected_revision: (await readable(PAGE)).revision, request_id: randomUUID(),
        edits: [{ old_text: 'Intro.', new_text: 'Intro, repaired.' }] });
      expect(next.body.error).toBeUndefined();
      expect(await untiled()).toBeUndefined();
    }, 600_000);

    test('the repair keeps a fact forgotten or purged since the version out of the republished page', async () => {
      const call = async (name: string, params: Record<string, unknown>) => (await brain.call(name, params)).body as Record<string, unknown>;
      const live = async () => (await page(OVERLAID));
      // Two remembered facts land as fence rows on the page; an edit then makes the page's preimage a segmented version
      // that holds both rows.
      for (const claim of [TEA, SECRET, STALE]) {
        const saved = await call('remember', { fact: claim, provenance: 'test', entity: OVERLAID, request_id: randomUUID() });
        expect(saved.error, JSON.stringify(saved).slice(0, 300)).toBeUndefined();
      }
      const edit = await call('edit_page', { slug: OVERLAID, expected_revision: (await readable(OVERLAID)).revision, request_id: randomUUID(),
        edits: [{ old_text: 'Intro.', new_text: 'Intro, versioned.' }] });
      expect(edit.error).toBeUndefined();
      const fact = async (claim: string) => (await brain.engine.executeRaw<{ id: number; row_num: number | null }>(
        `SELECT id, row_num FROM facts WHERE source_id='default' AND (source_markdown_slug=$1 OR entity_slug=$1) AND fact=$2 AND expired_at IS NULL ORDER BY id LIMIT 1`, [OVERLAID, claim]))[0];
      const tea = await fact(TEA), secret = await fact(SECRET);
      expect(tea && secret).toBeTruthy();
      // After the version was written: forget one claim, purge the other.
      expect((await call('forget', { id: String(tea!.id), reason: 'test', request_id: randomUUID() })).error).toBeUndefined();
      const dry = await call('purge_fact', { id: Number(secret!.id), dry_run: true });
      expect(dry.confirm_token).toBeDefined();
      const purged = await call('purge_fact', { id: Number(secret!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      expect(purged.error, JSON.stringify(purged).slice(0, 400)).toBeUndefined();
      const versions = (await brain.call('get_versions', { slug: OVERLAID, limit: 10 })).body as Array<{ id: number; body_generation?: number }>;
      const edited = await live();
      const target = versions.find(v => v.body_generation !== undefined && Number(v.body_generation) !== Number(edited.body_generation))!;
      expect(target).toBeDefined();
      const inVersion = async (claim: string) => (await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m
        JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
        WHERE m.page_id=$1 AND m.staging_id IS NULL AND m.gen_from <= $2::bigint AND (m.gen_to IS NULL OR m.gen_to > $2::bigint)
          AND strpos(convert_from(t.body,'UTF8'), $3::text) > 0`, [Number(edited.id), Number(target.body_generation), claim]))[0]!.n > 0;
      // The premises: forget never rewrites history, so the version still holds the forgotten row; purge_fact scrubs
      // versions itself, so the purged claim is already gone from it.
      expect(await inVersion(TEA)).toBe(true);
      expect(await inVersion(SECRET)).toBe(false);
      // A purge tombstone over a version its scrub did not reach (the state a stale preparation leaves): the claim's fact
      // row is gone and fact_purges holds it, while the version still carries its fence row.
      const stale = await fact(STALE);
      await brain.engine.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, reason) VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1), 'test')`, [STALE]);
      await brain.engine.executeRaw('DELETE FROM facts WHERE id=$1', [Number(stale!.id)]);
      expect(await inVersion(STALE)).toBe(true);
      // Make the live generation unreadable, then repair from the version.
      await brain.engine.executeRaw(`DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2::bigint`, [Number(edited.id), Number(edited.body_generation)]);
      expect(await untiledSegmentedPages(brain.engine, { sourceIds: ['default'], slugs: [OVERLAID] })).toHaveLength(1);
      const res = await brain.call('revert_version', { slug: OVERLAID, version_id: target.id, force: true, request_id: randomUUID() }, { remote: true });
      expect(res.body.error, JSON.stringify(res.body).slice(0, 400)).toBeUndefined();
      const after = await brain.body(OVERLAID);
      const text = after.truth + after.timeline;
      // The purged claim is gone from the body and from facts; the forgotten one stays struck, never active again.
      expect(text).not.toContain(SECRET);
      expect(await fact(SECRET)).toBeUndefined();
      expect(text).not.toContain(STALE);
      expect(await fact(STALE)).toBeUndefined();
      const teaLine = text.split('\n').find(line => line.includes(TEA));
      expect(teaLine).toBeDefined();
      expect(teaLine).toContain('forgotten:');
      expect(await fact(TEA)).toBeUndefined();
    }, 600_000);

    test('revert_version of a segmented page that tiles is refused as before', async () => {
      const versions = (await brain.call('get_versions', { slug: TILED, limit: 5 })).body as Array<{ id: number }>;
      if (!versions.length) {
        // The guard page has no version yet: a write gives it one.
        expect((await brain.call('remember', { fact: 'tiled fact', provenance: 'test', entity: TILED, request_id: randomUUID() })).isError).toBe(false);
      }
      const [version] = (await brain.call('get_versions', { slug: TILED, limit: 5 })).body as Array<{ id: number }>;
      const live = await segmentedLivePage(brain.engine, Number((await page(TILED)).id));
      expect(live.storage).toBe('segmented');
      const res = await brain.call('revert_version', { slug: TILED, version_id: version!.id, force: true, request_id: randomUUID() });
      expect(res.body.error).toBe('page_body_segmented');
    }, 600_000);
  });
}
