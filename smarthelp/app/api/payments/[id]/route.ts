import { handle, ok } from '@/lib/api';
import { requireCustomer } from '@/lib/addressServer';
import { getPaymentForCaller, paymentAmountPaise } from '@/lib/paymentServer';
import { rupees } from '@/lib/money';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/payments/[id] — one payment, its owner's own (§25.4).
 *
 * This is what the checkout screen polls while the webhook lands, so it is one
 * query and one ownership check, and nothing else: no booking join, no child
 * rows, no gateway call.
 *
 * `getPaymentForCaller` is required even though `payments` has a
 * `payments_select_own` policy, for the reason `test/routes.bookings.test.ts`
 * states in its header — every Route Handler here reaches Postgres through
 * `createServerClient()`, and the service role bypasses RLS entirely. Without it
 * a payment id a caller chose would be enough to read any payment in the table.
 *
 * The payload is a projection, not the row. `gateway_signature` is dispute
 * evidence under §12.2 and belongs in the database and in the audit trail
 * (redacted), not in a browser response, and `idempotency_key` is server state
 * — so neither is here, nor is anything else the client has no use for.
 * `amount` is rupees, like every other money figure this API returns.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'payments.get', async () => {
    const { auth, customer } = await requireCustomer(req);
    const payment = await getPaymentForCaller(uuid(params.id, 'id'), customer.id, auth.role);

    return ok({
      payment: {
        id: payment.id,
        bookingId: payment.booking_id,
        status: payment.status,
        amount: rupees(paymentAmountPaise(payment)),
        currency: payment.currency,
        method: payment.method,
        failureReason: payment.failure_reason,
        capturedAt: payment.captured_at,
        createdAt: payment.created_at,
        updatedAt: payment.updated_at,
      },
    });
  });
}
