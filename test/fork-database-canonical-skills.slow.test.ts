// Ours (governedwork fork): shared skills on a database-canonical source
// (src/core/persistence/database-canonical.ts).
//
// A brain made with `gbrain init --db-only` has no checkout to own shared
// skills. On upstream it serves them but cannot publish (writer_not_quiesced).
// The fork publishes them database-only: versions, rollback by republishing,
// and a restart with only the database left on disk.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
const env = { GBRAIN_NO_UPGRADE_CHECK: '1', GBRAIN_INIT_SKIP_EMBED_CHECK: '1', GBRAIN_SCHEMA_PACK: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

async function gbrain(...args: string[]): Promise<string> {
  const r = await runCli(args, { home, env, timeoutMs: 120_000 });
  if (r.exitCode !== 0) throw new Error(`gbrain ${args[0]} ${args[1] ?? ''} exited ${r.exitCode}: ${r.stderr.slice(-800)}`);
  return r.stdout;
}
const json = (out: string) => JSON.parse(out.slice(out.indexOf('{')));
const call = async (op: string, params: unknown) => json(await gbrain('call', op, JSON.stringify(params)));

async function writerState(): Promise<string> {
  return json(await gbrain('sources', 'writer', 'status', '--json')).admin_state;
}

function skill(version: string, expected: string | null, requestId: string) {
  const body = `---\nname: weekly-review\ndescription: Run the weekly review\n---\n# Weekly review ${version}\n`;
  return { source_id: 'default', pack_id: 'acme-way', name: 'weekly-review', request_id: requestId, expected_revision: expected,
    description: 'Run the weekly review', triggers: ['weekly review'],
    files: [{ path: 'skills/weekly-review/SKILL.md', content: body, encoding: 'utf8', file_class: 'prose', audience: ['readers'] }] };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-db-canonical-skills-'));
  await gbrain('init', '--pglite', '--db-only', '--non-interactive', '--no-embedding', '--json');
  await gbrain('config', 'set', 'mcp.publish_skills', 'true');
  await gbrain('sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', await writerState(), '--json');
  await gbrain('sources', 'writer', 'activate', '--confirm-quiesced', '--shared-skills', '--admin-intent', 'writer_activate', '--expected-state', await writerState(), '--json');
  await call('set_skill_policy', { source_id: 'default', expected_policy_epoch: null,
    policy: { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true } });
}, 300_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('database-canonical shared skills', () => {
  let r1: string; let r2: string;

  test('publishes with no checkout, database-only', async () => {
    const put = await call('put_skill', skill('v1', null, '11111111-1111-4111-8111-111111111111'));
    r1 = put.revision;
    expect(r1).toBeString();
    expect(JSON.stringify(put)).toContain('db_only');
  }, 120_000);

  test('a new revision, then rollback by republishing; the old revision stays readable', async () => {
    r2 = (await call('put_skill', skill('v2', r1, '22222222-2222-4222-8222-222222222222'))).revision;
    const r3 = (await call('put_skill', skill('v1', r2, '33333333-3333-4333-8333-333333333333'))).revision;
    const ref = { schema_version: 2, source_id: 'default', pack_id: 'acme-way', name: 'weekly-review' };
    const head = await call('get_skill', ref);
    expect(head.revision).toBe(r3);
    expect(head.body).toContain('Weekly review v1');
    expect((await call('get_skill', { ...ref, revision: r2 })).body).toContain('Weekly review v2');
  }, 120_000);

  test('a stale write is refused', async () => {
    const r = await runCli(['call', 'put_skill', JSON.stringify(skill('v3', r1, '44444444-4444-4444-8444-444444444444'))], { home, env, timeoutMs: 120_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('revision_conflict');
  }, 120_000);

  test('after a restart with only the database on disk, skills are served and publishing works', async () => {
    const db = join(home, '.gbrain', 'brain.pglite');
    const keep = join(tmpdir(), `gbrain-keep-${process.pid}-${Date.now()}`);
    renameSync(db, keep);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    renameSync(keep, db);
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db, embedding_disabled: true, mcp: { publish_skills: true } }));

    const listed = await call('list_skills', { schema_version: 2 });
    expect(JSON.stringify(listed)).toContain('weekly-review');
    const head = await call('get_skill', { schema_version: 2, source_id: 'default', pack_id: 'acme-way', name: 'weekly-review' });
    const after = await call('put_skill', skill('v4', head.revision, '55555555-5555-4555-8555-555555555555'));
    expect(after.revision).toBeString();
  }, 180_000);
});
