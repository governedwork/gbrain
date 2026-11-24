/**
 * T-G8 (refactor wave 1, EO7): PGLite snapshot hash inputs.
 *
 * Protects: the unit suite never runs on a stale PGLite snapshot. The runtime
 * hash (`computeSnapshotSchemaHash`) must cover the static import closure of
 * the schema roots (computed here independently with the TypeScript AST).
 * Fails when: a migration file, schema fragment or helper is imported but not
 * hashed; a new dynamic import in the closure is unclassified.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED,
  SNAPSHOT_SCHEMA_LEAVES,
  SNAPSHOT_SCHEMA_ROOTS,
  snapshotSchemaInputs,
} from '../src/core/snapshot-schema-inputs.ts';

const REPO = resolve(import.meta.dir, '..');
const CORE = join(REPO, 'src/core');
const SEE = 'See:  docs/TESTING.md#pglite-schema-snapshot-default-on';

// test-reads-source-ok[structural]: the closure walk reads module text to follow imports.
const read = (rel: string) => readFileSync(join(CORE, rel), 'utf8');
const runtimeInputs = snapshotSchemaInputs((rel) => existsSync(join(CORE, rel)), read);
const repoPath = (coreRel: string) => relative(REPO, resolve(CORE, coreRel));

/** Independent closure: TS AST, static value imports + re-exports; dynamic literal imports reported separately. */
function astClosure(): { files: Set<string>; dynamic: Map<string, string> } {
  const files = new Set<string>();
  const dynamic = new Map<string, string>();
  const resolveSpec = (fromAbs: string, spec: string): string | undefined => {
    const base = resolve(dirname(fromAbs), spec);
    return [base, `${base}.ts`, join(base, 'index.ts')].find((c) => c.endsWith('.ts') && existsSync(c));
  };
  const stack = SNAPSHOT_SCHEMA_ROOTS.map((r) => join(CORE, r));
  while (stack.length > 0) {
    const abs = stack.pop()!;
    if (files.has(abs)) continue;
    files.add(abs);
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
      let spec: string | undefined;
      if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && !stmt.isTypeOnly) spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (spec?.startsWith('.')) {
        const hit = resolveSpec(abs, spec);
        if (hit) stack.push(hit);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && arg.text.startsWith('.')) {
          const hit = resolveSpec(abs, arg.text);
          if (hit) dynamic.set(relative(CORE, hit), relative(REPO, abs));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files: new Set([...files].map((f) => relative(CORE, f))), dynamic };
}


describe('snapshot schema hash inputs (EO7)', () => {
  const ast = astClosure();

  test('the runtime hash covers the full static import closure of the schema roots', () => {
    const missing = [...ast.files].filter((f) => !runtimeInputs.includes(f)).sort();
    if (missing.length > 0) {
      throw new Error(missing.map((f) => [
        `FAIL: src/core/${f} is in the static import closure of the PGLite schema roots but computeSnapshotSchemaHash does not hash it.`,
        'Why:  a change to it would leave the test-fixture PGLite snapshot stale.',
        'Fix:  make src/core/snapshot-schema-inputs.ts reach it (import form it does not follow?), and cover it in every',
        '      pglite-snapshot cache key in .github/workflows/e2e.yml, test.yml and stress.yml.',
        SEE,
      ].join('\n')).join('\n'));
    }
    expect(missing).toEqual([]);
  });

  test('covers every split migration, the registry, migrate.ts, the PGLite schema and the bootstrap file', () => {
    const migrationFiles = readdirSync(join(CORE, 'schema-migrations')).filter((f) => /^v\d{3,}-.*\.ts$/.test(f));
    expect(migrationFiles.length).toBeGreaterThan(170);
    for (const f of migrationFiles) expect(runtimeInputs).toContain(`schema-migrations/${f}`);
    for (const f of [...SNAPSHOT_SCHEMA_ROOTS, ...SNAPSHOT_SCHEMA_LEAVES, 'schema-migrations/helpers.ts', 'engine-sql/bootstrap.ts']) expect(runtimeInputs).toContain(f);
  });

  test('every literal dynamic import inside the closure is classified (hashed leaf or not-hashed with a reason)', () => {
    const unclassified = [...ast.dynamic.entries()]
      .filter(([target]) => !SNAPSHOT_SCHEMA_LEAVES.includes(target) && !(target in SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED) && !ast.files.has(target))
      .map(([target, from]) => `FAIL: ${from} lazily imports src/core/${target}, which the snapshot hash neither hashes nor exempts.\n` +
        'Fix:  add it to SNAPSHOT_SCHEMA_LEAVES (runs during schema init/migrations) or SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED\n' +
        `      (with the reason) in src/core/snapshot-schema-inputs.ts; hashed leaves also go in every pglite-snapshot cache key.\n${SEE}`);
    if (unclassified.length > 0) throw new Error(unclassified.join('\n'));
    for (const target of Object.keys(SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED)) expect(ast.dynamic.has(target)).toBe(true);
  });
});
