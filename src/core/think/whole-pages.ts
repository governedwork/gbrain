/**
 * think `whole_pages` + the per-page evidence report.
 *
 * A gathered page reaches the synthesis prompt as an excerpt (600 chars per
 * page on a 40-page gather) or as a delivered block, and nothing in the
 * response said which. A caller that needs one page read in full (the entity
 * it anchors on) can name it in `whole_pages`: the page is read under the
 * caller's read scope, projected exactly as evidence delivery projects a page
 * (`pageEvidenceText`), placed first, and given its own bounded budget. The
 * response's `evidence_pages` then says, page by page, what the model saw.
 *
 * `whole: true` means that page's visible text reached the model in full. It
 * says nothing about pages the gather never found: it is a statement about
 * the inspected evidence, never about the brain.
 */

import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import {
  countEvidenceTokens, EVIDENCE_BLOCK_CHAR_CAP, EVIDENCE_CUT_MARKER, pageEvidenceText,
  type DeliveredSearchResult, type DeliveryMeta,
} from '../search/evidence-delivery.ts';
import { redactRetrievalOutput } from '../search/output-redaction.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { OperationError } from '../ops/contract.ts';

export const MAX_WHOLE_PAGES = 5;
/** Default token budget shared by the whole pages of one call; `token_budget` replaces it. */
export const DEFAULT_WHOLE_PAGES_BUDGET = 24_000;

/** What reached the model for one page. */
export interface EvidencePageReport {
  slug: string;
  source_id: string | null;
  /** 1-based position in the <pages> block; null when the page did not reach the model. */
  rank: number | null;
  /** The page's visible text reached the model in full. */
  whole: boolean;
  /** How it was shown: a whole-page read, a delivered unit, or the per-page excerpt. */
  shown_as: 'whole_page' | 'page' | 'section' | 'window' | 'chunk' | 'excerpt' | 'none';
  chars_shown: number;
  /** Only for whole-page reads: the visible text's full length. */
  chars_total?: number;
  /** The caller named this page in whole_pages. */
  requested_whole?: true;
  /** Why a page is not whole or not shown: over_budget, over_block_cap, not_found, dropped_by_budget. */
  reason?: string;
  /** Secret redaction changed the text the model saw. */
  redacted?: true;
}

export function parseWholePages(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some(s => typeof s !== 'string' || s.trim() === '')) {
    throw new OperationError('invalid_params', 'whole_pages must be an array of page slugs', '{"whole_pages": ["companies/acme-example"]}');
  }
  const slugs = [...new Set(raw.map(s => (s as string).trim()))];
  if (slugs.length > MAX_WHOLE_PAGES) {
    throw new OperationError('invalid_params', `whole_pages takes at most ${MAX_WHOLE_PAGES} pages (got ${slugs.length})`, `name the ${MAX_WHOLE_PAGES} pages the answer depends on`);
  }
  return slugs;
}

export interface WholePageBlock {
  /** The row the pages renderer prints verbatim. */
  row: SearchResult;
  report: EvidencePageReport;
}

/**
 * Read each named page under the caller's scope and fit it into the budget,
 * in the order given. A page the scope cannot read is reported `not_found`
 * (no distinction from a missing page: scope never leaks existence).
 */
export async function readWholePages(
  engine: BrainEngine,
  slugs: string[],
  scope: PageReadScope,
  budgetTokens: number,
): Promise<{ blocks: WholePageBlock[]; missing: EvidencePageReport[] }> {
  const blocks: WholePageBlock[] = [];
  const missing: EvidencePageReport[] = [];
  let remaining = budgetTokens;
  for (const slug of slugs) {
    const page = await engine.getPage(slug, scope).catch(() => null);
    if (!page) {
      missing.push({ slug, source_id: null, rank: null, whole: false, shown_as: 'none', chars_shown: 0, requested_whole: true, reason: 'not_found' });
      continue;
    }
    const visible = pageEvidenceText({ compiled_truth: page.compiled_truth ?? '', timeline: page.timeline ?? '' }, true).text;
    const redactedText = redactRetrievalOutput([{ chunk_text: visible }], {}).results[0].chunk_text;
    const redacted = redactedText !== visible;
    let text = redactedText;
    let reason: string | undefined;
    if (text.length > EVIDENCE_BLOCK_CHAR_CAP) {
      text = text.slice(0, safeSplitIndex(text, EVIDENCE_BLOCK_CHAR_CAP - EVIDENCE_CUT_MARKER.length)) + EVIDENCE_CUT_MARKER;
      reason = 'over_block_cap';
    }
    let tokens = countEvidenceTokens(text);
    if (tokens > remaining) {
      text = cutToTokens(text, Math.max(0, remaining));
      tokens = countEvidenceTokens(text);
      reason = 'over_budget';
    }
    remaining -= tokens;
    const whole = reason === undefined;
    blocks.push({
      row: {
        slug: page.slug, page_id: page.id, title: page.title, type: page.type,
        chunk_text: text, chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0,
        score: 1, stale: false, source_id: page.source_id ?? 'default',
        effective_date: page.effective_date instanceof Date ? page.effective_date.toISOString() : null,
        effective_date_source: page.effective_date_source ?? null,
      } as SearchResult,
      report: {
        slug: page.slug, source_id: page.source_id ?? 'default', rank: null, whole,
        shown_as: 'whole_page', chars_shown: whole ? text.length : Math.max(0, text.length - EVIDENCE_CUT_MARKER.length),
        chars_total: redactedText.length, requested_whole: true,
        ...(reason ? { reason } : {}), ...(redacted ? { redacted: true as const } : {}),
      },
    });
  }
  return { blocks, missing };
}

/** The longest prefix (on a safe boundary) within the token budget, with the cut marker. */
function cutToTokens(text: string, budget: number): string {
  if (budget <= countEvidenceTokens(EVIDENCE_CUT_MARKER)) return EVIDENCE_CUT_MARKER;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cut = text.slice(0, safeSplitIndex(text, mid)) + EVIDENCE_CUT_MARKER;
    if (countEvidenceTokens(cut) <= budget) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, safeSplitIndex(text, lo)) + EVIDENCE_CUT_MARKER;
}

/** Report for the pages rendered as excerpts (no evidence plan): never whole, by construction. */
export function excerptReports(pages: SearchResult[], excerptLen: number, firstRank: number): EvidencePageReport[] {
  return pages.map((p, i) => ({
    slug: p.slug, source_id: p.source_id ?? 'default', rank: firstRank + i, whole: false, shown_as: 'excerpt' as const,
    chars_shown: Math.min(excerptLen, String(p.chunk_text ?? '').length),
  }));
}

/** Report for delivered blocks, plus every gathered page the delivery dropped. */
export function deliveredReports(
  gathered: SearchResult[],
  delivered: DeliveredSearchResult[],
  delivery: DeliveryMeta,
  firstRank: number,
  blockCharCap: number,
): EvidencePageReport[] {
  const reports: EvidencePageReport[] = delivered.map((r, i) => {
    const shown = String(r.chunk_text ?? '');
    const capped = shown.length > blockCharCap;
    const whole = r.delivered.unit === 'page' && !r.delivered.truncated && !capped;
    return {
      slug: r.slug, source_id: r.source_id ?? 'default', rank: firstRank + i, whole, shown_as: r.delivered.unit,
      chars_shown: Math.min(shown.length, blockCharCap),
      ...(capped ? { reason: 'over_block_cap' } : r.delivered.truncated ? { reason: 'over_budget' } : {}),
    };
  });
  const seen = new Set(delivered.map(r => `${r.source_id ?? 'default'}:${r.slug}`));
  const droppedReason = Object.keys(delivery.dropped_reasons).sort().join(',') || 'dropped_by_budget';
  for (const p of gathered) {
    const key = `${p.source_id ?? 'default'}:${p.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reports.push({ slug: p.slug, source_id: p.source_id ?? 'default', rank: null, whole: false, shown_as: 'none', chars_shown: 0, reason: droppedReason });
  }
  return reports;
}
