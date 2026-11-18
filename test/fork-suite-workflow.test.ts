/**
 * Ours (governedwork fork), not upstream GBrain: pins what the fork's required `fork-suite` check runs.
 *
 * `fork-suite` (.github/workflows/fork-suite.yml) is the context the brains-v* ruleset requires beside
 * `lander/verdict`, and the only place the fork's whole suite runs (the lander runs a PR's named tests). Two
 * guarantees ride it:
 *   - postgres (ledger 111): the PostgreSQL-only tests — upstream's E2E corpus through scripts/run-e2e.sh and the
 *     unit suites' PostgreSQL arms through scripts/postgres-unit-arms.ts — are part of the required check.
 *   - flake (ledger 105): a shard whose only failures are listed known upstream flakes (belief-ledger probe 13)
 *     re-runs those tests once before it reads red; any other failure stays red.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/fork-suite.yml');
const RETRY_SCRIPT = join(ROOT, 'scripts/fork-retry-known-flakes.ts');
const FLAKE_LIST = join(ROOT, 'scripts/fork-known-flakes.txt');
const PROBE_13_FILE = 'test/belief-ledger-coverage.test.ts';
const PROBE_13_NAME =
  'probe 13: a stalled publication stays unproven until its commit mark, then becomes visible; a later event of the page proves it';

interface Step { name?: string; run?: string; env?: Record<string, unknown> }
interface Job {
  needs?: string[] | string;
  services?: Record<string, { image?: string }>;
  strategy?: { matrix?: { shard?: unknown[] } };
  env?: Record<string, unknown>;
  steps?: Step[];
}

function workflow(): { jobs: Record<string, Job> } {
  return Bun.YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as { jobs: Record<string, Job> };
}

/** The step whose `run` mentions `needle`, with the job env under its own. */
function stepRunning(job: Job, needle: string): { run: string; env: Record<string, unknown> } | undefined {
  const step = (job.steps ?? []).find((s) => (s.run ?? '').includes(needle));
  return step ? { run: step.run ?? '', env: { ...(job.env ?? {}), ...(step.env ?? {}) } } : undefined;
}

function aggregate(): { needs: string[]; run: string } {
  const job = workflow().jobs['fork-suite'];
  const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
  return { needs, run: (job.steps ?? []).map((s) => s.run ?? '').join('\n') };
}

describe('fork-suite PostgreSQL lanes (ledger 111)', () => {
  test('postgres: a sharded pgvector pg16 job runs upstream scripts/run-e2e.sh against DATABASE_URL', () => {
    const job = workflow().jobs['postgres-e2e'];
    expect(job).toBeDefined();
    expect(job.services?.postgres?.image).toBe('pgvector/pgvector:pg16');
    expect((job.strategy?.matrix?.shard ?? []).length).toBeGreaterThan(1);
    const step = stepRunning(job, 'scripts/run-e2e.sh');
    expect(step).toBeDefined();
    expect(String(step!.env.DATABASE_URL ?? '')).toMatch(/^postgres(ql)?:\/\/.+@(localhost|127\.0\.0\.1):5432\//);
    expect(String(step!.env.SHARD ?? '')).toContain('matrix.shard');
  });

  test('postgres: the unit suites\' PostgreSQL arms run through scripts/postgres-unit-arms.ts', () => {
    const job = workflow().jobs['postgres-arms'];
    expect(job).toBeDefined();
    expect(job.services?.postgres?.image).toBe('pgvector/pgvector:pg16');
    const step = stepRunning(job, 'scripts/postgres-unit-arms.ts run');
    expect(step).toBeDefined();
    expect(String(step!.env.GBRAIN_ARM_DATABASE_URLS ?? '')).toMatch(/postgres(ql)?:\/\//);
    expect(String(step!.env.GBRAIN_TEST_ALLOW_DATABASE_URL ?? '')).toBe('1');
  });

  test('postgres: the required fork-suite aggregate needs every lane and passes only when each succeeded', () => {
    const { needs, run } = aggregate();
    for (const lane of ['unit', 'serial', 'postgres-e2e', 'postgres-arms']) {
      expect(needs).toContain(lane);
      expect(run).toContain(`test "\${{ needs.${lane}.result }}" = success`);
    }
  });

  test('postgres: the Postgres-only takes lifecycle file is in run-e2e.sh\'s default corpus', () => {
    const listed = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], { cwd: ROOT, encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(listed.stdout.split('\n')).toContain('test/e2e/takes-db-native-postgres.test.ts');
  });
});

/** One Bun JUnit report (the shape `bun test --reporter=junit` writes) with the given failed and passed cases. */
function junit(cases: Array<{ file: string; name: string; failed: boolean }>): string {
  const body = cases
    .map((c) =>
      c.failed
        ? `<testcase name="${c.name}" classname="x" time="0.1" file="${c.file}" line="1" assertions="1">` +
          `<failure type="AssertionError" message="boom">AssertionError: boom</failure></testcase>`
        : `<testcase name="${c.name}" classname="x" time="0.1" file="${c.file}" line="1" assertions="1" />`,
    )
    .join('\n');
  const failures = cases.filter((c) => c.failed).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${cases.length}" failures="${failures}">\n` +
    `<testsuite name="${cases[0]?.file ?? 'none'}" file="${cases[0]?.file ?? 'none'}" tests="${cases.length}" failures="${failures}">\n` +
    `${body}\n</testsuite>\n</testsuites>\n`;
}

/**
 * Runs the retry script over a receipt dir holding `report`, with a stub test runner that records its argv and
 * exits `rerunExit`. Returns the script's exit status and every argv the stub saw.
 */
function retry(report: string | null, rerunExit: number): { status: number | null; reruns: string[]; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fork-retry-'));
  try {
    const receipts = join(dir, 'receipts');
    spawnSync('mkdir', ['-p', receipts]);
    if (report !== null) writeFileSync(join(receipts, 'unit--s1of12--primary.junit.xml'), report);
    const calls = join(dir, 'calls.log');
    const stub = join(dir, 'stub-runner.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${calls}'\nexit ${rerunExit}\n`);
    chmodSync(stub, 0o755);
    const res = spawnSync('bun', [RETRY_SCRIPT, receipts], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORK_RETRY_RUNNER: stub },
    });
    const reruns = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
    return { status: res.status, reruns, output: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fork-suite known-flake retry before red (ledger 105)', () => {
  test('flake: belief-ledger probe 13 is the listed known flake', () => {
    expect(existsSync(FLAKE_LIST)).toBe(true);
    const rows = readFileSync(FLAKE_LIST, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(rows).toContain(`${PROBE_13_FILE}\t${PROBE_13_NAME}`);
  });

  test('flake: unit shards keep JUnit receipts and hand a red shard to the retry script', () => {
    const job = workflow().jobs.unit;
    const step = stepRunning(job, 'scripts/test-shard.sh');
    expect(step).toBeDefined();
    expect(String(step!.env.GBRAIN_TEST_RECEIPT_DIR ?? '')).not.toBe('');
    expect(step!.run).toMatch(/scripts\/test-shard\.sh[^\n]*\|\|\s*bun scripts\/fork-retry-known-flakes\.ts/);
  });

  test('flake: a red whose only failure is a listed flake passes when one re-run passes', () => {
    const r = retry(junit([
      { file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true },
      { file: 'test/other.test.ts', name: 'stays green', failed: false },
    ]), 0);
    expect(r.status).toBe(0);
    expect(r.reruns).toHaveLength(1);
    expect(r.reruns[0]).toContain(`./${PROBE_13_FILE}`);
  });

  test('flake: a listed flake that fails its re-run stays red', () => {
    const r = retry(junit([{ file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true }]), 1);
    expect(r.status).toBe(1);
    expect(r.reruns).toHaveLength(1);
  });

  test('flake: any unlisted failure stays red and nothing is re-run', () => {
    const r = retry(junit([
      { file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true },
      { file: 'test/other.test.ts', name: 'a real regression', failed: true },
    ]), 0);
    expect(r.status).toBe(1);
    expect(r.reruns).toHaveLength(0);
    expect(r.output).toContain('a real regression');
  });

  test('flake: a red shard with no failed test in its receipts (a crash) stays red', () => {
    expect(retry(junit([{ file: 'test/other.test.ts', name: 'green', failed: false }]), 0).status).toBe(1);
    expect(retry(null, 0).status).toBe(1);
  });
});
