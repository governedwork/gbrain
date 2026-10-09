/**
 * Ours (governedwork fork): activating shared skills must not hide the host
 * skills directory (mcp.skills_dir, normally GBrain's bundled skills) from the
 * unversioned list_skills / get_skill. Both are served; on a name clash the
 * shared skill wins and the host skill is reported in shadowed_host_skills.
 * See src/core/shared-skills/beside-host.ts.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { skillsCatalogOperations } from '../src/core/ops/skills-catalog.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import type { SharedSkillPolicy } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const op = (name: string) => skillsCatalogOperations.find(o => o.name === name)!;
const skillMd = (name: string, text: string) => `---\nname: ${name}\ndescription: ${text}\n---\n\n${text}\n`;
const AUTO = 'Auto-registered (from skill frontmatter)';

interface Fixture { local: OperationContext; reader: OperationContext; getter: OperationContext }

/**
 * `hostSkills: false` leaves mcp.skills_dir unset and runs from an empty
 * directory with no $HOME OpenClaw workspace, so autodetection finds nothing.
 */
async function fixture(run: (f: Fixture) => Promise<void>, opts: { hostSkills?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-skills-beside-host-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_SKILLS_DIR: undefined, OPENCLAW_WORKSPACE: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine();
      const engine = isolated.engine;
      try {
        if (opts.hostSkills !== false) {
          const hostDir = join(dir, 'host-skills');
          for (const [name, text] of [['host-only', 'Bundled host skill'], ['clash', 'Bundled version of clash']]) {
            mkdirSync(join(hostDir, name), { recursive: true });
            writeFileSync(join(hostDir, name, 'SKILL.md'), skillMd(name, text));
          }
          await engine.setConfig('mcp.skills_dir', hostDir);
        }
        await engine.setConfig('mcp.publish_skills', 'true');
        const root = join(dir, 'default'); mkdirSync(root);
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await claimWorktree(engine, 'default', root);
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations,bound_slug_prefixes)
          VALUES('reader','Synthetic reader','read','default',$1::text[],NULL),('getter','Synthetic get-only reader','read','default',$2::text[],NULL)`,
        [['list_skills', 'get_skill'], ['get_skill']]);
        const local: OperationContext = { engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const remote = (id: string, allowedOperations: string[]): OperationContext => ({ ...local, remote: true,
          auth: { token: 'synthetic', clientId: id, principal: { kind: 'oauth_client', id }, scopes: ['read'], sourceId: 'default', allowedOperations } });
        await run({ local, reader: remote('reader', ['list_skills', 'get_skill']), getter: remote('getter', ['get_skill']) });
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}
async function put(ctx: OperationContext, name: string, body: string) {
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
  return submitSharedSkillMutation(ctx, 'put_skill', { request_id: randomUUID(), expected_revision: null, source_id: 'default',
    source_incarnation: source.incarnation, pack_id: 'company-pack', name, files: [{ path: `skills/${name}/SKILL.md`, content: body, file_class: 'prose' }] });
}
async function publishCompanySkills(ctx: OperationContext) {
  await activateSharedSkillPersistence(ctx.engine, { confirmQuiesced: true });
  await put(ctx, 'company-only', skillMd('company-only', 'Company skill'));
  await put(ctx, 'clash', skillMd('clash', 'Company version of clash'));
}
type Listed = { count: number; skills: { name: string; description: string }[]; shadowed_host_skills: string[];
  host_skills: { served_from: string } | { absent: string } };
type Detail = { body: string };

test('activating shared skills keeps the host skills; a shared skill shadows a same-named host skill and says so', () => fixture(async ({ local }) => {
  const before = await op('list_skills').handler(local, {}) as Listed;
  expect(before.skills.map(s => s.name)).toEqual(['clash', 'host-only']);

  await publishCompanySkills(local);

  const after = await op('list_skills').handler(local, {}) as Listed;
  expect(after.skills.map(s => s.name)).toEqual(['clash', 'company-only', 'host-only']);
  expect(after.count).toBe(3);
  expect(after.skills.find(s => s.name === 'clash')!.description).toBe('Company version of clash');
  expect(after.shadowed_host_skills).toEqual(['clash']);
  expect(after.host_skills).toEqual({ served_from: 'config' });

  const hostOnly = await op('get_skill').handler(local, { name: 'host-only' }) as Detail;
  expect(hostOnly.body).toContain('Bundled host skill');
  const clash = await op('get_skill').handler(local, { name: 'clash' }) as Detail;
  expect(clash.body).toContain('Company version of clash');
  const company = await op('get_skill').handler(local, { name: 'company-only' }) as Detail;
  expect(company.body).toContain('Company skill');

  // The source-qualified catalog stays the shared catalog only.
  const v2 = await op('list_skills').handler(local, { schema_version: 2 }) as { skills: { name: string }[] };
  expect(v2.skills.map(s => s.name).sort()).toEqual(['clash', 'company-only']);
}), 120_000);

test('a section filter never un-shadows a host skill: the clash is decided against the whole shared catalog', () => fixture(async ({ local }) => {
  await publishCompanySkills(local);
  const host = await op('list_skills').handler(local, { section: AUTO }) as Listed;
  expect(host.skills.map(s => [s.name, s.description])).toEqual([['host-only', 'Bundled host skill']]);
  expect(host.count).toBe(1);
  expect(host.shadowed_host_skills).toEqual(['clash']);
  const published = await op('list_skills').handler(local, { section: 'Published skills' }) as Listed;
  expect(published.skills.map(s => [s.name, s.description])).toEqual([['clash', 'Company version of clash'], ['company-only', 'Company skill']]);
}), 120_000);

test('get_skill stays inside the get_skill grant: a connection without list_skills still fetches shared and host skills', () => fixture(async ({ local, getter }) => {
  await publishCompanySkills(local);
  expect((await op('get_skill').handler(getter, { name: 'company-only' }) as Detail).body).toContain('Company skill');
  expect((await op('get_skill').handler(getter, { name: 'clash' }) as Detail).body).toContain('Company version of clash');
  expect((await op('get_skill').handler(getter, { name: 'host-only' }) as Detail).body).toContain('Bundled host skill');
}), 120_000);

test('a name in neither catalog gets the shared catalog\'s skill_not_found, not the host\'s page_not_found', () => fixture(async ({ local, reader }) => {
  await publishCompanySkills(local);
  for (const ctx of [local, reader]) {
    await expect(op('get_skill').handler(ctx, { name: 'no-such-skill' })).rejects.toMatchObject({ code: 'skill_not_found' });
  }
}), 120_000);

test('a shared skill this grant cannot see shadows nothing: list_skills and get_skill both fall through to the host skill', () => fixture(async ({ local, reader }) => {
  await publishCompanySkills(local);
  const [source] = await local.engine.executeRaw<{ epoch: string | null }>(`SELECT p.epoch FROM shared_skill_policies p JOIN sources s
    ON s.id=p.source_id AND s.incarnation=p.source_incarnation WHERE s.id='default'`);
  const closed: SharedSkillPolicy = { version: 1, enabled: false, classes: [], audiences: [], requirements: [], allow_follow: false };
  await setSharedSkillPolicy(local, 'default', closed, source?.epoch ?? null);
  const listed = await op('list_skills').handler(reader, {}) as Listed;
  expect(listed.skills.map(s => [s.name, s.description])).toEqual([['clash', 'Bundled version of clash'], ['host-only', 'Bundled host skill']]);
  expect(listed.shadowed_host_skills).toEqual([]);
  expect((await op('get_skill').handler(reader, { name: 'clash' }) as Detail).body).toContain('Bundled version of clash');
}), 120_000);

test('with no host skills directory the list says so, for remote callers naming mcp.skills_dir', () => fixture(async ({ local, reader }) => {
  await publishCompanySkills(local);
  const listed = await op('list_skills').handler(reader, {}) as Listed;
  expect(listed.skills.map(s => s.name)).toEqual(['clash', 'company-only']);
  expect(listed.shadowed_host_skills).toEqual([]);
  expect('absent' in listed.host_skills && listed.host_skills.absent).toContain('mcp.skills_dir');
  await expect(op('get_skill').handler(reader, { name: 'host-only' })).rejects.toMatchObject({ code: 'skill_not_found' });
}, { hostSkills: false }), 120_000);

test('publishing off refuses a remote caller in the shared read, as upstream does, before any host skill', () => fixture(async ({ local, reader }) => {
  await publishCompanySkills(local);
  await local.engine.setConfig('mcp.publish_skills', 'false');
  const refused = { code: 'permission_denied', message: 'Shared skills are not published by this brain.' };
  await expect(op('list_skills').handler(reader, {})).rejects.toMatchObject(refused);
  await expect(op('get_skill').handler(reader, { name: 'company-only' })).rejects.toMatchObject(refused);
  await expect(op('get_skill').handler(reader, { name: 'host-only' })).rejects.toMatchObject(refused);
}), 120_000);
