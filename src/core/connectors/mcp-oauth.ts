/**
 * mcp-oauth.ts — a login to a remote MCP server, held in the connector credential store.
 *
 * The MCP SDK's own OAuth client (`@modelcontextprotocol/sdk/client/auth.js`, a dependency gbrain already ships) does
 * the protocol: protected-resource and authorization-server discovery, dynamic client registration, PKCE, the token
 * exchange and refresh. This file only gives it a place to keep its state: the same 0600 file every connector
 * credential lives in (`~/.gbrain/connectors/<provider>.json`), holding the client registration, the tokens and their
 * expiry. Nothing here is returned by an op; `connectors status` shows provenance and expiry only.
 *
 * Two modes. `interactive` (the `gbrain connectors auth <p>` login) hands the authorization URL to the loopback flow;
 * `headless` (a sync) never starts a login: a refresh that fails, or no credential at all, is `auth_required`.
 */
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadCredential, saveCredential } from './credentials.ts';
import { generateState, runLoopbackFlow, type LoopbackOpts } from './oauth-pkce.ts';
import type { ConnectorCredential, McpOAuthProviderName } from './types.ts';

/** The fixed loopback port of an MCP-OAuth login (the registered redirect URI names it). */
export const MCP_OAUTH_REDIRECT_PORT = 1456;

/** Thrown by a headless provider when the server needs a new login: the caller maps it to `auth_required`. */
export class McpLoginRequiredError extends Error {
  readonly code = 'auth_required';
  constructor(provider: McpOAuthProviderName, why: string) {
    super(`${provider}: ${why}; run: gbrain connectors auth ${provider}`);
    this.name = 'McpLoginRequiredError';
  }
}

export interface McpOAuthOpts {
  provider: McpOAuthProviderName;
  serverUrl: string;
  mode: 'interactive' | 'headless';
  /** Loopback port (tests bind 0 and read it back through `redirectUrl`). */
  redirectPort?: number;
  now?: () => number;
}

/** The OAuthClientProvider the SDK drives, persisted in the connector credential file. */
export class ConnectorMcpOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  private stateValue: string | undefined;
  /** The authorization URL the SDK asked to open (interactive mode). */
  authorizationUrl: URL | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: McpOAuthOpts) {
    this.now = opts.now ?? Date.now;
  }

  private load(): ConnectorCredential | null {
    const cred = loadCredential(this.opts.provider);
    return cred && cred.strategy === 'mcp-oauth' && cred.serverUrl === this.opts.serverUrl ? cred : null;
  }

  private save(patch: Partial<ConnectorCredential>): void {
    const prev = this.load();
    saveCredential({
      ...(prev ?? {}),
      ...patch,
      provider: this.opts.provider,
      strategy: 'mcp-oauth',
      serverUrl: this.opts.serverUrl,
      savedAt: new Date(this.now()).toISOString(),
    });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.opts.redirectPort ?? MCP_OAUTH_REDIRECT_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'gbrain',
      client_uri: 'https://github.com/garrytan/gbrain',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    this.stateValue ??= generateState();
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.load()?.oauthClient as OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.save({ oauthClient: info as unknown as Record<string, unknown> });
  }

  tokens(): OAuthTokens | undefined {
    const cred = this.load();
    if (!cred?.accessToken) return undefined;
    const left = cred.expiresAt !== undefined ? Math.floor((cred.expiresAt - this.now()) / 1000) : undefined;
    return {
      access_token: cred.accessToken,
      token_type: 'Bearer',
      ...(cred.refreshToken ? { refresh_token: cred.refreshToken } : {}),
      ...(left !== undefined ? { expires_in: Math.max(0, left) } : {}),
    };
  }

  saveTokens(tokens: OAuthTokens): void {
    const prev = this.load();
    this.save({
      accessToken: tokens.access_token,
      // A refresh that returns no new refresh token keeps the one it used (RFC 6749 §6).
      refreshToken: tokens.refresh_token ?? prev?.refreshToken,
      expiresAt: typeof tokens.expires_in === 'number' ? this.now() + tokens.expires_in * 1000 : undefined,
    });
  }

  redirectToAuthorization(url: URL): void {
    if (this.opts.mode === 'headless') throw new McpLoginRequiredError(this.opts.provider, 'the login has expired or was revoked');
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no PKCE verifier: the login was not started in this process');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier' || scope === 'discovery') { if (scope === 'verifier') this.verifier = undefined; return; }
    const prev = this.load();
    if (!prev) return;
    this.save({
      ...(scope === 'all' || scope === 'client' ? { oauthClient: undefined } : {}),
      ...(scope === 'all' || scope === 'tokens' ? { accessToken: undefined, refreshToken: undefined, expiresAt: undefined } : {}),
    });
  }
}

/**
 * The interactive login: discovery and client registration by the SDK, the browser through gbrain's loopback
 * listener, then the code exchange. Leaves the credential file holding the client and the tokens.
 */
export async function mcpOAuthLogin(opts: Omit<McpOAuthOpts, 'mode'>, loopback: LoopbackOpts = {}): Promise<void> {
  const provider = new ConnectorMcpOAuthProvider({ ...opts, mode: 'interactive' });
  const first = await auth(provider, { serverUrl: opts.serverUrl });
  if (first === 'AUTHORIZED') return;
  if (!provider.authorizationUrl) throw new Error(`${opts.provider}: the server asked for a login but gave no authorization URL`);
  const port = opts.redirectPort ?? MCP_OAUTH_REDIRECT_PORT;
  const { code } = await runLoopbackFlow(
    { authorizeUrl: provider.authorizationUrl.toString(), tokenUrl: '', clientId: '', scopes: [], redirectPort: port },
    provider.authorizationUrl.toString(),
    provider.state(),
    loopback,
  );
  const second = await auth(provider, { serverUrl: opts.serverUrl, authorizationCode: code });
  if (second !== 'AUTHORIZED') throw new Error(`${opts.provider}: the code exchange did not authorize`);
}
