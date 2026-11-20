/**
 * Fork: open_loops labels reply-owed machine mail by sender class
 * (src/core/ops/loops.ts + src/core/google/sender-class.ts) on PGLite.
 *
 * The label is read-time only: every loop stays open and retrievable, and
 * the call writes nothing. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';
import { LOOPS_MACHINE_SENDERS_CONFIG_KEY, LOOPS_PERSON_SENDERS_CONFIG_KEY } from '../src/core/google/sender-class.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.unsetConfig(LOOPS_MACHINE_SENDERS_CONFIG_KEY);
  await engine.unsetConfig(LOOPS_PERSON_SENDERS_CONFIG_KEY);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at)
     VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
  );
});

const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'g1',
    ...over,
  } as OperationContext;
}

let threadSeq = 0;
function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  const threadId = over.threadId ?? `18c2f4a9b3d2${String(++threadSeq).padStart(4, '0')}`;
  return {
    sourceId: 'g1',
    dedupKey: `thread:${threadId}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com',
    summary: 'Reply owed',
    evidence: [{ message_id: threadId, quote: 'q' }],
    threadId,
    detector: 'deterministic_thread',
    ...over,
  };
}

type View = { id: number; loop_type: string; counterparty_email: string | null; sender_class: string | null; label?: string };
type Group = { counterparty: string; counterparty_email: string | null; loop_count: number; loops: View[]; sender_class?: string | null };
interface Grouped {
  groups: Group[];
  no_counterparty: { loop_count: number; loops: View[] } | null;
  machine_mail: { loop_count: number; group_count: number; groups: Group[]; groups_omitted: number } | null;
  count: number;
  reply_owed_count: number;
  machine_mail_count: number | null;
  machine_mail_notice: string | null;
  text?: string;
}
interface Flat {
  loops: View[];
  count: number;
  reply_owed_count: number;
  machine_mail_count: number | null;
  machine_mail_notice: string | null;
}

async function seed(): Promise<void> {
  await upsertOpenLoop(engine, loop({ counterpartyEmail: 'alice@example.com', summary: 'Reply owed to alice' }));
  await upsertOpenLoop(engine, loop({ counterpartyEmail: 'receipts@shop.example', summary: 'Your receipt' }));
  await upsertOpenLoop(engine, loop({ counterpartyEmail: 'receipts@shop.example', summary: 'Another receipt' }));
  await upsertOpenLoop(engine, loop({ counterpartyEmail: 'no_reply@bank.example', summary: 'Statement ready' }));
  await upsertOpenLoop(engine, loop({ counterpartyEmail: 'postmaster@acct.example', summary: 'Your tax question' }));
  // A machine sender on a commitment loop: carries the class, keeps its place.
  await upsertOpenLoop(engine, loop({ dedupKey: 'commit:aaaaaaaa', loopType: 'commitment_owed_by_me', counterpartyEmail: 'billing@vendor.example',
    summary: 'Pay the invoice', detector: 'llm_extract', threadId: undefined }));
}

async function statuses(): Promise<Array<{ id: number; status: string; closed_by: string | null }>> {
  return engine.executeRaw(`SELECT id, status, closed_by FROM open_loops ORDER BY id`, []);
}

const allEmails = (gs: Group[]) => gs.map((g) => g.counterparty_email).sort();

describe('open_loops machine-mail label: grouped', () => {
  test('machine reply-owed loops move to machine_mail, out of the reply-owed groups and counts', async () => {
    await seed();
    const r = await openLoopsOp.handler(ctx(), { limit: 50 }) as Grouped;

    expect(allEmails(r.groups)).toEqual(['alice@example.com', 'billing@vendor.example']);
    expect(r.machine_mail).not.toBeNull();
    expect(allEmails(r.machine_mail!.groups)).toEqual(['no_reply@bank.example', 'postmaster@acct.example', 'receipts@shop.example']);
    expect(r.machine_mail!.loop_count).toBe(4);
    expect(r.machine_mail!.group_count).toBe(3);
    const receipts = r.machine_mail!.groups.find((g) => g.counterparty_email === 'receipts@shop.example')!;
    expect(receipts.sender_class).toBe('receipt');
    expect(receipts.loops.every((l) => l.label === 'machine_mail' && l.sender_class === 'receipt')).toBe(true);

    expect(r.machine_mail_count).toBe(4);
    expect(r.reply_owed_count).toBe(1);
    expect(r.count).toBe(6);
    expect(r.machine_mail_notice).toBeNull();
  });

  test('every loop carries sender_class; a person loop and a non-inbound machine loop are untouched', async () => {
    await seed();
    const r = await openLoopsOp.handler(ctx(), { limit: 50 }) as Grouped;
    const alice = r.groups.find((g) => g.counterparty_email === 'alice@example.com')!;
    expect(alice.loops[0]).toMatchObject({ sender_class: 'person', loop_type: 'unanswered_inbound' });
    expect(alice.loops[0]!.label).toBeUndefined();
    const vendor = r.groups.find((g) => g.counterparty_email === 'billing@vendor.example')!;
    expect(vendor.loops[0]).toMatchObject({ sender_class: 'receipt', loop_type: 'commitment_owed_by_me' });
    expect(vendor.loops[0]!.label).toBeUndefined();
  });

  test('loops.person_senders keeps a human on a postmaster@ address as reply owed', async () => {
    await seed();
    const before = await openLoopsOp.handler(ctx(), { limit: 50 }) as Grouped;
    // Without the override postmaster@ is GBrain's no_reply rule, so its reply-owed loop is machine mail.
    const where = (r: Grouped) => r.machine_mail?.groups.some((g) => g.counterparty_email === 'postmaster@acct.example') ? 'machine' : 'groups';
    await engine.setConfig(LOOPS_PERSON_SENDERS_CONFIG_KEY, 'postmaster@acct.example');
    const after = await openLoopsOp.handler(ctx(), { limit: 50 }) as Grouped;
    expect(where(after)).toBe('groups');
    const g = after.groups.find((x) => x.counterparty_email === 'postmaster@acct.example')!;
    expect(g.loops[0]).toMatchObject({ sender_class: 'person' });
    expect(g.loops[0]!.label).toBeUndefined();
    expect(where(before)).toBe('machine');
  });

  test('loops.machine_senders labels an operator-named sender', async () => {
    await seed();
    await engine.setConfig(LOOPS_MACHINE_SENDERS_CONFIG_KEY, '@example.com=alert');
    const r = await openLoopsOp.handler(ctx(), { limit: 50 }) as Grouped;
    const alice = r.machine_mail!.groups.find((g) => g.counterparty_email === 'alice@example.com')!;
    expect(alice.sender_class).toBe('alert');
    expect(r.groups.some((g) => g.counterparty_email === 'alice@example.com')).toBe(false);
  });

  test('the text digest lists machine mail under its own heading, not as waiting on you', async () => {
    await seed();
    const r = await openLoopsOp.handler(ctx(), { limit: 50, include_context: false }) as Grouped;
    const [owed, machine] = r.text!.split('## Machine mail — no reply owed');
    expect(machine).toBeDefined();
    expect(machine).toContain('receipts@shop.example [receipt] (2 open)');
    expect(owed).not.toContain('receipts@shop.example');
    expect(owed).toContain('2 people are waiting on you');
  });

  test('only machine mail open: no "You are clean", no people waiting', async () => {
    await upsertOpenLoop(engine, loop({ counterpartyEmail: 'alerts@ci.example' }));
    const r = await openLoopsOp.handler(ctx(), { include_context: false }) as Grouped;
    expect(r.groups).toEqual([]);
    expect(r.text).toContain('No person is waiting on you; the open loops are machine mail');
    expect(r.text).not.toContain('You are clean');
  });

  test("machine_mail 'inline' keeps them in their groups, labelled; 'only' returns just them", async () => {
    await seed();
    const inline = await openLoopsOp.handler(ctx(), { limit: 50, machine_mail: 'inline' }) as Grouped;
    expect(inline.machine_mail).toBeNull();
    const receipts = inline.groups.find((g) => g.counterparty_email === 'receipts@shop.example')!;
    expect(receipts.loops.every((l) => l.label === 'machine_mail')).toBe(true);
    expect(inline.reply_owed_count).toBe(1);

    const only = await openLoopsOp.handler(ctx(), { limit: 50, machine_mail: 'only' }) as Grouped;
    expect(only.groups).toEqual([]);
    expect(only.no_counterparty).toBeNull();
    expect(only.machine_mail!.loop_count).toBe(4);
    expect(only.count).toBe(4);
  });

  test('the call writes nothing: every status is unchanged', async () => {
    await seed();
    const before = await statuses();
    await openLoopsOp.handler(ctx(), { limit: 50 });
    await openLoopsOp.handler(ctx(), { group_by: 'none' });
    await openLoopsOp.handler(ctx(), { machine_mail: 'only' });
    expect(await statuses()).toEqual(before);
    expect(before.every((s) => s.status === 'open' && s.closed_by === null)).toBe(true);
  });

  test('a no-counterparty loop is unknown, never machine mail', async () => {
    await upsertOpenLoop(engine, loop({ counterpartyEmail: null as unknown as string }));
    const r = await openLoopsOp.handler(ctx(), {}) as Grouped;
    expect(r.no_counterparty!.loops[0]).toMatchObject({ sender_class: 'unknown' });
    expect(r.machine_mail).toBeNull();
    expect(r.reply_owed_count).toBe(1);
  });
});

describe('open_loops machine-mail label: flat', () => {
  test('machine loops stay in loops with the label; reply_owed_count excludes them', async () => {
    await seed();
    const r = await openLoopsOp.handler(ctx(), { group_by: 'none' }) as Flat;
    expect(r.loops).toHaveLength(6);
    expect(r.count).toBe(6);
    const labelled = r.loops.filter((l) => l.label === 'machine_mail').map((l) => l.counterparty_email).sort();
    expect(labelled).toEqual(['no_reply@bank.example', 'postmaster@acct.example', 'receipts@shop.example', 'receipts@shop.example']);
    expect(r.machine_mail_count).toBe(4);
    expect(r.reply_owed_count).toBe(1);
    expect(r.loops.every((l) => typeof l.sender_class === 'string')).toBe(true);
  });
});

describe('open_loops machine-mail label: unreadable config fails visible', () => {
  function brokenConfigCtx(): OperationContext {
    const broken = new Proxy(engine, {
      get(target, prop, recv) {
        if (prop === 'getConfig') return async () => { throw new Error('config store unreachable'); };
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return ctx({ engine: broken as unknown as PGLiteEngine });
  }

  test('grouped: a notice, every loop returned as today, no label and no machine section', async () => {
    await seed();
    const r = await openLoopsOp.handler(brokenConfigCtx(), { limit: 50, include_context: false }) as Grouped;
    expect(r.machine_mail_notice).toContain('could not be labelled');
    expect(r.machine_mail).toBeNull();
    expect(r.machine_mail_count).toBeNull();
    expect(r.groups.flatMap((g) => g.loops)).toHaveLength(6);
    expect(r.groups.flatMap((g) => g.loops).every((l) => l.sender_class === null && l.label === undefined)).toBe(true);
    expect(r.reply_owed_count).toBe(5);
    expect(r.text).toContain('Machine mail could not be labelled');
  });

  test('a malformed config entry fails the same visible way', async () => {
    await seed();
    await engine.setConfig(LOOPS_PERSON_SENDERS_CONFIG_KEY, 'not an address');
    const r = await openLoopsOp.handler(ctx(), { group_by: 'none' }) as Flat;
    expect(r.machine_mail_notice).toContain('"not an address"');
    expect(r.machine_mail_count).toBeNull();
    expect(r.loops.every((l) => l.sender_class === null)).toBe(true);
  });

  test("machine_mail 'only' refuses rather than answering an empty list", async () => {
    await seed();
    await expect(openLoopsOp.handler(brokenConfigCtx(), { machine_mail: 'only' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('an unknown machine_mail value is refused', async () => {
    await expect(openLoopsOp.handler(ctx(), { machine_mail: 'hide' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
