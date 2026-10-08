import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/paymentClient.ts`, the browser's payment transport (§12.1, §12.2).
 *
 * Like its Phase 2 sibling `test/bookingClient.test.ts`, this file is about the
 * *transport* first: every payment call carries the caller's own bearer token
 * (`authorizationHeader()`); a signed-out visitor gets no header rather than a
 * stale one; and the order-create carries its idempotency key on the wire.
 *
 * The second half is the hard rule made testable. Razorpay's `handler` callback
 * fires the moment its window closes — seconds before the webhook can land — so
 * the handler payload alone must never produce `paid`. The pure mapping
 * `paymentDisplayState` is where that rule lives, and the test feeds the exact
 * payload shapes the two routes can return (`created`, `pending`, `success`,
 * `failed`, and the refund states) and asserts only `success`/`refunded` claim
 * `paid`. An unknown status under-claims (`confirming`), because an
 * over-claimed "paid" is a customer standing on a doorstep whose job was never
 * booked.
 */

const ACCESS_TOKEN = 'access-token-for-arushmita';

const getSession = vi.fn();
let jsonResponse: unknown;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
    },
  },
}));

import {
  BookingApiError,
} from '@/lib/bookingClient';
import {
  createPaymentOrder,
  fetchPayment,
  paymentDisplayState,
  verifyPayment,
} from '@/lib/paymentClient';

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('no fetch was made');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

function errorBody(
  code: string,
  message: string,
  details?: Record<string, unknown>
): unknown {
  return {
    success: false,
    error: message,
    code,
    ...(details ? { details } : {}),
    requestId: 'server',
    timestamp: '2026-10-06T00:00:00.000Z',
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  getSession.mockReset();
  jsonResponse = {
    success: true,
    data: { paymentId: 'p-1', orderId: 'order_1', keyId: 'rzp_test_1', amount: 613.6, currency: 'INR' },
  };
  getSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN } } });
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => jsonResponse,
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the payment client sends the caller\'s session', () => {
  it('attaches the bearer token on order-create', async () => {
    await createPaymentOrder({ bookingId: 'b-1' }, 'idem-pay-1');
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('attaches the bearer token on verify', async () => {
    await verifyPayment({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'deadbeef',
    });
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('attaches the bearer token on the payment read', async () => {
    await fetchPayment('b-1');
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('sends the idempotency key on order-create and nothing else', async () => {
    await createPaymentOrder({ bookingId: 'b-1', expectedTotal: 613.6 }, 'idem-pay-1');

    const init = lastCall().init;
    expect(headersOf(init)['idempotency-key']).toBe('idem-pay-1');
    expect(headersOf(init)['content-type']).toBe('application/json');
    // The verify and read verbs are idempotency-free; only the mutating one
    // carries a key.
    await verifyPayment({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'deadbeef',
    });
    expect(headersOf(lastCall().init)['idempotency-key']).toBeUndefined();
  });

  it('sends no header at all when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    await createPaymentOrder({ bookingId: 'b-1' }, 'idem-pay-1');

    const headers = headersOf(lastCall().init);
    expect(headers.authorization).toBeUndefined();
    expect(headers['idempotency-key']).toBe('idem-pay-1');
  });

  it('surfaces the server\'s 402 rejection as a BookingApiError with the code intact', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => errorBody('PAYMENT_FAILED', 'The card was declined by your bank.'),
    });

    const error = await createPaymentOrder({ bookingId: 'b-1' }, 'idem-pay-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookingApiError);
    expect(error).toMatchObject({ code: 'PAYMENT_FAILED', message: 'The card was declined by your bank.' });
  });

  it('traps a dead network as NETWORK_ERROR instead of leaking the TypeError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await createPaymentOrder({ bookingId: 'b-1' }, 'idem-pay-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookingApiError);
    expect((error as BookingApiError).code).toBe('NETWORK_ERROR');
  });
});

describe('paymentDisplayState — the hard rule as a pure function', () => {
  it('only success claims paid', () => {
    expect(paymentDisplayState('success')).toBe('paid');
  });

  it('the callback-visible statuses are confirming, never paid', () => {
    // A Razorpay `handler` has fired and `verify` has answered, but the webhook
    // has not — the row is still `created` or `pending`. Feeding this into the
    // display logic must NOT claim paid.
    expect(paymentDisplayState('created')).toBe('confirming');
    expect(paymentDisplayState('pending')).toBe('confirming');
  });

  it('failed is failed, and says so', () => {
    expect(paymentDisplayState('failed')).toBe('failed');
  });

  it('the refund states still claim paid — money did arrive', () => {
    expect(paymentDisplayState('refunded')).toBe('paid');
    expect(paymentDisplayState('partially_refunded')).toBe('paid');
  });

  it('under-claims on an unknown status instead of over-claiming', () => {
    // When in doubt the screen must under-claim: an over-claimed "paid" is a
    // customer on a doorstep whose job was never booked.
    expect(paymentDisplayState('whatever-new-status-phase-9-adds')).toBe('confirming');
  });
});