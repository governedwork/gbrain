import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts', 'e2e-provider-key-notice.sh');

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-key-notice-'));
  const summary = join(dir, 'summary');
  try {
    const r = spawnSync('bash', [SCRIPT], { env: { PATH: process.env.PATH!, GITHUB_STEP_SUMMARY: summary, ...env }, encoding: 'utf8' });
    let written = '';
    try { written = readFileSync(summary, 'utf8'); } catch { /* no summary written */ }
    return { status: r.status, stdout: r.stdout, summary: written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/e2e-provider-key-notice.sh', () => {
  test('an empty secret is a visible warning naming it and the owner-only fix, never a failure', () => {
    const r = run({ OPENAI_API_KEY: 'set', ANTHROPIC_API_KEY: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::Key-gated E2E tests skipped for missing keys: empty secret(s) ANTHROPIC_API_KEY.');
    expect(r.stdout).toContain('Fix (owner-only): gh secret set ANTHROPIC_API_KEY');
    expect(r.stdout).not.toContain('OPENAI_API_KEY;');
    expect(r.summary).toContain('## Key-gated E2E tests skipped for missing keys');
  });

  test('both secrets set and passed to the tests prints no warning and no summary', () => {
    const r = run({ OPENAI_API_KEY: 'set', ANTHROPIC_API_KEY: 'set', GBRAIN_TEST_KEEP_PROVIDER_KEYS: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('::warning::');
    expect(r.stdout).toContain('key-gated E2E tests ran keyed');
    expect(r.summary).toBe('');
  });

  test.each(['', '0'])('secrets set but stripped by the test preload (GBRAIN_TEST_KEEP_PROVIDER_KEYS=%p) is a named skip, never a keyed run', keep => {
    const r = run({ OPENAI_API_KEY: 'set', ANTHROPIC_API_KEY: 'set', GBRAIN_TEST_KEEP_PROVIDER_KEYS: keep });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::Key-gated E2E tests skipped: provider keys not passed (GBRAIN_TEST_KEEP_PROVIDER_KEYS unset).');
    expect(r.stdout).not.toContain('ran keyed');
    expect(r.summary).toContain('## Key-gated E2E tests skipped: provider keys not passed');
  });
});
