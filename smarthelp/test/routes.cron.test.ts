import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { GET as cron } from '@/app/api/cron/reconcile-payments/route';

/**
 * The reconciliation cron — the phase's only cron (§25.11).
 *
 * These tests are about four things:
 *
 *   1. **The guard fails closed.** No `CRON_SECRET` is a 503, not a silent
 *      skip-the-check; a wrong value is a 401 on any channel; the right value
 *      is accepted on all three channels with the reference's precedence
 *      (bearer, then `x-cron-secret`, then `?secret=`).
 *   2. **One writer.** A gateway order in `paid` produces exactly one
 *      `confirm_booking_payment` call (the webhook's RPC) with the row's own
 *      ids — and the booking is never updated directly, so the two writers can
 *      only ever agree.
 *   3. **A bad gateway answer writes nothing.** A rejected fetch is counted
 *      `unreachable`, left to the next pass, and alerted on; a still-pending
 *      order counts `stillPending` without writing a single row.
 *   4. **Only two conditions alert.** `unreachable` fires, and `stillPending`
 *      fires only past the 60-minute threshold — a customer who simply has not
 *      paid at 30 minutes counts without raising an alert.
 *
 * The gateway is stubbed through `vi.stubGlobal('fetch', …)`: the route builds
 * its client with the default transport at request time, so the seam the
 * client library exposes is the global fetch, and that is what is pointed at a
 * fake. No fixture holds a real key, and no test performs a network call.
 */

const CRON_SECRET = 'test-cron-secret-0123456789';
const PAYMENT_ID = '77777777-7777-4777-8777-777777777777';
const BOOKING_ID = 'abababab-1111-4111-8111-abababababab';
const ORDER_ID = 'order_TEST123';

let fake: FakeSupabase;
let tables: Record<string, (call: RecordedCall) => { data: any; error: any }>;
let rpcs: Record<string, (call: RecordedCall) => { data: any; error: any }>;
let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: 'dddddddd-1111-4111-8111-dddddddddddd',
    purpose: 'booking',
    amount: '613.60',
    currency: 'INR',
    gateway: 'razorpay',
    gateway_order_id: ORDER_ID,
    gateway_payment_id: null,
    gateway_signature: null,
    status: 'created',
    method: null,
    refundable_amount: '0.00',
    failure_reason: null,
    idempotency_key: 'idem-key-payment-0001',
    captured_at: null,
    created_at: minutesAgoIso(20),
    updated_at: minutesAgoIso(20),
    ...overrides,
  };
}

interface Prime {
  payments?: Record<string, unknown>[];
  bookings?: Record<string, unknown>[];
}

function prime(over: Prime = {}) {
  tables.payments = (_call: RecordedCall) => ({ data: over.payments ?? [], error: null });
  tables.bookings = (_call: RecordedCall) => ({
    data: over.bookings ?? [{ id: BOOKING_ID, status: 'payment_pending' }],
    error: null,
  });
}

function gatewayOrder(status: string): Response {
  return new Response(JSON.stringify({ id: ORDER_ID, entity: 'order', status }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function req(query = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/cron/reconcile-payments${query}`, { headers });
}

async function bodyOf(res: Response) {
  return res.json();
}

/** `ok()` wraps its payload as `{ success: true, data: { … } }`. */
async function dataOf(res: Response) {
  return (await bodyOf(res)).data;
}

describe('the reconciliation cron', () => {
  beforeEach(() => {
    fake = new FakeSupabase({}, {});
    tables = {};
    rpcs = {
      confirm_booking_payment: (call: RecordedCall) => ({
        data: [{ ...payment(), ...(call.args as Record<string, unknown>) }],
        error: null,
      }),
      write_audit: () => ({ data: null, error: null }),
    };
    fake = new FakeSupabase(tables, rpcs);
    vi.stubEnv('CRON_SECRET', CRON_SECRET);
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_key');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-key-secret');
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prime({ payments: [payment()] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  it('fails closed: no CRON_SECRET is a 503 with zero database calls', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await cron(req());
    expect(res.status).toBe(503);
    expect((await bodyOf(res)).code).toBe('SERVICE_UNAVAILABLE');
    expect(fake.calls).toHaveLength(0);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('answers 401 on a wrong secret, before touching the gateway', async () => {
    const res = await cron(req('', { authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBe('UNAUTHENTICATED');
    expect(fake.calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts all three channels in precedence order', async () => {
    const bearer = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(bearer.status).toBe(200);
    const header = await cron(req('', { 'x-cron-secret': CRON_SECRET }));
    expect(header.status).toBe(200);
    const query = await cron(req(`?secret=${CRON_SECRET}`));
    expect(query.status).toBe(200);
  });

  it('keeps precedence: a wrong bearer blocks a right query secret', async () => {
    const res = await cron(req(`?secret=${CRON_SECRET}`, { authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
  });

  it('answers a zero pass when nothing is waiting', async () => {
    prime({ payments: [] });
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 0,
      stillPending: 0,
      unreachable: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a paid order through confirm_booking_payment and never touches the booking', async () => {
    fetchMock.mockResolvedValue(gatewayOrder('paid'));
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({
      resolved: 1,
      failed: 0,
      stillPending: 0,
      unreachable: 0,
    });

    const confirms = fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.args).toMatchObject({
      p_payment_id: PAYMENT_ID,
      p_gateway_order_id: ORDER_ID,
      p_booking_id: BOOKING_ID,
      p_gateway_payment_id: null,
      p_gateway_signature: null,
    });
    const note = confirms[0]!.args.p_note as string;
    expect(note).toContain('reconciled');
    expect(note).toContain(ORDER_ID);

    // The booking row is read but never written by this pass.
    expect(fake.writesTo('bookings')).toHaveLength(0);
    // The payment row was confirmed through the RPC, not updated directly.
    expect(fake.writesTo('payments')).toHaveLength(0);

    const reconciled = fake.rpcCalls.filter((c) => c.fn === 'write_audit');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.args.p_action).toBe('payment.reconciled');
    expect(reconciled[0]!.args.p_entity_id).toBe(PAYMENT_ID);
  });

  it('treats a still-created order as still pending: counted, zero writes, no alert inside 60 minutes', async () => {
    fetchMock.mockResolvedValue(gatewayOrder('created'));
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 0,
      stillPending: 1,
      unreachable: 0,
    });
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(fake.rpcCalls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('treats a partially-paid order as still pending too', async () => {
    prime({ payments: [payment({ status: 'pending', gateway_order_id: 'order_PARTIAL' })] });
    fetchMock.mockResolvedValue(gatewayOrder('partially_paid'));
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 0,
      stillPending: 1,
      unreachable: 0,
    });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('never writes on an unreachable gateway: counted, alerted, left for the next pass', async () => {
    const row = payment();
    prime({ payments: [row] });
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 0,
      stillPending: 0,
      unreachable: 1,
    });
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fake.writesTo('bookings')).toHaveLength(0);

    const alerts = fake.rpcCalls.filter((c) => c.fn === 'write_audit');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.args.p_action).toBe('payment.reconcile.alert');
    expect(alerts[0]!.args.p_metadata).toMatchObject({
      condition: 'unreachable',
      count: 1,
      oldest: row.created_at,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('fails an expired order without touching the booking, so the customer can pay again', async () => {
    fetchMock.mockResolvedValue(gatewayOrder('expired'));
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 1,
      stillPending: 0,
      unreachable: 0,
    });

    const updates = fake.writesTo('payments');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ status: 'failed' });
    const payload = updates[0]!.payload as Record<string, unknown>;
    expect(String(payload.failure_reason)).toContain('expired');
    const filters = updates[0]!.filters as [string, unknown][];
    expect(filters).toContainEqual(['id', PAYMENT_ID]);
    expect(filters).toContainEqual(['status', ['created', 'pending']]);
    expect(fake.writesTo('bookings')).toHaveLength(0);

    const audits = fake.rpcCalls.filter((c) => c.fn === 'write_audit');
    expect(audits[0]!.args.p_action).toBe('payment.failed');
  });

  it('skips a payment whose booking is no longer waiting for payment', async () => {
    prime({ bookings: [{ id: BOOKING_ID, status: 'cancelled' }] });
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 0,
      stillPending: 0,
      unreachable: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('alerts on a stillPending payment older than the 60-minute stale threshold', async () => {
    const stale = minutesAgoIso(90);
    prime({ payments: [payment({ created_at: stale, updated_at: stale })] });
    fetchMock.mockResolvedValue(gatewayOrder('created'));
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 0,
      failed: 0,
      stillPending: 1,
      unreachable: 0,
    });

    const alerts = fake.rpcCalls.filter((c) => c.fn === 'write_audit');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.args.p_action).toBe('payment.reconcile.alert');
    expect(alerts[0]!.args.p_metadata).toEqual({
      condition: 'stillPending',
      count: 1,
      oldest: stale,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves a mixed pass correctly: paid confirmed, created counted, nothing else written', async () => {
    prime({
      payments: [
        payment(),
        payment({
          id: '88888888-8888-4888-8888-888888888888',
          gateway_order_id: 'order_STILLWARM',
          created_at: minutesAgoIso(25),
          updated_at: minutesAgoIso(25),
        }),
      ],
      bookings: [
        { id: BOOKING_ID, status: 'payment_pending' },
        { id: 'cccccccc-2222-4222-8222-cccccccccccc', status: 'payment_pending' },
      ],
    });
    fetchMock.mockImplementation(async (url: string | URL) =>
      String(url).includes('order_STILLWARM') ? gatewayOrder('attempted') : gatewayOrder('paid')
    );
    const res = await cron(req('', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(await dataOf(res)).toEqual({
      resolved: 1,
      failed: 0,
      stillPending: 1,
      unreachable: 0,
    });
    expect(fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment')).toHaveLength(1);
    expect(fake.rpcCalls.filter((c) => c.fn === 'write_audit')).toHaveLength(1);
  });
});