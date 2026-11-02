import { describe, expect, it } from 'bun:test';
import { pathPrefixNeedle } from '../src/core/path-prefix-needle.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';

describe('pathPrefixNeedle', () => {
  it('prepends a slash and lower-cases a bare prefix', () => {
    expect(pathPrefixNeedle('People/')).toBe('/people/');
    expect(pathPrefixNeedle('wiki/analysis/')).toBe('/wiki/analysis/');
  });

  it('keeps a leading slash as is', () => {
    expect(pathPrefixNeedle('/Decisions/')).toBe('/decisions/');
  });

  it('keeps LIKE metacharacters literal', () => {
    expect(pathPrefixNeedle('a_c/')).toBe('/a_c/');
    expect(pathPrefixNeedle('100%/')).toBe('/100%/');
  });

  it('is the needle inferTypeFromPack matches a path against', () => {
    const pack = { page_types: [{ name: 'decision', path_prefixes: ['Decisions/'] }] };
    const path = 'projects/x/decisions/0001-a.md';
    expect(('/' + path).toLowerCase().includes(pathPrefixNeedle('Decisions/'))).toBe(true);
    expect(inferTypeFromPack(path, pack)).toBe('decision');
    expect(inferTypeFromPack('abc/decisionsx/0001-a.md', pack)).toBe('concept');
  });
});
