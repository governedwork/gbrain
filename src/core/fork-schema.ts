/**
 * Ours (governedwork fork), not upstream GBrain: the fork's schema epoch.
 *
 * The fork's own tables (the FRAGMENTS entries marked `fork: true` in
 * scripts/build-schema.ts) reach a brain only through the schema blob that
 * initSchema replays, and a connect replays it only when
 * `hasPendingMigrations` says so. Upstream's schema version cannot say so:
 * the fork takes no migration number (a fork-numbered migration would shadow
 * the upstream migration that later takes the same number), so a brain an
 * upstream binary built at the same version has none of the fork's tables.
 *
 * The epoch is a hash of the fork fragments' text. `bun run build:schema`
 * writes it to fork-schema-epoch.generated.ts and ends the blob with the
 * statement that adds it to the brain's stamp, so a brain at this build's
 * schema version whose stamp lacks it (absent, or only other fork builds')
 * replays the blob once and gets every fork table.
 *
 * The stamp is the set of epochs whose blob the brain has run, appended to and
 * never replaced: fork fragments only add (IF NOT EXISTS), so a brain that ran
 * an epoch's blob keeps its tables. Two builds sharing a brain (a rolling
 * deploy, a rollback) therefore each replay once, instead of restamping each
 * other into a replay on every connect.
 */
import { createHash } from 'node:crypto';

/** The config key the blob stamps with the epoch of the fork fragments it carries. */
export const FORK_SCHEMA_EPOCH_KEY = 'fork_schema_epoch';

/** The epoch of the fork fragments: their text for each engine, in FRAGMENTS order. */
export function forkSchemaEpoch(fragmentSql: readonly string[]): string {
  return createHash('sha256').update(fragmentSql.join('\0')).digest('hex').slice(0, 16);
}

/** Whether the brain's stamp (a comma-separated set of epochs) holds `epoch`. */
export function forkSchemaStamped(stamp: string | null, epoch: string): boolean {
  return stamp !== null && stamp.split(',').includes(epoch);
}

/** The blob statement that adds `epoch` to the stamp; it comes after every fork fragment. */
export function forkSchemaEpochSql(epoch: string): string {
  return `INSERT INTO config (key, value) VALUES ('${FORK_SCHEMA_EPOCH_KEY}', '${epoch}')
  ON CONFLICT (key) DO UPDATE SET value = CASE
    WHEN position(',' || EXCLUDED.value || ',' IN ',' || config.value || ',') > 0 THEN config.value
    ELSE config.value || ',' || EXCLUDED.value END;
`;
}
