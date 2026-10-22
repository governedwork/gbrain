/**
 * The canonical takes projection (`takesPreparation.toCanonicalBatchInput`,
 * shared by the page-write projection, the takes reconcile and the shared-skills
 * migration preview) derives `superseded_by` from an inactive row's strike
 * citation. Protects: the pointer is read from the LAST citation (the fence
 * writer appends it after prior provenance), case-insensitively, and a cited
 * number that cannot be a row of the page (int4 overflow, zero, the row itself)
 * projects null instead of being handed to the int4 upsert, where one such cell
 * fails the whole batch. Regression: `superseded by #99999999999` on a struck
 * row threw `value out of range for type integer` from addTakesBatch.
 */
import { describe, expect, test } from 'bun:test';
import { takesPreparation } from '../src/core/takes-write.ts';
import type { ParsedTake } from '../src/core/takes-fence.ts';

const row = (over: Partial<ParsedTake>): ParsedTake => ({ rowNum: 3, claim: 'c', kind: 'take', holder: 'world', weight: 0.5, active: false, ...over });
const pointer = (t: ParsedTake) => takesPreparation.toCanonicalBatchInput(1, t).superseded_by;

describe('toCanonicalBatchInput superseded_by', () => {
  test('reads the last citation after prior provenance, case-insensitively', () => {
    expect(pointer(row({ source: 'superseded by #4' }))).toBe(4);
    expect(pointer(row({ source: 'notes; Superseded By #7' }))).toBe(7);
    expect(pointer(row({ source: 'superseded by #4; superseded by #9' }))).toBe(9);
  });
  test('an active row and a row without a citation project null', () => {
    expect(pointer(row({ active: true, source: 'superseded by #4' }))).toBeNull();
    expect(pointer(row({ source: 'office notes' }))).toBeNull();
    expect(pointer(row({}))).toBeNull();
  });
  test('a citation that cannot be a row of the page projects null instead of failing the batch', () => {
    expect(pointer(row({ source: 'superseded by #99999999999' }))).toBeNull();
    expect(pointer(row({ source: 'superseded by #2147483648' }))).toBeNull();
    expect(pointer(row({ source: 'superseded by #2147483647' }))).toBe(2147483647);
    expect(pointer(row({ source: 'superseded by #0' }))).toBeNull();
    expect(pointer(row({ rowNum: 3, source: 'superseded by #3' }))).toBeNull();
  });
});
