import { inlineCodeEndAt, scanMarkdownCode, type MarkdownCodeMap } from './fence-scan.ts';

/**
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing non-newline characters with spaces. Preserves CR/LF characters
 * and UTF-16 code-unit offsets for callers that care about positions.
 * Inline spans follow CommonMark (#6133): a run of n backticks closes at the
 * next run of exactly n on the same line (fence-scan.ts finds the spans), so
 * ``a `b` c`` is one span; a bare CR does not end the line here.
 * Runs between newlines, backticks and (with onHtmlComment) `<!--` are copied
 * as whole slices, so cost is linear in the text rather than per character.
 */
export function stripCodeBlocks(content: string, opts: { onHtmlComment?: (start: number, end: number) => void } = {}): string {
  const fenceMarker = / {0,3}(`{3,}|~{3,})([^\n]*)/y;
  const special = opts.onHtmlComment ? /\n|`|<!--/g : /\n|`/g;
  let fence: string | undefined;
  let inline: MarkdownCodeMap | undefined;
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (i === 0 || content[i - 1] === '\n') {
      fenceMarker.lastIndex = i;
      const marker = fence || /^ {0,3}[`~]/.test(content.slice(i, i + 4)) ? fenceMarker.exec(content) : null;
      if (fence || (marker && (marker[1][0] === '~' || !marker[2].includes('`')))) {
        const newline = content.indexOf('\n', i);
        const end = newline === -1 ? content.length : newline + 1;
        if (!fence) fence = marker![1];
        else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
        out += content.slice(i, end).replace(/[^\r\n]/g, ' ');
        i = end;
        continue;
      }
    }
    special.lastIndex = i;
    const next = special.exec(content);
    const at = next ? next.index : content.length;
    out += content.slice(i, at);
    i = at;
    if (!next) break;
    if (next[0] === '\n') {
      out += '\n';
      i++;
      continue;
    }
    if (next[0] === '<!--') {
      const close = content.indexOf('-->', i + 4);
      const end = close === -1 ? content.length : close + 3;
      opts.onHtmlComment!(i, end);
      out += content.slice(i, end).replace(/[^\r\n]/g, ' ');
      i = end;
      continue;
    }
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      const afterFence = end === -1 ? content.length : end + 3;
      out += content.slice(i, afterFence).replace(/[^\r\n]/g, ' ');
      i = afterFence;
      continue;
    }
    inline ??= scanMarkdownCode(content.replace(/\r(?!\n)/g, ' '));
    const end = inlineCodeEndAt(inline, i);
    if (end === -1) {
      out += '`';
      i++;
      continue;
    }
    out += content.slice(i, end).replace(/[^\r\n]/g, ' ');
    i = end;
  }
  return out;
}

/**
 * Link syntax that is not text the page says, in one left-to-right scan: a
 * wikilink (`[[target]]`, `![[target]]`; group 1 is the visible part of
 * `[[target|Display]]`), an inline link's or image's `(destination "title")`
 * after its `]`, a reference definition line, a scheme autolink `<scheme:…>`,
 * and a bare URL (`scheme://…`, `www.…`). The patterns' character classes are
 * disjoint where they repeat, so matching stays linear.
 */
const LINK_SYNTAX_RE = new RegExp([
  /!?\[\[[^[\]\n|]*(?:\|([^[\]\n]*))?\]\]/.source,
  /(?<=\])\([ \t]*(?:<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/.source,
  /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\r?$/.source,
  /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.source,
  /\b(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|www\.)[^\s<>]+/.source,
].join('|'), 'gm');

const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');

/**
 * Mask link syntax that is not prose, replacing every masked character but CR/LF
 * with a space, so UTF-16 offsets hold (like `stripCodeBlocks`): a wikilink's
 * target (`[[target]]` whole; `[[target|Display]]` all but `Display`), a markdown
 * link's or image's destination and title (the bracketed text stays), a
 * reference definition, an autolink and a bare URL. Run it on text whose code is
 * already stripped, so link syntax inside code is not read at all.
 */
export function maskLinkSyntax(content: string): string {
  if (!/[[<]|:\/\/|www\./.test(content)) return content;
  return content.replace(LINK_SYNTAX_RE, (match: string, display: string | undefined) => {
    if (display === undefined) return blank(match);
    const at = match.indexOf('|') + 1;
    return blank(match.slice(0, at)) + display + blank(match.slice(at + display.length));
  });
}
