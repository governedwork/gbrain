/**
 * Ours (governedwork fork), not upstream GBrain: derived mention edges a person
 * removed.
 *
 * `remove_link` of a `link_source='mentions'` edge records its page pair and
 * link type here (`*` for the whole pair when the removal names no link type,
 * else `mentions` for the plain mention or a typed NER edge's verb), and no
 * derive path writes such an edge again, so a rescan without a page
 * write (a gazetteer change, an extractor version bump) does not bring it back.
 * Page ids and a link type name only (no slug, name or text); both ends cascade
 * with their page.
 *
 * One canonical copy, reaching fresh installs and every upgrade as a fork
 * fragment of scripts/build-schema.ts FRAGMENTS (how a connect knows to replay
 * it: src/core/fork-schema.ts).
 */

export const MENTION_SUPPRESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mention_suppressions (
  from_page_id integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, to_page_id, link_type)
);
CREATE INDEX IF NOT EXISTS mention_suppressions_to_page_idx ON mention_suppressions(to_page_id);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE mention_suppressions ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
