/**
 * Fork: the machine-mail label's two brain config keys are settable with
 * `gbrain config set` (registered in KNOWN_CONFIG_KEYS), and a long list
 * (150 entries, ~5 KB) round-trips through set/get unchanged and still
 * parses into a policy. Spawns the real CLI against a throwaway PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { classifySender, parseSenderPolicy } from '../src/core/google/sender-class.ts';

const CLASSES: readonly string[] = ['no_reply', 'sign_in', 'receipt', 'alert', 'machine'];
const LONG_MACHINE = Array.from({ length: 150 }, (_, i) =>
  i % 3 === 0 ? `@machine-domain-${String(i).padStart(3, '0')}.example` : `sender-${String(i).padStart(3, '0')}@vendor-${i}.example=${CLASSES[i % CLASSES.length]}`,
).join(', ');
const LONG_PERSON = Array.from({ length: 150 }, (_, i) =>
  i % 3 === 0 ? `@person-domain-${String(i).padStart(3, '0')}.example` : `human.name-${String(i).padStart(3, '0')}@firm-${i}.example`,
).join(', ');

let home: string;
const env = { GBRAIN_BRAIN_ID: '', GBRAIN_SOURCE: '' };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-sender-class-config-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const dbPath = join(home, '.gbrain', 'brain.pglite');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  await engine.initSchema();
  await engine.disconnect();
}, 240_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function setAndGet(key: string, value: string): Promise<string> {
  const set = await runCli(['config', 'set', key, value], { home, env, timeoutMs: 120_000 });
  expect(set.stderr).not.toContain('Unknown config key');
  expect(set.exitCode).toBe(0);
  const get = await runCli(['config', 'get', key], { home, env, timeoutMs: 120_000 });
  expect(get.exitCode).toBe(0);
  return get.stdout.replace(/\n$/, '');
}

describe('machine-mail config keys through gbrain config set/get', () => {
  test.each([
    ['loops.machine_senders', 'a@b.example=receipt'],
    ['loops.person_senders', 'postmaster@acct.example, @firm.example'],
  ])('config set %s %s is accepted and reads back', async (key, value) => {
    expect(await setAndGet(key, value)).toBe(value);
  }, 240_000);

  test('a 150-entry (~5 KB) list round-trips unchanged and parses', async () => {
    expect(LONG_MACHINE.length).toBeGreaterThan(4500);
    expect(LONG_PERSON.length).toBeGreaterThan(4500);
    const machine = await setAndGet('loops.machine_senders', LONG_MACHINE);
    const person = await setAndGet('loops.person_senders', LONG_PERSON);
    expect(machine).toBe(LONG_MACHINE);
    expect(person).toBe(LONG_PERSON);
    const policy = parseSenderPolicy(machine, person);
    expect(policy.machineAddresses.size + policy.machineDomains.size).toBe(150);
    expect(policy.personAddresses.size + policy.personDomains.size).toBe(150);
    expect(classifySender('sender-001@vendor-1.example', policy)).toBe('sign_in');
    expect(classifySender('anyone@machine-domain-003.example', policy)).toBe('machine');
    expect(classifySender('billing@person-domain-000.example', policy)).toBe('person');
  }, 480_000);
});
