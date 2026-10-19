import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { parseWholePages, readWholePages, MAX_WHOLE_PAGES } from '../src/core/think/whole-pages.ts';
import { EVIDENCE_CUT_MARKER } from '../src/core/search/evidence-delivery.ts';

// A subject page whose decisive line shares no word with the question ("decide"
// vs "decision"), on a gather big enough that each page gets the 600-char floor:
// the line never reached the model, and nothing in the response said so.
const ANCHOR = 'companies/acme-example';
const DECISIVE = 'VD Bea Example and Carl Example decide.';
const QUESTION = 'Who at Acme Example makes the buying decision?';

let engine: PGLiteEngine;
let capturedUser = '';
const client: ThinkLLMClient = {
  create: async (params) => {
    const m = params.messages[0]?.content;
    capturedUser = typeof m === 'string' ? m : JSON.stringify(m);
    return {
      id: 'msg_whole_pages', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      content: [{ type: 'text', text: JSON.stringify({ answer: 'stubbed', citations: [], gaps: [] }) }],
    };
  },
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const body = [
    '# Acme Example',
    'Acme Example buying decision process: the buying decision for Acme Example tooling follows the buying calendar. '.repeat(6),
    'Background on the staffing market and the company history. '.repeat(20),
    '## People',
    DECISIVE,
    'Operations and scheduling notes. '.repeat(40),
  ].join('\n\n');
  await importFromContent(engine, ANCHOR, `---\ntitle: Acme Example\ntype: company\n---\n\n${body}`, { noEmbed: true, sourceId: 'default' });
  for (let i = 0; i < 39; i++) {
    await importFromContent(engine, `notes/buying-${i}`,
      `---\ntitle: Buying note ${i}\ntype: note\n---\n\nA buying decision note ${i} about Acme Example and the buying decision calendar.`,
      { noEmbed: true, sourceId: 'default' });
  }
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('think whole_pages', () => {
  test('reproduction: without whole_pages the subject page reaches the model as an excerpt, and the report says so', async () => {
    const r = await runThink(engine, { question: QUESTION, anchor: ANCHOR, client, withTrajectory: false });
    expect(r.pagesGathered).toBeGreaterThanOrEqual(20);
    expect(capturedUser).not.toContain(DECISIVE);
    const anchor = r.evidence_pages!.find(p => p.slug === ANCHOR)!;
    expect(anchor).toMatchObject({ whole: false, shown_as: 'excerpt' });
    expect(anchor.chars_shown).toBeLessThan(1000);
  });

  test('whole_pages puts the subject page first, in full, once, and reports it whole', async () => {
    const r = await runThink(engine, { question: QUESTION, anchor: ANCHOR, client, withTrajectory: false, wholePages: [ANCHOR] });
    expect(capturedUser).toContain(DECISIVE);
    expect(capturedUser.split(`slug="${ANCHOR}"`).length - 1).toBe(1);
    const first = r.evidence_pages![0];
    expect(first).toMatchObject({ slug: ANCHOR, rank: 1, whole: true, shown_as: 'whole_page', requested_whole: true });
    expect(first.chars_shown).toBe(first.chars_total!);
    // every other page in the prompt is reported, none of them as whole
    expect(r.evidence_pages!.filter(p => p.slug !== ANCHOR).every(p => p.whole === false)).toBe(true);
  });

  test('a named page the caller cannot read is reported not_found, never thrown', async () => {
    const r = await runThink(engine, { question: QUESTION, client, withTrajectory: false, wholePages: ['companies/no-such-example'] });
    expect(r.evidence_pages![0]).toMatchObject({ slug: 'companies/no-such-example', whole: false, shown_as: 'none', reason: 'not_found' });
  });

  test('a whole page over its budget is cut, marked, and reported not whole', async () => {
    const { blocks } = await readWholePages(engine, [ANCHOR], { sourceId: 'default' }, 60);
    expect(blocks[0].report).toMatchObject({ whole: false, reason: 'over_budget' });
    expect(String(blocks[0].row.chunk_text).endsWith(EVIDENCE_CUT_MARKER)).toBe(true);
    expect(blocks[0].report.chars_shown).toBeLessThan(blocks[0].report.chars_total!);
  });

  test('per-call return_unit page delivers whole pages within token_budget and reports the ones it dropped', async () => {
    const r = await runThink(engine, { question: QUESTION, client, withTrajectory: false, returnUnit: 'page', tokenBudget: 300 });
    expect(r.evidence_delivery?.requested_unit).toBe('page');
    const shown = r.evidence_pages!.filter(p => p.rank !== null);
    const dropped = r.evidence_pages!.filter(p => p.rank === null);
    expect(shown.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every(p => p.whole === false && p.shown_as === 'none')).toBe(true);
    expect(shown.length + dropped.length).toBe(r.pagesGathered);
  });

  test('whole_pages is validated', () => {
    expect(parseWholePages(undefined)).toBeUndefined();
    expect(parseWholePages([' a/b ', 'a/b'])).toEqual(['a/b']);
    expect(() => parseWholePages('a/b')).toThrow();
    expect(() => parseWholePages([''])).toThrow();
    expect(() => parseWholePages(Array.from({ length: MAX_WHOLE_PAGES + 1 }, (_, i) => `p/${i}`))).toThrow();
  });
});
