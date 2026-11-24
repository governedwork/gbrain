/**
 * An MCP login in the connector credential store: client registration and tokens persisted 0600, expiry kept as an
 * instant, a refresh that returns no refresh token keeps the old one, a headless sync never starts a login, and a
 * login for another server is not read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialMode, loadCredential } from '../src/core/connectors/credentials.ts';
import { ConnectorMcpOAuthProvider, McpLoginRequiredError } from '../src/core/connectors/mcp-oauth.ts';

const SERVER = 'https://mcp.example.test/mcp';
let tmp: string;
let prevHome: string | undefined;
let clock = 1_000_000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-mcp-oauth-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  clock = 1_000_000;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

const make = (mode: 'interactive' | 'headless', serverUrl = SERVER) =>
  new ConnectorMcpOAuthProvider({ provider: 'plaud', serverUrl, mode, now: () => clock });

describe('ConnectorMcpOAuthProvider', () => {
  test('client registration and tokens persist 0600 and read back with the time left', () => {
    const p = make('interactive');
    expect(p.clientInformation()).toBeUndefined();
    expect(p.tokens()).toBeUndefined();
    p.saveClientInformation({ client_id: 'c1', redirect_uris: [p.redirectUrl] } as never);
    p.saveTokens({ access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer', expires_in: 3600 });
    expect(credentialMode('plaud')).toBe(0o600);
    expect(loadCredential('plaud')).toMatchObject({ strategy: 'mcp-oauth', serverUrl: SERVER, accessToken: 'a1', refreshToken: 'r1', expiresAt: clock + 3_600_000 });

    clock += 600_000;
    const again = make('headless');
    expect(again.clientInformation()).toMatchObject({ client_id: 'c1' });
    expect(again.tokens()).toEqual({ access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1', expires_in: 3000 });
  });

  test('a refresh with no new refresh token keeps the one it used', () => {
    const p = make('headless');
    p.saveTokens({ access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer', expires_in: 60 });
    p.saveTokens({ access_token: 'a2', token_type: 'Bearer', expires_in: 60 });
    expect(p.tokens()).toMatchObject({ access_token: 'a2', refresh_token: 'r1' });
  });

  test('a headless provider never starts a login', () => {
    expect(() => make('headless').redirectToAuthorization(new URL('https://mcp.example.test/authorize'))).toThrow(McpLoginRequiredError);
    const interactive = make('interactive');
    interactive.redirectToAuthorization(new URL('https://mcp.example.test/authorize?x=1'));
    expect(interactive.authorizationUrl?.toString()).toBe('https://mcp.example.test/authorize?x=1');
  });

  test('a login saved for another server is not read', () => {
    make('interactive').saveTokens({ access_token: 'a1', token_type: 'Bearer' });
    expect(make('headless', 'https://other.example.test/mcp').tokens()).toBeUndefined();
  });

  test('invalidating tokens keeps the client registration; invalidating all clears both', () => {
    const p = make('interactive');
    p.saveClientInformation({ client_id: 'c1' } as never);
    p.saveTokens({ access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer' });
    p.invalidateCredentials('tokens');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toMatchObject({ client_id: 'c1' });
    p.invalidateCredentials('all');
    expect(p.clientInformation()).toBeUndefined();
  });

  test('the PKCE verifier lives in the process only', () => {
    const p = make('interactive');
    expect(() => p.codeVerifier()).toThrow();
    p.saveCodeVerifier('v');
    expect(p.codeVerifier()).toBe('v');
    expect(JSON.stringify(loadCredential('plaud') ?? {})).not.toContain('"v"');
  });
});
