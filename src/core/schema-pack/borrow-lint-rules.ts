// Ours (governedwork fork), not upstream GBrain: `borrow_from` lint rules.
//
// resolvePack (registry.ts) borrows a source pack's OWN declared types and
// link_types, by name, non-transitively, and never its frontmatter_links; the
// child-wins merge (merge.ts) then lets a borrowed type replace one the pack
// inherits through `extends`. Every one of those outcomes looks normal on the
// RESOLVED manifest the other rules read: a misspelt borrow is simply absent,
// a replaced type looks like any type, a dropped link is just not there. So
// these rules read the pack as DECLARED (LintOpts.declared) and load its
// sources and parent through the same loader + resolver the registry used.
//
// A caller that lints with only the resolved manifest gets one
// `borrow_checks_skipped` warning for a pack that borrows, never a silent pass.

import { canonicalJSONStringify, type SchemaPackManifest } from './manifest-v1.ts';
import type { ResolvedPack } from './registry.ts';
import type { LintIssue, LintOpts, LintRule } from './lint-rules.ts';

/** The pack as written, with the loader and resolver the registry used for it. */
export interface DeclaredPack {
  /** Before extends / borrow_from resolution. */
  manifest: SchemaPackManifest;
  /** Loads a pack by name, as written (the resolver's `loadByName`). */
  loadByName: (name: string) => Promise<SchemaPackManifest>;
  /** Resolves a loaded pack the way the registry does (cache + file tracking included). */
  resolve: (manifest: SchemaPackManifest) => Promise<ResolvedPack>;
}

export const BORROW_RULE_NAMES = [
  'borrow_name_undeclared',
  'borrow_name_clash',
  'borrow_replaces_inherited_type',
  'borrow_drops_frontmatter_links',
] as const;

/** The declared pack for `manifest`, or null when the caller supplied none. */
function declaredFor(manifest: SchemaPackManifest, opts: LintOpts | undefined): DeclaredPack | null {
  if (!opts?.declared) return null;
  if (opts.declared.manifest.name !== manifest.name) {
    throw new Error(`lint: declared pack '${opts.declared.manifest.name}' does not match linted pack '${manifest.name}'`);
  }
  return opts.declared;
}

type BorrowEntry = SchemaPackManifest['borrow_from'][number];

/** The two borrowable kinds, so each rule walks types and link types the same way. */
const KINDS = [
  {
    kind: 'type',
    names: (e: BorrowEntry) => e.types ?? [],
    declared: (m: SchemaPackManifest): ReadonlyArray<{ name: string }> => m.page_types,
    field: 'type',
  },
  {
    kind: 'link type',
    names: (e: BorrowEntry) => e.link_types ?? [],
    declared: (m: SchemaPackManifest): ReadonlyArray<{ name: string }> => m.link_types,
    field: 'link',
  },
] as const;

export const borrowNameUndeclared: LintRule = async (manifest, opts) => {
  const declared = declaredFor(manifest, opts);
  if (!declared) return [];
  const issues: LintIssue[] = [];
  for (const entry of declared.manifest.borrow_from) {
    const source = await declared.loadByName(entry.pack);
    for (const k of KINDS) {
      const own = new Set(k.declared(source).map((t) => t.name));
      for (const name of k.names(entry)) {
        if (own.has(name)) continue;
        issues.push({
          rule: 'borrow_name_undeclared',
          severity: 'error',
          message: `borrow_from '${entry.pack}' names ${k.kind} '${name}', which '${entry.pack}' does not declare itself; nothing is borrowed. Fix the name, OR borrow '${name}' from the pack that declares it (borrow_from takes a pack's own ${k.kind}s, never inherited ones)`,
          pack: manifest.name,
          [k.field]: name,
        });
      }
    }
  }
  return issues;
};

export const borrowNameClash: LintRule = (manifest, opts) => {
  const declared = declaredFor(manifest, opts);
  if (!declared) return [];
  const issues: LintIssue[] = [];
  for (const k of KINDS) {
    const own = new Set(k.declared(declared.manifest).map((t) => t.name));
    const from = new Map<string, string>();
    for (const entry of declared.manifest.borrow_from) {
      for (const name of k.names(entry)) {
        const earlier = from.get(name);
        if (earlier !== undefined) {
          issues.push({
            rule: 'borrow_name_clash',
            severity: 'error',
            message: `${k.kind} '${name}' is borrowed from both '${earlier}' and '${entry.pack}'; one silently wins. Borrow '${name}' from one pack only`,
            pack: manifest.name,
            [k.field]: name,
          });
        } else {
          from.set(name, entry.pack);
        }
        if (own.has(name)) {
          issues.push({
            rule: 'borrow_name_clash',
            severity: 'error',
            message: `${k.kind} '${name}' is declared by '${manifest.name}' and also borrowed from '${entry.pack}'; the pack's own declaration silently wins. Remove '${name}' from the borrow_from entry for '${entry.pack}' OR from this pack's own declarations`,
            pack: manifest.name,
            [k.field]: name,
          });
        }
      }
    }
  }
  return issues;
};

/**
 * A borrowed type or link type that differs from the one the pack inherits
 * through `extends`: the merge puts the borrowed one above every ancestor, so
 * it replaces the inherited one without a word. Borrowing a definition
 * identical to the inherited one changes nothing (the bundled lens packs
 * borrow from the pack they extend) and is not reported.
 */
export const borrowReplacesInheritedType: LintRule = async (manifest, opts) => {
  const declared = declaredFor(manifest, opts);
  if (!declared || !declared.manifest.extends) return [];
  const parentName = declared.manifest.extends;
  const parent = (await declared.resolve(await declared.loadByName(parentName))).manifest;
  const issues: LintIssue[] = [];
  for (const entry of declared.manifest.borrow_from) {
    const source = await declared.loadByName(entry.pack);
    for (const k of KINDS) {
      const inherited = new Map(k.declared(parent).map((t) => [t.name, canonicalJSONStringify(t)]));
      for (const name of k.names(entry)) {
        const was = inherited.get(name);
        const borrowed = k.declared(source).find((t) => t.name === name);
        if (was === undefined || borrowed === undefined || was === canonicalJSONStringify(borrowed)) continue;
        issues.push({
          rule: 'borrow_replaces_inherited_type',
          severity: 'error',
          message: `${k.kind} '${name}' borrowed from '${entry.pack}' replaces the different '${name}' this pack inherits from '${parentName}'. Drop '${name}' from the borrow_from entry for '${entry.pack}' to keep the inherited one, OR declare the intended '${name}' in this pack itself`,
          pack: manifest.name,
          [k.field]: name,
        });
      }
    }
  }
  return issues;
};

type FrontmatterLink = SchemaPackManifest['frontmatter_links'][number];

const linkKey = (l: FrontmatterLink): string =>
  // NUL delimiter, as merge.ts keys frontmatter_links: the parts are unconstrained strings.
  `${l.page_type}\x00${[...l.fields].sort().join('\x00')}\x00${l.link_type}`;

/**
 * Every frontmatter link a borrowed type carries in its source pack AS
 * RESOLVED (links the source inherits through its own `extends` included)
 * must be in the borrowing pack's resolved manifest: `borrow_from` copies
 * types, never the links that use them. `manifest` is the resolved pack, as
 * every lint caller passes it.
 */
export const borrowDropsFrontmatterLinks: LintRule = async (manifest, opts) => {
  const declared = declaredFor(manifest, opts);
  if (!declared) return [];
  const present = new Set(manifest.frontmatter_links.map(linkKey));
  const issues: LintIssue[] = [];
  for (const entry of declared.manifest.borrow_from) {
    const types = new Set(entry.types ?? []);
    if (types.size === 0) continue;
    const source = (await declared.resolve(await declared.loadByName(entry.pack))).manifest;
    for (const link of source.frontmatter_links) {
      if (!types.has(link.page_type) || present.has(linkKey(link))) continue;
      issues.push({
        rule: 'borrow_drops_frontmatter_links',
        severity: 'error',
        message: `type '${link.page_type}' borrowed from '${entry.pack}' carries the frontmatter link ${link.page_type}.${link.fields.join('/')} -> ${link.link_type} there, and borrow_from does not bring it along. Restate {page_type: ${link.page_type}, fields: [${link.fields.join(', ')}], link_type: ${link.link_type}} in this pack's frontmatter_links`,
        pack: manifest.name,
        type: link.page_type,
        link: link.link_type,
      });
    }
  }
  return issues;
};

/** The visible skip: a borrowing pack linted without its declared form. */
export const borrowChecksSkipped: LintRule = (manifest, opts) => {
  if (opts?.declared || manifest.borrow_from.length === 0) return [];
  return [{
    rule: 'borrow_checks_skipped',
    severity: 'warning',
    message: `pack '${manifest.name}' borrows from ${manifest.borrow_from.map((e) => `'${e.pack}'`).join(', ')}, but this lint had only the resolved manifest, so ${BORROW_RULE_NAMES.join(', ')} did not run. Make the pack and every pack it extends or borrows from loadable, then lint it again`,
    pack: manifest.name,
  }];
};
