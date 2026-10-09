// Ours (governedwork fork): borrow_from lint rules (borrow-lint-rules.ts). Ported from the
// blueprint check that used to live outside GBrain (wheelhouse
// src/blueprint-check.ts); its cases are the spec. Each rule reads the pack
// as declared and loads sources/parents through an in-memory loader + the
// real resolvePack, so inheritance behaves exactly as the registry's does.

import { beforeEach, describe, expect, it } from 'bun:test';
import { SchemaPackManifestSchema, type SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { _resetPackCacheForTests, resolvePack } from '../src/core/schema-pack/registry.ts';
import {
  borrowChecksSkipped,
  borrowDropsFrontmatterLinks,
  borrowNameClash,
  borrowNameUndeclared,
  borrowReplacesInheritedType,
  type DeclaredPack,
} from '../src/core/schema-pack/borrow-lint-rules.ts';
import { runAllLintRules, type LintOpts } from '../src/core/schema-pack/lint-rules.ts';

const pack = (m: Record<string, unknown>): SchemaPackManifest =>
  SchemaPackManifestSchema.parse({
    api_version: 'gbrain-schema-pack-v1',
    version: '1.0.0',
    extends: null,
    ...m,
  });

const type = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  primitive: 'entity',
  path_prefixes: [],
  ...over,
});

// area-base declares bet's links; area-a re-declares bet but inherits its
// `amends` link through extends (the inherited-links case).
const AREA_BASE = pack({
  name: 'area-base',
  page_types: [type('bet')],
  link_types: [{ name: 'amends' }],
  frontmatter_links: [{ page_type: 'bet', fields: ['amends'], link_type: 'amends' }],
});
const AREA_A = pack({
  name: 'area-a',
  extends: 'area-base',
  page_types: [type('bet'), type('customer', { path_prefixes: ['customers/'] })],
  link_types: [{ name: 'part_of' }],
  frontmatter_links: [{ page_type: 'bet', fields: ['project', 'product'], link_type: 'part_of' }],
});
const AREA_B = pack({ name: 'area-b', page_types: [type('bet')] });
const PARENT = pack({
  name: 'company-brain',
  page_types: [type('customer')],
  link_types: [{ name: 'part_of', inverse: 'has_part' }],
});

let packs: Map<string, SchemaPackManifest>;

beforeEach(() => {
  _resetPackCacheForTests();
  packs = new Map([AREA_BASE, AREA_A, AREA_B, PARENT].map((m) => [m.name, m]));
});

const loadByName = async (name: string): Promise<SchemaPackManifest> => {
  const m = packs.get(name);
  if (!m) throw new Error(`no pack ${name}`);
  return m;
};

/** The resolved manifest plus the lint opts every real caller passes. */
async function lintInput(company: SchemaPackManifest): Promise<{ resolved: SchemaPackManifest; opts: LintOpts }> {
  packs.set(company.name, company);
  const declared: DeclaredPack = {
    manifest: company,
    loadByName,
    resolve: (m) => resolvePack(m, loadByName),
  };
  return { resolved: (await resolvePack(company, loadByName)).manifest, opts: { declared } };
}

const rules = (issues: Array<{ rule: string }>) => issues.map((i) => i.rule);

describe('borrowNameUndeclared', () => {
  it('a borrowed type or link type the source does not declare is an error', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', types: ['Bet'], link_types: ['nope'] }],
    }));
    const issues = await borrowNameUndeclared(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_name_undeclared', 'borrow_name_undeclared']);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.type).toBe('Bet');
    expect(issues[1]!.link).toBe('nope');
  });

  it('a type the source only inherits is not borrowable, so it is an error too', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', link_types: ['amends'] }],
    }));
    expect(rules(await borrowNameUndeclared(resolved, opts))).toEqual(['borrow_name_undeclared']);
  });

  it('control: names the source declares itself are fine', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', types: ['bet'], link_types: ['part_of'] }],
    }));
    expect(await borrowNameUndeclared(resolved, opts)).toEqual([]);
  });
});

describe('borrowNameClash', () => {
  it('a name borrowed from two packs is an error', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c',
      borrow_from: [{ pack: 'area-a', types: ['bet'] }, { pack: 'area-b', types: ['bet'] }],
    }));
    const issues = await borrowNameClash(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_name_clash']);
    expect(issues[0]!.message).toContain("from both 'area-a' and 'area-b'");
  });

  it('a name also declared by the pack itself is an error', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', page_types: [type('bet')], borrow_from: [{ pack: 'area-a', types: ['bet'] }],
    }));
    const issues = await borrowNameClash(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_name_clash']);
    expect(issues[0]!.message).toContain("declared by 'c'");
  });

  it('a name borrowed twice from the SAME pack is not a clash (the resolver borrows it once)', async () => {
    for (const borrow_from of [
      [{ pack: 'area-a', types: ['bet', 'bet'] }],
      [{ pack: 'area-a', types: ['bet'] }, { pack: 'area-a', types: ['bet'] }],
    ]) {
      const { resolved, opts } = await lintInput(pack({ name: 'c', borrow_from }));
      expect(await borrowNameClash(resolved, opts)).toEqual([]);
    }
  });

  it('control: distinct names from distinct packs are fine', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', types: ['customer'] }, { pack: 'area-b', types: ['bet'] }],
    }));
    expect(await borrowNameClash(resolved, opts)).toEqual([]);
  });
});

describe('borrowReplacesInheritedType', () => {
  it('a borrowed type that differs from the inherited one is an error', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', extends: 'company-brain', borrow_from: [{ pack: 'area-a', types: ['customer'] }],
    }));
    const issues = await borrowReplacesInheritedType(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_replaces_inherited_type']);
    expect(issues[0]!.message).toContain("inherits from 'company-brain'");
  });

  it('a borrowed link type that differs from the inherited one is an error', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', extends: 'company-brain', borrow_from: [{ pack: 'area-a', link_types: ['part_of'] }],
    }));
    const issues = await borrowReplacesInheritedType(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_replaces_inherited_type']);
    expect(issues[0]!.link).toBe('part_of');
  });

  it("an ancestor's own borrow is not inherited, so borrowing a different one is not a replacement", async () => {
    // resolvePack merges ancestors as declared: mid's borrowed `bet` never reaches c.
    packs.set('area-d', pack({ name: 'area-d', page_types: [type('bet', { path_prefixes: ['d/'] })] }));
    packs.set('mid', pack({ name: 'mid', borrow_from: [{ pack: 'area-d', types: ['bet'] }] }));
    const { resolved, opts } = await lintInput(pack({
      name: 'c', extends: 'mid', borrow_from: [{ pack: 'area-a', types: ['bet'] }],
    }));
    expect(await borrowReplacesInheritedType(resolved, opts)).toEqual([]);
  });

  it("the inherited definition is the ancestors' own, whatever an ancestor borrowed over it", async () => {
    // mid borrows area-a's bet over root's; c inherits root's bet (mid's borrow does not
    // propagate), so c borrowing area-a's bet replaces root's and must be reported.
    packs.set('root', pack({ name: 'root', page_types: [type('bet', { path_prefixes: ['bets/'] })] }));
    packs.set('mid', pack({ name: 'mid', extends: 'root', borrow_from: [{ pack: 'area-a', types: ['bet'] }] }));
    const { resolved, opts } = await lintInput(pack({
      name: 'c', extends: 'mid', borrow_from: [{ pack: 'area-a', types: ['bet'] }],
    }));
    const issues = await borrowReplacesInheritedType(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_replaces_inherited_type']);
    expect(issues[0]!.message).toContain("inherits from 'mid'");
  });

  it('set-valued fields compare as sets: aliases or path_prefixes in another order are the same type', async () => {
    packs.set('company-brain', pack({
      name: 'company-brain',
      page_types: [type('customer', { aliases: ['client', 'account'], path_prefixes: ['b/', 'a/'] })],
    }));
    packs.set('area-b', pack({
      name: 'area-b',
      page_types: [type('customer', { aliases: ['account', 'client'], path_prefixes: ['a/', 'b/'] })],
    }));
    const { resolved, opts } = await lintInput(pack({
      name: 'c', extends: 'company-brain', borrow_from: [{ pack: 'area-b', types: ['customer'] }],
    }));
    expect(await borrowReplacesInheritedType(resolved, opts)).toEqual([]);
  });

  it('control: a different alias set is still a replacement', async () => {
    packs.set('company-brain', pack({ name: 'company-brain', page_types: [type('customer', { aliases: ['client'] })] }));
    packs.set('area-b', pack({ name: 'area-b', page_types: [type('customer', { aliases: ['client', 'account'] })] }));
    const { resolved, opts } = await lintInput(pack({
      name: 'c', extends: 'company-brain', borrow_from: [{ pack: 'area-b', types: ['customer'] }],
    }));
    expect(rules(await borrowReplacesInheritedType(resolved, opts))).toEqual(['borrow_replaces_inherited_type']);
  });

  it('control: a borrowed definition identical to the inherited one, or one the parent lacks, is fine', async () => {
    packs.set('company-brain', pack({
      name: 'company-brain',
      page_types: [type('customer', { path_prefixes: ['customers/'] })],
      link_types: [{ name: 'part_of' }],
    }));
    const { resolved, opts } = await lintInput(pack({
      name: 'c',
      extends: 'company-brain',
      borrow_from: [{ pack: 'area-a', types: ['customer', 'bet'], link_types: ['part_of'] }],
    }));
    expect(await borrowReplacesInheritedType(resolved, opts)).toEqual([]);
  });
});

describe('borrowDropsFrontmatterLinks', () => {
  it("a borrowed type's links, including those its source inherits, must be restated", async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c',
      link_types: [{ name: 'part_of' }],
      borrow_from: [{ pack: 'area-a', types: ['bet'] }],
      frontmatter_links: [{ page_type: 'bet', fields: ['product', 'project'], link_type: 'part_of' }],
    }));
    const issues = await borrowDropsFrontmatterLinks(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_drops_frontmatter_links']);
    expect(issues[0]!.message).toContain('bet.amends -> amends');
    expect(issues[0]!.link).toBe('amends');
  });

  it('control: every link restated (field order ignored) is fine', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c',
      link_types: [{ name: 'part_of' }, { name: 'amends' }],
      borrow_from: [{ pack: 'area-a', types: ['bet'] }],
      frontmatter_links: [
        { page_type: 'bet', fields: ['product', 'project'], link_type: 'part_of' },
        { page_type: 'bet', fields: ['amends'], link_type: 'amends' },
      ],
    }));
    expect(await borrowDropsFrontmatterLinks(resolved, opts)).toEqual([]);
  });

  it('a link restated with MORE fields keeps every source field, so it is fine', async () => {
    // merge.ts keys frontmatter_links on (page_type, link_type): this IS the bet->amends link.
    const { resolved, opts } = await lintInput(pack({
      name: 'c',
      link_types: [{ name: 'part_of' }, { name: 'amends' }],
      borrow_from: [{ pack: 'area-a', types: ['bet'] }],
      frontmatter_links: [
        { page_type: 'bet', fields: ['product', 'project', 'portfolio'], link_type: 'part_of' },
        { page_type: 'bet', fields: ['amended_by', 'amends'], link_type: 'amends' },
      ],
    }));
    expect(await borrowDropsFrontmatterLinks(resolved, opts)).toEqual([]);
  });

  it('a link restated with FEWER fields is reported once, naming the missing fields', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c',
      link_types: [{ name: 'part_of' }, { name: 'amends' }],
      borrow_from: [{ pack: 'area-a', types: ['bet'] }],
      frontmatter_links: [
        { page_type: 'bet', fields: ['project'], link_type: 'part_of' },
        { page_type: 'bet', fields: ['amends'], link_type: 'amends' },
      ],
    }));
    const issues = await borrowDropsFrontmatterLinks(resolved, opts);
    expect(rules(issues)).toEqual(['borrow_drops_frontmatter_links']);
    expect(issues[0]!.link).toBe('part_of');
    expect(issues[0]!.message).toContain('restates');
    expect(issues[0]!.message).toContain('without product');
  });

  it('control: links of types the pack did not borrow are not required', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', types: ['customer'] }],
    }));
    expect(await borrowDropsFrontmatterLinks(resolved, opts)).toEqual([]);
  });
});

describe('borrow rules without the declared pack', () => {
  it('a borrowing pack linted from its resolved manifest alone reports borrow_checks_skipped', async () => {
    const { resolved } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', types: ['Bet'] }],
    }));
    const report = await runAllLintRules(resolved);
    expect(rules(report.warnings)).toContain('borrow_checks_skipped');
    // True whether the caller held the resolved manifest or (CLI fallback) the raw one.
    const skipped = report.warnings.find((w) => w.rule === 'borrow_checks_skipped')!;
    expect(skipped.message).toContain('without the pack as declared');
    expect(skipped.message).not.toContain('only the resolved manifest');
    expect(rules(report.errors)).not.toContain('borrow_name_undeclared');
  });

  it('control: with the declared pack the rules run and nothing is skipped', async () => {
    const { resolved, opts } = await lintInput(pack({
      name: 'c', borrow_from: [{ pack: 'area-a', types: ['Bet'] }],
    }));
    const report = await runAllLintRules(resolved, opts);
    expect(rules(report.warnings)).not.toContain('borrow_checks_skipped');
    expect(rules(report.errors)).toContain('borrow_name_undeclared');
  });

  it('a pack that borrows nothing has nothing to skip', async () => {
    expect(await borrowChecksSkipped(pack({ name: 'c' }))).toEqual([]);
  });

  it('a declared pack for a different pack is refused, not trusted', async () => {
    const { opts } = await lintInput(pack({ name: 'c', borrow_from: [{ pack: 'area-a', types: ['bet'] }] }));
    expect(() => borrowNameClash(pack({ name: 'other' }), opts)).toThrow("does not match linted pack 'other'");
  });
});
