import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { POST as createOrder } from '@/app/api/payments/create-order/route';

/**
 * `POST /api/payments/create-order` â€” the money-in entry point (Â§25.8, Â§12.1).
 *
 * These tests are about four things, in this order:
 *
 *   1. **The server owns the amount.** The order is built from
 *      `bookings.total_amount`; an `amount` in the request body is not read, and
 *      `expectedTotal` is compared rather than trusted.
 *   2. **Presence gates payment, freshness does not.** A booking with no
 *      `quote_token` cannot be paid (Â§7.2's chain has nothing to attest to); a
 *      token whose `exp` is long gone still can, because rejecting a real charge
 *      over a 15-minute window would put a quote ahead of the webhook.
 *   3. **One key, one charge.** The ledger answers a replay, and
 *      `uniq_payments_idem` answers a replay the ledger can no longer see.
 *   4. **Nothing signed reaches the audit trail.** `gateway_signature` is
 *      dispute evidence (Â§12.2) and must not appear in recorded metadata.
 *
 * The gateway is `globalThis.fetch` with a stub: no test here, in this file or
 * anywhere else in the suite, performs a network call (`T-03-SC`).
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'test-token';
const CUSTOMER_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const BOOKING_ID = 'abababab-1111-4111-8111-abababababab';
const KEY = 'idem-key-payment-0001';

/** Not ours: the booking fixture is re-pointed at this in the ownership test. */
const OTHER_CUSTOMER_ID = 'cccccccc-2222-4222-8222-cccccccccccc';

let fake: FakeSupabase;
let tables: Record<string, (call: RecordedCall) => { data: any; error: any }>;
let rpcs: Record<string, (call: RecordedCall) => { data: any; error: any }>;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const fetchMock = vi.fn();
let savedEnv: Record<string, string | undefined>;

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20261006-00001',
    customer_id: CUSTOMER_ID,
    status: 'payment_pending',
    quote_token: 'quote-token-from-phase-2',
    total_amount: '613.60',
    currency: 'INR',
    version: 2,
    ...overrides,
  };
}

interface Prime {
  booking?: Record<string, unknown>;
  payments?: Record<string, unknown>[];
  /** Returned instead of a row when the `payments` insert runs. */
  insertError?: { message: string; code: string };
  claim?: Record<string, unknown>;
}

let stored: { paymentId: string; orderId: string; keyId: string; amount: number; currency: string };
let claimCount = 0;

function prime(over: Prime = {}) {
  claimCount = 0;

  tables = {
    profiles: () => ({
      data: [{ id: USER_ID, role: 'customer', status: 'active' }],
      error: null,
    }),
    customers: () => ({ data: [{ id: CUSTOMER_ID, profile_id: USER_ID }], error: null }),
    bookings: () => ({ data: [booking(over.booking)], error: null }),
    // One responder for three operations: an insert answers with an empty list
    // so `FakeSupabase` echoes the row it would have written, a read answers
    // with the fixture (which is how the pruned-ledger test hands back the row
    // the losing insert collided with), and an update of a non-existent fixture
    // row answers with nothing, which is what PostgREST does.
    payments: (call) => {
      if (call.op === 'insert' && over.insertError) return { data: null, error: over.insertError };
      return { data: over.payments ?? [], error: null };
    },
  };

  rpcs = {
    claim_idempotency_key: () => ({
      data:
        over.claim ??
        (claimCount++ === 0
          ? { outcome: 'claimed' }
          : { outcome: 'replay', stored_status: 201, stored_body: stored }),
      error: null,
    }),
    complete_idempotency_key: () => ({ data: null, error: null }),
    write_audit: () => ({ data: null, error: null }),
  };

  fake = new FakeSupabase(tables as any, rpcs as any);
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/payments/create-order', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function gatewayOrder(id = 'order_TEST123') {
  return new Response(
    JSON.stringify({ id, entity: 'order', amount: 61360, currency: 'INR', status: 'created' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeEach(() => {
  prime();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(gatewayOrder());
  vi.stubGlobal('fetch', fetchMock);

  savedEnv = {
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    NEXT_PUBLIC_RAZORPAY_KEY_ID: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
  };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_1234567890';
  process.env.RAZORPAY_KEY_SECRET = 'secret_test_abcdef';
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('POST /api/payments/create-order', () => {
  it('refuses a request with no Idempotency-Key', async () => {
    const res = await createOrder(req({ bookingId: BOOKING_ID }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.fields.idempotencyKey).toBe('Required');

    // Refused before anything was written or asked of the gateway.
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a booking with no quote attached, telling the client to re-quote', async () => {
    prime({ booking: { quote_token: null } });

    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('INVALID_STATE');
    // The consequence of Â§7.2's chain (quote -> token -> booking -> order), not
    // a generic "not allowed": the client has to be told what to do next.
    expect(body.error).toMatch(/refresh the price/i);
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a quote token past its expiry â€” freshness gates nothing here', async () => {
    // A token whose `exp` is well over 15 minutes old. The route does not parse
    // it, and that is the decision under test: a `payment.captured` routinely
    // arrives after the quote window, so freshness is the wrong property to
    // charge money on. Presence is what is asserted.
    prime({
      booking: {
        quote_token: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDB9.expired.sig',
      },
    });

    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.orderId).toBe('order_TEST123');
    expect(body.data.amount).toBe(613.6);
  });

  it('charges the booking total and ignores an amount the client puts in the body', async () => {
    const res = await createOrder(
      req({ bookingId: BOOKING_ID, amount: 1, expectedTotal: 613.6 }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    // Rupees back, because that is what every other money figure this API
    // returns is measured in.
    expect(body.data.amount).toBe(613.6);
    expect(body.data.currency).toBe('INR');
    expect(body.data.keyId).toBe('rzp_test_1234567890');

    // The gateway was asked for an integer in paise, taken from the row.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.amount).toBe(61360);
    expect(Number.isInteger(sent.amount)).toBe(true);

    // And the row holds the same figure, as a numeric literal.
    const insert = fake.writesTo('payments')[0];
    expect((insert.payload as Record<string, unknown>).amount).toBe('613.60');
    expect((insert.payload as Record<string, unknown>).customer_id).toBe(CUSTOMER_ID);
    expect((insert.payload as Record<string, unknown>).purpose).toBe('booking');
  });

  it('refuses an expectedTotal that disagrees with the booking', async () => {
    const res = await createOrder(
      req({ bookingId: BOOKING_ID, expectedTotal: 1 }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PRICE_CHANGED');
    expect(body.details.currentTotal).toBe(613.6);

    // Nothing written, nothing asked: a stale screen must not spend a key.
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a booking that is not waiting for payment', async () => {
    // A paid booking has a null `quote_token` too â€” the webhook nulls it. The
    // status check has to come first or the customer who already paid is told
    // to re-quote.
    prime({ booking: { status: 'paid', quote_token: null } });

    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('INVALID_STATE');
    expect(body.error).toMatch(/already been paid/i);
    expect(body.details.status).toBe('paid');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it("refuses a booking that belongs to another account", async () => {
    prime({ booking: { customer_id: OTHER_CUSTOMER_ID } });

    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('charges once and replays the first response for a second call with the same key', async () => {
    const first = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    stored = firstBody.data;
    const writesAfterFirst = fake.writesTo('payments').length;

    const second = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    const secondBody = await second.json();
    // Byte-identical to what the ledger stored, not a recomputation.
    expect(secondBody.data).toEqual(stored);

    // Zero writes and one gateway call between them: the ledger, not a second
    // charge, answered the retry.
    expect(fake.writesTo('payments')).toHaveLength(writesAfterFirst);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adopts the existing row when the ledger has been pruned', async () => {
    // The `idempotency_keys` row is gone (Â§25.11's wallet-expiry cron deletes by
    // age) so the ledger says "claimed" â€” and the column still holds the key.
    // `uniq_payments_idem` is what keeps "one charge attempt, one row" true.
    const existing = {
      id: '99999999-9999-4999-8999-999999999999',
      booking_id: BOOKING_ID,
      customer_id: CUSTOMER_ID,
      purpose: 'booking',
      amount: '613.60',
      currency: 'INR',
      gateway: 'razorpay',
      gateway_order_id: 'order_EXISTING',
      gateway_payment_id: null,
      gateway_signature: null,
      status: 'created',
      method: null,
      refundable_amount: '0.00',
      failure_reason: null,
      idempotency_key: KEY,
      captured_at: null,
      created_at: '2026-10-06T00:00:00.000Z',
      updated_at: '2026-10-06T00:00:00.000Z',
    };

    prime({
      payments: [existing],
      insertError: {
        message: 'duplicate key value violates unique constraint "uniq_payments_idem"',
        code: '23505',
      },
    });

    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.paymentId).toBe(existing.id);
    expect(body.data.orderId).toBe('order_EXISTING');

    // The winner's order, not a second one: no gateway call, and the losing
    // insert is the only write the fake recorded for `payments`.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers with a configuration error, and writes nothing, when the keys are absent', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.details.missing).toBe('RAZORPAY_KEY_ID');

    // Refused before the row: a deployment with no keys has not charged
    // anybody, so there is nothing for the cron to reconcile.
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records an audit entry with no signature in it', async () => {
    const res = await createOrder(
      req({ bookingId: BOOKING_ID }, { 'idempotency-key': KEY })
    );
    expect(res.status).toBe(201);

    const audits = fake.rpcCalls.filter((c) => c.fn === 'write_audit');
    expect(audits).toHaveLength(1);
    expect(audits[0].args.p_action).toBe('payment.order.created');
    expect(audits[0].args.p_entity_id).toBe('00000000-0000-4000-8000-0000000000ff');

    // Â§12.2: `gateway_signature` is dispute evidence and "never logged". The
    // route must not put it in metadata â€” and nothing else may smuggle it in
    // under another name either, which is what the recursive key scan checks.
    const serialised = JSON.stringify(audits[0].args.p_metadata ?? {});
    expect(serialised.toLowerCase()).not.toContain('signature');
    expect(Object.keys((audits[0].args.p_metadata ?? {}) as object)).toEqual(
      expect.arrayContaining(['bookingId', 'amount_paise', 'gateway'])
    );
  });
});

/**
 * `POST /api/payments/verify` and `GET /api/payments/[id]` â€” the two *reads*
 * of money (Â§25.8, Â§25.4).
 *
 * verify exists so a browser can close the loop on the Checkout callback
 * without a client-reachable write path: it is a signature check and a lookup,
 * and the status it reports is a fact the webhook owns. The tests therefore
 * pin two invariants together:
 *
 *   1. **A valid call writes nothing.** Paid rows stay `success`, unpaid rows
 *      stay `created`, bookings do not move, the gateway is not called.
 *   2. **A correct signature is not proof of ownership.** The row goes through
 *      `getPaymentForCaller` like every other read, so verifying someone
 *      else's order id is still 403.
 *
 * GET is the poll target behind "Confirming paymentâ€¦", so the important test
 * is the projection: every field the browser uses comes back in rupees, and
 * `gateway_signature` and `idempotency_key` â€” dispute evidence and server
 * state â€” do not come back at all.
 */
import { createHmac } from 'node:crypto';
import { POST as verifyPayment } from '@/app/api/payments/verify/route';
import { GET as getPayment } from '@/app/api/payments/[id]/route';

const PAYMENT_ID = '77777777-7777-4777-8777-777777777777';
const ORDER_ID = 'order_TEST123';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: CUSTOMER_ID,
    purpose: 'booking',
    amount: '613.60',
    currency: 'INR',
    gateway: 'razorpay',
    gateway_order_id: ORDER_ID,
    gateway_payment_id: 'pay_123',
    gateway_signature: 'deadbeef',
    status: 'success',
    method: 'card',
    refundable_amount: '613.60',
    failure_reason: null,
    idempotency_key: KEY,
    captured_at: '2026-10-06T00:01:00.000Z',
    created_at: '2026-10-06T00:00:00.000Z',
    updated_at: '2026-10-06T00:01:00.000Z',
    ...overrides,
  };
}

/** `verifyCheckoutSignature`'s message and key, recomputed in the test. */
function checkoutSignature(paymentId = 'pay_123', secret = 'secret_test_abcdef') {
  return createHmac('sha256', secret).update(`${ORDER_ID}|${paymentId}`).digest('hex');
}

function verifyReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/payments/verify', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/payments/verify', () => {
  it('confirms a genuine signature and reports the status the webhook set', async () => {
    prime({ payments: [payment()] });

    const res = await verifyPayment(
      verifyReq({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: 'pay_123',
        razorpay_signature: checkoutSignature(),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ verified: true, status: 'success', paymentId: PAYMENT_ID });

    // The webhook, not this route, owns `success`: the pair sent here is the
    // same pair the browser sent, and the row already moved. Zero writes.
    expect(fake.writesTo('payments')).toHaveLength(0);
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a pending row as pending, still without writing', async () => {
    prime({ payments: [payment({ status: 'created', captured_at: null })] });

    const res = await verifyPayment(
      verifyReq({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: 'pay_123',
        razorpay_signature: checkoutSignature(),
      })
    );

    expect(res.status).toBe(200);
    // The browser maps this to "Confirming paymentâ€¦" â€” the webhook has a few
    // more seconds, and this route must not close the gap itself.
    expect((await res.json()).data.status).toBe('created');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('rejects a signature that does not verify, writing nothing', async () => {
    prime({ payments: [payment()] });

    const res = await verifyPayment(
      verifyReq({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: 'pay_123',
        razorpay_signature: 'f'.repeat(64),
      })
    );

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('PAYMENT_NOT_VERIFIED');
    expect(body.details.reason).toBe('signature_mismatch');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('fails closed with a configuration error when the key secret is absent', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;

    const res = await verifyPayment(
      verifyReq({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: 'pay_123',
        razorpay_signature: checkoutSignature(),
      })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.details.missing).toBe('RAZORPAY_KEY_SECRET');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('refuses a missing signature field before touching anything', async () => {
    const res = await verifyPayment(verifyReq({ razorpay_order_id: ORDER_ID }));

    expect(res.status).toBe(400);
    const body = await res.json();
    // First missing field wins, like every other `str(...)` call in this API.
    expect(body.details.fields).toHaveProperty('razorpay_payment_id');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('treats a valid signature for a strangerâ€™s payment as 403', async () => {
    prime({ payments: [payment({ customer_id: OTHER_CUSTOMER_ID })] });

    const res = await verifyPayment(
      verifyReq({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: 'pay_123',
        razorpay_signature: checkoutSignature(),
      })
    );

    // The signature verifies â€” the webhook could have run for this order any
    // time. But the rows `payments` keeps are not this caller's, and the
    // signature is not ownership.
    expect(res.status).toBe(403);
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('answers 404 for a signed order this deployment never created', async () => {
    prime({ payments: [] });

    const res = await verifyPayment(
      verifyReq({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: 'pay_123',
        razorpay_signature: checkoutSignature(),
      })
    );

    expect(res.status).toBe(404);
    expect(fake.writesTo('payments')).toHaveLength(0);
  });
});

describe('GET /api/payments/[id]', () => {
  function getReq(id = PAYMENT_ID): Request {
    return new Request(`http://localhost/api/payments/${id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }

  function getRoute(id = PAYMENT_ID) {
    return getPayment(getReq(id), { params: { id } } as any);
  }

  it('returns the ownerâ€™s payment as a projection, rupees in and secrets out', async () => {
    prime({ payments: [payment()] });

    const res = await getRoute();
    expect(res.status).toBe(200);

    const { payment: p } = (await res.json()).data;
    expect(p).toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: 'success',
      amount: 613.6,
      currency: 'INR',
      method: 'card',
      failureReason: null,
      capturedAt: '2026-10-06T00:01:00.000Z',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:01:00.000Z',
    });

    // The projection is a projection: dispute evidence and server state stay
    // in the database, whatever the row holds.
    expect(p).not.toHaveProperty('gateway_signature');
    expect(p).not.toHaveProperty('gateway_order_id');
    expect(p).not.toHaveProperty('gateway_payment_id');
    expect(p).not.toHaveProperty('idempotency_key');
    expect(p).not.toHaveProperty('customer_id');
    expect(fake.writesTo('payments')).toHaveLength(0);
  });

  it('refuses a strangerâ€™s payment', async () => {
    prime({ payments: [payment({ customer_id: OTHER_CUSTOMER_ID })] });

    const res = await getRoute();
    expect(res.status).toBe(403);
  });

  it('refuses an id that is not a uuid', async () => {
    const res = await getRoute('not-a-uuid');
    expect(res.status).toBe(400);
  });
});
