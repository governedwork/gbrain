import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { verifyNightlyE2E } from '../../scripts/verify-nightly-e2e.ts';
import { classifyShards, main as classifyMain, DOCS as CLASSIFY_DOCS, type ShardJob } from '../../scripts/classify-full-e2e-shards.ts';

const repo = join(import.meta.dir, '../..');
const fullProfile = "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.full_corpus)";
const expected = Array.from({ length: 4 }, (_, i) => [`test/e2e/fixture-${i}-a.test.ts`, `test/e2e/fixture-${i}-b.test.ts`]);
function fixture(fn: (root: string) => void, partitions = expected) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-nightly-e2e-'));
  try {
    for (let index = 0; index < partitions.length; index++) {
      const dir = join(root, `coverage-full-e2e-${index + 1}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'lane-manifest.json'), JSON.stringify({ lane: `e2e-${index + 1}`, sha: 'fixture-sha', lcovCount: 2, complete: true }));
      writeFileSync(join(dir, 'executed-files.txt'), partitions[index].join('\n') + '\n');
    }
    fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('nightly E2E execution receipts', () => {
  test('accepts exactly four complete disjoint partitions of the same commit', () => fixture(root => {
    expect(() => verifyNightlyE2E(root, expected, 'fixture-sha')).not.toThrow();
  }));
  test.each(['missing artifact', 'missing manifest', 'missing receipt', 'wrong SHA', 'incomplete', 'duplicate lane', 'wrong lane', 'missing file', 'duplicate file', 'extra file', 'overlapping partitions', 'malformed manifest'])('%s fails closed', kind => fixture(root => {
    const dir = join(root, 'coverage-full-e2e-4');
    const manifest = join(dir, 'lane-manifest.json');
    const receipt = join(dir, 'executed-files.txt');
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    if (kind === 'missing artifact') rmSync(dir, { recursive: true });
    if (kind === 'missing manifest') rmSync(manifest);
    if (kind === 'missing receipt') rmSync(receipt);
    if (kind === 'wrong SHA') writeFileSync(manifest, JSON.stringify({ ...data, sha: 'stale-commit' }));
    if (kind === 'incomplete') writeFileSync(manifest, JSON.stringify({ ...data, complete: false }));
    if (kind === 'duplicate lane') writeFileSync(manifest, JSON.stringify({ ...data, lane: 'e2e-1' }));
    if (kind === 'wrong lane') writeFileSync(manifest, JSON.stringify({ ...data, lane: 'e2e-5' }));
    if (kind === 'missing file') writeFileSync(receipt, expected[3][0] + '\n');
    if (kind === 'duplicate file') writeFileSync(receipt, [expected[3][0], expected[3][0]].join('\n'));
    if (kind === 'extra file') writeFileSync(receipt, [...expected[3], 'test/e2e/extra.test.ts'].join('\n'));
    if (kind === 'overlapping partitions') writeFileSync(receipt, expected[0].join('\n'));
    if (kind === 'malformed manifest') writeFileSync(manifest, '{');
    expect(() => verifyNightlyE2E(root, expected, 'fixture-sha')).toThrow();
  }));
  test('an absent artifact directory cannot claim complete execution', () => fixture(root => {
    expect(() => verifyNightlyE2E(join(root, 'absent'), expected, 'fixture-sha')).toThrow();
  }));
});

describe('nightly E2E scheduling', () => {
  test('the four actual runner partitions cover the complete default discovery exactly once', () => {
    const discover = (shard: string) => {
      const result = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: shard, COVERAGE_DIR: '' },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split('\n').filter(Boolean);
    };
    const liveKeyOnly = readFileSync(join(repo, 'scripts/e2e-live-key-only.txt'), 'utf8')
      .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const corpus = [...readdirSync(join(repo, 'test/e2e')).filter(file => file.endsWith('.test.ts')).map(file => `test/e2e/${file}`).filter(file => !liveKeyOnly.includes(file)), 'test/phantom-redirect-engine-parity.test.ts'].sort();
    expect(discover('').sort()).toEqual(corpus);
    const byName = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list', ...liveKeyOnly], { cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: '', COVERAGE_DIR: '' } });
    expect(byName.stdout.trim().split('\n')).toEqual(liveKeyOnly);
    const partitions = [1, 2, 3, 4].map(n => discover(`${n}/4`));
    expect(partitions.every(files => files.length > 0)).toBe(true);
    expect(partitions.flat().sort()).toEqual(corpus);
    expect(new Set(partitions.flat()).size).toBe(corpus.length);
    fixture(root => {
      const verify = () => spawnSync(process.execPath, ['scripts/verify-nightly-e2e.ts', root, '4', 'fixture-sha'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: '3/4', COVERAGE_DIR: join(root, 'unused') },
      });
      const complete = verify();
      expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stdout).toContain(`all ${corpus.length} files accounted for across 4 isolated workers`);
      rmSync(join(root, 'coverage-full-e2e-4/executed-files.txt'));
      expect(verify().status).toBe(1);
    }, partitions);
  });
});

describe('full E2E shard classification (#6040)', () => {
  const run = { repo: 'acme-example/brain', runId: '42', attempt: '1', serverUrl: 'https://example.test' };
  // Annotation texts recorded from real runs: 37273083933 (cancelled by a
  // newer push, concurrency) and 37371914954 (cancelled by a user).
  const CONCURRENCY = 'Canceling since a higher priority waiting request for E2E Tests-refs/heads/master exists';
  const USER = 'The run was canceled by @capy-ai[bot].';
  const TIMEOUT = 'The job running on runner ubicloud-runner-1 has exceeded the maximum execution time of 60 minutes.';
  const OP = 'The operation was canceled.';
  const shard = (n: number, conclusion: string | null, annotations: string[] = []): ShardJob => ({ name: `coverage-full-e2e (${n})`, conclusion, annotations });
  const all = (conclusion: string, annotations: string[]) => [1, 2, 3, 4].map(n => shard(n, conclusion, annotations));

  test.each([
    ['all shards succeeded', 'success', all('success', []), 'complete'],
    ['cancelled by a newer run in the concurrency group', 'cancelled', all('cancelled', [CONCURRENCY, OP]), 'cancelled'],
    ['cancelled by a user', 'cancelled', all('cancelled', [USER, OP]), 'cancelled'],
    ['some shards finished before the run was cancelled', 'cancelled', [shard(1, 'success'), shard(2, 'cancelled', [USER, OP]), shard(3, 'success'), shard(4, 'cancelled', [USER])], 'cancelled'],
    ['a shard hit timeout-minutes in a run nobody cancelled', 'cancelled', [shard(1, 'success'), shard(2, 'cancelled', [TIMEOUT, OP]), shard(3, 'success'), shard(4, 'success')], 'failed'],
    ['a timed-out shard in a run later cancelled stays a failure', 'cancelled', [shard(1, 'cancelled', [USER]), shard(2, 'cancelled', [TIMEOUT, USER]), shard(3, 'success'), shard(4, 'success')], 'failed'],
    ['a shard failed before the run was cancelled', 'failure', [shard(1, 'failure', ['Process completed with exit code 1.']), shard(2, 'cancelled', [USER]), shard(3, 'success'), shard(4, 'success')], 'failed'],
    ['cancelled with no annotation saying why', 'cancelled', all('cancelled', [OP]), 'failed'],
    ['no shard jobs found', 'cancelled', [], 'failed'],
    ['skipped', 'skipped', all('skipped', []), 'failed'],
  ] as const)('%s → %s', (_name, result, shards, state) => {
    const c = classifyShards(result, [...shards], run);
    expect(c.state).toBe(state);
    if (state !== 'complete') expect(c.message).toContain(CLASSIFY_DOCS);
    if (state === 'cancelled') expect(c.message).toContain('gh workflow run e2e.yml --ref master -f full_corpus=true');
    if (state === 'failed') expect(c.message).toContain('gh run view 42 --log-failed');
  });

  test('unreadable evidence is a failure, never a cancellation on a guess', () => {
    const c = classifyShards('cancelled', new Error('GitHub API GET ... -> 403'), run);
    expect(c.state).toBe('failed');
    expect(c.title).toBe('Full E2E shard evidence unreadable');
  });

  test('the CLI reads this attempt\'s shard jobs and annotations, writes state and the summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-classify-shards-'));
    // main() prints a workflow command (::error/::warning/::notice). Printed to
    // this job's log, GitHub would turn it into a real annotation on the test
    // run, so it is captured and asserted here instead.
    const printed: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    try {
      const calls: string[] = [];
      const client = {
        async request<T>(_method: string, path: string): Promise<T> {
          calls.push(path);
          if (path.includes('/jobs')) return { jobs: [{ id: 7, name: 'coverage-full-e2e (1)', conclusion: 'cancelled' }, { id: 8, name: 'coverage-full-unit (1)', conclusion: 'success' }] } as T;
          return [{ message: USER }, { message: OP }] as T;
        },
      };
      const env = { FULL_E2E_RESULT: 'cancelled', GITHUB_REPOSITORY: run.repo, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_OUTPUT: join(root, 'out'), GITHUB_STEP_SUMMARY: join(root, 'summary') };
      expect(await classifyMain(env, client)).toBe(0);
      expect(calls).toEqual(['repos/{repo}/actions/runs/42/attempts/2/jobs?per_page=100', 'repos/{repo}/check-runs/7/annotations?per_page=50']);
      expect(readFileSync(join(root, 'out'), 'utf8')).toBe('state=cancelled\n');
      expect(readFileSync(join(root, 'summary'), 'utf8')).toContain('### Full-corpus coverage: cancelled');
      const failing = { ...client, async request<T>(_m: string, path: string): Promise<T> { if (path.includes('/jobs')) throw Object.assign(new Error('403'), { status: 403 }); return [] as T; } };
      const env2 = { ...env, GITHUB_OUTPUT: join(root, 'out2'), GITHUB_STEP_SUMMARY: join(root, 'summary2') };
      writeFileSync(env2.GITHUB_OUTPUT, '');
      expect(await classifyMain(env2, failing)).toBe(1);
      expect(readFileSync(env2.GITHUB_OUTPUT, 'utf8')).toBe('');
      expect(await classifyMain({ ...env, FULL_E2E_RESULT: 'success', GITHUB_OUTPUT: join(root, 'out3') }, failing)).toBe(0);
      expect(readFileSync(join(root, 'out3'), 'utf8')).toBe('state=complete\n');
      expect(printed.map(line => line.slice(0, line.indexOf(' title=')))).toEqual(['::warning', '::error', '::notice']);
    } finally { console.log = origLog; rmSync(root, { recursive: true, force: true }); }
  });
});
