import { readApiError } from './api';
import { authorizationHeader } from './sessionHeaders';
import { BookingApiError } from './bookingClient';

/**
 * The browser's half of the Phase 3 payment contract (§12.1, §12.2, §31.2).
 *
 * ## Why this module exists, and why it reuses `BookingApiError`
 *
 * The callback payload a customer is one click from paying with is the same
 * shape as the one the booking screen already handles, so payment reuses the
 * booking error type — one error vocabulary for the money half of the product,
 * not a second class that renders differently by accident. What this module adds
 * is the hard rule made testable:
 *
 * **The Razorpay `handler` callback never produces a `paid` state.** It fires
 * the moment the gateway closes its window, and a webhook can still be seconds
 * away — §12.1 is explicit that "paid" may not be claimed until the payment row
 * says `success`. Everything the handler *may* do is start `verifyPayment` and
 * begin polling `fetchPayment`; the only thing that may render "paid" is
 * `paymentDisplayState('success')`. The test for that feeds the handler payload
 * into the display logic and asserts the result is `confirming`, never `paid`.
 *
 * ## The `Authorization` header
 *
 * `request` resolves `authorizationHeader()` before the fetch, exactly like
 * `lib/bookingClient.ts` — the Phase 2 lesson where a client with
 * `credentials: 'include'` and no header looked signed in and was not. A missed
 * header here is worse than a 401: it would show on a screen that is visibly
 * processing a real payment.
 */

// ── Types ────────────────────────────────────────────────────

/** What the checkout screen may claim about a payment. `paid` is a fact the
 * webhook put on the row; the other two are states before or around it. */
export type PaymentDisplayState = 'confirming' | 'paid' | 'failed';

/** The payment row as `GET /api/payments/[id]` projects it (§4.5). */
export interface PaymentRow {
  id: string;
  bookingId: string;
  status: string;
  amount: number;
  currency: string;
  method: string | null;
  failureReason: string | null;
  capturedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentOrderResult {
  paymentId: string;
  orderId: string;
  keyId: string;
  amount: number;
  currency: string;
}

export interface CheckoutSignaturePayload {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

// ── Shared call ─────────────────────────────────────────────

/**
 * One authenticated call, in the same shape as `bookingClient.ts`'s.
 *
 * The idempotency key policy is the caller's: `createPaymentOrder` needs one
 * per *attempt*, where "attempt" is bounded by the caller's confidence that the
 * previous order-create actually landed. A network error must retry with the
 * same key (the order may exist); a gateway refusal (`402 PAYMENT_FAILED`) has
 * definitely not charged anyone and a fresh key is safe.
 */
async function request<T>(
  url: string,
  init?: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const auth = await authorizationHeader();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
        ...auth,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new BookingApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new BookingApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

// ── Calls ───────────────────────────────────────────────────

/**
 * Create the Razorpay order the checkout opens.
 *
 * Requires `idempotencyKey`, exactly as the route requires the header: a second
 * tap on a slow connection must not create a second charge attempt. A
 * `PAYMENT_FAILED` here carries the gateway's own words — the server stored
 * them in `payments.failure_reason` before refusing — so the button may say
 * what the gateway said instead of a fake success.
 */
export function createPaymentOrder(
  input: { bookingId: string; expectedTotal?: number | null },
  idempotencyKey: string
): Promise<PaymentOrderResult> {
  return request<PaymentOrderResult>('/api/payments/create-order', {
    method: 'POST',
    idempotencyKey,
    body: JSON.stringify({
      bookingId: input.bookingId,
      expectedTotal: input.expectedTotal ?? null,
    }),
  });
}

/**
 * The Checkout handler's one real job: prove the signature we were handed and
 * read what the webhook (so far) says. Writes nothing itself.
 */
export function verifyPayment(payload: CheckoutSignaturePayload): Promise<{
  verified: boolean;
  status: string;
  paymentId: string;
}> {
  return request('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** One poll of the row the webhook is authoritative over. */
export function fetchPayment(id: string): Promise<{ payment: PaymentRow }> {
  return request<{ payment: PaymentRow }>(`/api/payments/${encodeURIComponent(id)}`);
}

/**
 * The hard rule, as a pure function: is `paid` reachable from this status?
 *
 * `success` (and the refund states a row can hold after the fact) yes —
 * nothing else. `created`/`pending` map to `confirming`, and `failed` maps to
 * `failed`. An unknown status maps to `confirming` on purpose: when in doubt
 * the screen must under-claim, because an over-claimed "paid" is a customer
 * standing on a doorstep whose job was never booked.
 */
export function paymentDisplayState(status: string): PaymentDisplayState {
  if (status === 'success' || status === 'refunded' || status === 'partially_refunded') {
    return 'paid';
  }
  if (status === 'failed') return 'failed';
  return 'confirming';
}