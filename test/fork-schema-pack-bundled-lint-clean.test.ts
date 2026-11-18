// Ours (governedwork fork): every pack GBrain ships lints clean as declared.
//
// `gbrain schema lint <bundled pack>` runs the borrow_from rules over the
// pack as written (loadDeclaredPackByName + LintOpts.declared). A bundled
// pack that trips one of them fails the lint for every brain that uses it, so
// each bundled pack is linted here exactly as the CLI and the MCP op lint it.

import { beforeEach, describe, expect, it } from 'bun:test';
import { BUNDLED_PACK_NAMES } from '../src/core/schema-pack/bundled.ts';
import { loadDeclaredPackByName } from '../src/core/schema-pack/load-active.ts';
import { runAllLintRules } from '../src/core/schema-pack/lint-rules.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

beforeEach(() => _resetPackCacheForTests());

describe('bundled schema packs lint clean as declared', () => {
  for (const name of BUNDLED_PACK_NAMES) {
    it(`${name} has no lint errors`, async () => {
      const { resolved, declared } = await loadDeclaredPackByName(name);
      const report = await runAllLintRules(resolved.manifest, { declared });
      expect(report.errors.map((e) => `${e.rule}: ${e.message}`)).toEqual([]);
      expect(report.warnings.map((w) => w.rule)).not.toContain('borrow_checks_skipped');
    });
  }
});
