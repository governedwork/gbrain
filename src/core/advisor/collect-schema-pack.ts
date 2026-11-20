/**
 * advisor/collect-schema-pack.ts — schema-pack resolvability (a setup smell).
 *
 * Source-aware (#7): resolution goes through loadActivePack, which honors the
 * per-source + brain-wide config tiers. A healthy brain resolves to its pack (or
 * the gbrain-base default) and emits nothing; a brain configured to a pack that
 * isn't on disk surfaces a warn so the owner can fix the config.
 */

import { loadActivePack } from '../schema-pack/load-active.ts';
import type { AdvisorCollector } from './types.ts';

export const collectSchemaPack: AdvisorCollector = {
  id: 'schema-pack',
  collect: async (ctx) => {
    let dbConfig: string | undefined;
    try {
      dbConfig = (await ctx.engine.getConfig('schema_pack')) ?? undefined;
    } catch {
      dbConfig = undefined;
    }
    try {
      await loadActivePack({ cfg: ctx.config, remote: ctx.remote, dbConfig });
      return []; // resolves cleanly → nothing to say
    } catch (err) {
      // pack-store-failure-ok: reported as an advisor finding with the error text; nothing is written.
      const name = dbConfig ?? ctx.config?.schema_pack ?? '(configured)';
      // Ours (governedwork fork): a failure reading the brain's stored packs is a database problem, not a bad override.
      if ((await import('../schema-pack/db-store.ts')).isPackStoreFailure(err)) {
        return [{
          id: 'schema_pack_store_unreadable', severity: 'warn',
          title: `The brain's stored schema packs could not be read, so the pack "${name}" was not resolved.`,
          detail: `${(err as Error).message}. This is usually a passing database failure; retry, or check the database.`,
          fix: { command_argv: ['gbrain', 'doctor', '--json'] }, collector: 'schema-pack', ask_user: false,
        }];
      }
      return [
        {
          id: 'schema_pack_unresolved',
          severity: 'warn',
          title: `The configured schema pack "${name}" could not be resolved.`,
          detail: `${(err as Error).message}. Pick an installed pack or clear the override.`,
          fix: { command_argv: ['gbrain', 'schema', 'packs'] },
          collector: 'schema-pack',
          ask_user: true,
        },
      ];
    }
  },
};
