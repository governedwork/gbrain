/**
 * Fork: the owner API sets an OAuth client's takes-holder grant (`takesHolders`), on registration and on rescope.
 *
 * `oauth_clients.takes_holders` is GBrain's own per-client grant axis: verifyAccessToken reads it into
 * `takesHoldersAllowList`, the takes write fence (`assertHolderAllowed`, `authorizeTakeHolder`) and the takes read
 * filters use it, and GrantPatch / validateClientGrant already carry and check it. Upstream sets it only from the
 * local CLI (`gbrain auth rescope --client <id> --takes-holders`): `/admin/api/register-client` and
 * `/admin/api/rescope-client` parsed no `takesHolders`, and a registration's INSERT wrote no `takes_holders`, so a
 * front door registering its clients over the owner API could never grant a holder beyond the default `world`.
 */

import { expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mountAdminGrantEdits } from '../src/commands/serve-http-grants.ts';
import { mountAdminRegistration } from '../src/commands/serve-http-registration.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { withEnv } from './helpers/with-env.ts';

const HOLDERS = ['world', 'companies/acme-example', 'people/alice-example'];

test('the owner API registers and rescopes a client with its takes holders, and a token of it carries them', async () => {
  // The real path: macOS's /var is a symlink, and the credential delivery home refuses one.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-fork-takes-holders-'));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({}); await engine.initSchema();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: (fn) => engine.transaction((tx) => fn(sqlQueryForEngine(tx))) });
      const app = express();
      const admin = (_req: unknown, _res: unknown, next: () => void) => next();
      mountAdminRegistration(app, admin as never, engine, new URL('https://brain.example/mcp'), new URL('https://brain.example'));
      mountAdminGrantEdits(app, admin as never, engine, provider);
      const server = app.listen(0, '127.0.0.1');
      try {
        const { port } = server.address() as { port: number };
        const post = (path: string, body: Record<string, unknown>) =>
          fetch(`http://127.0.0.1:${port}/admin/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const stored = async (name: string) =>
          (await engine.executeRaw<{ client_id: string; takes_holders: string[] | null }>('SELECT client_id, takes_holders FROM oauth_clients WHERE client_name = $1', [name]))[0];
        const machine = { scopes: 'read write', grantTypes: ['client_credentials'] };

        // Registration with holders: the row, the answered grant and a minted token all carry them.
        const granted = await post('register-client', { name: 'holders-example', ...machine, takesHolders: HOLDERS });
        expect(granted.status).toBe(200);
        const reg = await granted.json() as { clientId: string; clientSecret: string; grant: { takesHolders: string[] | null } };
        expect(reg.grant.takesHolders).toEqual(HOLDERS);
        expect((await stored('holders-example'))?.takes_holders).toEqual(HOLDERS);
        const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret, 'read write');
        const info = await provider.verifyAccessToken(tokens.access_token) as { takesHoldersAllowList?: string[] };
        expect(info.takesHoldersAllowList).toEqual(HOLDERS);

        // Without the field nothing changes: GBrain's default (NULL, read as ['world']).
        const plain = await post('register-client', { name: 'plain-example', ...machine });
        expect(plain.status).toBe(200);
        expect((await plain.json() as { grant: { takesHolders: string[] | null } }).grant.takesHolders).toBeNull();
        expect((await stored('plain-example'))?.takes_holders).toBeNull();

        // A holder GBrain's own validator refuses is refused before any row exists.
        const bad = await post('register-client', { name: 'bad-holders-example', ...machine, takesHolders: ['world', 'people/a, people/b'] });
        expect(bad.status).toBe(400);
        expect(await stored('bad-holders-example')).toBeUndefined();
        const notList = await post('register-client', { name: 'bad-shape-example', ...machine, takesHolders: 'world' });
        expect(notList.status).toBe(400);
        expect(await stored('bad-shape-example')).toBeUndefined();

        // Rescope sets them on a live client, the token's next verification sees them, and null restores the default.
        const plainId = (await stored('plain-example'))!.client_id;
        const widened = await post('rescope-client', { clientId: plainId, takesHolders: ['world', 'brain'] });
        expect(widened.status).toBe(200);
        expect((await stored('plain-example'))?.takes_holders).toEqual(['world', 'brain']);
        const cleared = await post('rescope-client', { clientId: plainId, takesHolders: null });
        expect(cleared.status).toBe(200);
        expect((await stored('plain-example'))?.takes_holders).toBeNull();
      } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
    });
  } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
