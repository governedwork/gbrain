/**
 * Ours (ledger L159): a page's frontmatter `mention_ignore` is 737's native way to say "this page names X but must
 * not link it" (on a managed brain remove_link keeps a derived mention and says to edit the page text). The edge stays
 * gone on every path that derives `link_source='mentions'` edges from the page's text: the mention pass,
 * `extract links --by-mention`, its `--rebuild` and `extract links --ner`.
 *
 * Regression: a derive path that scans without the page's ignore list writes the edge back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); await engine.executeRaw('DELETE FROM op_checkpoints'); });

async function extract(args: string[]): Promise<void> {
  const log = console.log, err = console.error, write = process.stdout.write, ewrite = process.stderr.write;
  console.log = () => {}; console.error = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { await runExtract(engine, args); } finally {
    console.log = log; console.error = err; process.stdout.write = write; process.stderr.write = ewrite;
  }
}

/** Alice names Widget Co and Acme Example; her page ignores Widget Co. */
async function seed(): Promise<void> {
  await page(engine, 'companies/widget-co', 'company', 'Widget Co', 'A company.');
  await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
  await page(engine, 'people/alice', 'person', 'Alice Example', 'Alice works at Widget Co. Alice works at Acme Example.',
    { frontmatter: { mention_ignore: ['Widget Co'] } });
}

describe('L159: a name in mention_ignore keeps its edge gone on every mention derive path', () => {
  test('the mention pass', async () => {
    await seed();
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['people/alice -> companies/acme']);
  });

  test('extract links --by-mention, then --rebuild', async () => {
    await seed();
    await sweep(engine);
    await extract(['links', '--by-mention', '--source', 'db']);
    expect(await mentionLinks(engine)).toEqual(['people/alice -> companies/acme']);
    await extract(['links', '--by-mention', '--rebuild', '--source', 'db']);
    expect(await mentionLinks(engine)).toEqual(['people/alice -> companies/acme']);
  });

  test('extract links --ner', async () => {
    await seed();
    await sweep(engine);
    await extract(['links', '--ner', '--source', 'db']);
    const rows = await mentionLinks(engine);
    expect(rows.filter(r => r.includes('companies/widget-co'))).toEqual([]);
    // The page's other name is still typed, so the run did scan the page.
    expect(rows).toContain('people/alice -> companies/acme (typed_ner)');
  });
});
