/**
 * Ours (governedwork fork), not upstream GBrain: brain-resident schema packs.
 *
 * One canonical copy, reaching fresh installs and every upgrade as a fork
 * fragment of scripts/build-schema.ts FRAGMENTS: the schema blob that
 * initSchema replays creates the tables (how a connect knows to replay it:
 * src/core/fork-schema.ts).
 *
 * schema_pack_revisions holds append-only full manifests; schema_pack_heads
 * points at the current revision per pack and names the owning source.
 */

export const BRAIN_PACK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_pack_revisions (
  revision uuid PRIMARY KEY,
  name text NOT NULL,
  source_id text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL,
  parent_revision uuid,
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX IF NOT EXISTS schema_pack_revisions_name_idx ON schema_pack_revisions(name, published_at);
CREATE TABLE IF NOT EXISTS schema_pack_heads (
  name text PRIMARY KEY,
  revision uuid NOT NULL REFERENCES schema_pack_revisions(revision),
  source_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE schema_pack_revisions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE schema_pack_heads ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
