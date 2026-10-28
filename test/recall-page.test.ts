/**
 * recall's fact pages (src/core/facts/recall-page.ts), without an engine.
 *
 * Pins the pieces test/facts.test.ts exercises through the op:
 *  - readFactWindow fills a window past the engine's 100-row cap in capped
 *    reads, stops at the list's end, and reads a window without offset as one
 *    read with no `offset` key (the opts every read sent before recall paged)
 *  - recallSourceWindow: one source reads the page itself, several read the
 *    first offset+limit rows
 *  - mergeNewest slices the page out of a stable merge: pages of a merged
 *    order line up, ties keep list order
 *  - parseRecallOffset accepts only non-negative safe integers and refuses
 *    question / supersessions
 */
import { describe, expect, test } from 'bun:test';
import { mergeNewest, parseRecallOffset, readFactWindow, recallSourceWindow, type FactPage } from '../src/core/facts/recall-page.ts';
import { OperationError } from '../src/core/ops/contract.ts';

/** A fake engine list of `n` rows that clamps a read at 100 rows, as the engines do, and records each read. */
function fakeList(n: number) {
  const rows = Array.from({ length: n }, (_, i) => i);
  const reads: FactPage[] = [];
  const read = async (page: FactPage) => {
    reads.push(page);
    const offset = page.offset ?? 0;
    return rows.slice(offset, offset + Math.min(page.limit, 100));
  };
  return { rows, reads, read };
}

describe('readFactWindow', () => {
  test('a window without offset is one read with no offset key', async () => {
    const list = fakeList(230);
    expect(await readFactWindow(list.read, { offset: 0, limit: 50 })).toEqual(list.rows.slice(0, 50));
    expect(list.reads).toEqual([{ limit: 50 }]);
  });

  test('a window in SQL reads at its offset', async () => {
    const list = fakeList(230);
    expect(await readFactWindow(list.read, { offset: 100, limit: 100 })).toEqual(list.rows.slice(100, 200));
    expect(list.reads).toEqual([{ limit: 100, offset: 100 }]);
  });

  test('a window past the engine cap reads in capped pages until full', async () => {
    const list = fakeList(1000);
    expect(await readFactWindow(list.read, { offset: 0, limit: 300 })).toEqual(list.rows.slice(0, 300));
    expect(list.reads).toEqual([{ limit: 100 }, { limit: 100, offset: 100 }, { limit: 100, offset: 200 }]);
  });

  test('a window stops at the end of the list', async () => {
    const list = fakeList(230);
    expect(await readFactWindow(list.read, { offset: 0, limit: 400 })).toEqual(list.rows);
    expect(list.reads).toEqual([{ limit: 100 }, { limit: 100, offset: 100 }, { limit: 100, offset: 200 }]);
    const past = fakeList(230);
    expect(await readFactWindow(past.read, { offset: 500, limit: 100 })).toEqual([]);
    expect(past.reads).toHaveLength(1);
  });
});

describe('recallSourceWindow', () => {
  test('one source reads the page; several read the first offset+limit rows', () => {
    expect(recallSourceWindow(1, { offset: 200, limit: 100 })).toEqual({ offset: 200, limit: 100 });
    expect(recallSourceWindow(2, { offset: 200, limit: 100 })).toEqual({ offset: 0, limit: 300 });
    expect(recallSourceWindow(2, { offset: 0, limit: 50 })).toEqual({ offset: 0, limit: 50 });
  });
});

describe('mergeNewest', () => {
  type Row = { id: string; t: number };
  const key = (rec: Record<string, unknown>) => new Date(rec.t as number);
  // Two newest-first lists with ties inside and across them.
  const a: Row[] = [9, 9, 7, 5, 5, 5, 2].map((t, i) => ({ id: `a${i}`, t }));
  const b: Row[] = [9, 8, 5, 5, 1].map((t, i) => ({ id: `b${i}`, t }));
  const all = mergeNewest([a, b], key, { offset: 0, limit: 100 });

  test('ties keep list order, then position', () => {
    expect(all.map((r) => r.id)).toEqual(['a0', 'a1', 'b0', 'b1', 'a2', 'a3', 'a4', 'a5', 'b2', 'b3', 'a6', 'b4']);
  });

  test('pages of the merge cut from offset+limit prefixes line up with the whole', () => {
    const pages: Row[] = [];
    for (let offset = 0; offset < all.length; offset += 3) {
      const window = recallSourceWindow(2, { offset, limit: 3 });
      pages.push(...mergeNewest([a.slice(0, window.limit), b.slice(0, window.limit)], key, { offset, limit: 3 }));
    }
    expect(pages).toEqual(all);
  });

  test('one list is already the page', () => {
    expect(mergeNewest([a], key, { offset: 3, limit: 2 })).toBe(a);
  });
});

describe('parseRecallOffset', () => {
  const refused = (p: Record<string, unknown>, question: string | null = null) => {
    try {
      parseRecallOffset(p, question);
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
      return (e as OperationError).message;
    }
    throw new Error('not refused');
  };

  test('absent is 0; non-negative safe integers pass, -0 as 0', () => {
    expect(parseRecallOffset({}, null)).toBe(0);
    expect(parseRecallOffset({ offset: null }, null)).toBe(0);
    expect(parseRecallOffset({ offset: 0 }, null)).toBe(0);
    expect(Object.is(parseRecallOffset({ offset: -0 }, null), 0)).toBe(true);
    expect(parseRecallOffset({ offset: 230 }, null)).toBe(230);
    expect(parseRecallOffset({ offset: Number.MAX_SAFE_INTEGER }, null)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('anything else is invalid_params naming offset', () => {
    for (const offset of [-1, 1.5, 'x', '5', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, true, {}]) {
      expect(refused({ offset })).toContain('offset');
    }
  });

  test('refused with question or supersessions, with the reason', () => {
    expect(refused({ offset: 0 }, 'what changed?')).toContain('question');
    expect(refused({ offset: 100, supersessions: true })).toContain('supersessions');
    expect(parseRecallOffset({ supersessions: true }, null)).toBe(0);
    expect(parseRecallOffset({}, 'what changed?')).toBe(0);
  });
});
