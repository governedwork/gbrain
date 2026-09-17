/**
 * Brain identity — which brain a database IS, and which brain a credential
 * belongs to.
 *
 * WHY THIS EXISTS. Several brains can sit behind ONE public origin: one
 * `/mcp`, one `/token`, one issuer, with a separate database (and a separate
 * `gbrain serve` process) per brain. A router in front of them has to decide
 * where a request goes before any backend has seen it, and the only thing a
 * request reliably carries is its credential. So every credential a brain
 * mints names the brain that minted it:
 *
 *     gbrain_cl_<64 hex>              the host brain (no identity) — unchanged
 *     gbrain_cl_<brain-id>_<64 hex>   a brain whose database carries an identity
 *
 * (and the same for `gbrain_at_`, `gbrain_rt_` and `gbrain_code_`). The id is a
 * ROUTING HINT, never an authority: the backend still verifies the credential
 * against its own database, so a forged prefix lands on a brain that does not
 * know the credential and is refused there.
 *
 * WHERE THE IDENTITY LIVES: in the database (`config.brain_id`), not in the
 * process. A process-level setting would let a backend pointed at the wrong
 * database mint credentials in the wrong name; the database cannot be wrong
 * about itself. `GBRAIN_BRAIN_ID` in the serving process is a CROSS-CHECK —
 * `resolveServingIdentity` refuses to serve when the two disagree in either
 * direction, which is what catches "the host process was pointed at a
 * tenant's database" and "a tenant process was pointed at the host's".
 *
 * WHAT THE GUARDS ADD over the hash lookup that would refuse a foreign
 * credential anyway: a database restored or seeded from ANOTHER brain's dump
 * carries that brain's credential hashes. Without the guard those credentials
 * would authenticate against the copy. With it, a brain only honours
 * credentials minted in its own name.
 */

import { generateToken } from './utils.ts';
import type { SqlQuery } from './sql-query.ts';

/** `config` key holding this database's brain id. Absent on the host brain. */
export const BRAIN_IDENTITY_KEY = 'brain_id';

/** Same shape as a mount id: lowercase alphanumerics and inner dashes, 1-32. */
const BRAIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Ids a brain may never carry: `host` is the registry's name for the default brain. */
const RESERVED_BRAIN_IDS = new Set(['host']);

/** The credential kinds that carry a brain id. Client SECRETS do not need to:
 * a secret is only ever presented together with its client id. */
export type CredentialKind = 'gbrain_cl_' | 'gbrain_at_' | 'gbrain_rt_' | 'gbrain_code_';
const CREDENTIAL_KINDS: readonly CredentialKind[] = ['gbrain_cl_', 'gbrain_at_', 'gbrain_rt_', 'gbrain_code_'];

export class BrainIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainIdentityError';
  }
}

export function isValidBrainId(id: string): boolean {
  return BRAIN_ID_RE.test(id) && !RESERVED_BRAIN_IDS.has(id);
}

/** The brain id stored in this database, or null for the host brain. */
export async function readBrainIdentity(sql: SqlQuery): Promise<string | null> {
  const rows = await sql`SELECT value FROM config WHERE key = ${BRAIN_IDENTITY_KEY}`;
  if (rows.length === 0) return null;
  const value = rows[0]!.value;
  // A malformed stored id is refused rather than treated as absent: absent
  // means "host", and quietly serving a tenant database as the host brain is
  // exactly the confusion this module exists to prevent.
  if (typeof value !== 'string' || !isValidBrainId(value)) {
    throw new BrainIdentityError(
      `config.${BRAIN_IDENTITY_KEY} is ${JSON.stringify(value)}, which is not a valid brain id ` +
        `(lowercase letters, digits and inner dashes, 1-32 chars, not "host")`,
    );
  }
  return value;
}

/**
 * A memoised identity read, shared by everything that mints or checks
 * credentials against one database.
 *
 * Memoised because the identity is consulted on every token verification, and
 * it cannot legitimately change under a running process (`resolveServingIdentity`
 * pins it at startup). A FAILED read is not memoised: a transient database error
 * must not become a permanent answer.
 */
export function identityResolver(sql: SqlQuery): () => Promise<string | null> {
  let memo: Promise<string | null> | undefined;
  return () => {
    if (memo === undefined) {
      const read = readBrainIdentity(sql);
      memo = read;
      read.catch(() => {
        if (memo === read) memo = undefined;
      });
    }
    return memo;
  };
}

/**
 * Resolve the identity a `gbrain serve` process may serve under, refusing any
 * disagreement between the database and the process's declared intent.
 */
export async function resolveServingIdentity(
  sql: SqlQuery,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const stored = await readBrainIdentity(sql);
  const declared = env.GBRAIN_BRAIN_ID === undefined || env.GBRAIN_BRAIN_ID === '' ? null : env.GBRAIN_BRAIN_ID;
  if (declared !== null && !isValidBrainId(declared)) {
    throw new BrainIdentityError(`GBRAIN_BRAIN_ID=${JSON.stringify(declared)} is not a valid brain id`);
  }
  if (stored !== declared) {
    throw new BrainIdentityError(
      `refusing to serve: this database is brain ${stored === null ? '(host — no identity)' : JSON.stringify(stored)} ` +
        `but the process declares ${declared === null ? '(host — GBRAIN_BRAIN_ID unset)' : JSON.stringify(declared)}. ` +
        `Serving a database under the wrong identity would mint credentials in the wrong brain's name.`,
    );
  }
  return stored;
}

/** Mint a credential of `kind` in the name of `brainId` (null = host). */
export function mintCredential(kind: CredentialKind, brainId: string | null): string {
  if (brainId !== null && !isValidBrainId(brainId)) {
    throw new BrainIdentityError(`cannot mint a credential for invalid brain id ${JSON.stringify(brainId)}`);
  }
  return generateToken(brainId === null ? kind : `${kind}${brainId}_`);
}

export interface CredentialOwner {
  kind: CredentialKind;
  /** null = the host brain. */
  brainId: string | null;
}

/**
 * Which brain a credential names, or null when the value is not a
 * brain-routable credential at all (a legacy bearer, a client secret, junk).
 *
 * The random part is lowercase hex and brain ids cannot contain `_`, so the
 * split is unambiguous: no `_` after the kind means host, exactly one means a
 * named brain. Anything else is malformed and names no brain — which callers
 * must treat as foreign, never as host.
 */
export function credentialOwner(value: string): CredentialOwner | null {
  const kind = CREDENTIAL_KINDS.find((k) => value.startsWith(k));
  if (!kind) return null;
  const rest = value.slice(kind.length);
  const sep = rest.indexOf('_');
  if (sep === -1) return /^[0-9a-f]{64}$/.test(rest) ? { kind, brainId: null } : null;
  const id = rest.slice(0, sep);
  const random = rest.slice(sep + 1);
  if (!isValidBrainId(id) || !/^[0-9a-f]{64}$/.test(random)) return null;
  return { kind, brainId: id };
}

/**
 * True when `value` was minted by the brain `servingBrainId`.
 *
 * Values that are not brain-routable credentials at all (legacy `gbrain_…`
 * bearers, which carry no kind infix) are the HOST's business only: a named
 * brain never issues them, so a named brain refuses them.
 */
export function credentialBelongsTo(value: string, servingBrainId: string | null): boolean {
  const owner = credentialOwner(value);
  if (owner === null) {
    const looksLikeOurs = CREDENTIAL_KINDS.some((k) => value.startsWith(k));
    // A malformed value in one of our kinds names no brain, so it belongs to none.
    if (looksLikeOurs) return false;
    return servingBrainId === null;
  }
  return owner.brainId === servingBrainId;
}
