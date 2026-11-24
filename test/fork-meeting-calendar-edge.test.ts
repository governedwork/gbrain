/**
 * Ours (governedwork fork): a meeting's `calendar_event` frontmatter links the meeting to its calendar event.
 *
 * A collector files a meeting page at trust_tier external_untrusted, so the #56 guard (trust/auto-links.ts) drops
 * every edge its body seeds, including the `Calendar: [[…]]` line an enrichment step writes. The same step writes
 * `calendar_event: <slug>` into the frontmatter, and the event page lives in another source of the brain
 * (`calendar`). Protects: (1) that frontmatter value yields a frontmatter edge (origin_field calendar_event) into the
 * other source when `link_resolution.cross_source` is on, through `extract --stale` and put_page's link preparation
 * (the remote put/edit_page path), and it survives the untrusted guard while the body edge does not; (2) with the
 * flag off there is no edge and the drop is counted as cross-source; (3) on a trusted page the frontmatter and
 * markdown edges coexist, one row each, and a re-extraction adds none.
 * Seams: none (production entry points only). PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const MEETING = 'meetings/2026-11-24-weekly-sync';
const EVENT = 'calendar/2026/11/2026-11-24-weekly-sync';
const BODY = `Weekly sync notes.\n\nCalendar: [[${EVENT}]]`;
const FRONTMATTER_EDGE = `default:${MEETING} > calendar:${EVENT} mentions frontmatter calendar_event`;
const MARKDOWN_EDGE = `default:${MEETING} > calendar:${EVENT} mentions markdown -`;
const NO_ENV = { GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: a meeting's calendar_event frontmatter links it to its calendar event`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM links');
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
      await engine.executeRaw(`DELETE FROM config WHERE key = 'link_resolution.cross_source'`);
      await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('calendar','calendar','{}')`);
    }, 60_000);

    async function seed(crossSource: boolean, trust: 'external_untrusted' | null, body = BODY) {
      if (crossSource) await engine.setConfig('link_resolution.cross_source', 'true');
      await engine.putPage(EVENT, { type: 'calendar-event', title: 'Weekly sync', compiled_truth: 'An event.', frontmatter: {} }, { sourceId: 'calendar' });
      await engine.putPage(MEETING, { type: 'meeting', title: 'Weekly sync', compiled_truth: body,
        frontmatter: { calendar_event: EVENT } }, { sourceId: 'default' });
      if (trust) await engine.executeRaw(`UPDATE pages SET trust_tier=$1 WHERE source_id='default' AND slug=$2`, [trust, MEETING]);
    }

    /** Every edge out of the meeting as `from > to type producer field`. */
    async function edges() {
      const rows = await engine.executeRaw<{ edge: string }>(`SELECT f.source_id||':'||f.slug||' > '||t.source_id||':'||t.slug||' '||l.link_type
          ||' '||coalesce(l.link_source,'NULL')||' '||coalesce(l.origin_field,'-') AS edge
        FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.source_id='default' AND f.slug=$1`, [MEETING]);
      return rows.map(row => row.edge).sort();
    }

    const stale = () => extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, includeFrontmatter: true, catchUp: true });

    /** put_page's automatic link pass for the meeting (the remote put/edit_page path): prepare, lock, apply. */
    async function derive() {
      const snapshot = (await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!;
      const prepared = await prepareAutomaticLinks(engine, MEETING, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, 'default');
      return engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
    }

    test('extract --stale: an untrusted meeting gets the frontmatter edge into the calendar source and no markdown edge', () => withEnv(NO_ENV, async () => {
      await seed(true, 'external_untrusted');
      const result = await stale();
      expect(result.skippedCrossSource ?? 0).toBe(0);
      expect(await edges()).toEqual([FRONTMATTER_EDGE]);
    }), 60_000);

    test('put_page link preparation: an untrusted meeting gets the frontmatter edge and no markdown edge', () => withEnv(NO_ENV, async () => {
      await seed(true, 'external_untrusted');
      expect(await derive()).toMatchObject({ errors: 0, skipped_cross_source: 0 });
      expect(await edges()).toEqual([FRONTMATTER_EDGE]);
    }), 60_000);

    test('cross_source off: no edge, and the frontmatter reference counts as a cross-source drop', () => withEnv(NO_ENV, async () => {
      await seed(false, 'external_untrusted', 'Weekly sync notes.');
      const result = await stale();
      expect(result.skippedCrossSource).toBe(1);
      expect(await edges()).toEqual([]);
      expect(await derive()).toMatchObject({ errors: 0, skipped_cross_source: 1 });
      expect(await edges()).toEqual([]);
    }), 60_000);

    test('a trusted meeting keeps one frontmatter and one markdown edge; re-extraction adds none', () => withEnv(NO_ENV, async () => {
      await seed(true, null);
      await stale();
      expect(await edges()).toEqual([FRONTMATTER_EDGE, MARKDOWN_EDGE]);
      await engine.executeRaw(`UPDATE pages SET links_extracted_at=NULL WHERE source_id='default' AND slug=$1`, [MEETING]);
      await stale();
      expect(await derive()).toMatchObject({ errors: 0, created: 0 });
      expect(await edges()).toEqual([FRONTMATTER_EDGE, MARKDOWN_EDGE]);
    }), 60_000);
  });
}
