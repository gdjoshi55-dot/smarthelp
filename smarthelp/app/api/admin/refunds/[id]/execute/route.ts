import { ApiHttpError, handle, ok } from '@/lib/api';
import { clientIp } from '@/lib/audit';
import { executePendingRefund } from '@/lib/refundServer';
import { notifyRefundProcessed } from '@/lib/notificationHooks';
import { createServerClient } from '@/lib/supabaseServer';
import { getPlatformSettings } from '@/lib/settingsServer';
import { toPaise, parseNumeric } from '@/lib/money';
import { optionalStr, requireCapability, uuid } from '@/lib/validation';
import type { RefundStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXECUTABLE: readonly RefundStatus[] = ['requested', 'approved'];

/**
 * POST /api/admin/refunds/:id/execute — §25.10's approver (§22, §31.1).
 *
 * `refund.execute` is the gate. An above-limit refund was left `requested` by
 * `requestRefund` precisely so an approver could stamp it; this route is that
 * stamp. Dual approval (§22): above `supportRefundLimit` the approver must be
 * someone other than whoever requested the refund, or the second stamp is not
 * a second person at all.
 *
 * Everything after the state check is `executePendingRefund`'s job — gateway
 * first, wallet on a definite refusal, an ops ticket if the gateway is
 * unreachable — and it audits `refund.approved_and_completed` itself.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.refunds.execute', async (requestId) => {
    const auth = await requireCapability(req, 'refund.execute');
    const refundId = uuid(params.id, 'id');

    const body = await readBody(req);
    const note = optionalStr(body.note, 'note', { max: 500 });

    const supabase = createServerClient();

    const { data: refund, error } = await supabase
      .from('refunds')
      .select('*')
      .eq('id', refundId)
      .maybeSingle();
    if (error) throw error;
    if (!refund) {
      throw new ApiHttpError('NOT_FOUND', 'That refund was not found.', 404);
    }
    if (!EXECUTABLE.includes(refund.status)) {
      throw new ApiHttpError(
        'INVALID_STATE',
        `A ${refund.status} refund cannot be executed.`,
        409
      );
    }

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('*')
      .eq('id', refund.payment_id)
      .maybeSingle();
    if (paymentError) throw paymentError;
    if (!payment) {
      throw new ApiHttpError('NOT_FOUND', 'The payment for this refund was not found.', 404);
    }

    const settings = await getPlatformSettings(supabase);
    const aboveLimit =
      toPaise(parseNumeric(refund.amount)) > toPaise(settings.supportRefundLimit);

    if (aboveLimit && refund.requested_by === auth.userId) {
      throw new ApiHttpError(
        'SECOND_APPROVER_REQUIRED',
        'This refund is above the support limit and was requested by you, so a different staff member must approve it.',
        422
      );
    }

    const completed = await executePendingRefund({
      supabase,
      refund,
      payment,
      processedBy: auth.userId,
      supportRefundLimit: settings.supportRefundLimit,
      note,
      fetch,
      requestId,
      ipAddress: clientIp(req),
    });

    // The customer hears the money moved (§27.5 REFUND_PROCESSED).
    if (payment.booking_id) {
      const route = (refund as { route?: string | null }).route ?? 'your original payment method';
      await notifyRefundProcessed(payment.booking_id, `₹${refund.amount}`, route);
    }

    return ok({ refund: completed });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}