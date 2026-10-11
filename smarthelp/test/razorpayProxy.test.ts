import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRazorpayClient } from '../lib/razorpayClient';
import { createRazorpayProxyFetch, razorpayTransport } from '../lib/razorpayProxy';

/**
 * The pos-subscription transport, in SmartHelp's seam.
 *
 * `lib/razorpayClient.ts` takes its `fetch` as an argument (CONTEXT decision 4,
 * "mock the transport, not the logic"), so the proxy is tested by handing the
 * client a `fetch` that records the envelope. The point of these assertions is
 * the envelope's shape: it has to be the one
 * `supabase/functions/razorpay-proxy` reads, or a host with the proxy enabled
 * gets a 400 where a charge was meant.
 */

type Call = { url: string; init?: RequestInit };

const PROXY = 'https://test.supabase.co/functions/v1/razorpay-proxy';
const AUTH = `Basic ${Buffer.from('k:s').toString('base64')}`;

function stub(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetch: fn };
}

describe('createRazorpayProxyFetch', () => {
  it('posts the envelope pos-subscription sends and returns the upstream response', async () => {
    const { calls, fetch } = stub(200, { id: 'order_1', amount: 123456, currency: 'INR' });
    const proxyFetch = createRazorpayProxyFetch({ proxyUrl: PROXY, anonKey: 'anon', direct: fetch });

    const res = await proxyFetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 123456, currency: 'INR' }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PROXY);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      method: 'POST',
      url: 'https://api.razorpay.com/v1/orders',
      authHeader: AUTH,
      body: { amount: 123456, currency: 'INR' },
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.apikey).toBe('anon');
    expect(headers.Authorization).toBe('Bearer anon');
    expect(await res.json()).toEqual({ id: 'order_1', amount: 123456, currency: 'INR' });
  });

  it('falls back to the direct call when the proxy is unreachable', async () => {
    const seen: string[] = [];
    const transport = vi.fn(async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url === PROXY) throw new Error('network restricted');
      return new Response(JSON.stringify({ id: 'order_direct' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const proxyFetch = createRazorpayProxyFetch({ proxyUrl: PROXY, direct: transport });
    const res = await proxyFetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: 1 }),
    });

    expect(seen).toEqual([PROXY, 'https://api.razorpay.com/v1/orders']);
    expect(await res.json()).toEqual({ id: 'order_direct' });
  });

  it('lets createRazorpayClient talk through the proxy, auth intact', async () => {
    const { calls, fetch } = stub(200, { id: 'order_via_proxy', amount: 123456, currency: 'INR' });
    const client = createRazorpayClient({
      keyId: 'k',
      keySecret: 's',
      fetch: createRazorpayProxyFetch({ proxyUrl: PROXY, anonKey: 'anon', direct: fetch }),
    });

    const order = await client.createOrder({ amountPaise: 123456, receipt: 'SH-1' });

    expect(order.id).toBe('order_via_proxy');
    expect(calls[0].url).toBe(PROXY);
    expect(JSON.parse(String(calls[0].init?.body)).authHeader).toBe(AUTH);
  });
});

describe('razorpayTransport', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is undefined when RAZORPAY_PROXY_URL is unset', () => {
    vi.stubEnv('RAZORPAY_PROXY_URL', '');
    expect(razorpayTransport()).toBeUndefined();
  });

  it('returns the proxy fetch when RAZORPAY_PROXY_URL is set', () => {
    vi.stubEnv('RAZORPAY_PROXY_URL', PROXY);
    expect(typeof razorpayTransport()).toBe('function');
  });
});
