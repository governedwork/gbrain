/**
 * Opt-in output shaping for ops a harness hook calls directly (an `mcp_tool`
 * hook in Claude Code or Codex, or a `command` hook running the CLI).
 *
 * A hook reads the tool's text content as its output. Claude Code passes
 * context to the model only as `{hookSpecificOutput: {hookEventName,
 * additionalContext}}` (plain text from an `mcp_tool` hook is dropped on
 * UserPromptSubmit, and an op's own JSON is parsed as hook output and every key
 * ignored); Codex accepts that document or plain text. So an op that sets
 * `Operation.renderText` takes:
 *
 *   format: 'json' (default) — the op's JSON result, unchanged
 *   format: 'text'           — the op's compact injectable text block
 *   format: 'hook'           — that block as a hook document, under the
 *                              Claude Code hook-output cap; `{}` when empty
 *   hook_event               — the document's hookEventName (default UserPromptSubmit)
 *
 * Shaping is presentation only: the handler and its output redaction run
 * exactly as for JSON, and a shaped verb answer is not a v1 response document.
 */
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../bootstrap/host-specs.ts';
import type { Operation, ParamDef } from './contract.ts';

export const OUTPUT_FORMATS = ['json', 'text', 'hook'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const HOOK_EVENTS = ['UserPromptSubmit', 'SessionStart'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Spread into the `params` of every op that sets `renderText`. Full-surface-only: dispatch admits them on every
 * surface, but the starter tool list does not advertise them (its 25,000-character budget, mcp-schema-budget.test.ts);
 * a hook names `format` itself.
 */
export const OUTPUT_FORMAT_PARAMS: Record<'format' | 'hook_event', ParamDef> = {
  format: {
    type: 'string',
    enum: [...OUTPUT_FORMATS],
    description:
      "Output shape (default json). 'text' returns the compact injectable block; 'hook' returns " +
      '{hookSpecificOutput: {hookEventName, additionalContext}} for a Claude Code or Codex hook.',
    fullSurfaceOnly: true,
  },
  hook_event: {
    type: 'string',
    enum: [...HOOK_EVENTS],
    description: "hookEventName for format 'hook' (default UserPromptSubmit).",
    fullSurfaceOnly: true,
  },
};

export function requestedOutputFormat(params: Record<string, unknown>): OutputFormat {
  return (OUTPUT_FORMATS as readonly unknown[]).includes(params.format) ? (params.format as OutputFormat) : 'json';
}

/** The params minus the shaping keys — what a thin client forwards, so it shapes the JSON answer itself. */
export function withoutOutputFormat(params: Record<string, unknown>): Record<string, unknown> {
  const { format: _format, hook_event: _hookEvent, ...rest } = params;
  return rest;
}

function hookDocument(event: HookEvent, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** Cut `text` to at most `n` UTF-16 units without splitting a surrogate pair. */
function cutAt(text: string, n: number): string {
  const end = Math.max(0, n);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

/**
 * The shaped output for `params.format`, or null when the caller wants JSON
 * (or the op has no text rendering). `extraBlocks` (rendered notices) follow
 * the op's text, so they reach a hook that reads one block only.
 */
export async function shapeOutput(
  op: Pick<Operation, 'renderText'>,
  result: unknown,
  params: Record<string, unknown>,
  extraBlocks: readonly string[] = [],
): Promise<string | null> {
  const format = requestedOutputFormat(params);
  if (format === 'json' || !op.renderText) return null;
  const body = await op.renderText(result);
  const join = (b: string) => [b, ...extraBlocks].filter(Boolean).join('\n\n');
  if (format === 'text') return join(body);
  if (!join(body)) return '{}';
  const event: HookEvent = (HOOK_EVENTS as readonly unknown[]).includes(params.hook_event)
    ? (params.hook_event as HookEvent)
    : 'UserPromptSubmit';
  // Over the cap the harness diverts the output to a file and injects nothing,
  // so trim the op's text (never the notices) until the document fits. JSON
  // escaping inflates text by a content-dependent ratio, so cut in proportion.
  let kept = body;
  let doc = hookDocument(event, join(kept));
  while (doc.length > CLAUDE_HOOK_OUTPUT_CAP_CHARS && kept.length > 0) {
    kept = cutAt(kept, Math.floor((kept.length * CLAUDE_HOOK_OUTPUT_CAP_CHARS) / doc.length) - 16);
    doc = hookDocument(event, join(kept));
  }
  return doc;
}
