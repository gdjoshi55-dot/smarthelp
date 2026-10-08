import { ApiHttpError, handle, ok } from '@/lib/api';
import { requireCustomer } from '@/lib/addressServer';
import { getPaymentForCaller } from '@/lib/paymentServer';
import { verifyCheckoutSignature } from '@/lib/razorpaySignature';
import { createServerClient } from '@/lib/supabaseServer';
import { readJson, str } from '@/lib/validation';
import type { Payment } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payments/verify — the Checkout callback's signature check, and
 * **nothing else** (§25.8).
 *
 * The hard rule this route exists to satisfy is "no client-reachable path writes
 * `payments.status = 'success'`". So the route *reads*. It verifies that
 * Razorpay really did hand this browser `{ order_id, payment_id }` for a payment
 * made with our key secret, looks the row up, and answers with the status the
 * **webhook** put there. It does not store `gateway_payment_id`, does not nudge
 * `pending` to `success`, does not call `confirm_booking_payment`. A test in
 * `test/routes.payments.test.ts` asserts `payments.status` and
 * `bookings.status` are identical before and after a valid call.
 *
 * Why bother, if the webhook is the authority? Because the browser needs to know
 * what to show *now*: the checkout `handler` fires within a second of the customer
 * paying and the webhook can take a few more. The answer this route gives is
 * "verified, and the status is `created`" — which is exactly the state
 * `lib/paymentClient.ts` maps to "Confirming payment…". If the webhook has
 * already landed, it says `success`. Either way it is a read of a fact the
 * webhook owns, never a claim of its own.
 *
 * Verified-then-unauthorised is still refused: a correct signature proves
 * Razorpay issued the pair, not that the caller owns the payment, so the row
 * goes through `getPaymentForCaller` like every other read of one.
 */
export async function POST(req: Request) {
  return handle(req, 'payments.verify', async () => {
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

    // The one thing this route does: report the row as the webhook left it.
    return ok({ verified: true, status: payment.status, paymentId: payment.id });
  });
}
