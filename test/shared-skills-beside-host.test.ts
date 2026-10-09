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
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const op = (name: string) => skillsCatalogOperations.find(o => o.name === name)!;
const skillMd = (name: string, text: string) => `---\nname: ${name}\ndescription: ${text}\n---\n\n${text}\n`;

async function fixture(run: (local: OperationContext) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-skills-beside-host-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_SKILLS_DIR: undefined }, async () => {
    const isolated = await isolatedSharedSkillsEngine();
    const engine = isolated.engine;
    try {
      const hostDir = join(dir, 'host-skills');
      for (const [name, text] of [['host-only', 'Bundled host skill'], ['clash', 'Bundled version of clash']]) {
        mkdirSync(join(hostDir, name), { recursive: true });
        writeFileSync(join(hostDir, name, 'SKILL.md'), skillMd(name, text));
      }
      await engine.setConfig('mcp.skills_dir', hostDir);
      await engine.setConfig('mcp.publish_skills', 'true');
      const root = join(dir, 'default'); mkdirSync(root);
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await claimWorktree(engine, 'default', root);
      await run({ engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } });
    } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}
async function put(ctx: OperationContext, name: string, body: string) {
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
  return submitSharedSkillMutation(ctx, 'put_skill', { request_id: randomUUID(), expected_revision: null, source_id: 'default',
    source_incarnation: source.incarnation, pack_id: 'company-pack', name, files: [{ path: `skills/${name}/SKILL.md`, content: body, file_class: 'prose' }] });
}
type Listed = { count: number; skills: { name: string; description: string }[]; shadowed_host_skills?: string[] };

test('activating shared skills keeps the host skills; a shared skill shadows a same-named host skill and says so', () => fixture(async local => {
  const before = await op('list_skills').handler(local, {}) as Listed;
  expect(before.skills.map(s => s.name)).toEqual(['clash', 'host-only']);

  await activateSharedSkillPersistence(local.engine, { confirmQuiesced: true });
  await put(local, 'company-only', skillMd('company-only', 'Company skill'));
  await put(local, 'clash', skillMd('clash', 'Company version of clash'));

  const after = await op('list_skills').handler(local, {}) as Listed;
  expect(after.skills.map(s => s.name)).toEqual(['clash', 'company-only', 'host-only']);
  expect(after.count).toBe(3);
  expect(after.skills.find(s => s.name === 'clash')!.description).toBe('Company version of clash');
  expect(after.shadowed_host_skills).toEqual(['clash']);

  const hostOnly = await op('get_skill').handler(local, { name: 'host-only' }) as { body: string };
  expect(hostOnly.body).toContain('Bundled host skill');
  const clash = await op('get_skill').handler(local, { name: 'clash' }) as { body: string };
  expect(clash.body).toContain('Company version of clash');
  const company = await op('get_skill').handler(local, { name: 'company-only' }) as { body: string };
  expect(company.body).toContain('Company skill');

  // The source-qualified catalog stays the shared catalog only.
  const v2 = await op('list_skills').handler(local, { schema_version: 2 }) as { skills: { name: string }[] };
  expect(v2.skills.map(s => s.name).sort()).toEqual(['clash', 'company-only']);
}), 120_000);
