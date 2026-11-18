// Ours (governedwork fork): the `gbrain schema` CLI resolves a brain-resident pack.
//
// `gbrain schema active` (and every schema subcommand) opens the database through its own helper, not
// the CLI's engine startup; a pack stored only in the database must resolve there too. The hosting's
// migrate step relies on it (governedwork/engram host/engram-migrate.sh).

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { SCHEMA_PACK_API_VERSION } from '../src/core/schema-pack/manifest-v1.ts';

let home: string;
const env = { GBRAIN_NO_UPGRADE_CHECK: '1', GBRAIN_INIT_SKIP_EMBED_CHECK: '1', GBRAIN_SCHEMA_PACK: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const gbrain = (...args: string[]) => runCli(args, { home, env, timeoutMs: 120_000 });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-brain-pack-cli-'));
  const init = await gbrain('init', '--pglite', '--db-only', '--non-interactive', '--no-embedding', '--json');
  expect(init.exitCode).toBe(0);
}, 180_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

test('gbrain schema active resolves a pack stored only in the database', async () => {
  const manifest = {
    api_version: SCHEMA_PACK_API_VERSION, name: 'resident-pack', version: '0.3.0', description: '', gbrain_min_version: '0.38.0',
    extends: 'gbrain-base-v2', borrow_from: [], link_types: [], frontmatter_links: [], takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: [], filing_rules: [],
    page_types: [{ name: 'engagement', primitive: 'temporal', path_prefixes: ['engagements/'], aliases: [], extractable: false, expert_routing: false }],
  };
  const put = await gbrain('call', 'put_schema_pack', JSON.stringify({ name: 'resident-pack', manifest, expected_revision: null }));
  expect(put.exitCode).toBe(0);
  expect((await gbrain('config', 'set', 'schema_pack', 'resident-pack')).exitCode).toBe(0);
  expect(existsSync(join(home, '.gbrain', 'schema-packs', 'resident-pack'))).toBe(false);

  const active = await gbrain('schema', 'active');
  expect(active.exitCode).toBe(0);
  expect(active.stdout).toContain('Active pack: resident-pack v0.3.0');
  expect(active.stdout).toContain('Source: db-config');
}, 180_000);
