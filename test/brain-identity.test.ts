/**
 * Brain identity: credentials name the brain that minted them, and a brain
 * refuses credentials minted in another brain's name.
 *
 * Two PGLite databases play two brains behind one origin — the host (no
 * identity) and `alice`. The sharpest case is the dump-copy: a tenant database
 * seeded from the host's dump carries the host's client and token hashes, and
 * must still refuse them.
 *
 * Hermetic via PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import {
  BRAIN_IDENTITY_KEY,
  BrainIdentityError,
  credentialBelongsTo,
  credentialOwner,
  mintCredential,
  readBrainIdentity,
  resolveServingIdentity,
} from '../src/core/brain-identity.ts';
import { scanText } from '../src/core/secret-scan.ts';

const HEX = /^[0-9a-f]{64}$/;

async function brain(identity: string | null): Promise<{ engine: PGLiteEngine; provider: () => GBrainOAuthProvider }> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  if (identity !== null) {
    await engine.executeRaw(`INSERT INTO config (key, value) VALUES ($1, $2)`, [BRAIN_IDENTITY_KEY, identity]);
  }
  // A fresh provider per use, so a memoised identity never outlives a test's setup.
  const provider = () => new GBrainOAuthProvider({
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
    sql: sqlQueryForEngine(engine),
  });
  return { engine, provider };
}

async function enrol(p: GBrainOAuthProvider, name: string) {
  const reg = await p.registerClientManual(name, ['client_credentials'], 'read write');
  const tokens = await p.exchangeClientCredentials(reg.clientId, reg.clientSecret!, 'read');
  return { ...reg, accessToken: tokens.access_token };
}

let host: Awaited<ReturnType<typeof brain>>;
let alice: Awaited<ReturnType<typeof brain>>;

beforeAll(async () => {
  host = await brain(null);
  alice = await brain('alice');
});

afterAll(async () => {
  await host.engine.disconnect();
  await alice.engine.disconnect();
});

describe('minting', () => {
  test('the host brain mints exactly what upstream mints', async () => {
    const c = await enrol(host.provider(), 'host-device');
    expect(c.clientId.startsWith('gbrain_cl_')).toBe(true);
    expect(HEX.test(c.clientId.slice('gbrain_cl_'.length))).toBe(true);
    expect(HEX.test(c.accessToken.slice('gbrain_at_'.length))).toBe(true);
    expect(credentialOwner(c.clientId)).toEqual({ kind: 'gbrain_cl_', brainId: null });
  });

  test('a brain with an identity names itself in every client id and token', async () => {
    const c = await enrol(alice.provider(), 'alice-macbook');
    expect(c.clientId).toMatch(/^gbrain_cl_alice_[0-9a-f]{64}$/);
    expect(c.accessToken).toMatch(/^gbrain_at_alice_[0-9a-f]{64}$/);
    // Client secrets are never routed on, so they stay unprefixed.
    expect(c.clientSecret).toMatch(/^gbrain_cs_[0-9a-f]{64}$/);
    const auth = await alice.provider().verifyAccessToken(c.accessToken);
    expect(auth.clientId).toBe(c.clientId);
  });
});

describe('a brain refuses credentials minted in another brain\'s name', () => {
  test('an alice token is refused by the host, and a host token by alice', async () => {
    const h = await enrol(host.provider(), 'host-cross');
    const a = await enrol(alice.provider(), 'alice-cross');
    await expect(host.provider().verifyAccessToken(a.accessToken)).rejects.toThrow(/Invalid token/);
    await expect(alice.provider().verifyAccessToken(h.accessToken)).rejects.toThrow(/Invalid token/);
    await expect(alice.provider().verifyConfidentialClientSecret(h.clientId, h.clientSecret!)).rejects.toThrow(/Invalid client/);
  });

  test('DUMP COPY: alice holds the host\'s client and token rows and still refuses them', async () => {
    const h = await enrol(host.provider(), 'host-copied');
    // Copy the host's credential rows into alice's database, as a restore of the
    // host's dump into a tenant database would.
    const [client] = await host.engine.executeRaw<Record<string, unknown>>(
      `SELECT client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope,
              token_endpoint_auth_method, source_id, federated_read, token_ttl
       FROM oauth_clients WHERE client_id = $1`, [h.clientId]);
    await alice.engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope,
                                  token_endpoint_auth_method, source_id, federated_read, token_ttl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [client!.client_id, client!.client_secret_hash, client!.client_name, client!.redirect_uris, client!.grant_types,
       client!.scope, client!.token_endpoint_auth_method, client!.source_id, client!.federated_read, client!.token_ttl]);
    const tokenRows = await host.engine.executeRaw<Record<string, unknown>>(
      `SELECT token_hash, token_type, client_id, scopes, expires_at FROM oauth_tokens WHERE client_id = $1`, [h.clientId]);
    for (const r of tokenRows) {
      await alice.engine.executeRaw(
        `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [r.token_hash, r.token_type, r.client_id, r.scopes, r.expires_at]);
    }
    // Control: the rows really are there, so any refusal below is the guard's.
    const present = await alice.engine.executeRaw(`SELECT 1 FROM oauth_clients WHERE client_id = $1`, [h.clientId]);
    expect(present.length).toBe(1);

    const p = alice.provider();
    await expect(p.verifyAccessToken(h.accessToken)).rejects.toThrow(/Invalid token/);
    expect(await p.clientsStore.getClient(h.clientId)).toBeUndefined();
    await expect(p.exchangeClientCredentials(h.clientId, h.clientSecret!, 'read')).rejects.toThrow(/Invalid client/);
  });

  test('a forged brain prefix is refused by both the named brain and the real one', async () => {
    const a = await enrol(alice.provider(), 'alice-forged');
    const forged = a.accessToken.replace('gbrain_at_alice_', 'gbrain_at_bob_');
    await expect(alice.provider().verifyAccessToken(forged)).rejects.toThrow(/Invalid token/);
    const stripped = a.accessToken.replace('gbrain_at_alice_', 'gbrain_at_');
    await expect(host.provider().verifyAccessToken(stripped)).rejects.toThrow(/Invalid token/);
  });
});

describe('serving identity', () => {
  const env = (v?: string) => ({ GBRAIN_SERVE_IDENTITY: v });

  test('the database and the process must agree, in both directions', async () => {
    const h = sqlQueryForEngine(host.engine);
    const a = sqlQueryForEngine(alice.engine);
    expect(await resolveServingIdentity(h, env(undefined))).toBeNull();
    expect(await resolveServingIdentity(a, env('alice'))).toBe('alice');
    // the host process pointed at a tenant's database
    await expect(resolveServingIdentity(a, env(undefined))).rejects.toThrow(BrainIdentityError);
    // a tenant process pointed at the host's database
    await expect(resolveServingIdentity(h, env('alice'))).rejects.toThrow(BrainIdentityError);
    // a tenant process pointed at a DIFFERENT tenant's database
    await expect(resolveServingIdentity(a, env('bob'))).rejects.toThrow(/refusing to serve/);
    await expect(resolveServingIdentity(h, env('host'))).rejects.toThrow(/not a valid brain id/);
  });

  test('the cross-check does not read GBRAIN_BRAIN_ID, which selects a mounted brain', async () => {
    const a = sqlQueryForEngine(alice.engine);
    // Setting the mount selector must neither satisfy nor break the identity check.
    await expect(resolveServingIdentity(a, { GBRAIN_BRAIN_ID: 'alice' })).rejects.toThrow(/refusing to serve/);
    expect(await resolveServingIdentity(a, { GBRAIN_BRAIN_ID: 'host', GBRAIN_SERVE_IDENTITY: 'alice' })).toBe('alice');
  });

  test('a malformed stored identity is refused, never read as "host"', async () => {
    const bad = await brain('placeholder');
    await bad.engine.executeRaw(`UPDATE config SET value = $1 WHERE key = $2`, ['Not_Valid', BRAIN_IDENTITY_KEY]);
    await expect(readBrainIdentity(sqlQueryForEngine(bad.engine))).rejects.toThrow(BrainIdentityError);
    await expect(bad.provider().verifyAccessToken('gbrain_at_' + 'a'.repeat(64))).rejects.toThrow(BrainIdentityError);
    await bad.engine.disconnect();
  });
});

describe('credential ownership parsing', () => {
  const hex = 'ab'.repeat(32);
  test.each([
    [`gbrain_at_${hex}`, { kind: 'gbrain_at_', brainId: null }],
    [`gbrain_rt_alice_${hex}`, { kind: 'gbrain_rt_', brainId: 'alice' }],
    [`gbrain_cl_team-2_${hex}`, { kind: 'gbrain_cl_', brainId: 'team-2' }],
    [`gbrain_code_alice_${hex}`, { kind: 'gbrain_code_', brainId: 'alice' }],
  ])('%s', (value, owner) => {
    expect(credentialOwner(value)).toEqual(owner as ReturnType<typeof credentialOwner>);
  });

  test.each([
    `gbrain_at_host_${hex}`,        // reserved id
    `gbrain_at_Alice_${hex}`,       // uppercase
    `gbrain_at_alice_bob_${hex}`,   // two separators
    `gbrain_at_alice_${hex}0`,      // wrong length
    `gbrain_at_`,
  ])('malformed %s names no brain and belongs to none', (value) => {
    expect(credentialOwner(value)).toBeNull();
    expect(credentialBelongsTo(value, null)).toBe(false);
    expect(credentialBelongsTo(value, 'alice')).toBe(false);
  });

  test('legacy bearers and arbitrary client ids are the host\'s business only', () => {
    expect(credentialBelongsTo(`gbrain_${hex}`, null)).toBe(true);
    expect(credentialBelongsTo(`gbrain_${hex}`, 'alice')).toBe(false);
    expect(credentialBelongsTo('public-pkce', null)).toBe(true);
    expect(credentialBelongsTo('public-pkce', 'alice')).toBe(false);
  });

  test('mintCredential refuses an invalid identity', () => {
    expect(() => mintCredential('gbrain_at_', 'host')).toThrow(BrainIdentityError);
  });
});

describe('secret scanning', () => {
  test('a brain-prefixed token is redacted exactly like a host token', () => {
    const tenant = mintCredential('gbrain_at_', 'alice');
    const hostToken = mintCredential('gbrain_at_', null);
    const findings = scanText(`Authorization: Bearer ${tenant}\nAuthorization: Bearer ${hostToken}\n`)
      .filter(f => f.pattern === 'gbrain_token');
    // One finding per line, and the preview carries neither value.
    expect(findings.map(f => f.line).sort()).toEqual([1, 2]);
    for (const f of findings) {
      expect(f.redactedPreview).not.toContain(tenant);
      expect(f.redactedPreview).not.toContain(hostToken);
    }
  });
});
