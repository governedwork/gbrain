/**
 * The substring a path must contain for a schema-pack `path_prefixes` entry
 * to match it, once the path is `('/' + path).toLowerCase()`: the prefix
 * lower-cased, with a leading `/` unless it already has one. Matching is
 * "contains", not "starts with": `decisions/` types
 * `projects/x/decisions/0001-a`.
 *
 * The one definition of that rule. `inferTypeFromPack` and
 * `inferTypeAndSubtypeFromPack` (markdown.ts) and the dead-prefix scan in
 * `schema-pack/stats.ts` all use it, so what `schema_stats` calls a live
 * prefix is exactly what type inference matches. A leaf module on purpose:
 * `markdown.ts` is a public export, and this stays off that surface.
 */
export function pathPrefixNeedle(prefix: string): string {
  return prefix.startsWith('/') ? prefix.toLowerCase() : '/' + prefix.toLowerCase();
}
