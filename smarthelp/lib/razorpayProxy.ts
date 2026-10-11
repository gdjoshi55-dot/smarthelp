type FetchLike = typeof fetch;

/**
 * The pos-subscription transport for Razorpay, in SmartHelp's shape.
 *
 * pos-subscription never calls `api.razorpay.com` directly from its Route
 * Handlers: it posts an envelope — `{ method, url, authHeader, body }` — to a
 * Supabase edge function (`razorpay-proxy`) which makes the call, so a host
 * whose egress rules block Razorpay still reaches it. `lib/razorpayClient.ts`
 * already takes an injectable `fetch`; this module is that seam filled with the
 * proxy, so the client code above it cannot tell the two transports apart.
 *
 * ## Why it is opt-in
 *
 * The proxy only helps once the function is deployed and `RAZORPAY_PROXY_URL` is
 * set. With the variable absent, `razorpayTransport()` returns `undefined` and
 * the client keeps calling Razorpay directly — the default SmartHelp shipped
 * with. A host that has the proxy turns it on without a code change; a host that
 * does not cannot accidentally route a charge through a function that is not
 * there. See `supabase/functions/razorpay-proxy/index.ts`.
 */

export interface RazorpayProxyOptions {
  /** The deployed function URL, e.g. `https://<ref>.supabase.co/functions/v1/razorpay-proxy`. */
  proxyUrl: string;
  /** Sent as both `apikey` and `Authorization` to reach the Supabase function. */
  anonKey?: string;
  /** The real network. Defaults to `globalThis.fetch`; a test passes a stub. */
  direct?: FetchLike;
}

function ownUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string' || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * A `fetch` that satisfies the Razorpay client by proxying through the edge
 * function. On a transport failure reaching the proxy it falls back to the
 * direct call, so a missing or unreachable function degrades to SmartHelp's
 * original behaviour rather than refusing the charge.
 */
export function createRazorpayProxyFetch(options: RazorpayProxyOptions): FetchLike {
  const direct: FetchLike = options.direct ?? ((...args) => globalThis.fetch(...args));
  const { proxyUrl, anonKey } = options;

  return async (input, init) => {
    const envelope = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: ownUrl(input),
      authHeader: new Headers(init?.headers).get('authorization') ?? '',
      body: parseBody(init?.body),
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (anonKey) {
      headers.apikey = anonKey;
      headers.Authorization = `Bearer ${anonKey}`;
    }

    let response: Response;
    try {
      response = await direct(proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
      });
    } catch {
      return direct(input, init);
    }

    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/**
 * The proxy `fetch` when `RAZORPAY_PROXY_URL` is configured, otherwise
 * `undefined` so the caller keeps the direct transport.
 */
export function razorpayTransport(): FetchLike | undefined {
  const proxyUrl = process.env.RAZORPAY_PROXY_URL;
  if (!proxyUrl) return undefined;
  return createRazorpayProxyFetch({
    proxyUrl,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}
