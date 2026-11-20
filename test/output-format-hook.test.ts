/**
 * Ours (governedwork fork): `format: text | hook` on volunteer_context (ops/output-format.ts), the shapes a Claude Code
 * / Codex UserPromptSubmit hook can inject, and the per-session dedupe a per-prompt hook relies on. Unit cases for
 * shapeText and renderVolunteeredBlock, then in-process through dispatchToolCall (the layer both MCP transports share)
 * against in-memory PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { shapeOutput, shapeText, withoutOutputFormat, type OutputShaper } from '../src/core/ops/output-format.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../src/core/bootstrap/host-specs.ts';
import { renderVolunteeredBlock, TURN_CONTEXT_ENVELOPE } from '../src/core/context/turn-context.ts';
import type { VolunteeredPage } from '../src/core/context/volunteer.ts';
import { awaitPendingVolunteerEventWrites, SESSION_DEDUPE_HOURS } from '../src/core/context/volunteer-events.ts';

const textOp = { renderText: async () => (r: unknown) => (r as { text: string }).text };
const shaper = (format: OutputShaper['format'], render: OutputShaper['render']): OutputShaper => ({ format, render });

const page = (n: number, confidence: number, synopsis: string): VolunteeredPage => ({
  slug: `people/p${n}`, source_id: 'default', display: `P${n}`, confidence, arm: 'alias', rationale: `named P${n}`, synopsis,
  trust_tier: 'external_untrusted', origin: 'mcp',
});
const OPEN = '<external-data';
const CLOSE = '</external-data>';
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('shapeOutput / shapeText', () => {
  it('json (the default) and an op without renderText leave the result to the JSON path', async () => {
    expect(await shapeOutput(textOp, { text: 'x' }, {})).toBeNull();
    expect(await shapeOutput(textOp, { text: 'x' }, { format: 'json' })).toBeNull();
    expect(await shapeOutput({}, { text: 'x' }, { format: 'text' })).toBeNull();
  });

  it('text is the rendered block with the extra blocks after it', async () => {
    expect(await shapeOutput(textOp, { text: 'block' }, { format: 'text' }, ['notice'])).toBe('block\n\nnotice');
  });

  it('hook wraps the block for UserPromptSubmit, the only event; a hook_event key changes nothing', async () => {
    const doc = JSON.parse((await shapeOutput(textOp, { text: 'block' }, { format: 'hook', hook_event: 'SessionStart' }))!);
    expect(doc).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'block' } });
  });

  it('an empty block is an empty hook document and empty text', async () => {
    expect(await shapeOutput(textOp, { text: '' }, { format: 'hook' })).toBe('{}');
    expect(await shapeOutput(textOp, { text: '' }, { format: 'text' })).toBe('');
  });

  it('a block the renderer cannot fit is dropped whole, never cut, and the folded notices are kept', () => {
    const notice = '[gbrain notice degraded kind=degraded]';
    const fenced = `${OPEN} trust="external_untrusted" origin="mcp">${'a"\n'.repeat(CLAUDE_HOOK_OUTPUT_CAP_CHARS)}${CLOSE}`;
    const doc = shapeText(shaper('hook', () => fenced), {}, [notice]);
    expect(doc.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    expect(JSON.parse(doc).hookSpecificOutput.additionalContext).toBe(notice);
  });

  it('withoutOutputFormat drops only format', () => {
    expect(withoutOutputFormat({ format: 'hook', window: 'w', session_id: 's' })).toEqual({ window: 'w', session_id: 's' });
  });
});

describe('renderVolunteeredBlock under a budget', () => {
  it('drops whole pages, lowest confidence first, so every trust envelope stays whole', () => {
    const pages = [page(1, 0.95, 'x'.repeat(3000)), page(2, 0.75, 'y'.repeat(3000)), page(3, 0.85, 'z'.repeat(3000)), page(4, 0.8, 'w'.repeat(3000))];
    const doc = shapeText(shaper('hook', (r, fits) => renderVolunteeredBlock((r as { pages: VolunteeredPage[] }).pages, fits)), { pages });
    expect(doc.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    const ctx = JSON.parse(doc).hookSpecificOutput.additionalContext as string;
    expect(ctx.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
    expect(count(ctx, OPEN)).toBe(3);
    expect(count(ctx, CLOSE)).toBe(3);
    expect(ctx).toContain('`people/p1`');
    expect(ctx).not.toContain('`people/p2`'); // the lowest confidence went first
    expect(pages).toHaveLength(4); // the caller's array is not trimmed in place
  });

  it('without a budget it renders every page', () => {
    const text = renderVolunteeredBlock([page(1, 0.9, 'a'), page(2, 0.8, 'b')]);
    expect(count(text, CLOSE)).toBe(2);
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

describe('context_pack is not shaped (no caller; the fork carries volunteer_context only)', () => {
  it('declares no format param and answers JSON when one is passed', async () => {
    expect('format' in operationsByName.context_pack.params).toBe(false);
    const res = await call('context_pack', { entities: 'Zelda Quartermain', format: 'text' });
    expect(JSON.parse(res.content[0].text).text).toContain('Zelda Quartermain');
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
