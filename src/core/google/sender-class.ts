/**
 * sender-class — what kind of sender an address is, from the ADDRESS ALONE
 * (fork patch: the machine-mail label on open_loops).
 *
 * A reply-owed loop whose counterparty is a machine (a receipt, a sign-in
 * code, a monitoring alert, a no-reply sender) owes nobody a reply. Loops
 * opened before the automated-mail rule (#5012), or from addresses that rule
 * does not match, still read as "reply owed". open_loops labels them at READ
 * time with this classifier; nothing is written, closed or muted.
 *
 * Rules, in order (first match wins):
 *   1. `loops.person_senders` (operator data): an exact address or `@domain`
 *      is always `person`. It wins over every other rule, so a human who
 *      writes from a `postmaster@` or `billing@` address is never machine mail.
 *   2. `loops.machine_senders` (operator data): an exact address, then an
 *      `@domain`, each with an optional `=class` (default `machine`).
 *   3. GBrain's own automated-mail rule (`isNoiseSender`) → `no_reply`.
 *   4. Generic local-part classes, matched as WHOLE tokens of the local part
 *      (split on `.`, `-`, `_`, `+`), never as substrings, so
 *      `alice.billingsley@` stays a person:
 *        sign_in  verify, verification, security, login, signin, sign-in,
 *                 2fa, mfa, otp, passcode, auth
 *        receipt  receipt(s), billing, invoice(s), order(s), payment(s),
 *                 purchase(s)
 *        alert    alert(s), alerting, monitor, monitoring, health,
 *                 healthcheck, status, uptime
 *   5. Anything else → `person`.
 *
 * No subject or body content is ever consulted, and no operator- or
 * company-specific address lives in source: those are config.
 */
import type { BrainEngine } from '../engine.ts';
import { isNoiseSender } from './google-render.ts';

export const LOOPS_MACHINE_SENDERS_CONFIG_KEY = 'loops.machine_senders';
export const LOOPS_PERSON_SENDERS_CONFIG_KEY = 'loops.person_senders';

export const MACHINE_SENDER_CLASSES = ['no_reply', 'sign_in', 'receipt', 'alert', 'machine'] as const;
export type MachineSenderClass = (typeof MACHINE_SENDER_CLASSES)[number];
/** `unknown`: the loop names no counterparty address; never machine. */
export type SenderClass = 'person' | 'unknown' | MachineSenderClass;

export function isMachineSenderClass(c: SenderClass | null | undefined): c is MachineSenderClass {
  return c !== null && c !== undefined && c !== 'person' && c !== 'unknown';
}

export interface SenderClassPolicy {
  /** Exact addresses and `@domain` entries (lowercased) that are always `person`. */
  personAddresses: ReadonlySet<string>;
  personDomains: ReadonlySet<string>;
  /** Exact address / domain → machine class. */
  machineAddresses: ReadonlyMap<string, MachineSenderClass>;
  machineDomains: ReadonlyMap<string, MachineSenderClass>;
}

export const EMPTY_SENDER_POLICY: SenderClassPolicy = Object.freeze({
  personAddresses: new Set<string>(),
  personDomains: new Set<string>(),
  machineAddresses: new Map<string, MachineSenderClass>(),
  machineDomains: new Map<string, MachineSenderClass>(),
});

const TOKEN_CLASSES: ReadonlyArray<readonly [Exclude<MachineSenderClass, 'no_reply' | 'machine'>, ReadonlySet<string>]> = [
  ['sign_in', new Set(['verify', 'verification', 'security', 'login', 'signin', '2fa', 'mfa', 'otp', 'passcode', 'auth'])],
  ['receipt', new Set(['receipt', 'receipts', 'billing', 'invoice', 'invoices', 'order', 'orders', 'payment', 'payments', 'purchase', 'purchases'])],
  ['alert', new Set(['alert', 'alerts', 'alerting', 'monitor', 'monitoring', 'health', 'healthcheck', 'status', 'uptime'])],
];

/** Two-token spellings (`sign-in`, `sign.in`) folded into one token before matching. */
const JOINED_TOKENS: ReadonlyArray<readonly [string, string, string]> = [['sign', 'in', 'signin']];

function localTokens(local: string): string[] {
  const parts = local.split(/[-._+]/).filter((t) => t.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const joined = JOINED_TOKENS.find(([a, b]) => parts[i] === a && parts[i + 1] === b);
    if (joined) { out.push(joined[2]); i++; continue; }
    out.push(parts[i]!);
  }
  return out;
}

/** Splits `local@domain`; null when the value is not one address. */
function splitAddress(address: string): { address: string; local: string; domain: string } | null {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at <= 0 || at === a.length - 1 || /\s/.test(a)) return null;
  return { address: a, local: a.slice(0, at), domain: a.slice(at + 1) };
}

/** The class of one sender address under `policy`. A null or malformed address is `unknown`, never machine. */
export function classifySender(address: string | null | undefined, policy: SenderClassPolicy = EMPTY_SENDER_POLICY): SenderClass {
  if (address === null || address === undefined) return 'unknown';
  const parts = splitAddress(address);
  if (!parts) return 'unknown';
  if (policy.personAddresses.has(parts.address) || policy.personDomains.has(parts.domain)) return 'person';
  const configured = policy.machineAddresses.get(parts.address) ?? policy.machineDomains.get(parts.domain);
  if (configured) return configured;
  if (isNoiseSender(parts.address)) return 'no_reply';
  const tokens = localTokens(parts.local);
  for (const [cls, words] of TOKEN_CLASSES) if (tokens.some((t) => words.has(t))) return cls;
  return 'person';
}

/** A config value that could not be turned into a policy; the label is then not computed. */
export class SenderPolicyError extends Error {}

function entries(raw: string | null): string[] {
  if (raw === null) return [];
  return raw.split(/[,\n]/).map((t) => t.trim()).filter((t) => t.length > 0);
}

/** `address` or `@domain`, lowercased; throws on anything else. */
function target(token: string, key: string): { kind: 'address' | 'domain'; value: string } {
  const t = token.toLowerCase();
  if (/^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return { kind: 'domain', value: t.slice(1) };
  if (/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return { kind: 'address', value: t };
  throw new SenderPolicyError(`${key}: "${token}" is not an address or @domain`);
}

/** Builds the policy from the two raw config values; throws SenderPolicyError on a malformed entry. */
export function parseSenderPolicy(machineRaw: string | null, personRaw: string | null): SenderClassPolicy {
  const personAddresses = new Set<string>();
  const personDomains = new Set<string>();
  for (const token of entries(personRaw)) {
    const t = target(token, LOOPS_PERSON_SENDERS_CONFIG_KEY);
    (t.kind === 'domain' ? personDomains : personAddresses).add(t.value);
  }
  const machineAddresses = new Map<string, MachineSenderClass>();
  const machineDomains = new Map<string, MachineSenderClass>();
  for (const token of entries(machineRaw)) {
    const eq = token.indexOf('=');
    const who = eq === -1 ? token : token.slice(0, eq).trim();
    const cls = eq === -1 ? 'machine' : token.slice(eq + 1).trim().toLowerCase();
    if (!(MACHINE_SENDER_CLASSES as readonly string[]).includes(cls)) {
      throw new SenderPolicyError(`${LOOPS_MACHINE_SENDERS_CONFIG_KEY}: "${token}" names class "${cls}"; use one of ${MACHINE_SENDER_CLASSES.join(', ')}`);
    }
    const t = target(who, LOOPS_MACHINE_SENDERS_CONFIG_KEY);
    (t.kind === 'domain' ? machineDomains : machineAddresses).set(t.value, cls as MachineSenderClass);
  }
  return { personAddresses, personDomains, machineAddresses, machineDomains };
}

export type SenderPolicyLoad = { ok: true; policy: SenderClassPolicy } | { ok: false; reason: string };

/**
 * Reads both keys from brain config. Fails visible: an unreadable config or
 * a malformed entry answers `ok: false` with the reason, never a policy that
 * would silently call every sender a person (or a machine).
 */
export async function loadSenderPolicy(engine: Pick<BrainEngine, 'getConfig'>): Promise<SenderPolicyLoad> {
  try {
    const [machineRaw, personRaw] = await Promise.all([
      engine.getConfig(LOOPS_MACHINE_SENDERS_CONFIG_KEY),
      engine.getConfig(LOOPS_PERSON_SENDERS_CONFIG_KEY),
    ]);
    return { ok: true, policy: parseSenderPolicy(machineRaw, personRaw) };
  } catch (e) {
    if (e instanceof SenderPolicyError) return { ok: false, reason: e.message };
    return { ok: false, reason: `brain config could not be read (${LOOPS_MACHINE_SENDERS_CONFIG_KEY}, ${LOOPS_PERSON_SENDERS_CONFIG_KEY})` };
  }
}
