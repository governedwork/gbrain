import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import manifest from '../../native/locks/manifest.json';

const repo = join(import.meta.dir, '../..');
function verify(root: string) {
  return spawnSync(process.execPath, ['scripts/native/verify.ts'], { cwd: root, encoding: 'utf8' });
}

function windowsImports(binary: Buffer): string[] {
  const pe = binary.readUInt32LE(0x3c);
  expect(binary.toString('ascii', pe, pe + 4)).toBe('PE\0\0');
  const optional = pe + 24;
  expect(binary.readUInt16LE(optional)).toBe(0x20b);
  const sectionTable = optional + binary.readUInt16LE(pe + 20);
  const offset = (rva: number) => {
    for (let i = 0; i < binary.readUInt16LE(pe + 6); i++) {
      const section = sectionTable + i * 40;
      const start = binary.readUInt32LE(section + 12);
      const length = Math.max(binary.readUInt32LE(section + 8), binary.readUInt32LE(section + 16));
      if (rva >= start && rva < start + length) return binary.readUInt32LE(section + 20) + rva - start;
    }
    throw new Error(`PE import RVA ${rva} has no section`);
  };
  const names: string[] = [];
  for (let entry = offset(binary.readUInt32LE(optional + 120)); binary.readUInt32LE(entry + 12); entry += 20) {
    const start = offset(binary.readUInt32LE(entry + 12));
    names.push(binary.toString('ascii', start, binary.indexOf(0, start)).toLowerCase());
  }
  return names;
}

describe('native lock distribution integrity', () => {
  test('all eight vendored binaries match the current source and hash manifest', () => {
    const result = verify(repo);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified 8 native lock prebuilds');
  });

  test.each(['win32-x64', 'win32-arm64'])('%s binds Node-API to its host without loading another runtime', target => {
    const imports = windowsImports(readFileSync(join(repo, `native/locks/prebuilds/${target}.node`)));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter(name => name.endsWith('.exe') || name === 'node.dll' || name === 'libnode.dll')).toEqual([]);
  });

  test.each(['binary', 'source'])('verification rejects changed %s bytes', (changed) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-native-manifest-'));
    try {
      cpSync(join(repo, 'native/locks'), join(root, 'native/locks'), { recursive: true });
      cpSync(join(repo, 'scripts/native'), join(root, 'scripts/native'), { recursive: true });
      const file = join(root, changed === 'source'
        ? 'native/locks/locks.c' : 'native/locks/prebuilds/linux-x64-glibc.node');
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(file, bytes);
      const result = verify(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(changed === 'source' ? 'source changed' : 'integrity mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
