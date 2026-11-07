/**
 * The sender's authentication verdict, as Gmail itself recorded it.
 *
 * Gmail's receiving server prepends an RFC 8601 `Authentication-Results`
 * header under its authserv-id `mx.google.com`:
 *
 *   mx.google.com; dkim=pass header.i=@example.com header.s=… header.b=…;
 *     spf=pass (google.com: …) smtp.mailfrom=…; dmarc=pass (p=…) header.from=example.com
 *
 * A sender can write any header it likes, including one that claims to be
 * Gmail's, so only the TOPMOST header under `mx.google.com` counts (Gmail
 * prepends; a copy the sender wrote sits below it) and every other copy is
 * ignored. The topmost one also carries sender-chosen text (the envelope
 * sender, the From domain), so it is read strictly: a quoted string, a
 * backslash, an unbalanced comment, a token outside the `method=result` /
 * `ptype.property=value` grammar or a repeated spf/dmarc result makes the
 * whole header read `none`, and so does a `dkim` result after `spf` or
 * `dmarc` (Gmail writes dkim first). Any doubt reads `none`, never `pass`,
 * and a malformed topmost header never falls through to a lower copy.
 *
 * `dmarc` reads `pass` only when Gmail's `header.from` is the domain of the
 * From address GBrain parsed for the same message: a DMARC pass is a verdict
 * about the domain Gmail read, and it must not be pinned to another one.
 *
 * GBrain upstream reads no authentication header (checked at 0.60.342.0,
 * 0.60.599.0 and 0.60.604.0); this is the fork's.
 */
import type {
  DkimVerdict,
  DmarcVerdict,
  GmailThreadData,
  PageSenderAuth,
  SenderAuthVerdict,
  SpfVerdict,
} from './types.ts';

export const GMAIL_AUTHSERV_ID = 'mx.google.com';

/** Headers looked at per message, and the longest header value read; a longer Gmail header reads none. */
const MAX_HEADERS = 1_000;
const MAX_VALUE_CHARS = 16_384;

export const NO_SENDER_AUTH: Readonly<SenderAuthVerdict> = Object.freeze({
  spf: 'none',
  dkim: 'none',
  dmarc: 'none',
  dkim_domain: null,
});

/** A result keyword → its contract value; anything not listed reads `none`. */
function verdicts<T extends string>(values: readonly T[], synonyms: Readonly<Record<string, T>> = {}): ReadonlyMap<string, T> {
  return new Map<string, T>([...values.map((v) => [v, v] as const), ...Object.entries(synonyms)]);
}

// RFC 8601 §2.7: spf `hardfail` is a legacy synonym of fail; dkim `policy` is a
// valid signature the verifier's policy refused — not a pass.
const SPF = verdicts<SpfVerdict>(['pass', 'fail', 'none', 'neutral', 'softfail', 'temperror', 'permerror'], { hardfail: 'fail' });
const DKIM = verdicts<DkimVerdict>(['pass', 'fail', 'none', 'neutral', 'temperror', 'permerror'], { policy: 'fail' });
const DMARC = verdicts<DmarcVerdict>(['pass', 'fail', 'none', 'temperror', 'permerror']);

const METHOD_RE = /^([a-z0-9-]+)(?:\/[0-9]+)?=([a-z0-9-]+)$/;
const PROPERTY_RE = /^([a-z0-9-]+\.[a-z0-9_.-]+)=(\S*)$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

interface ResInfo {
  method: string;
  result: string;
  props: Map<string, string>;
}

/** Comments dropped and `;`-split; null when the text is not plainly RFC 8601 (quotes, escapes, unbalanced comments). */
function segments(value: string): string[] | null {
  if (/["\\]/.test(value)) return null;
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of value) {
    if (c === '(') depth++;
    else if (c === ')') {
      if (--depth < 0) return null;
      cur += ' ';
    } else if (depth > 0) continue;
    else if (c === ';') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (depth !== 0) return null;
  out.push(cur.trim());
  return out;
}

/** The authserv-id: the first token before the first `;`, comments dropped, lower-cased. */
function authservId(value: string): string {
  const head = value.split(';', 1)[0]!.replace(/\([^()]*\)/g, ' ').trim();
  return (head.split(/\s+/)[0] ?? '').toLowerCase();
}

/** The resinfo list of a header known to be Gmail's, or null when any part of it is unreadable. */
function parseResults(rest: string[]): ResInfo[] | null {
  const results: ResInfo[] = [];
  let pastDkim = false;
  for (const seg of rest) {
    const tokens = seg.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0] === 'none') continue;
    const head = METHOD_RE.exec(tokens[0] ?? '');
    if (!head) return null;
    const props = new Map<string, string>();
    for (const t of tokens.slice(1)) {
      const p = PROPERTY_RE.exec(t);
      if (!p) return null;
      props.set(p[1]!, p[2]!);
    }
    if (head[1] === 'dkim' && pastDkim) return null;
    if (head[1] === 'spf' || head[1] === 'dmarc') pastDkim = true;
    results.push({ method: head[1]!, result: head[2]!, props });
  }
  // verdictOf reads the first spf/dmarc result; a repeat is refused here, so "first" is "only".
  const count = (m: string) => results.filter((r) => r.method === m).length;
  if (count('spf') > 1 || count('dmarc') > 1) return null;
  return results;
}

function signingDomain(r: ResInfo): string | null {
  const raw = r.props.get('header.d') ?? r.props.get('header.i')?.split('@').pop() ?? '';
  const domain = raw.replace(/\.$/, '');
  return DOMAIN_RE.test(domain) ? domain : null;
}

function verdictOf(results: ResInfo[], fromDomain: string): SenderAuthVerdict {
  const spf = results.find((r) => r.method === 'spf');
  const dmarc = results.find((r) => r.method === 'dmarc');
  const dkims = results.filter((r) => r.method === 'dkim');
  const passing = dkims.filter((r) => r.result === 'pass');
  const domains = passing.map(signingDomain).filter((d): d is string => d !== null);
  const dmarcDomain = dmarc?.props.get('header.from');
  const dmarcVerdict = (dmarc && DMARC.get(dmarc.result)) || 'none';
  return {
    spf: (spf && SPF.get(spf.result)) || 'none',
    dkim: passing.length ? 'pass' : (dkims[0] && DKIM.get(dkims[0].result)) || 'none',
    dmarc: dmarcVerdict === 'pass' && (!fromDomain || dmarcDomain !== fromDomain) ? 'none' : dmarcVerdict,
    dkim_domain: domains.find((d) => d === dmarcDomain) ?? domains[0] ?? null,
  };
}

/**
 * The verdict of one message from its top-level headers, in the order Gmail
 * returns them (the raw message's order, top first), and the bare From
 * address GBrain parsed for it.
 */
export function senderAuthFromHeaders(
  headers: ReadonlyArray<{ name: string; value: string }> | undefined,
  fromAddress: string,
): SenderAuthVerdict {
  const list = headers ?? [];
  const fromDomain = fromAddress.includes('@') ? fromAddress.slice(fromAddress.lastIndexOf('@') + 1) : '';
  for (let i = 0; i < Math.min(list.length, MAX_HEADERS); i++) {
    const h = list[i]!;
    // Gmail's JSON is cast, not validated: a non-string name or value is no header at all.
    if (typeof h?.name !== 'string' || typeof h.value !== 'string') continue;
    if (h.name.toLowerCase() !== 'authentication-results' || authservId(h.value) !== GMAIL_AUTHSERV_ID) continue;
    // The first header that is Gmail's decides, readable or not: never a lower copy.
    const segs = h.value.length <= MAX_VALUE_CHARS ? segments(h.value) : null;
    const results = segs && parseResults(segs.slice(1));
    return results ? verdictOf(results, fromDomain) : { ...NO_SENDER_AUTH };
  }
  return { ...NO_SENDER_AUTH };
}

/**
 * The page's `sender_auth`: the verdict of the thread's newest inbound
 * message, that message's id and its bare From. Inbound is decided by Gmail's own labels
 * (no SENT, no DRAFT), never by the From line: a sender can write the
 * owner's address, and that mail is still inbound. No inbound message reads
 * none with `message_id` and `from` null.
 */
export function threadSenderAuth(thread: GmailThreadData): PageSenderAuth {
  const inbound = thread.messages.findLast((m) => !m.labelIds.includes('SENT') && !m.labelIds.includes('DRAFT'));
  const v = inbound?.senderAuth ?? NO_SENDER_AUTH;
  // Field by field, so the rendered line carries the contract's keys and nothing else.
  return {
    spf: v.spf, dkim: v.dkim, dmarc: v.dmarc, dkim_domain: v.dkim_domain,
    message_id: inbound?.id ?? null,
    from: inbound?.fromAddress || null,
  };
}
