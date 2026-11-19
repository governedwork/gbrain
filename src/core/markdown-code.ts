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
 * Link syntax, in one left-to-right scan: a wikilink or embed (`[[target]]`,
 * `![[target]]`, `[[target|display]]`; groups 1-2), an inline link's or image's
 * `(destination "title")` after its `]`, a whole reference definition line
 * `[label]: destination "title"` (groups 3-5; never a footnote definition
 * `[^x]: …`), a scheme autolink `<scheme:…>`, and a bare URL (`scheme://…`,
 * `www.…`; group 6). The patterns' character classes are disjoint where they
 * repeat, so matching stays linear.
 */
const LINK_SYNTAX_RE = new RegExp([
  /!?\[\[([^[\]\n|]*)(?:\|([^[\]\n]*))?\]\]/.source,
  /(?<=\])\([ \t]*(?:<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/.source,
  /^( {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\r?$/.source,
  /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.source,
  /(\b(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|www\.)[^\s<>"|\u3000-\u303f\uff00-\uff65]+)/.source,
].join('|'), 'gm');

/**
 * Where a bare URL ends, as a GFM extended autolink ends: at whitespace or `<` (and at `>`, `"` or `|`, which are
 * no URL's characters: an HTML attribute's quote, a table cell's edge, and at CJK punctuation, U+3000-U+303F and the
 * fullwidth forms U+FF00-U+FF65 such as `。、，：`, which end a URL in CJK prose that has no spaces), with trailing
 * punctuation (`?!.,:*_~'"`) and an unbalanced `)` not part of it. Other non-ASCII text (a katakana path), commas and
 * brackets inside a URL are part of it: a renderer links them.
 */
function urlEnd(url: string): number {
  let end = url.length;
  const count = (ch: string) => url.slice(0, end).split(ch).length - 1;
  for (;;) {
    const last = url[end - 1]!;
    if ('?!.,:*_~\'"'.includes(last) || (last === ')' && count('(') < count(')'))) end--;
    else return end;
  }
}

const ATTACHMENT = /\.(?:txt|pdf|png|jpe?g|gif|webp|svg|csv|json|html?|canvas|mp3|mp4|m4a|mov|wav)$/i;
const FILE_NAME = /\.(?:md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|csv|json|html?|canvas|mp3|mp4|m4a|mov|wav)$/i;

/**
 * A link target or destination that reads as an address, not a name: a path
 * (any `/`), a URL or scheme, a file name, an anchor alone, or a slug
 * (`acme-example`). `Acme Example` and `Acme Example#Funding` are names.
 */
function addressShaped(raw: string): boolean {
  const target = raw.trim().replace(/^<([^>]*)>$/, '$1').replace(/#.*$/, '');
  if (!target || target.includes('/')) return true;
  if (/\s/.test(target)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || /^www\./i.test(target) || FILE_NAME.test(target) || /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(target);
}

const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');

/**
 * Mask link syntax but keep the text a reader sees, replacing every masked
 * character but CR/LF with a space, so UTF-16 offsets hold (like
 * `stripCodeBlocks`): an attachment embed (`![[Acme Example logo.png]]`, a
 * file extension) is masked whole, since a reader sees the attachment;
 * `[[Acme Example]]` and a note transclusion `![[Acme Example]]` keep
 * `Acme Example` (only the brackets go) unless the target is address-shaped
 * (`[[notes/widget-co-launch]]`: masked whole); `[[target|display]]` keeps
 * `display`; a markdown link or image keeps its bracketed text and loses its
 * `(destination)`; a reference definition line loses its title (a tooltip) and
 * an address-shaped destination, while a prose line that only starts like one
 * and a footnote definition are untouched; autolinks and bare URLs (`urlEnd`)
 * are masked. Run it on text whose code is already stripped, so link syntax
 * inside code is not read at all.
 */
export function maskLinkSyntax(content: string): string {
  if (!/[[<]|:\/\/|www\./.test(content)) return content;
  return content.replace(LINK_SYNTAX_RE, (match: string, target?: string, display?: string, label?: string, destination?: string, title?: string, url?: string) => {
    if (target !== undefined) {
      if (match.startsWith('!') && ATTACHMENT.test(target.replace(/#.*$/, '').trim())) return blank(match);
      const open = match.indexOf('[[') + 2;
      if (display !== undefined) {
        const at = open + target.length + 1;
        return blank(match.slice(0, at)) + display + blank(match.slice(at + display.length));
      }
      if (addressShaped(target)) return blank(match);
      return blank(match.slice(0, open)) + target + blank(match.slice(open + target.length));
    }
    if (label !== undefined) {
      const rest = match.slice(label.length + destination!.length + (title ?? '').length);
      return label + (addressShaped(destination!) ? blank(destination!) : destination!) + blank(title ?? '') + rest;
    }
    if (url !== undefined) return blank(url.slice(0, urlEnd(url))) + url.slice(urlEnd(url));
    return blank(match);
  });
}
