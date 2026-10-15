import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { getPaymentForCaller, paymentAmountPaise } from '@/lib/paymentServer';
import { verifyCheckoutSignature } from '@/lib/razorpaySignature';
import { createServerClient } from '@/lib/supabaseServer';
import { notifyBookingConfirmed } from '@/lib/notificationHooks';
import { readJson, str } from '@/lib/validation';
import type { Payment } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payments/verify — the Checkout callback's signature check, and the
 * confirmation of a booking payment (§12.1, §25.8).
 *
 * ## Why this route writes now
 *
 * Phase 3 held that "no client-reachable path writes `payments.status =
 * 'success'`": the webhook and the reconciliation cron were the only writers.
 * That is correct and safe, and it is also the bug the checkout screen kept
 * showing. The webhook cannot reach a deployment it cannot see — a laptop, a
 * preview, any host Razorpay has no route to — and `CRON_SECRET` may be unset,
 * so neither writer ever runs. The customer pays, Razorpay's `handler` fires,
 * and the row sits at `created` forever while the screen says "Confirming
 * payment…". The money arrived; nothing wrote it down.
 *
 * The signature is what makes the write safe, and it is the same argument the
 * webhook makes. Razorpay's Checkout `handler` is handed `{ order_id,
 * payment_id, signature }` where the signature is HMAC-SHA256 over
 * `order_id + '|' + payment_id` with the **key secret** — a server-only value —
 * so possessing a signature that verifies under it proves Razorpay issued the
 * pair for this browser, not that the client invented one. (That is why the
 * message is `order_id|payment_id` and not the request body: the route does not
 * trust anything the client can choose.) A successful Checkout only reaches the
 * `handler` after authorisation, so a valid signature is gateway truth in
 * exactly the sense the webhook's header signature is.
 *
 * ## What it does, in order
 *
 *   1. `requireCustomer` — a payment is a `customers.id` aggregate.
 *   2. Verify the checkout signature; a mismatch is `402 PAYMENT_NOT_VERIFIED`,
 *      before any row is touched.
 *   3. Look the row up by `gateway_order_id`, then pass it through
 *      `getPaymentForCaller`: the signature is not ownership, so verifying
 *      somebody else's order id is still `403`.
 *   4. If the row is still awaiting money (`created`/`pending`) and has a
 *      booking, call `confirm_booking_payment()` — **the single writer** (0014),
 *      the same function the webhook and the cron call. It moves the payment to
 *      `success` and the booking to `paid` in one transaction, and its
 *      `status in ('created','pending')` guard makes a concurrent webhook a
 *      no-op rather than a double write. A `null` return means someone else
 *      won the race, so the row is re-read for its real status.
 *   5. Report `{ verified, status, paymentId }`, where `status` is now the
 *      confirmed fact. The browser's poll of `GET /api/payments/[id]` sees
 *      `success` and the screen reaches `paid`.
 *
 * A row already `success` (or `refunded`) is left alone: the write is skipped
 * and the current status is reported, so a retry of the `handler` is a read.
 */
export async function POST(req: Request) {
  return handle(req, 'payments.verify', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);

    const body = await readJson(req);
    const orderId = str(body.razorpay_order_id, 'razorpay_order_id', { max: 64 });
    const paymentId = str(body.razorpay_payment_id, 'razorpay_payment_id', { max: 64 });
    const signature = str(body.razorpay_signature, 'razorpay_signature', { max: 128 });

    // Read at request time, like the webhook's secret: no `RAZORPAY_*` variable
    // is inlined by vitest, and a deployment with no key secret is a
    // configuration problem rather than a failed verification.
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      throw new ApiHttpError(
        'SERVICE_UNAVAILABLE',
        'Online payment is not configured on this deployment yet. Please try again later.',
        422,
        { missing: 'RAZORPAY_KEY_SECRET' }
      );
    }

    // HMAC-SHA256 over `order_id + '|' + payment_id` with the *key* secret —
    // a different message and a different key from the webhook's header
    // signature. Both algorithms live in `lib/razorpaySignature.ts`.
    if (!verifyCheckoutSignature(orderId, paymentId, secret, signature)) {
      throw new ApiHttpError(
        'PAYMENT_NOT_VERIFIED',
        'This payment could not be verified. Please try again or use a different payment method.',
        402,
        { reason: 'signature_mismatch' }
      );
    }

    const supabase = createServerClient();
    const { data: row, error } = await supabase
      .from('payments')
      .select('*')
      .eq('gateway', 'razorpay')
      .eq('gateway_order_id', orderId)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      throw new ApiHttpError('NOT_FOUND', 'No payment exists for that order.', 404);
    }

    // The signature is not ownership. `payments` has no UPDATE policy for a
    // reason, and a caller who verified somebody else's order id must not be
    // handed its status either.
    const payment = (await getPaymentForCaller(
      (row as Payment).id,
      customer.id,
      auth.role
    )) as Payment;

    let status = payment.status;
    const awaiting = payment.status === 'created' || payment.status === 'pending';

    if (awaiting && payment.booking_id) {
      // One statement, one transaction: the payment and the booking move
      // together or not at all. The replay guard is inside the function, so a
      // webhook arriving at the same moment is a no-op rather than a second
      // `captured_at`.
      const { data: confirmed, error: confirmError } = await supabase.rpc(
        'confirm_booking_payment',
        {
          p_payment_id: payment.id,
          p_gateway_order_id: orderId,
          p_booking_id: payment.booking_id,
          p_gateway_payment_id: paymentId,
          p_gateway_signature: signature,
          p_note: `payment confirmed by checkout callback (${paymentId})`,
        }
      );
      if (confirmError) throw confirmError;

      if (confirmed) {
        status = (confirmed as Payment).status;
        await audit(supabase, {
          // This one *does* have an actor: the customer whose browser the
          // Checkout callback returned to. `write_audit` stamps the role from
          // the database, so the row says who confirmed it and how.
          actorProfileId: auth.userId,
          action: 'payment.callback.confirmed',
          entityType: 'payments',
          entityId: payment.id,
          metadata: {
            bookingId: payment.booking_id,
            gatewayPaymentId: paymentId,
            amount_paise: paymentAmountPaise(payment),
            currency: payment.currency,
          },
          requestId,
          ipAddress: clientIp(req),
        });
        // The catalogue's BOOKING_CONFIRMED (§27.5). Quiet by design: it can
        // never fail this route (§28.4).
        if (payment.booking_id) await notifyBookingConfirmed(payment.booking_id);
      } else {
        // The guard refused: the webhook (or an earlier callback) confirmed the
        // row between the read above and this call. The row is correct either
        // way, so report what it actually says rather than the stale read.
        const current = (await getPaymentForCaller(
          payment.id,
          customer.id,
          auth.role
        )) as Payment;
        status = current.status;
      }
    }

    return ok({ verified: true, status, paymentId: payment.id });
  });
}
