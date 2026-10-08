import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { POST as requestRefund, GET as listRefunds } from '@/app/api/refunds/route';
import { POST as cancelBooking } from '@/app/api/bookings/[id]/cancel/route';
import { POST as webhook } from '@/app/api/webhooks/razorpay/route';

/**
 * The refund routes (§12.3, §25.10) and the two ways money goes back.
 *
 * Six facts these tests exist to keep true:
 *
 *   1. **The capability is the only gate.** A caller without `refund.request`
 *      is refused before anything is read or written.
 *   2. **₹1500 is the line.** At or below it a support agent's request executes;
 *      one paisa above it the row is created `requested` and *not* executed —
 *      that is what makes the check meaningful.
 *   3. **Route follows the payment.** A gateway-captured payment refunds through
 *      the gateway; one with no gateway id refunds to the wallet.
 *   4. **A definitive refusal is answered with money, not nothing.** §12.3's
 *      wallet fallback credits the same amount and opens an ops ticket.
 *   5. **Cancelling a paid booking refunds the refundable part.** The fee stays
 *      with the platform; the rest goes back, exactly once.
 *   6. **Nothing signed reaches the audit trail.** `gateway_signature` never
 *      appears in a recorded metadata object.
 *
 * The transport is `globalThis.fetch` with a stub: no test here performs a
 * network call (`T-03-SC`).
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'test-token';
const CUSTOMER_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const OTHER_CUSTOMER_ID = 'cccccccc-2222-4222-8222-cccccccccccc';
const BOOKING_ID = 'abababab-1111-4111-8111-abababababab';
const PAYMENT_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const REFUND_ID = '00000000-0000-4000-8000-0000000000aa';
const WALLET_ID = '00000000-0000-4000-8000-0000000000bb';
const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

let fake: FakeSupabase;
let tables: Record<string, (call: RecordedCall) => { data: any; error: any }>;
let rpcs: Record<string, (call: RecordedCall) => { data: any; error: any }>;
let refundRecord: Record<string, unknown> | null;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const fetchMock = vi.fn();
let savedEnv: Record<string, string | undefined>;

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: CUSTOMER_ID,
    amount: '2000.00',
    refundable_amount: '2000.00',
    currency: 'INR',
    gateway: 'razorpay',
    gateway_order_id: 'order_TEST123',
    gateway_payment_id: null,
    status: 'success',
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20261007-00001',
    customer_id: CUSTOMER_ID,
    status: 'paid',
    total_amount: '2000.00',
    currency: 'INR',
    version: 2,
    scheduled_start_at: null,
    arrived_at: null,
    cancellation_fee: '0.00',
    cancellation_reason_code: null,
    ...overrides,
  };
}

function refundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: CUSTOMER_ID,
    amount: '500.00',
    currency: 'INR',
    status: 'requested',
    route: 'gateway',
    reason_code: 'customer_request',
    note: null,
    gateway_refund_id: null,
    requested_by: USER_ID,
    processed_by: null,
    approved_by: null,
    requested_at: '2026-10-07T00:00:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

interface Prime {
  role?: string;
  payment?: Record<string, unknown>;
  booking?: Record<string, unknown>;
  refunds?: Record<string, unknown>[];
  cancelResult?: Record<string, unknown> | null;
  completeResult?: Record<string, unknown> | null;
}

function prime(over: Prime = {}) {
  refundRecord = null;

  tables = {
    profiles: () => ({
      data: [{ id: USER_ID, role: over.role ?? 'support', status: 'active' }],
      error: null,
    }),
    customers: () => ({ data: [{ id: CUSTOMER_ID, profile_id: USER_ID }], error: null }),
    bookings: () => ({ data: [booking(over.booking)], error: null }),
    payments: () => ({ data: [payment(over.payment)], error: null }),
    refunds: (call) => {
      if (call.op === 'update') return { data: [refundRow()], error: null };
      return { data: over.refunds ?? [], error: null };
    },
  };

  rpcs = {
    record_booking_refund: (call) => {
      // The row `record_booking_refund()` would have written, so a later
      // completion can be observed as "the same row, completed".
      refundRecord = refundRow({
        amount: String(call.args!.p_amount),
        status: 'requested',
        route: call.args!.p_route,
        reason_code: call.args!.p_reason_code,
        requested_by: call.args!.p_requested_by,
      });
      return { data: refundRecord, error: null };
    },
    complete_booking_refund: (call) => {
      const row = {
        ...(refundRecord ?? refundRow()),
        status: 'completed',
        route: call.args!.p_route,
        gateway_refund_id: call.args!.p_gateway_refund_id,
        completed_at: '2026-10-07T00:00:05.000Z',
      };
      return { data: over.completeResult === undefined ? row : over.completeResult, error: null };
    },
    get_or_create_wallet: () => ({ data: WALLET_ID, error: null }),
    apply_wallet_delta: () => ({ data: 500, error: null }),
    write_audit: () => ({ data: null, error: null }),
    cancel_booking: (call) => ({
      data:
        over.cancelResult === undefined
          ? {
              ...booking(over.booking),
              status: 'cancelled',
              version: 3,
              cancellation_fee: Number(call.args!.p_fee ?? 0).toFixed(2),
              cancellation_reason_code: call.args!.p_reason_code,
            }
          : over.cancelResult,
      error: null,
    }),
  };

  fake = new FakeSupabase(tables as any, rpcs as any);
}

function refundReq(body: unknown): Request {
  return new Request('http://localhost/api/refunds', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function listReq(query = '', token: string | null = TOKEN): Request {
  return new Request(`http://localhost/api/refunds${query}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function cancelReq(): NextRequest {
  return new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reasonCode: 'changed_mind' }),
  });
}

const call = (fn: string) => fake.rpcCalls.filter((c) => c.fn === fn);
const audits = () => call('write_audit').map((c) => c.args.p_action);
const auditMeta = () =>
  JSON.stringify(call('write_audit').map((c) => c.args.p_metadata)).toLowerCase();

function gatewayRefund(id = 'rfnd_TEST123') {
  return new Response(JSON.stringify({ id, entity: 'refund', status: 'processed' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function gatewayRefusal(message = 'The refund could not be processed.') {
  return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  prime();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(gatewayRefund());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', WEBHOOK_SECRET);

  savedEnv = {
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  };
  vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_1234567890');
  vi.stubEnv('RAZORPAY_KEY_SECRET', 'secret_test_abcdef');
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(savedEnv ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('POST /api/refunds', () => {
  it('refuses a caller without refund.request, writing nothing', async () => {
    prime({ role: 'customer' });

    const res = await requestRefund(refundReq({ paymentId: PAYMENT_ID, amount: 100 }));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
    expect(fake.writesTo('refunds')).toHaveLength(0);
    expect(call('record_booking_refund')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a refund larger than the payment can still cover', async () => {
    prime({ payment: { refundable_amount: '100.00' } });

    const res = await requestRefund(refundReq({ paymentId: PAYMENT_ID, amount: 500 }));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(call('record_booking_refund')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('executes a refund at exactly the ₹1500 limit', async () => {
    prime();

    const res = await requestRefund(
      refundReq({ paymentId: PAYMENT_ID, amount: 1500, reasonCode: 'goodwill' })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.refund.status).toBe('completed');
    expect(body.data.refund.amount).toBe(1500);

    const record = call('record_booking_refund');
    expect(record).toHaveLength(1);
    // Rupees in, paise in the arithmetic, a numeric literal to Postgres.
    expect(record[0].args.p_amount).toBe('1500.00');
    expect(record[0].args.p_requested_by).toBe(USER_ID);
    // The payment has no gateway id, so the money goes to the wallet.
    expect(record[0].args.p_route).toBe('wallet');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates but does not execute a refund one paisa over the limit', async () => {
    prime();

    const res = await requestRefund(refundReq({ paymentId: PAYMENT_ID, amount: 1500.01 }));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.refund.status).toBe('requested');
    expect(body.data.heldForApproval).toBe(true);

    // The above-limit path never touches the money-moving functions.
    expect(call('record_booking_refund')).toHaveLength(0);
    expect(call('complete_booking_refund')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const insert = fake.writesTo('refunds')[0];
    expect((insert.payload as Record<string, unknown>).status).toBe('requested');
    expect((insert.payload as Record<string, unknown>).amount).toBe('1500.01');
  });

  it('refunds a gateway-captured payment through the gateway', async () => {
    prime({ payment: { gateway_payment_id: 'pay_TEST123' } });

    const res = await requestRefund(refundReq({ paymentId: PAYMENT_ID, amount: 500 }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.refund.status).toBe('completed');
    expect(body.data.refund.route).toBe('gateway');
    expect(body.data.refund.gatewayRefundId).toBe('rfnd_TEST123');

    // The gateway was asked for an integer in paise, against the payment id.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/payments/pay_TEST123/refunds');
    expect(JSON.parse((init as RequestInit).body as string).amount).toBe(50000);

    const complete = call('complete_booking_refund')[0];
    expect(complete.args.p_route).toBe('gateway');
    expect(complete.args.p_gateway_refund_id).toBe('rfnd_TEST123');

    // The gateway's id was persisted on the row before completion.
    const update = fake.writesTo('refunds').find((c) => c.op === 'update');
    expect((update!.payload as Record<string, unknown>).gateway_refund_id).toBe('rfnd_TEST123');
    expect(auditMeta()).not.toContain('signature');
  });

  it('falls back to the wallet when the gateway definitively refuses', async () => {
    prime({ payment: { gateway_payment_id: 'pay_TEST123' } });
    fetchMock.mockResolvedValue(gatewayRefusal('Refunds are disabled for this account.'));

    const res = await requestRefund(refundReq({ paymentId: PAYMENT_ID, amount: 500 }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.refund.status).toBe('completed');
    expect(body.data.refund.route).toBe('wallet');

    // The same amount, credited to the wallet — §12.3's promise.
    const credit = call('apply_wallet_delta')[0];
    expect(credit.args.p_type).toBe('credit');
    expect(credit.args.p_amount).toBe('500.00');

    // And an operator can see why the instrument did not take it.
    expect(audits()).toContain('refund.ops_ticket');
    expect(audits()).toContain('refund.wallet_fallback');
    expect(auditMeta()).toContain('gateway_reached');
    expect(auditMeta()).not.toContain('signature');
  });

  it('never credits the wallet when the gateway is merely unreachable', async () => {
    prime({ payment: { gateway_payment_id: 'pay_TEST123' } });
    fetchMock.mockRejectedValue(new Error('socket refused'));

    const res = await requestRefund(refundReq({ paymentId: PAYMENT_ID, amount: 500 }));

    // The row exists and waits for a human; nothing was paid twice.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.refund.status).toBe('requested');
    expect(call('apply_wallet_delta')).toHaveLength(0);
    expect(audits()).toContain('refund.ops_ticket');
    expect(auditMeta()).toContain('"gateway_reached":false');
  });
});

describe('GET /api/refunds', () => {
  it('lets staff list them and narrow by customer', async () => {
    prime({
      refunds: [
        refundRow(),
        refundRow({ id: '00000000-0000-4000-8000-0000000000cc', customer_id: OTHER_CUSTOMER_ID }),
      ],
    });

    const res = await listRefunds(listReq(`?customerId=${CUSTOMER_ID}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.refunds).toHaveLength(1);
    expect(body.data.refunds[0].customerId).toBe(CUSTOMER_ID);
    // The projection carries no signature field to leak.
    expect(JSON.stringify(body.data.refunds)).not.toContain('gateway_signature');
  });

  it('scopes a customer to their own refunds, ignoring any customerId they pass', async () => {
    prime({
      role: 'customer',
      refunds: [
        refundRow(),
        refundRow({ id: '00000000-0000-4000-8000-0000000000cc', customer_id: OTHER_CUSTOMER_ID }),
      ],
    });

    const res = await listRefunds(listReq(`?customerId=${OTHER_CUSTOMER_ID}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.refunds).toHaveLength(1);
    expect(body.data.refunds[0].customerId).toBe(CUSTOMER_ID);
  });
});

describe('POST /api/bookings/[id]/cancel — the paid case', () => {
  it('refunds the refundable part of a paid booking, exactly once', async () => {
    prime({
      role: 'customer',
      booking: { status: 'paid', total_amount: '2000.00' },
    });

    const res = await cancelBooking(cancelReq(), { params: { id: BOOKING_ID } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.autoRefund).not.toBeNull();

    // One refund, for the captured amount less §11.1's fee.
    const record = call('record_booking_refund');
    expect(record).toHaveLength(1);
    const expectedPaise = 200000 - Math.round(Number(body.data.cancellationFee) * 100);
    expect(record[0].args.p_amount).toBe((expectedPaise / 100).toFixed(2));
    expect(record[0].args.p_requested_by).toBeNull();
    expect(call('complete_booking_refund')).toHaveLength(1);
  });

  it('does not refund an unpaid booking', async () => {
    prime({ role: 'customer', booking: { status: 'confirmed' } });
    // No captured payment: the status filter finds nothing. `tables` is the same
    // object the fake holds, so mutating it re-points the `payments` responder.
    tables.payments = () => ({ data: [], error: null });

    const res = await cancelBooking(cancelReq(), { params: { id: BOOKING_ID } });

    expect(res.status).toBe(200);
    expect((await res.json()).data.autoRefund).toBeNull();
    expect(call('record_booking_refund')).toHaveLength(0);
  });
});

describe('POST /api/webhooks/razorpay — refund.processed', () => {
  function sign(raw: string): string {
    return createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  }

  function refundDelivery(raw: string): Request {
    return new Request('http://localhost/api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(raw) },
      body: raw,
    });
  }

  it('completes a refund and moves the booking to refunded', async () => {
    prime({ refunds: [refundRow({ gateway_refund_id: 'rfnd_TEST123', status: 'approved' })] });

    const raw = JSON.stringify({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_TEST123' } } },
    });
    const res = await webhook(refundDelivery(raw));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ refunded: true, refundId: REFUND_ID });

    const complete = call('complete_booking_refund');
    expect(complete).toHaveLength(1);
    expect(complete[0].args.p_route).toBe('gateway');
    expect(complete[0].args.p_processed_by).toBeNull();
    expect(audits()).toContain('refund.processed');
    expect(auditMeta()).not.toContain('signature');
  });
});
