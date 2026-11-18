#!/usr/bin/env bun
/**
 * Ours (governedwork fork), not upstream GBrain: retry-before-red for known upstream flakes in `fork-suite`.
 *
 * Usage: bun scripts/fork-retry-known-flakes.ts <receipts-dir>
 *
 * A unit shard of .github/workflows/fork-suite.yml runs `scripts/test-shard.sh … || bun <this> "$GBRAIN_TEST_RECEIPT_DIR"`,
 * so this runs only after a red shard. It reads the shard's JUnit receipts (`*.junit.xml`, written by test-shard.sh
 * when GBRAIN_TEST_RECEIPT_DIR is set) and decides whether the shard may still pass:
 *   - every failed test is listed in scripts/fork-known-flakes.txt → each is re-run once, alone; the shard passes
 *     only if every re-run passes;
 *   - any failed test is not listed → it is printed and the shard stays red; nothing is re-run;
 *   - no failed test in the receipts (a crash, a timeout, no receipt at all) → the shard stays red.
 * FORK_RETRY_RUNNER replaces `bun` as the re-run command (the test seam).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface FailedTest { file: string; name: string }

const ROOT = resolve(import.meta.dir, '..');
const FLAKE_LIST = join(ROOT, 'scripts', 'fork-known-flakes.txt');

const unescapeXml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function attr(attrs: string, key: string): string | null {
  const m = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs);
  return m ? unescapeXml(m[1]!) : null;
}

/** The failed test cases of one Bun JUnit report: a `<testcase>` holding a `<failure>` or `<error>`. */
export function failedTests(xml: string): FailedTest[] {
  const out: FailedTest[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] ?? '';
    if (!/<(failure|error)\b/.test(body)) continue;
    const name = attr(m[1]!, 'name');
    const file = attr(m[1]!, 'file');
    if (name !== null && file !== null) out.push({ file: file.replace(/^\.\//, ''), name });
  }
  return out;
}

/** The listed known flakes: `<test file>\t<test name>` per line; `#` starts a comment. */
export function knownFlakes(text: string): Set<string> {
  return new Set(text.split('\n').map((l) => l.trimEnd()).filter((l) => l && !l.startsWith('#')));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main(dir: string | undefined): number {
  if (!dir) { console.error('usage: bun scripts/fork-retry-known-flakes.ts <receipts-dir>'); return 2; }
  let reports: string[] = [];
  try { reports = readdirSync(dir).filter((f) => f.endsWith('.junit.xml')); } catch { /* no receipt dir: no receipts */ }
  const failed = reports.flatMap((f) => failedTests(readFileSync(join(dir, f), 'utf8')));
  if (failed.length === 0) {
    console.error('fork-retry: the shard is red but its receipts name no failed test (a crash or timeout); it stays red.');
    return 1;
  }
  const listed = knownFlakes(readFileSync(FLAKE_LIST, 'utf8'));
  const unlisted = failed.filter((t) => !listed.has(`${t.file}\t${t.name}`));
  if (unlisted.length > 0) {
    console.error('fork-retry: failures that are not listed known flakes; the shard stays red:');
    for (const t of unlisted) console.error(`  ${t.file} > ${t.name}`);
    return 1;
  }
  const runner = process.env.FORK_RETRY_RUNNER || 'bun';
  let rc = 0;
  for (const t of failed) {
    console.error(`fork-retry: re-running listed known flake once: ${t.file} > ${t.name}`);
    const res = spawnSync(runner, ['test', '--timeout=60000', `./${t.file}`, '-t', escapeRegex(t.name)], { cwd: ROOT, stdio: 'inherit' });
    if (res.status !== 0) { console.error(`fork-retry: it failed again: ${t.file} > ${t.name}`); rc = 1; }
  }
  if (rc === 0) console.error('fork-retry: every failure was a listed known flake that passed on its re-run.');
  return rc;
}

if (import.meta.main) process.exit(main(process.argv[2]));
