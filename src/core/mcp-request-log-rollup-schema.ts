/**
 * Ours (governedwork fork): the request-log retention tally's DDL, carried as
 * a fork fragment of scripts/build-schema.ts FRAGMENTS (src/core/fork-schema.ts
 * says how a brain at the current upstream version replays it).
 *
 * Upstream GBrain creates this table in a numbered schema migration (#6770);
 * the fork takes no migration numbers, so the same IF NOT EXISTS DDL rides the
 * schema blob instead, and the upstream migration is a no-op when the fork
 * catches up to it.
 *
 * mcp_request_log_rollup is the per-token tally of request-log rows the opt-in
 * retention prune (src/core/mcp-request-log-retention.ts,
 * cycle.purge.mcp_request_log_retention_days) removed: how many, the newest
 * one's time (lifetime last-used) and pruned_through, the newest pruned row,
 * which tells a usage window whether it reaches back past pruned detail. A row
 * with a NULL token_name counts under ''. Creating the table copies no rows
 * and deletes nothing: retention stays off until an operator sets the key.
 */

export const MCP_REQUEST_LOG_ROLLUP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mcp_request_log_rollup (
  token_name TEXT PRIMARY KEY,
  requests BIGINT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  pruned_through TIMESTAMPTZ
);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE mcp_request_log_rollup ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
