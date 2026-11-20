/**
 * Ours (governedwork fork): the record of version history an owner pruned
 * (`prune_page_versions`, src/core/page-state/version-prune.ts), carried as a fork
 * fragment of scripts/build-schema.ts FRAGMENTS (src/core/fork-schema.ts says
 * how a brain at the current upstream version replays it).
 *
 * One row per page and knowledge revision whose versions a prune deleted. It
 * holds identifiers only (never text), and says that a missing version of that
 * revision was removed on purpose: the belief ledger's preimage scan
 * (src/core/belief/preimages.ts) does not report such a revision as a gap. A
 * page's rows go with the page.
 */

export const PAGE_VERSION_PRUNES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS page_version_prunes (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  knowledge_revision UUID NOT NULL,
  pruned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, knowledge_revision)
);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE page_version_prunes ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
