/**
 * Postgres lane for test/takes-db-native.test.ts (the OAuth-client takes
 * lifecycle on a source with no markdown repo), plus the one leg only real
 * PostgreSQL can prove: a pg_dump / pg_restore round trip keeps every take and
 * the restored brain still accepts the lifecycle. The dump is plain SQL so a
 * newer client (pg17 emits `SET transaction_timeout`, unknown to a pg16 server)
 * restores through psql with ON_ERROR_STOP after that one line is dropped;
 * any other restore error fails the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { registerPostgresTests, requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { hasDatabase } from './helpers.ts';

// With no database the file skips, as upstream's E2E files do (`hasDatabase() ? describe : describe.skip`), so a run
// that names it without DATABASE_URL is not failed by it; scripts/run-e2e.sh, which sets DATABASE_URL, runs both arms.
const d = hasDatabase() ? describe : describe.skip;
if (hasDatabase()) await registerPostgresTests(() => import('../takes-db-native.test.ts'));
const lifecycle = hasDatabase() ? await import('../takes-db-native.test.ts') : null;

d('pg_dump / pg_restore round trip on a managed Postgres brain', () => {
  let adminUrl: string;
  let source: { engine: PostgresEngine; databaseUrl: string; close: () => Promise<void> };
  let restored: BrainEngine | undefined;
  let restoredName: string | undefined;
  let dir: string;
  beforeAll(async () => {
    adminUrl = requirePostgresTestDatabase();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-takes-dump-'));
    source = await isolatedPersistencePostgres(adminUrl);
  }, 120_000);
  afterAll(async () => {
    try {
      if (restored) { await disposePersistenceConsumer(restored); await restored.disconnect(); }
    } finally {
      const admin = postgres(adminUrl, { max: 1, prepare: false });
      try { if (restoredName) await admin.unsafe(`DROP DATABASE IF EXISTS ${restoredName} WITH (FORCE)`); }
      finally {
        await admin.end();
        try { await disposePersistenceConsumer(source.engine); await source.close(); }
        finally { rmSync(dir, { recursive: true, force: true }); }
      }
    }
  });

  /** libpq connection settings from a URL, passed through the environment so the credential never reaches argv or an error message. */
  function pgEnv(url: string): NodeJS.ProcessEnv {
    const u = new URL(url);
    return { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) };
  }

  test('pg_dump then pg_restore keeps every take, and the restored brain accepts the lifecycle', async () => {
    const { call, callOk, seedBrain, takeRows, HOLDER, SLUG } = lifecycle!;
    const { granted } = await seedBrain(source.engine, true);
    const add = await callOk(source.engine, 'takes_add', { slug: SLUG, claim: 'Alice ships weekly', kind: 'take', holder: HOLDER, weight: 0.7 }, granted);
    const sup = await callOk(source.engine, 'takes_supersede', { slug: SLUG, row_num: add.row_num, claim: 'Alice ships daily' }, granted);
    expect(await call(source.engine, 'takes_resolve', { slug: SLUG, row_num: sup.new_row, quality: 'correct' }, granted)).toMatchObject({ quality: 'correct' });
    const before = await takeRows(source.engine);
    expect(before).toMatchObject([{ row_num: 1, active: false, superseded_by: 2 }, { row_num: 2, resolved_quality: 'correct' }]);

    const sql = execFileSync('pg_dump', ['-Fp', '--no-owner', '--no-privileges'], { env: pgEnv(source.databaseUrl), encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
    const dump = join(dir, 'brain.sql');
    writeFileSync(dump, sql.split('\n').filter(line => !/^SET transaction_timeout\b/.test(line)).join('\n'));
    restoredName = `gbrain_test_restore_${randomUUID().replace(/-/g, '')}`;
    const admin = postgres(adminUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${restoredName}`);
    await admin.end();
    const restoredUrl = new URL(adminUrl); restoredUrl.pathname = `/${restoredName}`;
    execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-f', dump], { env: pgEnv(restoredUrl.toString()), stdio: ['ignore', 'ignore', 'pipe'] });

    const fresh = new PostgresEngine();
    await fresh.connect({ database_url: restoredUrl.toString(), poolSize: 2 });
    restored = fresh;
    expect(await takeRows(fresh)).toEqual(before);
    const after = await call(fresh, 'takes_add', { slug: SLUG, claim: 'After restore', kind: 'take', holder: HOLDER }, granted); // the same client credential, against the restored brain
    expect(after).toMatchObject({ status: 'created_or_updated', row_num: 3, holder: HOLDER });
    expect(await takeRows(fresh)).toHaveLength(3);
    expect(await takeRows(source.engine)).toEqual(before); // the source brain is untouched by the restore
  }, 120_000);
});
