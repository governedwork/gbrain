/**
 * Ours (governedwork fork), not upstream GBrain: pins what the fork's `fork-suite` workflow runs.
 *
 * `fork-suite` (.github/workflows/fork-suite.yml) is the fork's main verification: it runs the whole suite on every
 * push to brains-v*, after the merge (the lander gates each PR with the typecheck alone). Three guarantees ride it:
 *   - trigger: push to brains-v* and by hand, never per pull request.
 *   - postgres (ledger 111): the PostgreSQL-only tests — upstream's E2E corpus through scripts/run-e2e.sh and the
 *     unit suites' PostgreSQL arms through scripts/postgres-unit-arms.ts — are part of it.
 *   - flake (ledger 105): a shard whose only failures are listed known upstream flakes (belief-ledger probe 13)
 *     re-runs those tests once before it reads red; any other failure stays red.
 */
import { describe, expect, test } from 'bun:test';
import { ARM_SHARDS } from '../scripts/postgres-unit-arms.ts';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  strategy?: { matrix?: { shard?: unknown[] | string } };
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

describe('fork-suite is main verification (lander standard profile)', () => {
  test('it runs on push to brains-v* and by hand, never per pull request', () => {
    const { on } = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as { on: Record<string, unknown> };
    expect(Object.keys(on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(on.push).toEqual({ branches: ['brains-v*'] });
  });
});

describe('fork-suite PostgreSQL lanes (ledger 111)', () => {
  test('postgres: a sharded pgvector pg16 job runs upstream scripts/run-e2e.sh against DATABASE_URL', () => {
    const job = workflow().jobs['postgres-e2e'];
    expect(job).toBeDefined();
    expect(job.services?.postgres?.image).toBe('pgvector/pgvector:pg16');
    expect((job.strategy?.matrix?.shard ?? []).length).toBeGreaterThan(1);
    const step = stepRunning(job, 'scripts/run-e2e.sh');
    expect(step).toBeDefined();
    expect(String(step!.env.DATABASE_URL ?? '')).toMatch(/^postgres(ql)?:\/\/.+@(localhost|127\.0\.0\.1):\$\{\{ job\.services\.postgres\.ports\['5432'\] \}\}\//);
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
    // The matrix and the shard count come from the plan job's ARM_SHARDS, so a rebase that raises it cannot leave the
    // lane short.
    expect(String(job.strategy?.matrix?.shard)).toBe('${{ fromJSON(needs.plan.outputs.arms) }}');
    expect(step!.run).toContain('${{ needs.plan.outputs.arms_total }}');
  });

  test('plan: the unit and arm shard counts are read from upstream\'s UNIT_SHARDS and ARM_SHARDS', () => {
    const job = workflow().jobs.plan;
    const run = (job.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(run).toContain('UNIT_SHARDS } = await import("./scripts/sharding.ts")');
    expect(run).toContain('ARM_SHARDS } = await import("./scripts/postgres-unit-arms.ts")');
    expect(ARM_SHARDS).toBeGreaterThan(0);
    expect(String(workflow().jobs.unit.strategy?.matrix?.shard)).toBe('${{ fromJSON(needs.plan.outputs.unit) }}');
  });

  test('postgres: the required fork-suite aggregate needs every lane and passes only when each succeeded', () => {
    const { needs, run } = aggregate();
    for (const lane of ['plan', 'unit', 'serial', 'postgres-e2e', 'postgres-arms']) {
      expect(needs).toContain(lane);
      expect(run).toContain(`test "\${{ needs.${lane}.result }}" = success`);
    }
  });

  test('postgres: the Postgres-only takes lifecycle file is in run-e2e.sh\'s default corpus', () => {
    const listed = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], { cwd: ROOT, encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(listed.stdout.split('\n')).toContain('test/e2e/takes-db-native-postgres.test.ts');
  });
  test('postgres: every fork E2E exclusion names an existing E2E file and its reason, and the lane drops exactly those', () => {
    // test-reads-source-ok[structural]: an exclusion row is the only record of why a file runs nowhere.
    const rows = readFileSync(join(ROOT, 'scripts/fork-e2e-exclusions.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    for (const row of rows) {
      const [file, reason] = row.split('\t');
      expect(file!.startsWith('test/e2e/')).toBe(true);
      expect(existsSync(join(ROOT, file!))).toBe(true);
      expect((reason ?? '').trim().length).toBeGreaterThan(20);
    }
    const step = stepRunning(workflow().jobs['postgres-e2e'], 'scripts/run-e2e.sh');
    expect(step!.run).toContain('scripts/fork-e2e-exclusions.txt');
  });

});

/** One Bun JUnit report (the shape `bun test --reporter=junit` writes) with the given failed and passed cases. */
function junit(cases: Array<{ file: string; name: string; failed: boolean; skipped?: boolean }>): string {
  const body = cases
    .map((c) =>
      c.failed
        ? `<testcase name="${c.name}" classname="x" time="0.1" file="${c.file}" line="1" assertions="1">` +
          `<failure type="AssertionError" message="boom">AssertionError: boom</failure></testcase>`
        : c.skipped
          ? `<testcase name="${c.name}" classname="x" time="0" file="${c.file}" line="1" assertions="0"><skipped /></testcase>`
          : `<testcase name="${c.name}" classname="x" time="0.1" file="${c.file}" line="1" assertions="1" />`,
    )
    .join('\n');
  const failures = cases.filter((c) => c.failed).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${cases.length}" failures="${failures}">\n` +
    `<testsuite name="${cases[0]?.file ?? 'none'}" file="${cases[0]?.file ?? 'none'}" tests="${cases.length}" failures="${failures}">\n` +
    `${body}\n</testsuite>\n</testsuites>\n`;
}

/**
 * Runs the retry script over a receipt dir holding `report`, with a stub test runner that records its argv, writes
 * its own JUnit report (the probe as `rerun`: passed, skipped or absent) and exits `rerunExit`. `log` is the shard
 * log handed to the script. Returns the script's exit status and every argv the stub saw.
 */
function retry(report: string | null, rerunExit: number, opts: { rerun?: 'pass' | 'skip' | 'none' | 'other-fails'; log?: string } = {}): { status: number | null; reruns: string[]; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fork-retry-'));
  try {
    const receipts = join(dir, 'receipts');
    mkdirSync(receipts, { recursive: true });
    if (report !== null) writeFileSync(join(receipts, 'unit--s1of12--primary.junit.xml'), report);
    const calls = join(dir, 'calls.log');
    const rerunCase = opts.rerun === 'none' ? []
      : [{ file: PROBE_13_FILE, name: PROBE_13_NAME, failed: rerunExit !== 0, skipped: opts.rerun === 'skip' },
        ...(opts.rerun === 'other-fails' ? [{ file: PROBE_13_FILE, name: 'probe 12: a neighbour', failed: true }] : [])];
    const rerunReport = join(dir, 'rerun-template.xml');
    writeFileSync(rerunReport, junit(rerunCase));
    const stub = join(dir, 'stub-runner.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${calls}'\n`
      + `for a in "$@"; do case "$a" in --reporter-outfile=*) cp '${rerunReport}' "\${a#--reporter-outfile=}";; esac; done\n`
      + `exit ${rerunExit}\n`);
    chmodSync(stub, 0o755);
    const args = [RETRY_SCRIPT, receipts];
    if (opts.log !== undefined) { writeFileSync(join(dir, 'shard.log'), opts.log); args.push(join(dir, 'shard.log')); }
    const res = spawnSync('bun', args, {
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
    // The whole file is re-run: a listed test can depend on what its file sets up.
    expect(r.reruns[0]).not.toContain(' -t ');
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

  test('flake: a shard whose log counts errors outside any test (a file that failed to load) stays red, nothing re-run', () => {
    const r = retry(junit([{ file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true }]), 0,
      { log: ' 120 pass\n 1 fail\n 1 error\nRan 121 tests across 12 files.\n' });
    expect(r.status).toBe(1);
    expect(r.reruns).toHaveLength(0);
  });

  test('flake: a re-run of the file in which another test fails stays red', () => {
    expect(retry(junit([{ file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true }]), 0, { rerun: 'other-fails' }).status).toBe(1);
  });

  test('flake: a re-run that exits 0 but skips the test, or never reaches it, is not a pass', () => {
    expect(retry(junit([{ file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true }]), 0, { rerun: 'skip' }).status).toBe(1);
    expect(retry(junit([{ file: PROBE_13_FILE, name: PROBE_13_NAME, failed: true }]), 0, { rerun: 'none' }).status).toBe(1);
  });

  test('flake: every listed row names a test that exists in its file', () => {
    // test-reads-source-ok[structural]: a stale row would retry whatever test later takes the same name.
    const rows = readFileSync(FLAKE_LIST, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [file, name] = row.split('\t');
      expect(existsSync(join(ROOT, file!))).toBe(true);
      expect(readFileSync(join(ROOT, file!), 'utf8')).toContain(name!);
    }
  });
});
