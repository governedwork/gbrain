import type { SqlEngine } from './model.ts';

/**
 * Ours (governedwork fork), not upstream GBrain: carried until upstream lands
 * its own design for publishing skills without a checkout.
 *
 * A database-canonical source keeps its shared skills only in the database:
 * `shared_skill_revisions.files` is the canonical copy and nothing is written
 * to a checkout. It is the source `gbrain init --db-only` records
 * (content receipt `repository_kind: 'db_only'`) with no registered canonical
 * root. A source that has a root, or gains one, is never database-canonical,
 * so a filesystem owner is never bypassed.
 */
export async function isDatabaseCanonicalSource(engine: SqlEngine, sourceId: string): Promise<boolean> {
  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null; archived: boolean }>(
    'SELECT incarnation,local_path,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived || source.local_path) return false;
  const bound = await engine.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1 LIMIT 1', [sourceId]);
  if (bound.length) return false;
  const [receipt] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1',
    [`shared_skills.content.v1.${sourceId}.${source.incarnation}`]);
  if (!receipt) return false;
  try { return (JSON.parse(receipt.value) as { repository_kind?: string }).repository_kind === 'db_only'; }
  catch { return false; }
}
