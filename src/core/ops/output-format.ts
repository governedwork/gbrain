/**
 * Ours (governedwork fork): opt-in output shaping for an op a harness hook calls directly (an `mcp_tool` hook in
 * Claude Code or Codex, or a `command` hook running the CLI). Today only `volunteer_context` sets it.
 *
 * A hook reads the tool's text content as its output. Claude Code passes context to the model only as
 * `{hookSpecificOutput: {hookEventName, additionalContext}}` (plain text from an `mcp_tool` hook is dropped on
 * UserPromptSubmit, and an op's own JSON is parsed as hook output and every key ignored); Codex accepts that document
 * or plain text. So an op that sets `Operation.renderText` takes:
 *
 *   format: 'json' (default) — the op's JSON result, unchanged
 *   format: 'text'           — the op's compact injectable text block
 *   format: 'hook'           — that block as a UserPromptSubmit hook document, under the Claude Code hook-output
 *                              cap; `{}` when empty
 *
 * Shaping is presentation only: the handler and its output redaction run exactly as for JSON, and a shaped verb
 * answer is not a v1 response document. Fitting the cap never cuts text: the op's renderer drops whole units (a
 * volunteered page, with its trust envelope or quote fence) until the document fits, and if it still does not, the
 * op's text is dropped whole. The notices folded in after it are never trimmed.
 */
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../bootstrap/host-specs.ts';
import type { Operation, ParamDef } from './contract.ts';

export const OUTPUT_FORMATS = ['json', 'text', 'hook'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * An op's text rendering of its own (redacted) result. With `fits`, it returns the fullest rendering of whole units
 * for which `fits(text)` holds (or its smallest one, which the caller then drops); it never cuts inside a unit.
 */
export type TextRenderer = (result: unknown, fits?: (text: string) => boolean) => string;

/**
 * Spread into the `params` of every op that sets `renderText`. Full-surface-only: dispatch admits it on every surface,
 * but the starter tool list does not advertise it (its 25,000-character budget, mcp-schema-budget.test.ts); a hook
 * names `format` itself.
 */
export const OUTPUT_FORMAT_PARAMS: Record<'format', ParamDef> = {
  format: {
    type: 'string',
    enum: [...OUTPUT_FORMATS],
    description:
      "Output shape (default json). 'text' returns the compact injectable block; 'hook' returns " +
      '{hookSpecificOutput: {hookEventName, additionalContext}} for a Claude Code or Codex UserPromptSubmit hook.',
    fullSurfaceOnly: true,
  },
};

export function requestedOutputFormat(params: Record<string, unknown>): OutputFormat {
  return (OUTPUT_FORMATS as readonly unknown[]).includes(params.format) ? (params.format as OutputFormat) : 'json';
}

/** The params minus `format` — what a thin client forwards, so it shapes the JSON answer itself. */
export function withoutOutputFormat(params: Record<string, unknown>): Record<string, unknown> {
  const { format: _format, ...rest } = params;
  return rest;
}

export interface OutputShaper {
  format: Exclude<OutputFormat, 'json'>;
  render: TextRenderer;
}

/** The shaper for `params.format`, or null when the caller wants JSON or the op has no text rendering. */
export async function outputShaper(op: Pick<Operation, 'renderText'>, params: Record<string, unknown>): Promise<OutputShaper | null> {
  const format = requestedOutputFormat(params);
  if (format === 'json' || !op.renderText) return null;
  return { format, render: await op.renderText() };
}

function hookDocument(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

/**
 * The shaped output. `extraBlocks` (evidence and rendered notices) follow the op's text, so they reach a hook that
 * reads one block only; they are never trimmed.
 */
export function shapeText(shaper: OutputShaper, result: unknown, extraBlocks: readonly string[] = []): string {
  const join = (body: string) => [body, ...extraBlocks].filter(Boolean).join('\n\n');
  if (shaper.format === 'text') return join(shaper.render(result));
  // Over the cap the harness diverts the output to a file and injects nothing, so the document must fit.
  const fits = (body: string) => hookDocument(join(body)).length <= CLAUDE_HOOK_OUTPUT_CAP_CHARS;
  let body = shaper.render(result, fits);
  if (!fits(body)) body = '';
  const text = join(body);
  return text ? hookDocument(text) : '{}';
}

/** Both phases at once, for the CLI. */
export async function shapeOutput(op: Pick<Operation, 'renderText'>, result: unknown, params: Record<string, unknown>,
  extraBlocks: readonly string[] = []): Promise<string | null> {
  const shaper = await outputShaper(op, params);
  return shaper ? shapeText(shaper, result, extraBlocks) : null;
}
