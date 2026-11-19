/**
 * Ours (governedwork fork, ledger L144): `gbrain history prune`, the CLI front of the owner-only
 * `prune_page_versions` operation.
 *
 *   gbrain history prune <slug> --keep <n>             [--source <id>] [--yes] [--dry-run] [--json]
 *   gbrain history prune <slug> --version <id> [...]   [--source <id>] [--yes] [--dry-run] [--json]
 *
 * Without --yes it is a dry run that lists the version ids a prune would delete. It runs on the brain host only:
 * through the resident owner when a live serve holds the brain (its 0600 socket), else in-process as the trusted
 * local CLI. Exit 2 on bad arguments.
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

const USAGE = `Usage: gbrain history prune <slug> --keep <n> [--source <id>] [--yes] [--dry-run] [--json]
       gbrain history prune <slug> --version <id> [--version <id> ...] [--source <id>] [--yes] [--dry-run] [--json]

Deletes versions from a page's history (all but the newest <n>, or the ids given) so text a rewrite
removed leaves it; the live page is unchanged. Without --yes it only lists what it would prune.
Pruned versions cannot be restored. List a page's versions with: gbrain history <slug>
`;

const VALUE_FLAGS = new Set(['--keep', '--version', '--source']);
const BOOLEAN_FLAGS = new Set(['--yes', '--dry-run', '--json']);

function usage(message: string) {
  return opError('invalid_params', message, 'Run gbrain history prune --help for the forms.');
}

/** The op params from argv; throws invalid_params on anything it does not know. */
export function parseHistoryPruneArgs(args: readonly string[]): { params: Record<string, unknown>; source: string | null; json: boolean } {
  let slug: string | undefined;
  let keep: number | undefined;
  let source: string | null = null;
  const versionIds: number[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw usage(`${flag} needs a value.`);
      if (flag === '--source') source = value;
      else {
        if (!/^\d+$/.test(value)) throw usage(`${flag} takes a whole number, not '${value}'.`);
        if (flag === '--keep') keep = Number(value);
        else versionIds.push(Number(value));
      }
    } else if (BOOLEAN_FLAGS.has(arg)) flags.add(arg);
    else if (arg.startsWith('-')) throw usage(`unknown flag ${arg} for 'gbrain history prune'.`);
    else if (slug === undefined) slug = arg;
    else throw usage(`unexpected argument '${arg}'; pass one slug.`);
  }
  if (!slug) throw usage('gbrain history prune needs the page slug.');
  if ((keep === undefined) === (versionIds.length === 0)) throw usage('Pass exactly one of --keep <n> or --version <id>.');
  const dryRun = flags.has('--dry-run') || !flags.has('--yes');
  const params: Record<string, unknown> = { slug, ...(keep !== undefined ? { keep } : { version_ids: versionIds }),
    ...(dryRun ? { dry_run: true } : { yes: true }) };
  return { params, source, json: flags.has('--json') };
}

export async function runHistoryPrune(connect: () => Promise<BrainEngine>, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return; }
  const json = args.includes('--json');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  const { finishCliTeardown, setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  let connected: BrainEngine | null = null;
  const getEngine = async () => connected ??= await connect();
  try {
    const parsed = parseHistoryPruneArgs(args);
    const cfg = loadConfig();
    if (isThinClient(cfg)) {
      throw opError('trusted_local_only', 'prune_page_versions runs only from the trusted local CLI on the brain host.',
        `Run gbrain history prune ${String(parsed.params.slug)} on the brain host.`, { legacy_error: 'permission_denied' });
    }
    const { maybeDelegateLocalOperation } = await import('../core/persistence/local-client.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    const cli = getCliOptions();
    const delegated = await maybeDelegateLocalOperation('prune_page_versions', parsed.params, cfg,
      { brain: cli.brain, source: parsed.source, timeoutMs: cli.timeoutMs ?? undefined });
    let result: Record<string, unknown>;
    if (delegated.handled) result = delegated.result as Record<string, unknown>;
    else {
      const engine = await getEngine();
      const sourceId = await resolveSourceId(engine, parsed.source);
      const { operations } = await import('../core/operations.ts');
      const op = operations.find(o => o.name === 'prune_page_versions')!;
      result = await op.handler({ engine, config: cfg ?? { engine: engine.kind }, remote: false, dryRun: false, sourceId,
        logger: { info: console.log, warn: console.warn, error: console.error } }, parsed.params) as Record<string, unknown>;
    }
    if (parsed.json) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return; }
    const ids = (result.version_ids as number[] | undefined) ?? [];
    const held = (result.held as Array<{ id: number; reason: string; ref: string }> | undefined) ?? [];
    process.stdout.write(`${result.dry_run ? 'Would prune' : 'Pruned'} ${ids.length} version(s) of ${result.slug} (source ${result.source_id})`
      + `${ids.length ? `: ${ids.join(', ')}` : ''}.\n`
      + held.map(h => `Kept version ${h.id}: ${h.reason === 'trust_proposal' ? `trust proposal ${h.ref} reverts to it` : `it holds a database edit a sync overwrote (import ${h.ref})`}.\n`).join('')
      + `${String(result.next ?? '')}\n`);
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) {
      if ((error as { code?: string }).code === 'invalid_params') setCliExitVerdict(2);
      return;
    }
    throw error;
  } finally {
    if (connected) await finishCliTeardown({ engine: connected, drainTimeoutMs: 1000 });
  }
}
