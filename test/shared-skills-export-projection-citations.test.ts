/**
 * The export preview (`assertExportProjectionRoundtrip`) must derive a struck
 * row's `superseded_by` with the same projection the page write used
 * (`takesPreparation.toCanonicalBatchInput`), or a page the brain itself
 * projected reports a conflict it cannot have: the strike citation's spelling
 * (case, a later re-citation, a number no row can carry) is projected one way
 * on the write and must not be re-derived another way on export.
 */
import { expect, test } from 'bun:test';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { assertExportProjectionRoundtrip } from '../src/core/shared-skills/migration-projection.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';

const citations: Record<string, { source: string; superseded_by: number | null }> = {
  'a capitalised citation': { source: 'Private provenance — Superseded by #2', superseded_by: 2 },
  'the last of two citations': { source: 'superseded by #2 then re-struck: superseded by #3', superseded_by: 3 },
  'a number above int4': { source: 'Private provenance — superseded by #99999999999', superseded_by: null },
};

for (const [name, { source, superseded_by }] of Object.entries(citations)) {
  test(`export preview accepts a page whose struck take carries ${name}`, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(process.env.SHARED_SKILLS_EXPORT_DATABASE_URL);
    try {
      const body = renderTakesFence([
        { rowNum: 1, claim: 'Synthetic first', kind: 'take', holder: 'brain', weight: 0.6, active: false, source },
        { rowNum: 2, claim: 'Synthetic second', kind: 'take', holder: 'brain', weight: 0.6, active: true },
        { rowNum: 3, claim: 'Synthetic third', kind: 'take', holder: 'brain', weight: 0.6, active: true },
      ]).trim();
      await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: { visibility: 'private' } }, { sourceId: 'default' });
      const page = (await engine.getPage('notes/example', { sourceId: 'default' }))!;
      const parsed = parseMarkdown(serializePageToMarkdown(page, []), 'notes/example.md');
      const project = await prepareCanonicalProjections(engine, parsed, page.slug, 'default', null, 'editing');
      await engine.transaction(tx => project(tx));
      const rows = await engine.executeRaw<{ row_num: number; superseded_by: number | null }>('SELECT row_num, superseded_by FROM takes WHERE page_id=$1 ORDER BY row_num', [page.id]);
      expect(rows).toEqual([{ row_num: 1, superseded_by }, { row_num: 2, superseded_by: null }, { row_num: 3, superseded_by: null }]);
      await expect(assertExportProjectionRoundtrip(engine, parsed, page.id, 'default')).resolves.toBeUndefined();
    } finally { await close(); }
  }, 60_000);
}
