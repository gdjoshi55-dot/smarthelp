import { handle, ok, created, ApiHttpError } from '@/lib/api';
import {
  num,
  optionalStr,
  parsePaging,
  requireAuth,
  requireCapability,
  str,
  uuid,
} from '@/lib/validation';
import { requireCustomer } from '@/lib/addressServer';
import { clientIp } from '@/lib/audit';
import { parseNumeric, rupees, toPaise } from '@/lib/money';
import { isStaffRole } from '@/lib/roles';
import {
  executeRefund,
  planRefund,
  requestRefund,
} from '@/lib/refundServer';
import { createServerClient } from '@/lib/supabaseServer';
import type { Payment, Refund } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/refunds — an agent asks for money back (§12.3, §25.10).
 *
 * The rules themselves live in `lib/refundServer.ts`; this route is the doorway
 * and nothing else. `requireCapability('refund.request')` is the only gate, and
 * it is the reason a *support* agent can execute a refund at or below ₹1500 and
 * only *request* one above it: the same grant lets both happen, and the limit —
 * not a second role — decides which. `ops`/`admin`/`super_admin` hold
 * `refund.execute` as well, and `planRefund()` reads the limit for all of them
 * alike.
 *
 * **The amount is rupees in the body, paise in the arithmetic, `numeric` in the
 * column.** `lib/refundServer.ts` converts exactly once; this route must not
 * multiply by 100 anywhere, or a ₹15 refund becomes a ₹1500 one.
 *
 * **Above the limit the row is created but not executed.** `requestRefund()`
 * writes a `requested` row directly (never `record_booking_refund()`, which
 * would hop a still-paid booking to `refund_pending`). Executing waits for
 * Phase 6's approver endpoint. That is why the answer is `202`, distinct from
 * the `201` an executed refund returns — the client can tell "money moved" from
 * "queued" without parsing a sentence.
 *
 * The payload is a projection. `gateway_signature` never appears — it is
 * dispute evidence under §12.2 and belongs in the database, redacted, in the
 * audit trail.
 */
export async function POST(req: Request) {
  return handle(req, 'refunds.post', async (requestId) => {
    const auth = await requireCapability(req, 'refund.request');
    const body = await req.json().catch(() => ({}));

    const paymentId = uuid((body as any).paymentId, 'paymentId');
    const amountRupees = num((body as any).amount, 'amount', { min: 0 });
    const amountPaise = toPaise(amountRupees);
    if (amountPaise <= 0) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Enter an amount to refund.', 400, {
        fields: { amount: 'Must be more than zero' },
      });
    }
    const reasonCode = str((body as any).reasonCode ?? 'customer_request', 'reasonCode', {
      max: 60,
    });
    const note = optionalStr((body as any).note, 'note', { max: 500 });

    const supabase = createServerClient();
    const { data: payment, error } = await supabase
      .from('payments')
      .select('*')
      .eq('id', paymentId)
      .maybeSingle();
    if (error) throw error;
    if (!payment) {
      throw new ApiHttpError('NOT_FOUND', 'Payment not found', 404, { paymentId });
    }

    const plan = planRefund({ payment: payment as Payment, amountPaise });

    if (plan.execute) {
      const refund = await executeRefund({
        supabase,
        payment: payment as Payment,
        amountPaise,
        reasonCode,
        note,
        requestedBy: auth.userId,
        requestId,
        ipAddress: clientIp(req),
      });
      return created({ refund: present(refund) });
    }

    const refund = await requestRefund({
      supabase,
      payment: payment as Payment,
      amountPaise,
      reasonCode,
      note,
      requestedBy: auth.userId,
      requestId,
      ipAddress: clientIp(req),
    });
    return ok({ refund: present(refund), heldForApproval: true }, 202);
  });
}

/**
 * GET /api/refunds — the refunds a caller is allowed to see.
 *
 * Staff see the table (optionally narrowed by `?customerId=` and `?status=`); a
 * customer sees only their own. The filter is applied server-side from the
 * resolved `customers.id`, never from a query string a customer could set to
 * somebody else's id — the same reason every other read in this tree checks
 * ownership despite the RLS policy: Route Handlers reach Postgres as the service
 * role, which bypasses RLS.
 */
export async function GET(req: Request) {
  return handle(req, 'refunds.get', async () => {
    const auth = await requireAuth(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const supabase = createServerClient();

    let query = supabase
      .from('refunds')
      .select('*')
      .order('requested_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (isStaffRole(auth.role)) {
      const customerFilter = url.searchParams.get('customerId');
      if (customerFilter) query = query.eq('customer_id', uuid(customerFilter, 'customerId'));
    } else {
      const { customer } = await requireCustomer(req);
      query = query.eq('customer_id', customer.id);
    }

    const status = url.searchParams.get('status');
    if (status) {
      query = query.eq('status', str(status, 'status', { max: 30 }) as NonNullable<Refund['status']>);
    }

    const { data, error } = await query;
    if (error) throw error;

    return ok({ refunds: ((data ?? []) as Refund[]).map(present) });
  });
}

/** Rupees out, `gateway_signature` never — the one projection both verbs share. */
function present(refund: Refund) {
  return {
    id: refund.id,
    paymentId: refund.payment_id,
    bookingId: refund.booking_id,
    customerId: refund.customer_id,
    amount: rupees(toPaise(parseNumeric(refund.amount))),
    currency: refund.currency,
    status: refund.status,
    route: refund.route,
    reasonCode: refund.reason_code,
    note: refund.note,
    gatewayRefundId: refund.gateway_refund_id,
    requestedBy: refund.requested_by,
    processedBy: refund.processed_by,
    approvedBy: refund.approved_by,
    requestedAt: refund.requested_at,
    completedAt: refund.completed_at,
  };
}
