import { describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '../lib/api';
import { createRazorpayClient } from '../lib/razorpayClient';

/**
 * The gateway transport, against a stub that *is* the assertion.
 *
 * CONTEXT decision 4 — "mock the transport, not the logic" — is what this file
 * makes concrete. The client takes its `fetch` as an argument, so the test
 * hands it one that records every call and answers with a canned body. Nothing
 * in this file opens a socket, and nothing in it needs a Razorpay account: the
 * request shape is the thing under test, because a request shape that is wrong
 * here is a 400 from a live gateway at checkout.
 *
 * The `amount` assertion matters more than it looks. Razorpay's smallest unit
 * is paise, `lib/money.ts` already counts paise, and `1234.56` would be a
 * silently different charge from `123456`.
 */

type Call = { url: string; init?: RequestInit };

/** A fetch that records what it was asked and answers from a fixture. */
function stubFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetch: fn };
}

const KEY_ID = 'rzp_test_syntheticKey';
const KEY_SECRET = 'synthetic-key-secret-for-tests';

const authHeader = () => `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

const orderBody = {
  id: 'order_Nx1234',
  entity: 'order',
  amount: 123456,
  currency: 'INR',
  receipt: 'SH-20261006-00001',
  status: 'created',
};

describe('createRazorpayClient().createOrder', () => {
  it('posts to the orders endpoint with Basic auth built from key id and secret', async () => {
    const { calls, fetch } = stubFetch(200, orderBody);
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });

    await client.createOrder({ amountPaise: 123456, receipt: 'SH-20261006-00001' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(authHeader());
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends the amount as an integer number of paise, with currency INR', async () => {
    const { calls, fetch } = stubFetch(200, orderBody);
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });

    await client.createOrder({
      amountPaise: 123456,
      receipt: 'SH-20261006-00001',
      notes: { bookingId: 'b-1' },
    });

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.amount).toBe(123456);
    expect(Number.isInteger(sent.amount)).toBe(true);
    expect(sent.currency).toBe('INR');
    expect(sent.receipt).toBe('SH-20261006-00001');
    expect(sent.notes).toEqual({ bookingId: 'b-1' });
    // The conversion is the caller's job (parseNumeric → round); the transport
    // must not multiply by 100 a second time.
    expect(sent.amount).not.toBe(1234.56);
  });

  it('returns the gateway order as it came back', async () => {
    const { fetch } = stubFetch(200, orderBody);
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });
    const order = await client.createOrder({ amountPaise: 123456, receipt: 'r' });
    expect(order).toEqual(orderBody);
  });

  it('turns a non-2xx answer into PAYMENT_FAILED carrying the gateway description', async () => {
    const { fetch } = stubFetch(400, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid amount, should be above 100' },
    });
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });

    const failure = await client
      .createOrder({ amountPaise: 1, receipt: 'r' })
      .then(() => null)
      .catch((e) => e);

    expect(failure).toBeInstanceOf(ApiHttpError);
    expect(failure.code).toBe('PAYMENT_FAILED');
    // The route must not invent a message the gateway already wrote.
    expect(failure.message).toBe('Invalid amount, should be above 100');
    expect(failure.details).toMatchObject({
      code: 'BAD_REQUEST_ERROR',
      description: 'Invalid amount, should be above 100',
    });
  });

  it('falls back to its own sentence when the gateway says nothing useful', async () => {
    const { fetch } = stubFetch(503, 'Service Unavailable');
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });
    const failure = await client
      .createOrder({ amountPaise: 100, receipt: 'r' })
      .then(() => null)
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ApiHttpError);
    expect(failure.code).toBe('PAYMENT_FAILED');
    expect(failure.message.length).toBeGreaterThan(0);
  });

  it('opens exactly one request, so nothing behind the stub dials out', async () => {
    const { calls, fetch } = stubFetch(200, orderBody);
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });
    await client.createOrder({ amountPaise: 500, receipt: 'r' });
    expect(calls).toHaveLength(1);
  });
});

describe('createRazorpayClient().fetchOrder', () => {
  it('reads one order by id with the same auth', async () => {
    const { calls, fetch } = stubFetch(200, orderBody);
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });

    const order = await client.fetchOrder('order_Nx1234');

    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders/order_Nx1234');
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(authHeader());
    expect(order.id).toBe('order_Nx1234');
  });

  it('raises PAYMENT_FAILED when the order cannot be read', async () => {
    const { fetch } = stubFetch(404, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'Order not found' },
    });
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });
    const failure = await client
      .fetchOrder('order_missing')
      .then(() => null)
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ApiHttpError);
    expect(failure.code).toBe('PAYMENT_FAILED');
  });
});

describe('createRazorpayClient().listPaymentsForOrder', () => {
  it('reads the payments under an order', async () => {
    const { calls, fetch } = stubFetch(200, {
      entity: 'collection',
      count: 1,
      items: [{ id: 'pay_Nx1', amount: 123456, status: 'captured' }],
    });
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });

    const list = await client.listPaymentsForOrder('order_Nx1234');

    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders/order_Nx1234/payments');
    expect(calls[0].init?.method).toBe('GET');
    expect(list.items).toHaveLength(1);
  });
});

describe('createRazorpayClient().createRefund', () => {
  it('posts a refund in paise at the requested speed', async () => {
    const { calls, fetch } = stubFetch(200, {
      id: 'rfnd_Nx1',
      entity: 'refund',
      amount: 50000,
      speed: 'optimum',
      status: 'processed',
    });
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });

    const refund = await client.createRefund({
      paymentId: 'pay_Nx1',
      amountPaise: 50000,
      speed: 'optimum',
    });

    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_Nx1/refunds');
    expect(calls[0].init?.method).toBe('POST');
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.amount).toBe(50000);
    expect(Number.isInteger(sent.amount)).toBe(true);
    expect(sent.speed).toBe('optimum');
    expect(refund.id).toBe('rfnd_Nx1');
  });

  it('turns a gateway refusal into PAYMENT_FAILED', async () => {
    const { fetch } = stubFetch(400, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'Refund already processed' },
    });
    const client = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch });
    const failure = await client
      .createRefund({ paymentId: 'pay_Nx1', amountPaise: 100 })
      .then(() => null)
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ApiHttpError);
    expect(failure.code).toBe('PAYMENT_FAILED');
    expect(failure.message).toBe('Refund already processed');
  });
});
