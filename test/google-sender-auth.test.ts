/**
 * google-sender-auth — the sender's authentication verdict on email pages.
 *
 * Gmail prepends an `Authentication-Results` header under its own authserv-id
 * `mx.google.com`. Only the topmost such header counts: any other copy, and
 * any header under another authserv-id, is text the sender wrote. Anything
 * the parser cannot read with certainty reads `none`, never `pass`.
 * All fixture data is synthetic (example.com / example.org).
 */
import { describe, expect, test } from 'bun:test';

import { GoogleTokenProvider } from '../src/core/creds/providers/google.ts';
import type {
  CredentialEntry,
  CredentialMeta,
  CredentialVault,
  ProviderClientRecord,
} from '../src/core/creds/vault.ts';
import { GmailClient, type FetchImpl } from '../src/core/google/google-clients.ts';
import { renderThreadPage } from '../src/core/google/google-render.ts';
import {
  NO_SENDER_AUTH,
  senderAuthFromHeaders,
  threadSenderAuth,
} from '../src/core/google/sender-auth.ts';
import type { GmailMessageMeta, GmailThreadData, SenderAuthVerdict } from '../src/core/google/types.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { bareAddress } from '../src/core/google/types.ts';

/** The parser for a message whose parsed From is `from` (Gmail's fixtures below use example.com). */
function readAuth(headers: Parameters<typeof senderAuthFromHeaders>[0], from = 'charlie@example.com') {
  return senderAuthFromHeaders(headers, from);
}

const GMAIL_AR =
  'mx.google.com; dkim=pass header.i=@example.com header.s=sel1 header.b=AbCd12; ' +
  'spf=pass (google.com: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com; ' +
  'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';

const ALL_PASS: SenderAuthVerdict = { spf: 'pass', dkim: 'pass', dmarc: 'pass', dkim_domain: 'example.com' };

function ar(value: string): { name: string; value: string } {
  return { name: 'Authentication-Results', value };
}

describe('senderAuthFromHeaders: the authserv-id rule', () => {
  test("Gmail's header with spf, dkim header.d and dmarc pass reads as C-AUTH", () => {
    const v = readAuth([
      ar('mx.google.com; dkim=pass header.d=Example.COM header.s=s1; spf=pass smtp.mailfrom=x@example.com; dmarc=pass header.from=example.com'),
    ]);
    expect(v).toEqual(ALL_PASS);
  });

  test("Gmail's real shape (header.i, comments) reads as C-AUTH", () => {
    expect(readAuth([ar(GMAIL_AR)])).toEqual(ALL_PASS);
  });

  test('a header under another authserv-id is ignored, above or below Gmail\'s', () => {
    const forged = ar('mx.example.org; dkim=pass header.d=bank.example.org; spf=pass; dmarc=pass header.from=bank.example.org');
    const gmailFail = ar('mx.google.com; spf=fail smtp.mailfrom=x@example.org; dmarc=fail header.from=bank.example.org');
    const expected: SenderAuthVerdict = { spf: 'fail', dkim: 'none', dmarc: 'fail', dkim_domain: null };
    expect(readAuth([forged, gmailFail])).toEqual(expected);
    expect(readAuth([gmailFail, forged])).toEqual(expected);
  });

  test('only another authserv-id present → none', () => {
    expect(readAuth([
      ar('mx.example.org; dkim=pass header.d=example.com; spf=pass; dmarc=pass header.from=example.com'),
    ])).toEqual(NO_SENDER_AUTH);
  });

  test('a look-alike authserv-id is not Gmail\'s', () => {
    for (const id of ['mx.google.com.example.org', 'xmx.google.com', 'mx.google.co', 'google.com', 'mx-google-com']) {
      expect(readAuth([ar(`${id}; dkim=pass header.d=example.com; spf=pass; dmarc=pass`)])).toEqual(NO_SENDER_AUTH);
    }
  });

  test('the authserv-id matches case-insensitively and may carry a version', () => {
    expect(readAuth([ar(GMAIL_AR.replace('mx.google.com', 'MX.Google.Com 1'))])).toEqual(ALL_PASS);
  });

  test('a second mx.google.com copy below the topmost one is ignored (the sender wrote it)', () => {
    const real = ar('mx.google.com; spf=softfail smtp.mailfrom=x@example.org; dmarc=fail header.from=bank.example.org');
    const forged = ar('mx.google.com; dkim=pass header.d=bank.example.org; spf=pass; dmarc=pass header.from=bank.example.org');
    expect(readAuth([real, forged])).toEqual({ spf: 'softfail', dkim: 'none', dmarc: 'fail', dkim_domain: null });
  });

  test('a malformed topmost Gmail header reads none; it never falls through to a lower copy', () => {
    const forged = ar(GMAIL_AR);
    expect(readAuth([ar('mx.google.com; dkim=pass header.d=example.com (unclosed'), forged])).toEqual(NO_SENDER_AUTH);
  });

  test('an oversized topmost Gmail header reads none; it never falls through to a lower copy', () => {
    const huge = ar(`mx.google.com; spf=fail smtp.mailfrom=x@example.org; dmarc=fail header.from=example.org; x=y${' header.z=a'.repeat(7000)}`);
    expect(huge.value.length).toBeGreaterThan(65_536);
    expect(readAuth([huge, ar(GMAIL_AR)])).toEqual(NO_SENDER_AUTH);
  });

  test('header names match case-insensitively; unrelated headers are skipped', () => {
    expect(readAuth([
      { name: 'ARC-Authentication-Results', value: 'i=1; mx.google.com; dkim=pass header.d=bank.example.org' },
      { name: 'authentication-results', value: GMAIL_AR },
    ])).toEqual(ALL_PASS);
  });

  test('no header → every verdict none, dkim_domain null', () => {
    expect(NO_SENDER_AUTH).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', dkim_domain: null });
    expect(readAuth([])).toEqual(NO_SENDER_AUTH);
    expect(readAuth(undefined)).toEqual(NO_SENDER_AUTH);
    expect(readAuth([{ name: 'From', value: 'x@example.com' }])).toEqual(NO_SENDER_AUTH);
    expect(readAuth([ar('mx.google.com; none')])).toEqual(NO_SENDER_AUTH);
  });
});

describe('senderAuthFromHeaders: verdict values', () => {
  const ROUND_TRIPS = [
    ['spf', ['pass', 'fail', 'none', 'neutral', 'softfail', 'temperror', 'permerror'], 'smtp.mailfrom=x@example.com'],
    ['dkim', ['pass', 'fail', 'none', 'neutral', 'temperror', 'permerror'], 'header.i=@example.com'],
    ['dmarc', ['pass', 'fail', 'none', 'temperror', 'permerror'], 'header.from=example.com'],
  ] as const;
  for (const [method, values, prop] of ROUND_TRIPS) {
    test(`each ${method} verdict round-trips`, () => {
      for (const v of values) {
        expect(readAuth([ar(`mx.google.com; ${method}=${v} ${prop}`)])[method]).toBe(v);
      }
    });
  }

  test('verdicts are case-insensitive; legacy synonyms map; unknown values read none, never pass', () => {
    expect(readAuth([ar('mx.google.com; spf=HardFail smtp.mailfrom=x@example.com')]).spf).toBe('fail');
    expect(readAuth([ar('mx.google.com; dkim=policy header.d=example.com')]).dkim).toBe('fail');
    const odd = readAuth([ar('mx.google.com; dkim=passed header.d=example.com; spf=ok; dmarc=bestguesspass header.from=example.com')]);
    expect(odd).toEqual(NO_SENDER_AUTH);
    expect(readAuth([ar('mx.google.com; spf=PASS smtp.mailfrom=x@example.com')]).spf).toBe('pass');
  });

  test('a missing method reads none', () => {
    expect(readAuth([ar('mx.google.com; spf=pass smtp.mailfrom=x@example.com')]))
      .toEqual({ spf: 'pass', dkim: 'none', dmarc: 'none', dkim_domain: null });
  });
});

describe('senderAuthFromHeaders: dkim_domain', () => {
  test('dkim_domain is the lower-cased header.d, else the header.i domain, of a passing signature', () => {
    expect(readAuth([ar('mx.google.com; dkim=pass header.i=@Mail.Example.COM header.s=s')]).dkim_domain).toBe('mail.example.com');
    expect(readAuth([ar('mx.google.com; dkim=pass header.i=news@Example.com header.d=Example.org')]).dkim_domain).toBe('example.org');
  });

  test('a failing signature gives no dkim_domain', () => {
    expect(readAuth([ar('mx.google.com; dkim=fail header.d=example.com')]))
      .toEqual({ spf: 'none', dkim: 'fail', dmarc: 'none', dkim_domain: null });
  });

  test('any passing signature makes dkim pass; its domain is used, not the failing one\'s', () => {
    expect(readAuth([ar('mx.google.com; dkim=fail header.d=example.org; dkim=pass header.d=esp.example.net')]))
      .toEqual({ spf: 'none', dkim: 'pass', dmarc: 'none', dkim_domain: 'esp.example.net' });
  });

  test('among passing signatures, the one aligned with the dmarc header.from is preferred', () => {
    const v = readAuth([ar(
      'mx.google.com; dkim=pass header.i=@esp.example.net; dkim=pass header.i=@example.com; spf=pass; dmarc=pass header.from=Example.com',
    )]);
    expect(v.dkim_domain).toBe('example.com');
  });

  test('a passing signature with no domain-shaped d/i keeps dkim pass and dkim_domain null', () => {
    expect(readAuth([ar('mx.google.com; dkim=pass header.s=sel1')]))
      .toEqual({ spf: 'none', dkim: 'pass', dmarc: 'none', dkim_domain: null });
    expect(readAuth([ar('mx.google.com; dkim=pass header.d=not_a_domain')]).dkim_domain).toBeNull();
  });
});

describe('senderAuthFromHeaders: dmarc is bound to the message\'s own From', () => {
  test('a DMARC pass for another domain than the parsed From reads none', () => {
    const evilPass = ar('mx.google.com; dkim=pass header.i=@evil.example; spf=pass smtp.mailfrom=x@evil.example; dmarc=pass header.from=evil.example');
    expect(readAuth([evilPass], 'ceo@bank.example')).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'none', dkim_domain: 'evil.example' });
    expect(readAuth([evilPass], 'x@evil.example').dmarc).toBe('pass');
  });

  test('a DMARC pass with no header.from, or a message with no parsed From, reads none', () => {
    expect(readAuth([ar('mx.google.com; dmarc=pass')]).dmarc).toBe('none');
    expect(readAuth([ar(GMAIL_AR)], '').dmarc).toBe('none');
  });

  test('a display name holding an <addr> is not the From address (Gmail reads the real one)', () => {
    expect(bareAddress('"<ceo@bank.example>" <x@evil.example>')).toBe('x@evil.example');
    expect(bareAddress('(<ceo@bank.example>) <x@evil.example>')).toBe('x@evil.example');
    expect(bareAddress('Bank <ceo@bank.example> <x@evil.example>')).toBe('');
    expect(bareAddress('"Doe, Jane" <Jane@Example.com>')).toBe('jane@example.com');
    expect(bareAddress('a@example.com')).toBe('a@example.com');
  });
});

describe('senderAuthFromHeaders: sender text inside Gmail\'s header cannot add a result', () => {
  test('a dkim result after spf or dmarc (a smuggled `;`) makes the whole header read none', () => {
    expect(readAuth([ar('mx.google.com; spf=pass smtp.mailfrom=a@evil.example;dkim=pass header.i=@example.com; dmarc=fail header.from=example.com')])).toEqual(NO_SENDER_AUTH);
    expect(readAuth([ar('mx.google.com; dmarc=fail header.from=example.com;dkim=pass header.d=example.com')])).toEqual(NO_SENDER_AUTH);
  });

  test('a quoted string (a sender-chosen local part) makes the whole header read none', () => {
    const injected = ar(
      'mx.google.com; spf=fail smtp.mailfrom="a; dkim=pass header.d=bank.example.org; dmarc=pass x"@example.org; dmarc=fail header.from=bank.example.org',
    );
    expect(readAuth([injected])).toEqual(NO_SENDER_AUTH);
  });

  test('a comment that closes early and smuggles a result makes the whole header read none', () => {
    const injected = ar(
      'mx.google.com; spf=fail (google.com: domain of a) x; dkim=pass header.d=bank.example.org (b@example.org) smtp.mailfrom=b@example.org; dmarc=fail header.from=bank.example.org',
    );
    expect(readAuth([injected])).toEqual(NO_SENDER_AUTH);
  });

  test('a repeated spf or dmarc result makes the whole header read none', () => {
    expect(readAuth([ar('mx.google.com; dmarc=fail header.from=example.org; dmarc=pass header.from=example.org')])).toEqual(NO_SENDER_AUTH);
    expect(readAuth([ar('mx.google.com; spf=fail; spf=pass smtp.mailfrom=x@example.org')])).toEqual(NO_SENDER_AUTH);
  });

  test('a backslash or an unbalanced parenthesis makes the whole header read none', () => {
    expect(readAuth([ar('mx.google.com; dkim=pass header.d=example.com (a\\) b)')])).toEqual(NO_SENDER_AUTH);
    expect(readAuth([ar('mx.google.com; dkim=pass header.d=example.com a)')])).toEqual(NO_SENDER_AUTH);
  });

  test('comments elsewhere (Gmail\'s own) are dropped and do not disturb the parse', () => {
    expect(readAuth([ar(
      'mx.google.com; dkim=pass (test mode) header.i=@example.com header.s=s1 header.b=Zz; spf=pass (google.com: best guess record) smtp.mailfrom=x@example.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com',
    )])).toEqual(ALL_PASS);
  });
});

// ── the newest inbound message (render) ──────────────────────────────────────

const T_ID = '17aa1111bbbb2222';
const ACCOUNT = 'a@example.com';

function msg(over: Partial<GmailMessageMeta> = {}): GmailMessageMeta {
  const ms = over.internalDateMs ?? Date.parse('2026-08-10T12:00:00Z');
  return {
    id: '18c2f4a9b3d21e01',
    threadId: T_ID,
    from: 'Charlie Example <charlie@example.com>',
    fromAddress: 'charlie@example.com',
    to: [ACCOUNT],
    cc: [],
    subject: 'Zephyr roadmap',
    dateIso: new Date(ms).toISOString(),
    internalDateMs: ms,
    labelIds: ['INBOX'],
    listUnsubscribe: false,
    bodyText: 'Sharing the roadmap draft.',
    senderAuth: NO_SENDER_AUTH,
    ...over,
  };
}

function thread(messages: GmailMessageMeta[]): GmailThreadData {
  return { threadId: T_ID, account: ACCOUNT, messages };
}

function renderedSenderAuth(t: GmailThreadData): unknown {
  const page = renderThreadPage(t);
  if (!page) throw new Error('thread did not render');
  return parseMarkdown(page.markdown).frontmatter.sender_auth;
}

const AT = (min: number) => Date.parse('2026-08-10T12:00:00Z') + min * 60_000;

describe('threadSenderAuth + email page frontmatter', () => {
  test('the newest inbound message\'s verdict and message_id are recorded, not an older one\'s', () => {
    const older = msg({ id: '18c2f4a9b3d21e01', internalDateMs: AT(0), senderAuth: ALL_PASS });
    const newer = msg({ id: '18c2f4a9b3d21e02', internalDateMs: AT(5), senderAuth: { spf: 'softfail', dkim: 'fail', dmarc: 'fail', dkim_domain: null } });
    const t = thread([older, newer]);
    expect(threadSenderAuth(t)).toEqual({ spf: 'softfail', dkim: 'fail', dmarc: 'fail', dkim_domain: null, message_id: '18c2f4a9b3d21e02', from: 'charlie@example.com' });
    expect(renderedSenderAuth(t)).toEqual({ spf: 'softfail', dkim: 'fail', dmarc: 'fail', dkim_domain: null, message_id: '18c2f4a9b3d21e02', from: 'charlie@example.com' });
  });

  test('the owner\'s own later reply (SENT or DRAFT) is skipped', () => {
    const inbound = msg({ id: '18c2f4a9b3d21e01', internalDateMs: AT(0), senderAuth: ALL_PASS });
    const sent = msg({ id: '18c2f4a9b3d21e02', internalDateMs: AT(5), from: ACCOUNT, fromAddress: ACCOUNT, labelIds: ['SENT'] });
    const draft = msg({ id: '18c2f4a9b3d21e03', internalDateMs: AT(6), from: ACCOUNT, fromAddress: ACCOUNT, labelIds: ['DRAFT'] });
    expect(renderedSenderAuth(thread([inbound, sent, draft]))).toEqual({ ...ALL_PASS, message_id: '18c2f4a9b3d21e01', from: 'charlie@example.com' });
  });

  test('sender_auth.from is the inbound message\'s From, not the page\'s (the owner replied last); unparseable From is null', () => {
    const inbound = msg({ id: '18c2f4a9b3d21e01', internalDateMs: AT(0), senderAuth: ALL_PASS });
    const sent = msg({ id: '18c2f4a9b3d21e02', internalDateMs: AT(5), from: ACCOUNT, fromAddress: ACCOUNT, labelIds: ['SENT'] });
    const page = parseMarkdown(renderThreadPage(thread([inbound, sent]))!.markdown).frontmatter;
    expect(page.from).toBe(ACCOUNT);
    expect((page.sender_auth as { from: unknown }).from).toBe('charlie@example.com');
    const odd = msg({ from: 'Bank <ceo@bank.example> <x@evil.example>', fromAddress: bareAddress('Bank <ceo@bank.example> <x@evil.example>') });
    expect(threadSenderAuth(thread([odd])).from).toBeNull();
  });

  test('mail that only claims the owner\'s address (no SENT label) is inbound, so an older pass is not reused', () => {
    const bank = msg({ id: '18c2f4a9b3d21e01', internalDateMs: AT(0), senderAuth: ALL_PASS });
    const spoof = msg({ id: '18c2f4a9b3d21e02', internalDateMs: AT(5), from: `Me <${ACCOUNT}>`, fromAddress: ACCOUNT, labelIds: ['INBOX'] });
    expect(renderedSenderAuth(thread([bank, spoof]))).toEqual({ ...NO_SENDER_AUTH, message_id: '18c2f4a9b3d21e02', from: ACCOUNT });
  });

  test('an inbound message without the header renders none/null with its message_id', () => {
    const t = thread([msg({ id: '18c2f4a9b3d21e09' })]);
    expect(renderedSenderAuth(t)).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', dkim_domain: null, message_id: '18c2f4a9b3d21e09', from: 'charlie@example.com' });
  });

  test('a thread with no inbound message renders none/null, message_id and from null', () => {
    const t = thread([msg({ from: ACCOUNT, fromAddress: ACCOUNT, labelIds: ['SENT'] })]);
    expect(renderedSenderAuth(t)).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', dkim_domain: null, message_id: null, from: null });
  });

  test('the frontmatter keys come in the contract\'s order', () => {
    const page = renderThreadPage(thread([msg({ senderAuth: ALL_PASS })]));
    const line = page!.markdown.split('\n').find((l) => l.startsWith('sender_auth:'));
    expect(line).toBe('sender_auth: {"spf":"pass","dkim":"pass","dmarc":"pass","dkim_domain":"example.com","message_id":"18c2f4a9b3d21e01","from":"charlie@example.com"}');
  });
});

// ── getThread reads every copy of the header (fake Gmail) ────────────────────

class FakeVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();
  async get(id: string): Promise<CredentialEntry | null> { return this.entries.get(id) ?? null; }
  async put(entry: CredentialEntry): Promise<void> { this.entries.set(entry.id, entry); }
  async list(): Promise<CredentialMeta[]> { return []; }
  async delete(id: string): Promise<boolean> { return this.entries.delete(id); }
  async getClient(provider: string): Promise<ProviderClientRecord | null> { return this.clients.get(provider) ?? null; }
  async putClient(rec: ProviderClientRecord): Promise<void> { this.clients.set(rec.provider, rec); }
  async deleteClient(provider: string): Promise<boolean> { return this.clients.delete(provider); }
}

const CLIENT_ID = '123-abc.apps.googleusercontent.com';

function gmailFor(rawThread: unknown): GmailClient {
  const vault = new FakeVault();
  vault.entries.set(`google:${ACCOUNT}`, {
    id: `google:${ACCOUNT}`,
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: { access_token: 't', refresh_token: 'r', expiry: new Date(Date.now() + 3_600_000).toISOString() },
    meta: { account: ACCOUNT, connected_at: new Date().toISOString(), client_id: CLIENT_ID },
  });
  vault.clients.set('google', { provider: 'google', client_id: CLIENT_ID, client_secret: 'GOCSPX-test-secret-0000', created_at: new Date().toISOString() });
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl: FetchImpl = async (url) => {
    if (new URL(url).hostname === 'oauth2.googleapis.com') return respond({ access_token: 't2', expires_in: 3600 });
    return respond(rawThread);
  };
  return new GmailClient(new GoogleTokenProvider(vault, `google:${ACCOUNT}`, fetchImpl), fetchImpl, () => {}, CLIENT_ID);
}

describe('getThread stamps senderAuth from the message headers', () => {
  const rawThread = {
    id: '17aa6666cccc0000',
    messages: [
      {
        id: '18c2f4a9b3d21b01',
        threadId: '17aa6666cccc0000',
        labelIds: ['INBOX'],
        internalDate: String(AT(0)),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Delivered-To', value: ACCOUNT },
            { name: 'Authentication-Results', value: 'mx.google.com; spf=fail smtp.mailfrom=x@example.org; dmarc=fail header.from=bank.example.org' },
            { name: 'From', value: 'Bank <alerts@bank.example.org>' },
            { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=bank.example.org; spf=pass; dmarc=pass header.from=bank.example.org' },
            { name: 'Authentication-Results', value: 'mx.example.org; dkim=pass header.d=bank.example.org; spf=pass; dmarc=pass' },
          ],
          body: { data: Buffer.from('Verify your account.').toString('base64url') },
        },
      },
      {
        id: '18c2f4a9b3d21b02',
        threadId: '17aa6666cccc0000',
        labelIds: ['INBOX'],
        internalDate: String(AT(1)),
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Authentication-Results', value: GMAIL_AR }, { name: 'From', value: 'Charlie <charlie@example.com>' }],
          body: { data: Buffer.from('Hi.').toString('base64url') },
        },
      },
      {
        id: '18c2f4a9b3d21b03',
        threadId: '17aa6666cccc0000',
        labelIds: ['INBOX'],
        internalDate: String(AT(2)),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Dana <dana@example.com>' }], body: { data: '' } },
      },
    ],
  };

  for (const metadataOnly of [false, true]) {
    test(`topmost mx.google.com copy wins; a lower forged copy and a foreign authserv-id are ignored (metadataOnly=${metadataOnly})`, async () => {
      const t = await gmailFor(rawThread).getThread('17aa6666cccc0000', ACCOUNT, { metadataOnly });
      expect(t.messages.map((m) => m.senderAuth)).toEqual([
        { spf: 'fail', dkim: 'none', dmarc: 'fail', dkim_domain: null },
        ALL_PASS,
        NO_SENDER_AUTH,
      ]);
    });
  }
});
