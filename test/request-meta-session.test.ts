/**
 * CX2-11: the request-level `_meta.session_id` is read the same way by every transport (stdio and
 * HTTP), through one helper — so a remote `remember` records its session as a local one does.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { requestMetaSessionId } from '../src/mcp/dispatch.ts';

describe('requestMetaSessionId', () => {
  test('reads the session beside the arguments', () => {
    expect(requestMetaSessionId({ name: 'remember', arguments: {}, _meta: { session_id: 'sess-1' } })).toBe('sess-1');
  });

  test('absent, empty or non-string is no session', () => {
    expect(requestMetaSessionId({ name: 'remember', arguments: {} })).toBeUndefined();
    expect(requestMetaSessionId({ _meta: { session_id: '' } })).toBeUndefined();
    expect(requestMetaSessionId({ _meta: { session_id: 7 } })).toBeUndefined();
    expect(requestMetaSessionId(undefined)).toBeUndefined();
  });

  test('both transports thread it into dispatch', () => {
    for (const file of ['src/mcp/server.ts', 'src/commands/serve-http.ts']) {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).toContain('requestMetaSessionId(request.params)');
    }
  });
});
