import { ApiHttpError } from './api';

/**
 * The Razorpay transport: four `fetch` calls with an injectable `fetch`.
 *
 * ## Why there is no `razorpay` npm package
 *
 * Two reasons, and the second is the load-bearing one. The SDK builds its own
 * request layer with no supported way to hand it a fake transport, so CONTEXT
 * decision 4 (*mock the transport, not the logic*) would be unimplementable —
 * a test would have to intercept at the socket, which is not a seam, it is a
 * interception. And four endpoints do not justify a dependency whose upgrade
 * cadence is not ours. **No package enters `package.json` in this phase**, and
 * `T-03-SC` in the plan's threat register records that as a deliberate choice
 * rather than an oversight.
 *
 * ## Why the amount is an integer in paise
 *
 * Razorpay's smallest unit is paise and `lib/money.ts` already counts paise, so
 * the two agree without arithmetic at this boundary. The conversion from
 * PostgREST's `numeric` string is the caller's job — `parseNumeric()` then
 * `Math.round(… * 100)` — and happens exactly once, in
 * `lib/paymentServer.ts`. This module must not multiply again: a `* 100` here
 * would charge a hundred times the agreed figure, and every test below would
 * still pass if it asserted only on the shape.
 *
 * ## Why a non-2xx carries the gateway's own words
 *
 * `error.description` is a message Razorpay already wrote for a human. Copying
 * it into `details` means the route never invents a sentence the gateway
 * already had, and a checkout failure reads "Invalid amount, should be above
 * 100" instead of "Something went wrong".
 */

/** The three endpoints Wave A needs, plus the refund path Wave B will call. */
const BASE_URL = 'https://api.razorpay.com/v1';

export interface RazorpayClientOptions {
  keyId: string;
  keySecret: string;
  /** The seam. Defaults to `globalThis.fetch`; a test passes a stub. */
  fetch?: typeof fetch;
}

export interface CreateOrderInput {
  /** Integer paise. The caller converts; this module never does. */
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  entity?: string;
  amount: number;
  currency: string;
  receipt?: string;
  status?: string;
  created_at?: number;
  [key: string]: unknown;
}

export interface CreateRefundInput {
  paymentId: string;
  /** Integer paise. `undefined` refunds the full capture, which is Razorpay's own default. */
  amountPaise?: number;
  speed?: 'optimum' | 'instant';
}

export interface RazorpayClient {
  createOrder(input: CreateOrderInput): Promise<RazorpayOrder>;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
  listPaymentsForOrder(orderId: string): Promise<{ count: number; items: unknown[] }>;
  createRefund(input: CreateRefundInput): Promise<Record<string, unknown>>;
}

/**
 * Razorpay's error envelope, and the sentence the route should show.
 *
 * Anything that is not a JSON `{ error: { … } }` — a 503 with an HTML body, a
 * truncated response — still has to become an `ApiHttpError`, because a route
 * that lets a raw `SyntaxError` escape answers 500 where 402 was meant.
 */
function toPaymentFailed(status: number, body: unknown): ApiHttpError {
  const error = (body as any)?.error;
  const description =
    typeof error?.description === 'string' && error.description.trim().length > 0
      ? error.description
      : `The payment gateway rejected the request (HTTP ${status}).`;
  const details: Record<string, unknown> = {};
  if (error?.code) details.code = error.code;
  if (error?.description) details.description = error.description;
  return new ApiHttpError('PAYMENT_FAILED', description, 402, details);
}

export function createRazorpayClient(options: RazorpayClientOptions): RazorpayClient {
  const { keyId, keySecret } = options;
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));

  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  /**
   * One request, one shape.
   *
   * `!res.ok` rather than `res.status >= 400`: a 3xx that was not followed, a
   * 1xx, or anything else outside 2xx is still not a successful order.
   */
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: auth,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // A refused socket is a gateway outage, not an application bug, and the
      // reconciliation cron in particular must be able to tell the two apart
      // from the error code alone.
      throw new ApiHttpError(
        'PAYMENT_FAILED',
        'The payment gateway could not be reached. Please try again.',
        402,
        { unreachable: true }
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) throw toPaymentFailed(res.status, parsed);
    if (parsed === null) {
      throw new ApiHttpError(
        'PAYMENT_FAILED',
        'The payment gateway answered with something this server could not read.',
        402,
        { status: res.status }
      );
    }
    return parsed as T;
  }

  return {
    async createOrder({ amountPaise, receipt, notes }: CreateOrderInput): Promise<RazorpayOrder> {
      if (!Number.isInteger(amountPaise)) {
        // The one invariant this module owns. A non-integer here means a caller
        // skipped `parseNumeric()` and a float is on its way to a charge.
        throw new TypeError(`amountPaise must be an integer number of paise, got ${amountPaise}`);
      }
      return call<RazorpayOrder>('POST', '/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt,
        ...(notes ? { notes } : {}),
      });
    },

    fetchOrder(orderId: string): Promise<RazorpayOrder> {
      return call<RazorpayOrder>('GET', `/orders/${encodeURIComponent(orderId)}`);
    },

    listPaymentsForOrder(orderId: string): Promise<{ count: number; items: unknown[] }> {
      return call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
    },

    async createRefund({ paymentId, amountPaise, speed }: CreateRefundInput) {
      if (amountPaise !== undefined && !Number.isInteger(amountPaise)) {
        throw new TypeError(`amountPaise must be an integer number of paise, got ${amountPaise}`);
      }
      return call('POST', `/payments/${encodeURIComponent(paymentId)}/refunds`, {
        ...(amountPaise === undefined ? {} : { amount: amountPaise }),
        ...(speed ? { speed } : {}),
      });
    },
  };
}
