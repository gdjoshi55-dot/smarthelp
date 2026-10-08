import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { clientIp } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { getBookingForCaller } from '@/lib/bookingServer';
import { readIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { rupees, toPaise } from '@/lib/money';
import {
  bookingAmountPaise,
  createBookingOrder,
  type CreateOrderResult,
} from '@/lib/paymentServer';
import { readJson, uuid } from '@/lib/validation';
import type { Booking } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payments/create-order — one charge attempt, one row (§25.8, §12.1).
 *
 * The order of decisions here is the whole route:
 *
 *   1. caller    `requireCustomer`, because `payments.customer_id` is a
 *                `customers.id` and is not null — a professional or an admin
 *                with no customer row is refused before anything is read.
 *   2. ownership `getBookingForCaller`. The service-role client bypasses RLS,
 *                so a booking id is otherwise a number a caller simply chooses.
 *   3. state     `payment_pending` only: a paid or cancelled booking never gets
 *                a second order, and the message says which one it is.
 *   4. quote     `bookings.quote_token IS NOT NULL` — **presence, not freshness.**
 *   5. price     `expectedTotal`, compared against `bookings.total_amount` in
 *                paise. The client's figure is never stored and never wins.
 *   6. idempotency `Idempotency-Key` is *required* (§25.8).
 *   7. write     `createBookingOrder()` — row, gateway, order id, audit.
 *
 * Steps 2–5 are read-only and deliberately happen *before* the ledger claim.
 * `claim_idempotency_key()` marks a key claimed the moment it is spent, and
 * `withIdempotency` only completes it when `run()` returns: a request refused
 * from inside `run()` would leave `completed_at` null and every later retry on
 * that key answering `in_flight`. That is the same reason `app/api/bookings/route.ts`
 * prices before it claims — a request that could never have succeeded should not
 * spend a customer's key.
 *
 * ## The quoteToken decision (STATE.md's first open item)
 *
 * **Presence is asserted, freshness is not.** The token carries a 15-minute
 * `exp`, and re-verifying it would either reject a legitimate `payment.captured`
 * arriving later (violating "the webhook is the sole authority") or require
 * re-quoting at checkout, which charges a total the customer did not agree to.
 * What this route consumes instead is the attestation Phase 2 stored when the
 * booking was created: *this booking was priced by our engine from a signed
 * quote*. So:
 *
 *   - `quote_token IS NULL` ⇒ `409 INVALID_STATE`, told to re-quote. A booking
 *     created without a token (Phase 2 tolerates that for a hand-rolled request)
 *     has nothing for the payment to attest to, and §7.2's chain is quote →
 *     token → booking → order. It can still be cancelled.
 *   - present but 40 minutes old ⇒ accepted, because freshness gates nothing
 *     here; the total was frozen at creation either way.
 *   - **nulled by the webhook**, inside `confirm_booking_payment`, which makes
 *     the token single-use across the payment lifecycle. This route never clears
 *     it: a retry after an abandoned checkout has to find it still there.
 *
 * The amount never comes from the body. `bookings.total_amount` was frozen at
 * creation (§16, #19), so it is the figure the order is built from, and a
 * client-sent `amount` field is not read at all — `test/routes.payments.test.ts`
 * proves that from the other side, the way `test/routes.bookings.test.ts` proves
 * it for bookings.
 */
export async function POST(req: Request) {
  return handle(req, 'payments.create.order', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);

    const body = await readJson(req);
    const bookingId = uuid(body.bookingId, 'bookingId');
    const expectedTotal = parseExpectedTotal(body.expectedTotal);

    const booking = (await getBookingForCaller(bookingId, customer.id, auth.role)) as Booking;
    assertChargeable(booking, expectedTotal);

    const key = readIdempotencyKey(req);
    const outcome = await withIdempotency<CreateOrderResult>({
      key,
      operation: 'payments.create.order',
      actorProfileId: auth.userId,
      // The validated values, not the raw text: whitespace must not spend a
      // customer's key, and two payloads differing in a real field must not look
      // identical. See `lib/idempotency.ts`.
      payload: { bookingId: booking.id, expectedTotal },
      required: true,
      run: async () => ({
        status: 201,
        body: await createBookingOrder({
          booking,
          customerId: customer.id,
          // `required: true` refuses a missing key before `run` is ever called,
          // so this is never null where it is used.
          idempotencyKey: key as string,
          actorProfileId: auth.userId,
          requestId,
          ipAddress: clientIp(req),
        }),
      }),
    });

    if (outcome.kind === 'rejected') return outcome.response;
    if (outcome.kind === 'replay') return ok(outcome.body, outcome.status, outcome.headers);
    return created(outcome.body, outcome.headers);
  });
}

/**
 * The three refusals, in the order a customer meets them.
 *
 * Status is checked before the token on purpose. The webhook nulls
 * `quote_token` when it confirms a payment, so a *paid* booking has a null token
 * as well; asking such a booking for a re-quote would answer "refresh the price"
 * to somebody who has already paid. Status first means each message names the
 * thing that is actually wrong.
 */
function assertChargeable(booking: Booking, expectedTotal: number | null): void {
  if (booking.status !== 'payment_pending') {
    throw new ApiHttpError(
      'INVALID_STATE',
      booking.status === 'paid'
        ? 'This booking has already been paid for.'
        : 'This booking is not waiting for payment.',
      409,
      { status: booking.status }
    );
  }

  if (!booking.quote_token) {
    throw new ApiHttpError(
      'INVALID_STATE',
      'This booking has no quote attached, so its total cannot be verified. Refresh the price and create a new booking to continue.',
      409,
      { fields: { quoteToken: 'Re-quote this booking before paying' } }
    );
  }

  if (expectedTotal === null) return;

  const actual = bookingAmountPaise(booking);
  const expected = toPaise(expectedTotal);
  if (expected === actual) return;

  throw new ApiHttpError(
    'PRICE_CHANGED',
    'The price changed while you were deciding. Please review the new total.',
    409,
    { previousTotal: expectedTotal, currentTotal: rupees(actual) }
  );
}

/**
 * The total the customer was shown, or null when they sent none.
 *
 * Compared, never stored. A client that sends no total is still charged the
 * booking's own figure — the comparison exists to catch a stale screen, not to
 * make the total optional on the server.
 */
function parseExpectedTotal(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiHttpError('VALIDATION_ERROR', 'The quoted total is not valid.', 400, {
      fields: { expectedTotal: 'Not a valid amount' },
    });
  }
  return n;
}
