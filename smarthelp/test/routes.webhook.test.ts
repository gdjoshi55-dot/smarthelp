import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { POST as webhook } from '@/app/api/webhooks/razorpay/route';

/**
 * The Razorpay webhook — the sole authority on whether money arrived (§12.1).
 *
 * These tests are about five things:
 *
 *   1. **The signature covers the bytes, not the meaning.** A body with real
 *      gateway formatting verifies; its `JSON.parse` + `JSON.stringify` twin,
 *      signed with the same secret over the *raw* bytes, does not. That pair is
 *      what "reads the raw body first" means, and it fails the moment anything
 *      upstream parses and re-serialises the request.
 *   2. **The guard fails closed.** No secret, or the placeholder a copied
 *      `.env.example` leaves behind, is a sentence — not a 500 out of
 *      `timingSafeEqual`, and not a silent rejection of every delivery.
 *   3. **One writer.** A captured payment calls `confirm_booking_payment` once,
 *      with the row's own order id; a replay calls it and gets null back,
 *      performs zero writes, and logs a duplicate (§30.1).
 *   4. **Disagreement writes nothing.** Amount, currency or order id that does
 *      not match the row is a 400 and an audit row, never a confirmation.
 *   5. **`payment.failed` fails the payment and not the booking.** The customer
 *      can pay again; a booking that vanished on a declined card cannot.
 *
 * Secrets come from `vi.stubEnv` and are synthetic. No fixture holds a real one
 * and no test in this file performs a network call.
 */

const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
const PAYMENT_ID = '77777777-7777-4777-8777-777777777777';
const BOOKING_ID = 'abababab-1111-4111-8111-abababababab';
const ORDER_ID = 'order_TEST123';
const REFUND_ID = '99999999-9999-4999-8999-999999999999';
const GATEWAY_REFUND_ID = 'rfnd_TEST123';

let fake: FakeSupabase;
let tables: Record<string, (call: RecordedCall) => { data: any; error: any }>;
let rpcs: Record<string, (call: RecordedCall) => { data: any; error: any }>;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

/** What `confirm_booking_payment` returns: a row, or null on the replay guard. */
let confirmResult: Record<string, unknown> | null;

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
    created_at: '2026-10-06T00:00:00.000Z',
    updated_at: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

interface Prime {
  payments?: Record<string, unknown>[];
  confirm?: Record<string, unknown> | null;
  /** Rows the `refunds` table answers with, for the `refund.processed` path. */
  refunds?: Record<string, unknown>[];
  /** What `complete_booking_refund` returns; `null` is its replay guard. */
  complete?: Record<string, unknown> | null;
}

function prime(over: Prime = {}) {
  confirmResult = over.confirm === undefined ? payment({ status: 'success' }) : over.confirm;

  tables = {
    payments: () => ({ data: over.payments ?? [payment()], error: null }),
    refunds: () => ({ data: over.refunds ?? [], error: null }),
  };

  rpcs = {
    confirm_booking_payment: () => {
      // The function's writes happen inside its transaction; note them so the
      // tests can talk about rows rather than about a single RPC.
      if (confirmResult) {
        fake.noteWrite('payments', 'update', { status: 'success' });
        fake.noteWrite('bookings', 'update', { status: 'paid', quote_token: null });
      }
      return { data: confirmResult, error: null };
    },
    complete_booking_refund: (call) => {
      const result =
        over.complete === undefined
          ? { id: call.args!.p_refund_id, status: 'completed', route: call.args!.p_route }
          : over.complete;
      if (result) {
        fake.noteWrite('refunds', 'update', { status: 'completed' });
        fake.noteWrite('bookings', 'update', { status: 'refunded' });
      }
      return { data: result, error: null };
    },
    write_audit: () => ({ data: null, error: null }),
  };

  fake = new FakeSupabase(tables as any, rpcs as any);
}

function sign(raw: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function delivery(raw: string, signature: string | null): Request {
  return new Request('http://localhost/api/webhooks/razorpay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-razorpay-signature': signature }),
    },
    body: raw,
  });
}

/**
 * The exact string a gateway would send: no spaces after `:` or `,` in some
 * places, two in another, and a key order `JSON.stringify` would never produce.
 * Signed over as-is, it is what a real delivery looks like to the verifier.
 */
const RAW =
  '{"event" : "payment.captured","payload":   {"payment":{"entity":{"currency":"INR","amount":61360,"order_id":"' +
  ORDER_ID +
  '","id":"pay_123","status":"captured"}}}}';

const capturedEvent = JSON.stringify({
  event: 'payment.captured',
  payload: {
    payment: {
      entity: { id: 'pay_123', order_id: ORDER_ID, amount: 61360, currency: 'INR' },
    },
  },
});

/** A `refunds` row as `executeRefund()` would have left it before completion. */
function refundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: 'dddddddd-1111-4111-8111-dddddddddddd',
    amount: '306.80',
    currency: 'INR',
    status: 'approved',
    route: 'gateway',
    reason_code: 'customer_request',
    gateway_refund_id: GATEWAY_REFUND_ID,
    ...overrides,
  };
}

function refundEvent(id = GATEWAY_REFUND_ID) {
  return JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id } } } });
}

function failedEvent(reason = 'Card declined by the issuer') {
  return JSON.stringify({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: 'pay_123',
          order_id: ORDER_ID,
          amount: 61360,
          currency: 'INR',
          error_description: reason,
        },
      },
    },
  });
}

const audits = (f: FakeSupabase) =>
  f.rpcCalls.filter((c) => c.fn === 'write_audit').map((c) => c.args.p_action);

beforeEach(() => {
  prime();
  vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', WEBHOOK_SECRET);
});

describe('POST /api/webhooks/razorpay', () => {
  it('verifies the bytes it was sent, and not their re-serialisation', async () => {
    const signature = sign(RAW);

    // The raw body, signed over as it stands, verifies.
    const good = await webhook(delivery(RAW, signature));
    expect(good.status).toBe(200);
    expect((await good.json()).data.confirmed).toBe(true);

    prime();

    // The same event after a parse/stringify round trip, carrying the signature
    // computed over the *raw* bytes: different spacing, different key order, and
    // therefore a different message. This is the case that fails the moment
    // anything upstream parses the request before this route reads it.
    const reserialised = JSON.stringify(JSON.parse(RAW));
    expect(reserialised).not.toBe(RAW);

    const bad = await webhook(delivery(reserialised, signature));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('VALIDATION_ERROR');
    expect(fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment')).toHaveLength(0);
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('refuses an invalid signature with no writes at all', async () => {
    const res = await webhook(delivery(RAW, sign('something else entirely')));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.reason).toBe('signature_mismatch');
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment')).toHaveLength(0);
  });

  it('refuses a delivery with no signature header', async () => {
    const res = await webhook(delivery(RAW, null));
    expect(res.status).toBe(400);
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('answers with the guard’s sentence when the secret is missing', async () => {
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', '');

    const res = await webhook(delivery(RAW, sign(RAW)));

    // Not a 500 out of `timingSafeEqual`, and not a silent rejection.
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.details.missing).toBe('RAZORPAY_WEBHOOK_SECRET');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('answers with the guard’s sentence when the secret is still the placeholder', async () => {
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'REPLACE_WITH_YOUR_WEBHOOK_SECRET');

    const res = await webhook(delivery(RAW, sign(RAW)));

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SERVICE_UNAVAILABLE');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('confirms once, through the one writer, with the row’s own arguments', async () => {
    const res = await webhook(delivery(capturedEvent, sign(capturedEvent)));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ confirmed: true, paymentId: PAYMENT_ID });

    const calls = fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      p_payment_id: PAYMENT_ID,
      p_gateway_order_id: ORDER_ID,
      p_booking_id: BOOKING_ID,
      p_gateway_payment_id: 'pay_123',
      // The signature is stored as dispute evidence on the row (§12.2), which
      // is where it belongs — never in the audit trail below.
      p_gateway_signature: sign(capturedEvent),
    });
    expect(calls[0].args.p_note).toContain('payment confirmed by webhook');
    expect(calls[0].args.p_note).toContain('pay_123');

    expect(audits(fake)).toEqual(['payment.captured']);
    const auditMeta = JSON.stringify(
      fake.rpcCalls.find((c) => c.fn === 'write_audit')!.args.p_metadata
    );
    expect(auditMeta.toLowerCase()).not.toContain('signature');
  });

  it('performs zero writes and logs a duplicate when the webhook is replayed', async () => {
    prime({ confirm: null });

    const res = await webhook(delivery(capturedEvent, sign(capturedEvent)));

    // 200, because the delivery *was* handled — the state just did not change.
    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(true);

    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(audits(fake)).toEqual(['payment.webhook.duplicate']);
  });

  it('rejects an amount that disagrees with the row, writing nothing', async () => {
    const tampered = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_123', order_id: ORDER_ID, amount: 1, currency: 'INR' },
        },
      },
    });

    const res = await webhook(delivery(tampered, sign(tampered)));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.reason).toBe('amount_mismatch');
    // Paise against paise: 613.60 is 61360, and a single rupee is not close.
    expect(body.details.expectedAmount_paise).toBe(61360);
    expect(body.details.gotAmount_paise).toBe(1);

    expect(fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment')).toHaveLength(0);
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(audits(fake)).toEqual(['payment.webhook.mismatch']);
  });

  it('rejects a currency that disagrees with the row', async () => {
    const tampered = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_123', order_id: ORDER_ID, amount: 61360, currency: 'USD' },
        },
      },
    });

    const res = await webhook(delivery(tampered, sign(tampered)));

    expect(res.status).toBe(400);
    expect((await res.json()).details.gotCurrency).toBe('USD');
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(audits(fake)).toEqual(['payment.webhook.mismatch']);
  });

  it('refuses a signed delivery for an order this deployment never created', async () => {
    prime({ payments: [] });

    const res = await webhook(delivery(capturedEvent, sign(capturedEvent)));

    expect(res.status).toBe(400);
    expect((await res.json()).details.reason).toBe('unknown_order');
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(audits(fake)).toEqual(['payment.webhook.mismatch']);
  });

  it('fails the payment and leaves the booking waiting', async () => {
    const res = await webhook(delivery(failedEvent(), sign(failedEvent())));

    expect(res.status).toBe(200);
    expect((await res.json()).data.failed).toBe(true);

    const writes = fake.writesTo('payments');
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({
      status: 'failed',
      failure_reason: 'Card declined by the issuer',
    });

    // The whole point of the "booking stays payment_pending" decision: the
    // customer can try another card, and the quote is still attached.
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment')).toHaveLength(0);
    expect(audits(fake)).toEqual(['payment.failed']);
  });

  it('does not walk a successful payment back to failed', async () => {
    prime({ payments: [payment({ status: 'success' })] });

    const res = await webhook(delivery(failedEvent(), sign(failedEvent())));

    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(true);
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(audits(fake)).toEqual(['payment.webhook.duplicate']);
  });

  it('acknowledges a signed event it does not handle', async () => {
    const other = JSON.stringify({ event: 'payment.authorized', payload: {} });

    const res = await webhook(delivery(other, sign(other)));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ignored: true, event: 'payment.authorized' });
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fake.rpcCalls.filter((c) => c.fn === 'confirm_booking_payment')).toHaveLength(0);
  });

  it('completes a refund the gateway reports processed', async () => {
    prime({ refunds: [refundRow()] });

    const raw = refundEvent();
    const res = await webhook(delivery(raw, sign(raw)));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ refunded: true, refundId: REFUND_ID });

    const calls = fake.rpcCalls.filter((c) => c.fn === 'complete_booking_refund');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      p_refund_id: REFUND_ID,
      p_gateway_refund_id: GATEWAY_REFUND_ID,
      p_route: 'gateway',
      p_processed_by: null,
    });

    // The function's writes, in one statement: the refund completes and the
    // booking reaches `refunded`.
    expect(fake.writesTo('refunds')).toHaveLength(1);
    expect(fake.writesTo('bookings')[0].payload).toMatchObject({ status: 'refunded' });

    expect(audits(fake)).toEqual(['refund.processed']);
    const auditMeta = JSON.stringify(
      fake.rpcCalls.find((c) => c.fn === 'write_audit')!.args.p_metadata
    );
    expect(auditMeta.toLowerCase()).not.toContain('signature');
  });

  it('answers duplicate when the refund was already completed', async () => {
    prime({ refunds: [refundRow()], complete: null });

    const raw = refundEvent();
    const res = await webhook(delivery(raw, sign(raw)));

    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(true);
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(audits(fake)).toEqual(['refund.webhook.duplicate']);
  });

  it('refuses a refund.processed delivery for a refund we never created', async () => {
    prime({ refunds: [] });

    const raw = refundEvent('rfnd_UNKNOWN');
    const res = await webhook(delivery(raw, sign(raw)));

    expect(res.status).toBe(400);
    expect((await res.json()).details.reason).toBe('unknown_refund');
    expect(fake.rpcCalls.filter((c) => c.fn === 'complete_booking_refund')).toHaveLength(0);
    expect(audits(fake)).toEqual(['refund.webhook.mismatch']);
  });

  it('refuses a refund.processed delivery carrying no refund entity', async () => {
    const raw = JSON.stringify({ event: 'refund.processed', payload: {} });

    const res = await webhook(delivery(raw, sign(raw)));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(fake.rpcCalls.filter((c) => c.fn === 'complete_booking_refund')).toHaveLength(0);
  });
});
