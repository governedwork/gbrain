/**
 * governedwork/captain#485: a page stored at `external_untrusted` (verbatim fetched text, e.g. a remote put_page with
 * `content_origin: tool_output`) never seeds an AUTOMATIC edge from its body. Each automatic producer yields no target
 * for such a page and reconciles, so the edges it made from the page before disappear on its next pass or write:
 *   - the remote-write `links` effect (`mcp-remote-mention`, persistence/effect-links.ts) and its wanted rows;
 *   - the gazetteer mention pass (`mentions`, plain; mentions/pass.ts), `extract --by-mention` and NER (`typed_ner`);
 *   - body-derived edges (`markdown`, `wikilink-resolved`, legacy NULL) and body wanted rows at publication
 *     (derived-links.ts publishDerivedLinks, which every body-link producer publishes through).
 * Edges a caller writes by name (`add_link`, `manual`), frontmatter edges, and links INTO the page are untouched.
 * The tier is read from `pages.trust_tier`, as eligibility/stamp.ts loadPageTrust does; a page snapshot carries it
 * (isUntrustedSnapshot) from the statement that reads the page, so publication adds no statement for it.
 */
import type { BrainEngine } from '../engine.ts';
import type { TrustTier } from './tier.ts';
import type { PageSnapshot } from '../page-state/types.ts';

/** The page tier whose body never seeds automatic edges. */
export const NO_AUTO_LINK_TIER: TrustTier = 'external_untrusted';

/** SQL predicate over a `pages` alias: the page's body seeds no automatic edges. */
export const noAutoLinkPageSql = (alias: string) => `${alias}.trust_tier = '${NO_AUTO_LINK_TIER}'`;

/**
 * The internal mark a snapshot read sets from the row's `trust_tier` (snapshot reads select `p.*`, so no statement is
 * added). Deliberately not a member of the exported PageSnapshot type: it is a runtime property that survives spreads
 * of the snapshot, read only through isUntrustedSnapshot.
 */
interface UntrustedSnapshotMark { externalUntrusted?: true }

/** The mark for a snapshot built from `row`: present only on NO_AUTO_LINK_TIER. */
export const untrustedSnapshotField = (row: Record<string, unknown>): UntrustedSnapshotMark =>
  row.trust_tier === NO_AUTO_LINK_TIER ? { externalUntrusted: true } : {};

/** Whether a snapshot read marked its page NO_AUTO_LINK_TIER (untrustedSnapshotField). */
export const isUntrustedSnapshot = (snapshot: PageSnapshot): boolean => (snapshot as PageSnapshot & UntrustedSnapshotMark).externalUntrusted === true;

/** The ids among `ids` whose page is stored at NO_AUTO_LINK_TIER. */
export async function noAutoLinkPageIds(engine: Pick<BrainEngine, 'executeRaw'>, ids: readonly (number | string)[]): Promise<Set<number>> {
  const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!unique.length) return new Set();
  const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages p WHERE p.id = ANY($1::int[]) AND ${noAutoLinkPageSql('p')}`, [unique]);
  return new Set(rows.map(row => Number(row.id)));
}

/** Whether the page with this id is stored at NO_AUTO_LINK_TIER. */
export async function isNoAutoLinkPage(engine: Pick<BrainEngine, 'executeRaw'>, id: number | string): Promise<boolean> {
  return (await noAutoLinkPageIds(engine, [id])).has(Number(id));
}
