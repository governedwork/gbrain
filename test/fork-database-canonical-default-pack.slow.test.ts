// Ours (governedwork fork): GBrain's default pack on a database-canonical source
// (src/core/persistence/database-canonical.ts).
//
// Upstream installs the packaged `gbrain-memory` pack into an owned content root:
// at a fresh `gbrain init`, and through the 0.53.0 migration once shared skills
// are active on an existing brain. A `gbrain init --db-only` brain has no root, so
// upstream's migration stops at db_only_export_required and the pack never lands.
// The fork publishes shared skills database-only on such a source, so the
// migration installs the same pack there, with the same bytes and the same
// owner-policy rules: no policy is written, and an explicit policy that does not
// approve the pack's requirements leaves the stage pending instead of widening it.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { DEFAULT_SHARED_PACK_ID, packagedSharedSkillPolicy, packagedSharedSkills } from '../src/core/shared-skills/setup-bundle.ts';

const env = { GBRAIN_NO_UPGRADE_CHECK: '1', GBRAIN_INIT_SKIP_EMBED_CHECK: '1', GBRAIN_SCHEMA_PACK: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

function brain() {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-db-default-pack-'));
  homes.push(home);
  const run = (...args: string[]) => runCli(args, { home, env, timeoutMs: 180_000 });
  const gbrain = async (...args: string[]) => {
    const r = await run(...args);
    if (r.exitCode !== 0) throw new Error(`gbrain ${args.slice(0, 2).join(' ')} exited ${r.exitCode}: ${r.stderr.slice(-800)}`);
    return r.stdout;
  };
  const json = (out: string) => JSON.parse(out.slice(out.indexOf('{')));
  const call = async (op: string, params: unknown) => json(await gbrain('call', op, JSON.stringify(params)));
  const writerState = async () => json(await gbrain('sources', 'writer', 'status', '--json')).admin_state as string;
  return {
    run, gbrain, call,
    async init() {
      await gbrain('init', '--pglite', '--db-only', '--non-interactive', '--no-embedding', '--json');
      await gbrain('config', 'set', 'mcp.publish_skills', 'true');
    },
    async activate() {
      await gbrain('sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', await writerState(), '--json');
      await gbrain('sources', 'writer', 'activate', '--confirm-quiesced', '--shared-skills', '--admin-intent', 'writer_activate', '--expected-state', await writerState(), '--json');
    },
    async migrate() {
      const r = await run('apply-migrations', '--migration', '0.53.0', '--yes', '--json');
      return { exitCode: r.exitCode, out: r.stdout + r.stderr };
    },
    async report() {
      return json(await gbrain('config', 'get', 'shared_skills.migration.v1'));
    },
    async packHeads() {
      const listed = await call('list_skills', { schema_version: 2, source_id: 'default' });
      return (listed.skills as Array<{ pack_id: string; name: string; revision: string; qualified_id: string }>)
        .filter(skill => skill.pack_id === DEFAULT_SHARED_PACK_ID)
        .map(skill => ({ name: skill.name, revision: skill.revision, qualified_id: skill.qualified_id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

const packaged = packagedSharedSkills();
const packagedNames = (JSON.parse(packaged['skillpack.json']).skills as string[]).map(path => path.slice('skills/'.length)).sort();

describe('the 0.53.0 migration on a database-canonical source', () => {
  const b = brain();

  test('before shared skills are active it asks for activation, not an export, and installs nothing', async () => {
    await b.init();
    await b.migrate();
    const source = (await b.report()).sources.find((s: { source_id: string }) => s.source_id === 'default');
    const reasons = JSON.stringify(source.stages);
    expect(reasons).not.toContain('db_only_export_required');
    expect(reasons).toContain('writer_not_quiesced');
  }, 300_000);

  test('once active, it installs GBrain\'s default pack with the packaged bytes', async () => {
    await b.activate();
    await b.migrate();
    const heads = await b.packHeads();
    expect(heads.map(h => h.name)).toEqual(packagedNames);
    for (const head of heads) {
      const skill = await b.call('get_skill', { schema_version: 2, qualified_id: head.qualified_id, revision: head.revision });
      expect(skill.body).toBe(packaged[`skills/${head.name}/SKILL.md`]);
    }
    const source = (await b.report()).sources.find((s: { source_id: string }) => s.source_id === 'default');
    expect(source.stages.find((s: { stage: string }) => s.stage === 'projection')?.status).toBe('complete');
  }, 300_000);

  test('a second run changes nothing', async () => {
    const before = await b.packHeads();
    expect(before.map(h => h.name)).toEqual(packagedNames);
    await b.migrate();
    expect(await b.packHeads()).toEqual(before);
  }, 300_000);
});

describe('an explicit owner policy is never widened', () => {
  const b = brain();

  test('a policy that does not approve the pack\'s requirements leaves projection pending', async () => {
    await b.init();
    await b.activate();
    await b.call('set_skill_policy', { source_id: 'default', expected_policy_epoch: null,
      policy: { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: false } });
    await b.migrate();
    const source = (await b.report()).sources.find((s: { source_id: string }) => s.source_id === 'default');
    const projection = source.stages.find((s: { stage: string }) => s.stage === 'projection');
    expect(projection?.status).toBe('action_required');
    expect(projection?.reason).toContain('requirements_changed');
    expect(await b.packHeads()).toEqual([]);
    const policy = await b.call('get_skill_policy', { source_id: 'default' });
    expect(policy.policy.requirements).toEqual([]);
  }, 300_000);

  test('after the owner approves them, the next run installs the pack', async () => {
    const current = await b.call('get_skill_policy', { source_id: 'default' });
    await b.call('set_skill_policy', { source_id: 'default', expected_policy_epoch: current.policy_epoch,
      policy: { ...current.policy, requirements: packagedSharedSkillPolicy().requirements } });
    await b.migrate();
    expect((await b.packHeads()).map(h => h.name)).toEqual(packagedNames);
  }, 300_000);
});
