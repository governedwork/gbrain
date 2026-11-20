/**
 * Fork: the address-only sender classifier behind open_loops' machine-mail
 * label (src/core/google/sender-class.ts). Synthetic addresses only.
 */
import { describe, expect, test } from 'bun:test';

import {
  classifySender,
  loadSenderPolicy,
  LOOPS_MACHINE_SENDERS_CONFIG_KEY,
  LOOPS_PERSON_SENDERS_CONFIG_KEY,
  parseSenderPolicy,
  SenderPolicyError,
} from '../src/core/google/sender-class.ts';

function table(rows: Array<[string, string]>, policy = parseSenderPolicy(null, null)): void {
  for (const [address, cls] of rows) expect([address, classifySender(address, policy)]).toEqual([address, cls]);
}

describe('classifySender: built-in classes', () => {
  test('no_reply reuses GBrain\'s automated-mail rule (isNoiseSender)', () => {
    table([
      ['noreply@example.com', 'no_reply'], ['no-reply@example.com', 'no_reply'], ['donotreply@example.com', 'no_reply'],
      ['notifications@example.com', 'no_reply'], ['mailer-daemon@example.com', 'no_reply'], ['postmaster@example.com', 'no_reply'],
      ['gemini-notes@google.com', 'no_reply'],
    ]);
  });

  test('no_reply covers the upstream #7856 separator and localized spellings', () => {
    table([
      ['no_reply@example.com', 'no_reply'], ['no.reply@example.com', 'no_reply'], ['do_not_reply@example.com', 'no_reply'],
      ['noresponder@example.com', 'no_reply'], ['notificaciones@example.com', 'no_reply'], ['notificacoes@example.com', 'no_reply'],
      ['ne-pas-repondre@example.com', 'no_reply'], ['keine-antwort@example.com', 'no_reply'],
    ]);
  });

  test('sign_in: verification, security and login-code senders', () => {
    table([
      ['verify@example.com', 'sign_in'], ['verification@example.com', 'sign_in'], ['security@example.com', 'sign_in'],
      ['account-security@example.com', 'sign_in'], ['login@example.com', 'sign_in'], ['signin@example.com', 'sign_in'],
      ['sign-in@example.com', 'sign_in'], ['sign.in@example.com', 'sign_in'], ['2fa@example.com', 'sign_in'],
      ['otp@example.com', 'sign_in'], ['auth@example.com', 'sign_in'],
    ]);
  });

  test('receipt: receipts, billing, invoices, orders, payments', () => {
    table([
      ['receipts@example.com', 'receipt'], ['receipt@example.com', 'receipt'], ['billing@example.com', 'receipt'],
      ['invoice@example.com', 'receipt'], ['invoices+eu@example.com', 'receipt'], ['orders@example.com', 'receipt'],
      ['order-update@example.com', 'receipt'], ['payments@example.com', 'receipt'], ['billing.team@example.com', 'receipt'],
    ]);
  });

  test('alert: alerts, monitoring, health, status', () => {
    table([
      ['alerts@example.com', 'alert'], ['alert@example.com', 'alert'], ['monitoring@example.com', 'alert'],
      ['health@example.com', 'alert'], ['status@example.com', 'alert'], ['uptime-monitor@example.com', 'alert'],
    ]);
  });

  test('lookalikes stay person: whole tokens only, never substrings', () => {
    table([
      ['alice@example.com', 'person'], ['alice.billingsley@example.com', 'person'], ['orderly.jones@example.com', 'person'],
      ['statusquo@example.com', 'person'], ['alerton@example.com', 'person'], ['securitas.anna@example.com', 'person'],
      ['healthy.bob@example.com', 'person'], ['receiptor@example.com', 'person'], ['loginova@example.com', 'person'],
      ['author@example.com', 'person'], ['bob@billing.example.com', 'person'], ['carol@alerts.example.com', 'person'],
      ['noah@example.com', 'person'], ['nora.reply@example.com', 'person'],
    ]);
  });

  test('a null or malformed counterparty is unknown, never machine', () => {
    expect(classifySender(null)).toBe('unknown');
    expect(classifySender(undefined)).toBe('unknown');
    expect(classifySender('noreply')).toBe('unknown');
    expect(classifySender('')).toBe('unknown');
  });

  test('case does not matter', () => {
    table([['NoReply@Example.COM', 'no_reply'], ['BILLING@EXAMPLE.COM', 'receipt']]);
  });
});

describe('classifySender: operator config', () => {
  test('loops.person_senders wins over every rule (address and @domain)', () => {
    const policy = parseSenderPolicy('postmaster@acct.example, @alerts.example=alert', 'postmaster@acct.example, @alerts.example, billing@example.com');
    table([
      ['postmaster@acct.example', 'person'],
      ['ops@alerts.example', 'person'],
      ['billing@example.com', 'person'],
      ['postmaster@other.example', 'no_reply'],
      ['billing@other.example', 'receipt'],
    ], policy);
  });

  test('loops.machine_senders: address beats @domain, class defaults to machine', () => {
    const policy = parseSenderPolicy('robot@shop.example=receipt, @shop.example, @ci.example=alert, ping@example.com', null);
    table([
      ['robot@shop.example', 'receipt'],
      ['anyone@shop.example', 'machine'],
      ['builds@ci.example', 'alert'],
      ['ping@example.com', 'machine'],
      ['dana@sub.shop.example', 'person'],
      ['erin@example.com', 'person'],
    ], policy);
  });

  test('a configured machine class overrides the built-in class', () => {
    table([['noreply@example.com', 'sign_in']], parseSenderPolicy('noreply@example.com=sign_in', null));
  });

  test('a malformed entry or unknown class is refused, never half-applied', () => {
    expect(() => parseSenderPolicy('not-an-address', null)).toThrow(SenderPolicyError);
    expect(() => parseSenderPolicy('robot@example.com=spam', null)).toThrow(SenderPolicyError);
    expect(() => parseSenderPolicy(null, '@')).toThrow(SenderPolicyError);
    expect(() => parseSenderPolicy(null, 'alice@example.com=person')).toThrow(SenderPolicyError);
  });
});

describe('loadSenderPolicy', () => {
  test('reads both keys from brain config', async () => {
    const values: Record<string, string> = {
      [LOOPS_MACHINE_SENDERS_CONFIG_KEY]: '@shop.example=receipt',
      [LOOPS_PERSON_SENDERS_CONFIG_KEY]: 'postmaster@acct.example',
    };
    const load = await loadSenderPolicy({ getConfig: async (k: string) => values[k] ?? null });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(classifySender('postmaster@acct.example', load.policy)).toBe('person');
    expect(classifySender('x@shop.example', load.policy)).toBe('receipt');
  });

  test('an unreadable config fails visible, not as an all-person or all-machine policy', async () => {
    const load = await loadSenderPolicy({ getConfig: async () => { throw new Error('boom'); } });
    expect(load).toEqual({ ok: false, reason: expect.stringContaining('could not be read') });
  });

  test('a malformed entry fails visible and names the entry', async () => {
    const load = await loadSenderPolicy({ getConfig: async (k: string) => (k === LOOPS_PERSON_SENDERS_CONFIG_KEY ? 'alice' : null) });
    expect(load).toEqual({ ok: false, reason: expect.stringContaining('"alice"') });
  });
});
