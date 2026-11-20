/**
 * `gbrain forget`: durable withdrawal of facts (the `forget` verb), the front of
 * `gbrain forget <id> --purge` (src/commands/forget-purge.ts) too.
 *
 *   gbrain forget <fact-id> [--reason <text>] [--source <id>] [--request-id <uuid>] [--json]
 *   gbrain forget <fact-id> <fact-id>... [--ids-from-stdin] [--reason <text>] [--source <id>] [--json]
 *
 * One id keeps the single-forget output and exit codes. More than one id (or
 * ids read from stdin, whitespace- or comma-separated) is a batch (ours,
 * governedwork fork, ledger L146): remote forget cannot see private facts, so
 * the trusted local CLI forgets every id it is given in one run. Ids are
 * deduplicated in order; each is its own forget with its own request id; a
 * failing id never stops the others. The run prints one line per id (--json:
 * `{ forgotten, already_withdrawn, pending: [{ id, request_id, state }], failed: [{ id, code, request_id }] }`) and
 * exits 1 when any id failed, else as a single forget does for a still-pending write (PENDING_WRITE_EXIT_CODE, 0 with
 * --accept-pending). Every value-taking flag consumes its value, so a number given as a flag value is never an id, and a
 * positional token that is not an id refuses the run.
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient, type GBrainConfig } from '../core/config.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

type ForgetResult = { id: string; expired: boolean; similar_active?: { candidates?: Array<{ fact_id: string; similarity: number }>; next?: string } };
type EngineArg = BrainEngine | (() => Promise<BrainEngine>);

const SINGLE_USAGE = 'Usage: gbrain forget <fact-id> [<fact-id>...] [--ids-from-stdin] [--reason <text>] [--source <id>] [--request-id <uuid>] [--json]\n';

function flagValue(args: readonly string[], name: string): { present: boolean; value: string | undefined; index: number } {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return { present: false, value: undefined, index };
  return { present: true, value: args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1], index };
}

/** Flags of `gbrain forget` that take a value: their value is never a fact id (a --match / --status value belongs to the purge forms). */
const VALUE_FLAGS = new Set(['--reason', '--source', '--request-id', '--match', '--status', '--brain']);

/**
 * The fact ids on the command line. Every value-taking flag consumes its value (`--flag value` or `--flag=value`), so a
 * number given as a reason, source, request id or match is never forgotten; any other positional token that is not a
 * whole-number id refuses the run (an unquoted multi-word --reason lands here), so nothing is forgotten by accident.
 */
async function idArgs(args: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    if (!/^\d+$/.test(arg)) {
      const { opError } = await import('../core/ops/contract.ts');
      throw opError('invalid_params', `'${arg}' is not a fact id, so nothing was forgotten. A --reason of several words needs quotes.`,
        'Pass whole-number fact ids, and quote a value of several words, as in: gbrain forget 42 --reason "moved to another team".');
    }
    ids.push(arg);
  }
  return ids;
}

/** Ids from stdin: integers separated by whitespace or commas; anything else refuses the run before any forget. */
async function stdinIds(stream?: NodeJS.ReadableStream): Promise<string[]> {
  const { readStdinBounded } = await import('../core/interaction.ts');
  const { opError } = await import('../core/ops/contract.ts');
  const read = await readStdinBounded(stream ? { stream } : {});
  if (read.kind === 'empty') return [];
  if (read.kind !== 'data') {
    throw opError('invalid_params', `--ids-from-stdin could not read stdin (${read.kind}); nothing was forgotten.`,
      'Pipe the fact ids in, e.g. printf "12\\n15\\n" | gbrain forget --ids-from-stdin.');
  }
  const tokens = read.text.split(/[\s,]+/).filter(Boolean);
  const bad = tokens.filter(t => !/^\d+$/.test(t));
  if (bad.length) {
    throw opError('invalid_params', `--ids-from-stdin takes fact ids only; '${bad[0]}' is not one, so nothing was forgotten.`,
      'Pass whole-number fact ids separated by spaces, commas or new lines.');
  }
  return tokens;
}

/** Test seam: the stream `--ids-from-stdin` reads (default: process stdin). */
export interface ForgetCliIo { stdin?: NodeJS.ReadableStream }

export async function runForget(engine: EngineArg, args: string[], io: ForgetCliIo = {}): Promise<void> {
  const purge = await import('./forget-purge.ts');
  if (purge.routesToForgetPurge(args)) return purge.runForgetPurge(engine, args);
  const json = args.includes('--json');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  let ids: string[];
  const fromStdin = args.includes('--ids-from-stdin');
  try {
    ids = await idArgs(args);
    if (fromStdin) ids = [...ids, ...await stdinIds(io.stdin)];
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return;
    throw error;
  }
  ids = [...new Set(ids.map(id => String(parseInt(id, 10))))];
  if (!ids.length) {
    process.stderr.write(SINGLE_USAGE);
    process.exit(1);
  }
  if (ids.length === 1 && !fromStdin) return forgetOne(engine, args, ids[0]!);
  return forgetMany(engine, args, ids);
}

/** Parsed common flags; throws invalid_params on a flag missing its value. */
async function commonFlags(args: readonly string[], idHint: string) {
  const { opError } = await import('../core/ops/contract.ts');
  const reason = flagValue(args, '--reason');
  const request = flagValue(args, '--request-id');
  const source = flagValue(args, '--source');
  if (request.present && (!request.value || request.value.startsWith('--'))) {
    throw opError('invalid_params', '--request-id requires a UUID.',
      `Give --request-id the UUID an earlier attempt of this forget printed, or omit it and gbrain forget ${idHint} generates one.`);
  }
  if (source.present && (!source.value || source.value.startsWith('--'))) {
    throw opError('invalid_params', '--source requires a source ID.', `Give --source the id of the source that holds fact ${idHint}, e.g. --source default, or omit it to use the default source.`,
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists the source ids, read-only.', requires_exclusive: false } });
  }
  return { reason: reason.present && reason.value !== undefined ? reason.value : undefined, requestValue: request.value, requestGiven: request.present, sourceValue: source.value };
}

/** One forget: through the resident owner when one holds the brain, else in-process as the trusted local CLI. */
async function forgetLocal(engine: EngineArg, cfg: GBrainConfig | null, source: string | null, params: Record<string, unknown>): Promise<ForgetResult> {
  const { maybeDelegateLocalOperation } = await import('../core/persistence/local-client.ts');
  const { getCliOptions } = await import('../core/cli-options.ts');
  const { operations } = await import('../core/operations.ts');
  const cli = getCliOptions();
  const delegated = await maybeDelegateLocalOperation('forget', params, cfg, { brain: cli.brain, source, timeoutMs: cli.timeoutMs ?? undefined });
  if (delegated.handled) return delegated.result as ForgetResult;
  const connected = typeof engine === 'function' ? await engine() : engine;
  const sourceId = await resolveSourceId(connected, source);
  const op = operations.find(operation => operation.name === 'forget')!;
  return await op.handler({ engine: connected, config: cfg ?? { engine: 'pglite' }, remote: false,
    dryRun: false, sourceId, logger: { info: console.log, warn: console.warn, error: console.error } }, params) as ForgetResult;
}

async function forgetOne(engine: EngineArg, args: string[], idArg: string): Promise<void> {
  const id = parseInt(idArg, 10);
  const { parseWriteRequestId } = await import('../core/persistence/preconditions.ts');
  const { randomUUID } = await import('node:crypto');
  const { opError } = await import('../core/ops/contract.ts');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  const json = args.includes('--json');
  let requestId: string;
  let flags: Awaited<ReturnType<typeof commonFlags>>;
  try {
    flags = await commonFlags(args, String(id));
    requestId = parseWriteRequestId(flags.requestValue) ?? randomUUID();
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return;
    throw error;
  }
  const { reason, sourceValue } = flags;
  // Optional --reason <text> passes through to the fence's "forgotten: <reason>" context cell.
  const params: Record<string, unknown> = { id: String(id), request_id: requestId, ...(reason !== undefined ? { reason } : {}) };

  // v0.33: thin-client routing. Without this, `gbrain forget <id>` on a
  // thin-client install would call the local fence helper against the empty
  // local PGLite and report "No fact" while the real fact lives on the
  // remote brain.
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
    try {
      if (sourceValue) throw opError('invalid_params', '--source cannot override the remote memory writer grant.',
        'Drop --source: on a remote brain the connection\'s memory writer grant decides the source.',
        { fix: { argv: ['gbrain', 'forget', String(id), ...(reason !== undefined ? ['--reason', reason] : []), '--request-id', requestId], consent: [], actor: 'agent',
          requires_exclusive: false, why: `The same forget of fact ${id} without --source, under the same request id.` } });
      const raw = await callRemoteTool(cfg!, 'forget', params, { timeoutMs: 30_000 });
      const result = unpackToolResult<{ id: string; expired: boolean }>(raw);
      if (json) console.log(JSON.stringify(result, null, 2));
      else process.stdout.write(result.expired ? `Forgot fact id=${id}\n` : `Fact id=${id} was already withdrawn\n`);
    } catch (error) {
      if (await reportPersistenceCliError(error, json)) return;
      console.error(error instanceof Error ? error.message : String(error));
      console.error(`Retry the same forget with --request-id ${requestId}.`);
      const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
      setCliExitVerdict(1);
    }
    return;
  }

  try {
    const result = await forgetLocal(engine, cfg, sourceValue ?? null, params);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      process.stdout.write(result.expired ? `Forgot fact id=${id}\n` : `Fact id=${id} was already withdrawn\n`);
      const similar = result.similar_active;
      if (similar?.candidates?.length) {
        process.stdout.write(`Close matches still active: ${similar.candidates.map(c => `#${c.fact_id} (${c.similarity})`).join(', ')}\n`);
      }
      if (similar?.next) {
        const { agentBlock } = await import('../core/agent-markers.ts');
        process.stderr.write(agentBlock({ next: similar.next }));
      }
    }
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return;
    throw error;
  }
}

/** The error code a failed id reports: the canonical code when the error carries a legacy one. */
function failureCode(error: unknown): string {
  const e = error as { canonical?: unknown; code?: unknown; toJSON?: () => { error?: unknown } };
  if (typeof e?.canonical === 'string') return e.canonical;
  if (typeof e?.code === 'string') return e.code;
  const wire = typeof e?.toJSON === 'function' ? e.toJSON().error : undefined;
  return typeof wire === 'string' ? wire : 'internal_error';
}

async function forgetMany(engine: EngineArg, args: string[], ids: string[]): Promise<void> {
  const { opError } = await import('../core/ops/contract.ts');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  const json = args.includes('--json');
  let flags: Awaited<ReturnType<typeof commonFlags>>;
  try {
    flags = await commonFlags(args, ids[0]!);
    if (flags.requestGiven) {
      throw opError('invalid_params', '--request-id names one forget; a run of several ids gives each its own request id, so nothing was forgotten.',
        `Drop --request-id and run gbrain forget ${ids.join(' ')} again: each id gets its own request id, and the summary prints the request id of any id that fails, so that one id can be resubmitted alone under it.`);
    }
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return;
    throw error;
  }
  const cfg = loadConfig();
  const thin = isThinClient(cfg);
  if (thin && flags.sourceValue) {
    if (await reportPersistenceCliError(opError('invalid_params', '--source cannot override the remote memory writer grant.',
      'Drop --source: on a remote brain the connection\'s memory writer grant decides the source.'), json)) return;
  }
  const { getCliOptions } = await import('../core/cli-options.ts');
  const { acceptPendingRequested } = await import('../core/persistence/write-wait.ts');
  const remote = thin ? await import('../core/mcp-client.ts') : null;
  const { summary, exitCode } = await forgetBatch(ids, async params => remote
    ? remote.unpackToolResult<ForgetResult>(await remote.callRemoteTool(cfg!, 'forget', params, { timeoutMs: 30_000 }))
    : forgetLocal(engine, cfg, flags.sourceValue ?? null, params),
  { reason: flags.reason, acceptPending: acceptPendingRequested(getCliOptions().acceptPending), json });
  if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    process.stdout.write(`${summary.forgotten.length} forgotten, ${summary.already_withdrawn.length} already withdrawn, ${summary.pending.length} pending, ${summary.failed.length} failed.\n`);
    if (summary.failed.length) process.stdout.write(`Retry a failed id with: gbrain forget <id> --request-id <its request id>\n`);
  }
  if (exitCode !== 0) setCliExitVerdict(exitCode);
}

export interface ForgetBatchSummary {
  forgotten: number[];
  already_withdrawn: number[];
  /** Admitted but not committed when the owner's write wait ended: they may still commit (poll the request id). */
  pending: Array<{ id: number; request_id: string; state: string }>;
  failed: Array<{ id: number; code: string; request_id: string }>;
}

/**
 * Forgets each id in order, each with its own request id; one id's failure never stops the next. Exit code: 1 when any id
 * failed, else PENDING_WRITE_EXIT_CODE when any is still pending (0 with --accept-pending), as the single forget exits.
 */
export async function forgetBatch(ids: readonly string[], forgetOne: (params: Record<string, unknown>) => Promise<ForgetResult>,
  opts: { reason?: string; acceptPending: boolean; json: boolean }): Promise<{ summary: ForgetBatchSummary; exitCode: number }> {
  const { randomUUID } = await import('node:crypto');
  const { pendingReceiptOf } = await import('../core/persistence/write-wait.ts');
  const { PENDING_WRITE_EXIT_CODE } = await import('../core/exit-codes.ts');
  const summary: ForgetBatchSummary = { forgotten: [], already_withdrawn: [], pending: [], failed: [] };
  for (const idText of ids) {
    const id = Number(idText);
    const requestId = randomUUID();
    const params: Record<string, unknown> = { id: idText, request_id: requestId, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) };
    try {
      const result = await forgetOne(params);
      (result.expired ? summary.forgotten : summary.already_withdrawn).push(id);
      if (!opts.json) process.stdout.write(result.expired ? `Forgot fact id=${id}\n` : `Fact id=${id} was already withdrawn\n`);
    } catch (error) {
      const pending = pendingReceiptOf(error);
      if (pending) {
        summary.pending.push({ id, request_id: pending.request_id, state: pending.state });
        process.stderr.write(`Pending fact id=${id}: accepted, not yet committed; it may still commit (request ${pending.request_id}).\n`);
        continue;
      }
      const code = failureCode(error);
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({ id, code, request_id: requestId });
      process.stderr.write(`Failed fact id=${id} [${code}]: ${message} (request ${requestId})\n`);
    }
  }
  const exitCode = summary.failed.length ? 1 : summary.pending.length ? (opts.acceptPending ? 0 : PENDING_WRITE_EXIT_CODE) : 0;
  return { summary, exitCode };
}
