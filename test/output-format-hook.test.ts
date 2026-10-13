/**
 * `format: text | hook` on volunteer_context and context_pack
 * (ops/output-format.ts): the shapes a Claude Code / Codex hook can inject.
 * Unit cases for shapeOutput, then in-process through dispatchToolCall (the
 * layer both MCP transports share) against in-memory PGLite. Also the
 * per-session dedupe a per-prompt hook relies on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { shapeOutput, withoutOutputFormat } from '../src/core/ops/output-format.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../src/core/bootstrap/host-specs.ts';
import { TURN_CONTEXT_ENVELOPE } from '../src/core/context/turn-context.ts';
import { awaitPendingVolunteerEventWrites, SESSION_DEDUPE_HOURS } from '../src/core/context/volunteer-events.ts';

const textOp = { renderText: (r: unknown) => (r as { text: string }).text };

describe('shapeOutput', () => {
  it('json (the default) and an op without renderText leave the result to the JSON path', async () => {
    expect(await shapeOutput(textOp, { text: 'x' }, {})).toBeNull();
    expect(await shapeOutput(textOp, { text: 'x' }, { format: 'json' })).toBeNull();
    expect(await shapeOutput({}, { text: 'x' }, { format: 'text' })).toBeNull();
  });

  it('text is the rendered block with the extra blocks after it', async () => {
    expect(await shapeOutput(textOp, { text: 'block' }, { format: 'text' }, ['notice'])).toBe('block\n\nnotice');
  });

  it('hook wraps the block for UserPromptSubmit by default, or the named event', async () => {
    const doc = JSON.parse((await shapeOutput(textOp, { text: 'block' }, { format: 'hook' }))!);
    expect(doc).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'block' } });
    const start = JSON.parse((await shapeOutput(textOp, { text: 'block' }, { format: 'hook', hook_event: 'SessionStart' }))!);
    expect(start.hookSpecificOutput.hookEventName).toBe('SessionStart');
  });

  it('an empty block is an empty hook document and empty text', async () => {
    expect(await shapeOutput(textOp, { text: '' }, { format: 'hook' })).toBe('{}');
    expect(await shapeOutput(textOp, { text: '' }, { format: 'text' })).toBe('');
  });

  it('hook output stays under the Claude Code hook-output cap', async () => {
    const big = 'a"\n'.repeat(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    const doc = (await shapeOutput(textOp, { text: big }, { format: 'hook' }))!;
    expect(doc.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    expect(JSON.parse(doc).hookSpecificOutput.additionalContext.length).toBeGreaterThan(1000);
  });

  it('withoutOutputFormat drops only the shaping keys', () => {
    expect(withoutOutputFormat({ format: 'hook', hook_event: 'SessionStart', window: 'w' })).toEqual({ window: 'w' });
  });
});

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await operationsByName.put_page.handler({
    engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default',
  } as unknown as OperationContext, {
    slug: 'people/zelda-quartermain',
    content: '---\ntitle: Zelda Quartermain\ntype: person\n---\n\n# Zelda Quartermain\n\nRuns the canary programme.\n',
  });
});

async function call(name: string, params: Record<string, unknown>) {
  return dispatchToolCall(engine, name, params, { remote: true, sourceId: 'default' });
}

const WINDOW = 'user: What did Zelda Quartermain say about the launch?';

describe('volunteer_context format', () => {
  it('json stays the {pages, count, window_turns} document', async () => {
    const res = await call('volunteer_context', { window: WINDOW });
    const body = JSON.parse(res.content[0].text);
    expect(body.count).toBe(1);
    expect(body.pages[0].slug).toBe('people/zelda-quartermain');
  });

  it('hook is one content block a Claude Code hook injects', async () => {
    const res = await call('volunteer_context', { window: WINDOW, session_id: 's-1', format: 'hook' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);
    const doc = JSON.parse(res.content[0].text);
    expect(Object.keys(doc)).toEqual(['hookSpecificOutput']);
    expect(doc.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx = doc.hookSpecificOutput.additionalContext as string;
    expect(ctx.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
    expect(ctx).toContain('**Zelda Quartermain** → `people/zelda-quartermain`');
  });

  it('text is the plain block', async () => {
    const res = await call('volunteer_context', { window: WINDOW, format: 'text' });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
    expect(res.content[0].text).toContain('people/zelda-quartermain');
  });

  it('nothing volunteered is an empty hook document', async () => {
    const res = await call('volunteer_context', { window: 'user: nothing to see here', format: 'hook' });
    expect(res.content[0].text).toBe('{}');
  });

  it('stats mode renders the precision summary as text', async () => {
    const res = await call('volunteer_context', { stats: true, format: 'text' });
    expect(res.content[0].text).toContain('volunteered-context precision');
  });

  it('an unknown format is invalid_params', async () => {
    const res = await call('volunteer_context', { window: WINDOW, format: 'xml' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('invalid_params');
  });
});

describe('context_pack format', () => {
  it('hook carries the pack text under the named event', async () => {
    const json = JSON.parse((await call('context_pack', { entities: 'Zelda Quartermain' })).content[0].text);
    expect(json.text).toContain('Zelda Quartermain');
    const res = await call('context_pack', { entities: 'Zelda Quartermain', format: 'hook', hook_event: 'SessionStart' });
    expect(res.content).toHaveLength(1);
    const doc = JSON.parse(res.content[0].text);
    expect(doc.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: json.text });
  });

  it('text is the pack text verbatim', async () => {
    const json = JSON.parse((await call('context_pack', { entities: 'Zelda Quartermain' })).content[0].text);
    const res = await call('context_pack', { entities: 'Zelda Quartermain', format: 'text' });
    expect(res.content[0].text).toBe(json.text);
  });
});

describe('volunteer_context per-session dedupe', () => {
  it('a page volunteered to a session is not volunteered to it again; other sessions still get it', async () => {
    const first = JSON.parse((await call('volunteer_context', { window: WINDOW, session_id: 'sess-a' })).content[0].text);
    expect(first.count).toBe(1);
    await awaitPendingVolunteerEventWrites();
    const again = JSON.parse((await call('volunteer_context', { window: WINDOW, session_id: 'sess-a' })).content[0].text);
    expect(again.count).toBe(0);
    const hook = await call('volunteer_context', { window: WINDOW, session_id: 'sess-a', format: 'hook' });
    expect(hook.content[0].text).toBe('{}');
    const other = JSON.parse((await call('volunteer_context', { window: WINDOW, session_id: 'sess-b' })).content[0].text);
    expect(other.count).toBe(1);
    const anonymous = JSON.parse((await call('volunteer_context', { window: WINDOW })).content[0].text);
    expect(anonymous.count).toBe(1);
  });

  it('only events inside the dedupe window count', async () => {
    await call('volunteer_context', { window: WINDOW, session_id: 'sess-old' });
    await awaitPendingVolunteerEventWrites();
    await engine.executeRaw(
      `UPDATE context_volunteer_events SET volunteered_at = now() - ($1 || ' hours')::interval WHERE session_id = 'sess-old'`,
      [String(SESSION_DEDUPE_HOURS + 1)],
    );
    const later = JSON.parse((await call('volunteer_context', { window: WINDOW, session_id: 'sess-old' })).content[0].text);
    expect(later.count).toBe(1);
  });
});
