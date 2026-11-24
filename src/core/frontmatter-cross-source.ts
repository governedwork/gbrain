/**
 * Ours (governedwork fork): frontmatter link mappings whose value names its page as written, in any source.
 *
 * A meeting a collector files is `external_untrusted`, so the #56 guard (trust/auto-links.ts) drops every edge its
 * body seeds; an enrichment step records the meeting's calendar event in frontmatter (`calendar_event: <slug>`), and
 * that event lives in another source of the brain (captain's `calendar`). makeResolver only looks in the origin's
 * source, so the value would never resolve. For a mapping marked here, a path-shaped slug skips the resolver (and its
 * fuzzy step) and becomes the candidate's target as written; the source policy (resolveCandidateSources) then picks
 * the target's source as it does for a body link to that path: the origin's own source first, another source only
 * with `link_resolution.cross_source` (or a federated origin), else a counted cross_source drop.
 *
 * The mark is a runtime property kept off the exported FrontmatterFieldMapping type, so the public type surface
 * (test/export-surface-golden.test.ts) stays upstream's.
 */
import type { FrontmatterFieldMapping } from './link-extraction.ts';
import { EXACT_SLUG_SHAPE_RE } from './exact-slug-candidates.ts';

interface CrossSourceMark { crossSource?: true }

/**
 * A meeting's calendar event. `mentions` is the one generic verb gbrain-base, gbrain-base-v2 and company-brain (which
 * extends v2) all declare; `related_to` exists only in gbrain-base (v2 calls it `relates_to`).
 */
export const MEETING_CALENDAR_EVENT: FrontmatterFieldMapping = Object.assign<FrontmatterFieldMapping, CrossSourceMark>(
  { fields: ['calendar_event'], pageType: 'meeting', type: 'mentions', direction: 'outgoing', dirHint: '' }, { crossSource: true });

/** The target as written when `mapping` is marked and `value` is a path-shaped slug; null otherwise (resolve it). */
export function crossSourceSlugAsWritten(mapping: FrontmatterFieldMapping, value: string): string | null {
  return (mapping as CrossSourceMark).crossSource && value.includes('/') && EXACT_SLUG_SHAPE_RE.test(value) ? value : null;
}
