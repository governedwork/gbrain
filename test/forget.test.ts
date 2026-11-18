/**
 * L146: `gbrain forget` takes one fact id, and remote forget cannot see
 * private facts, so withdrawing many private facts is one host command per id.
 * The trusted local CLI forgets every id it is given in one run: each id is
 * its own forget (own request id), a failing id never stops the others, and
 * the run exits 1 with a failure entry per failed id. Planned --json shape
 * for more than one id:
 *   { forgotten: [id...], already_withdrawn: [id...], failed: [{ id, code, request_id }] }
 * In-process against real PGLite (no config file, so no resident owner).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runForget } from '../src/commands/recall.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-batch-'));
let engine: PGLiteEngine;
let ids: number[];

async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [], err: string[] = [];
  const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  const log = console.log, error = console.error;
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); };
  _resetCliExitVerdictForTests();
  try { await withEnv({ GBRAIN_HOME: home }, fn); } finally {
    process.stdout.write = o; process.stderr.write = e; console.log = log; console.error = error;
  }
  return { out: out.join(''), err: err.join(''), code: currentExitCode() };
}

const expired = async (factIds: number[]) => (await engine.executeRaw<{ id: number; expired: boolean }>(
  'SELECT id, expired_at IS NOT NULL AS expired FROM facts WHERE id = ANY($1::int[]) ORDER BY id', [factIds]))
  .map(r => ({ id: Number(r.id), expired: r.expired === true }));

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await registerLocalWriter(engine, 'cli');
}), 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  const slug = `people/${randomUUID().slice(0, 8)}-example`;
  const tag = randomUUID().slice(0, 6);
  await importFromContent(engine, slug, `---\ntitle: X\ntype: person\n---\n# X\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Private claim one ${tag} | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |
| 2 | Private claim two ${tag} | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |
| 3 | Private claim three ${tag} | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`, { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  ids = (await engine.executeRaw<{ id: number; visibility: string }>(
    'SELECT id, visibility FROM facts WHERE entity_slug=$1 ORDER BY id', [slug])).map(r => {
    expect(r.visibility).toBe('private');
    return Number(r.id);
  });
  expect(ids).toHaveLength(3);
}, 60_000);

describe('gbrain forget <id>... (L146)', () => {
  test('L146: one local forget run withdraws every private fact id it is given', async () => {
    const run = await capture(() => runForget(engine, ids.map(String)));
    expect(await expired(ids)).toEqual(ids.map(id => ({ id, expired: true })));
    expect(run.code).toBe(0);
  }, 60_000);

  test('L146: a bad id in the middle does not stop the others; the run exits 1 with a failure entry for it', async () => {
    const [{ max }] = await engine.executeRaw<{ max: number }>('SELECT max(id)::int AS max FROM facts');
    const bad = Number(max) + 100_000;
    const run = await capture(() => runForget(engine, [String(ids[0]), String(bad), String(ids[1]), String(ids[2]), '--json']));
    // Every real id is withdrawn although the second id does not exist.
    expect(await expired(ids)).toEqual(ids.map(id => ({ id, expired: true })));
    expect(run.code).toBe(1);
    const summary = JSON.parse(run.out) as { forgotten?: unknown[]; failed?: Array<{ id: unknown; code: unknown; request_id?: unknown }> };
    expect((summary.forgotten ?? []).map(String).sort()).toEqual(ids.map(String).sort());
    expect((summary.failed ?? []).map(f => ({ id: String(f.id), code: f.code }))).toEqual([{ id: String(bad), code: 'not_found' }]);
    expect(typeof summary.failed?.[0]?.request_id).toBe('string');
  }, 60_000);
});
