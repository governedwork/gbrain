/**
 * Fork patch (2026-11-02): a coordinated edit of a segmented page whose version prunes the page's history.
 *
 * 1. Protects: a coordinated (single write group) edit_page of a segmented page publishes a generation whose manifest
 *    rows tile its body_bytes, also when the version the write takes prunes the page's segmented history and sweeps its
 *    manifest in the publication transaction. The version is taken before the generation flip, never beside it in the
 *    import's pipelined wave, where the sweep collected the rows the flip had just published (gen_from above the page's
 *    not yet updated body_generation, referenced by no version) and left a live generation that covered only its kept
 *    prefix: every reader then answered page_body_rows_unreadable.
 * 2. Fails when: createVersion of a segmented page runs in the same pipelined wave as the flip again (import-file.ts
 *    applyPrepared). Whether its sweep lands inside the flip's window depends on timing, so the test asserts the
 *    ordering itself: no manifest sweep starts while a generation flip runs (the engine's flipBodyGeneration and
 *    sweepSegments are wrapped to record when each starts and ends), and a sweep did run in each edit's publication,
 *    so the check examined something. The readable-page and tiling checks report the damage when the window is hit.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Only the PostgreSQL arm can fail:
 *    PGLite runs a pipelined wave one call after another (page-state/transactions.ts), so the two calls never overlap
 *    there. On the pinned code the PostgreSQL arm fails on its first round.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody } from '../helpers/conversation-page.ts';
import { FACTS_BLOCK } from '../helpers/segment-bodies.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';

const PAGE = 'notes/edit-version-race';
const fm = (from: string) => `---\ntitle: Race\ntype: note\nmoved_from:\n  - slug: ${from}\n    brain: zz\n---\n\n`;

for (const kind of testBackends()) {
  describe(`segmented edit beside a pruning version (${kind})`, () => {
    let brain: AppendBrain;
    const page = async () => (await brain.engine.executeRaw<{ id: number; body_generation: string; body_bytes: string }>(
      "SELECT id, body_generation::text AS body_generation, body_bytes::text AS body_bytes FROM pages WHERE source_id='default' AND slug=$1", [PAGE]))[0]!;
    /** The live rows' extent: contiguous from byte 0 (covered) or not (null). */
    const covered = async () => {
      const rows = await brain.engine.readManifest(Number((await page()).id));
      let end = 0;
      for (const row of rows) { if (Number(row.byteStart) !== end) return null; end += row.byteLen; }
      return end;
    };

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      // Every new segmented version prunes the one before it, so each write's createVersion sweeps the page's manifest.
      await brain.engine.setConfig('versions.segmented_max_per_page', '1');
      const timeline = Array.from({ length: 300 }, (_, i) => `- **2024-0${1 + (i % 9)}-1${i % 10}** | src — entry ${i}`).join('\n');
      await brain.seed(PAGE, fm('old/a') + 'Intro.\n\n' + FACTS_BLOCK + '\n' + conversationBody(1_300_000, { seed: 21 }) + '\n\n<!-- timeline -->\n\n' + timeline + '\n');
      expect((await brain.body(PAGE)).storage).toBe('segmented');
      // A first write leaves one segmented version for the next one to prune.
      const first = await brain.call('remember', { fact: 'the race page has a fact', provenance: 'test', entity: PAGE, request_id: randomUUID() });
      expect(first.isError).toBe(false);
    }, 600_000);
    afterAll(() => brain?.close(), 120_000);
    /** Starts and ends of flips and sweeps, in order: transaction engines inherit the wrapped methods (Object.create). */
    const events: string[] = [];
    const record = (name: 'flipBodyGeneration' | 'sweepSegments', tag: string) => {
      const target = brain.engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = target[name]!;
      target[name] = async function (this: unknown, ...args: unknown[]) {
        events.push(`${tag}:start`);
        try { return await original.apply(this, args); } finally { events.push(`${tag}:end`); }
      };
    };

    test('a remote frontmatter edit that materializes database-only timeline rows keeps the page readable', async () => {
      record('flipBodyGeneration', 'flip');
      record('sweepSegments', 'sweep');
      for (let round = 0; round < 4; round++) {
        const id = Number((await page()).id);
        // Database-only timeline rows: the edit writes them back at the end of the timeline, so the tail segment changes
        // (a staged row) while the rows before it are kept.
        for (let i = 0; i < 20; i++) {
          await brain.engine.executeRaw(`INSERT INTO timeline_entries (page_id,date,source,summary,detail) VALUES ($1,'2025-05-05'::date,'db',$2,'')`,
            [id, `database-only row ${round}-${i}`]);
        }
        const before = await page();
        events.length = 0;
        const revision = (await brain.call('get_page', { slug: PAGE, body: 'none' }, { remote: true })).body.revision as string;
        const res = await brain.call('edit_page', { slug: PAGE, expected_revision: revision, request_id: randomUUID(),
          edits: [{ old_text: `slug: old/${round === 0 ? 'a' : `r${round - 1}`}\n`, new_text: `slug: old/r${round}\n` }] }, { remote: true });
        // The version's sweep ran in the publication, and never while the flip was running.
        const flipStart = events.indexOf('flip:start'), flipEnd = events.indexOf('flip:end');
        expect(flipStart, events.join(' ')).toBeGreaterThanOrEqual(0);
        expect(events.slice(0, flipStart).includes('sweep:end'), events.join(' ')).toBe(true);
        expect(events.slice(flipStart, flipEnd).filter(event => event.startsWith('sweep')), events.join(' ')).toEqual([]);
        expect(res.body.error).toBeUndefined();
        const after = await page();
        expect(Number(after.body_generation)).toBe(Number(before.body_generation) + 1);
        // Every reader can open the published generation, and its rows tile its body.
        const read = await brain.call('get_page', { slug: PAGE, body: 'none' });
        expect(read.body.error).toBeUndefined();
        expect(read.body.size.total_bytes).toBeGreaterThan(1_000_000);
        expect(await covered()).toBe(Number(after.body_bytes));
      }
    }, 600_000);
  });
}
