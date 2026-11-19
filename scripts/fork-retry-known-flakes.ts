#!/usr/bin/env bun
/**
 * Ours (governedwork fork), not upstream GBrain: retry-before-red for known upstream flakes in `fork-suite`.
 *
 * Usage: bun scripts/fork-retry-known-flakes.ts <receipts-dir> [<shard-log>]
 *
 * A unit shard of .github/workflows/fork-suite.yml runs `scripts/test-shard.sh … | tee <log> || bun <this> "$GBRAIN_TEST_RECEIPT_DIR" <log>`,
 * so this runs only after a red shard. It reads the shard's JUnit receipts (`*.junit.xml`, written by test-shard.sh
 * when GBRAIN_TEST_RECEIPT_DIR is set, parsed strictly by scripts/ci-executed-counts.ts) and decides whether the shard
 * may still pass:
 *   - the shard log reports errors outside any test (a file that failed to load, a throw in a describe body): those
 *     never reach the JUnit report, so the shard stays red;
 *   - no failed test in the receipts (a crash, a timeout, no receipt at all), or a report that does not parse: red;
 *   - any failed test is not listed in scripts/fork-known-flakes.txt: it is printed and the shard stays red;
 *   - every failed test is listed: each file holding one is re-run once, whole (a listed test can depend on what its
 *     file sets up, so run alone it may fail where the file passes), under its own JUnit report, and the shard passes
 *     only if that report shows every listed test passed (a re-run that skips one, or never reaches it, is not a pass)
 *     and nothing else in the file failed. A shard that passes this way is annotated in the job summary, so a known
 *     flake that starts failing often stays visible.
 * FORK_RETRY_RUNNER replaces `bun` as the re-run command (the test seam).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseJUnit, type TestCase } from './ci-executed-counts.ts';

export interface FailedTest { file: string; test: string }

const ROOT = resolve(import.meta.dir, '..');
const FLAKE_LIST = join(ROOT, 'scripts', 'fork-known-flakes.txt');
/** A re-run that wedges (a stall-type flake blocking the event loop) ends here, not at the job timeout. */
const RERUN_TIMEOUT_MS = 10 * 60_000;

/** The listed known flakes: `<test file>\t<test name>` per line; `#` starts a comment. */
export function knownFlakes(text: string): Array<{ file: string; name: string }> {
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const tab = l.indexOf('\t');
    return { file: l.slice(0, tab), name: l.slice(tab + 1) };
  }).filter((row) => row.file && row.name);
}

/** A failed case matches a listed row by file and by its own name (the JUnit identity is `describe > … > name`). */
function listed(rows: Array<{ file: string; name: string }>, t: FailedTest): { file: string; name: string } | undefined {
  const file = t.file.replace(/^\.\//, '');
  return rows.find((r) => r.file === file && (t.test === r.name || t.test.endsWith(` > ${r.name}`)));
}

/** Errors Bun counts outside any test (load failures, describe-body throws), from the shard's summary lines. */
export function shardLogErrors(log: string): number {
  let errors = 0;
  for (const m of log.matchAll(/^\s*(\d+) errors?\s*$/gm)) errors += Number(m[1]);
  return errors;
}

function rerun(runner: string, file: string, names: string[]): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'fork-retry-'));
  const report = join(dir, 'rerun.junit.xml');
  try {
    // The shard's receipt variables stay with the shard: a re-run writes no stray receipts into its directory.
    const env = { ...process.env };
    delete env.GBRAIN_TEST_RECEIPT_DIR;
    delete env.GBRAIN_TEST_RECEIPT_LANE;
    const res = spawnSync(runner, ['test', '--timeout=60000', '--reporter=junit', `--reporter-outfile=${report}`, `./${file}`],
      { cwd: ROOT, stdio: 'inherit', env, timeout: RERUN_TIMEOUT_MS });
    if (res.status !== 0 || !existsSync(report)) return false;
    let cases: TestCase[];
    try { cases = parseJUnit(readFileSync(report, 'utf8')); } catch { return false; }
    if (cases.some((c) => c.status === 'fail')) return false;
    return names.every((name) => {
      const ran = cases.filter((c) => c.test === name || c.test.endsWith(` > ${name}`));
      return ran.length > 0 && ran.every((c) => c.status === 'pass');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(dir: string | undefined, logPath: string | undefined): number {
  if (!dir) { console.error('usage: bun scripts/fork-retry-known-flakes.ts <receipts-dir> [<shard-log>]'); return 2; }
  if (logPath) {
    const errors = existsSync(logPath) ? shardLogErrors(readFileSync(logPath, 'utf8')) : 0;
    if (errors > 0) {
      console.error(`fork-retry: the shard reported ${errors} error(s) outside any test (a file that failed to load, a describe that threw); it stays red.`);
      return 1;
    }
  }
  let failed: FailedTest[] = [];
  try {
    const reports = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.junit.xml')) : [];
    failed = reports.flatMap((f) => parseJUnit(readFileSync(join(dir, f), 'utf8')).filter((c) => c.status === 'fail'))
      .map((c) => ({ file: c.file.replace(/^\.\//, ''), test: c.test }));
  } catch (error) {
    console.error(`fork-retry: a receipt does not parse (${error instanceof Error ? error.message : String(error)}); the shard stays red.`);
    return 1;
  }
  if (failed.length === 0) {
    console.error('fork-retry: the shard is red but its receipts name no failed test (a crash or timeout); it stays red.');
    return 1;
  }
  const rows = knownFlakes(readFileSync(FLAKE_LIST, 'utf8'));
  const unlisted = failed.filter((t) => !listed(rows, t));
  if (unlisted.length > 0) {
    console.error('fork-retry: failures that are not listed known flakes; the shard stays red:');
    for (const t of unlisted) console.error(`  ${t.file} > ${t.test}`);
    return 1;
  }
  const runner = process.env.FORK_RETRY_RUNNER || 'bun';
  const byFile = new Map<string, Set<string>>();
  for (const t of failed) {
    const row = listed(rows, t)!;
    byFile.set(row.file, (byFile.get(row.file) ?? new Set()).add(row.name));
  }
  let rc = 0;
  for (const [file, names] of byFile) {
    console.error(`fork-retry: re-running ${file} once for its listed known flake(s): ${[...names].join('; ')}`);
    if (!rerun(runner, file, [...names])) { console.error(`fork-retry: ${file} did not pass on its re-run`); rc = 1; }
  }
  if (rc === 0) {
    console.log(`::warning title=fork-suite retry::passed only after re-running listed known flake(s): ${failed.map((t) => t.test).join('; ')}`);
    console.error('fork-retry: every failure was a listed known flake that passed on its re-run.');
  }
  return rc;
}

if (import.meta.main) process.exit(main(process.argv[2], process.argv[3]));
