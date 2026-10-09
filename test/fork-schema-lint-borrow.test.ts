// Ours (governedwork fork): borrow_from lint through the real callers — the MCP schema_lint op
// and `gbrain schema lint <pack>` — on packs seeded under GBRAIN_HOME. The
// case is the inherited-links one: area-a re-declares `bet` but inherits its
// `amends` frontmatter link from area-base, and borrow_from never carries
// links, so a company that borrows `bet` from area-a without restating that
// link loses it. On the resolved manifest alone nothing looks wrong.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = join(import.meta.dir, '..');

const pack = (m: { name: string } & Record<string, unknown>) => ({
  api_version: 'gbrain-schema-pack-v1',
  version: '1.0.0',
  extends: null,
  borrow_from: [],
  page_types: [],
  link_types: [],
  frontmatter_links: [],
  ...m,
});
const type = (name: string) => ({ name, primitive: 'entity', path_prefixes: [] });

const AREA_BASE = pack({
  name: 'area-base',
  page_types: [type('bet')],
  link_types: [{ name: 'amends' }],
  frontmatter_links: [{ page_type: 'bet', fields: ['amends'], link_type: 'amends' }],
});
const AREA_A = pack({ name: 'area-a', extends: 'area-base', page_types: [type('bet')] });
const COMPANY_DROPS = pack({
  name: 'company-drops',
  link_types: [{ name: 'amends' }],
  borrow_from: [{ pack: 'area-a', types: ['bet'] }],
});
const COMPANY_KEEPS = pack({
  ...COMPANY_DROPS,
  name: 'company-keeps',
  frontmatter_links: [{ page_type: 'bet', fields: ['amends'], link_type: 'amends' }],
});
// Borrows from a pack that does not exist: the chain cannot resolve, so the
// CLI lints the raw manifest and must say the borrow rules did not run.
const COMPANY_ORPHAN = pack({ name: 'company-orphan', borrow_from: [{ pack: 'area-missing', types: ['bet'] }] });

let tmpHome: string;

function seedPack(m: { name: string }): void {
  const dir = join(tmpHome, '.gbrain', 'schema-packs', m.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(m), 'utf-8');
}

beforeEach(() => {
  _resetPackCacheForTests();
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-lint-borrow-'));
  for (const m of [AREA_BASE, AREA_A, COMPANY_DROPS, COMPANY_KEEPS, COMPANY_ORPHAN]) seedPack(m);
});

afterEach(() => {
  _resetPackCacheForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

function ctxOf(): OperationContext {
  return {
    engine: null,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
  } as unknown as OperationContext;
}

type LintReport = { ok: boolean; errors: Array<{ rule: string; message: string }>; warnings: Array<{ rule: string }> };

const lintOp = async (name: string): Promise<LintReport> =>
  await withEnv({ GBRAIN_HOME: tmpHome }, async () =>
    await operationsByName.schema_lint!.handler(ctxOf(), { pack: name }) as LintReport);

function lintCli(name: string | null, activePack = ''): { status: number | null; report: LintReport } {
  // bun's spawnSync does NOT inherit process.env mutations, so pass env explicitly.
  const env = { ...process.env, GBRAIN_DATABASE_URL: '', DATABASE_URL: '', GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: activePack };
  const args = ['run', 'src/cli.ts', 'schema', 'lint', ...(name === null ? [] : [name]), '--json'];
  const result = spawnSync('bun', args, {
    cwd: REPO_ROOT, encoding: 'utf-8', env,
  });
  return { status: result.status, report: JSON.parse(result.stdout) as LintReport };
}

const rules = (issues: Array<{ rule: string }>) => issues.map((i) => i.rule);

describe('schema_lint op — borrow_from', () => {
  it('a borrowed type whose inherited link was dropped is an error', async () => {
    const report = await lintOp('company-drops');
    expect(rules(report.errors)).toEqual(['borrow_drops_frontmatter_links']);
    expect(report.errors[0]!.message).toContain('bet.amends -> amends');
    expect(report.ok).toBe(false);
  });

  it('control: the same pack with the link restated is clean', async () => {
    const report = await lintOp('company-keeps');
    expect(report.errors).toEqual([]);
    expect(rules(report.warnings)).not.toContain('borrow_checks_skipped');
    expect(report.ok).toBe(true);
  });
});

describe('schema_lint op — active pack borrow_from', () => {
  it('the active pack is linted as declared too', async () => {
    const report = await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: 'company-drops' }, async () =>
      await operationsByName.schema_lint!.handler(ctxOf(), {}) as LintReport);
    expect(rules(report.errors)).toEqual(['borrow_drops_frontmatter_links']);
  });
});

describe('gbrain schema lint <pack> CLI — borrow_from', () => {
  it('a borrowed type whose inherited link was dropped fails the lint', () => {
    const { status, report } = lintCli('company-drops');
    expect(rules(report.errors)).toEqual(['borrow_drops_frontmatter_links']);
    expect(status).toBe(1);
  });

  it('control: the same pack with the link restated passes', () => {
    const { status, report } = lintCli('company-keeps');
    expect(report.errors).toEqual([]);
    expect(status).toBe(0);
  });

  it('the active pack (no name) is linted as declared too', () => {
    const { status, report } = lintCli(null, 'company-drops');
    expect(rules(report.errors)).toEqual(['borrow_drops_frontmatter_links']);
    expect(status).toBe(1);
  });

  it('a pack whose borrow chain cannot resolve reports the borrow rules as skipped', () => {
    const { report } = lintCli('company-orphan');
    expect(rules(report.warnings)).toContain('borrow_checks_skipped');
  });
});
