import { ApiHttpError, handle, ok } from '@/lib/api';
import { clientIp } from '@/lib/audit';
import { audit } from '@/lib/audit';
import { quoteCancellation } from '@/lib/cancellation';
import { numericLiteral, parseNumeric, toPaise } from '@/lib/money';
import { optionalStr, requireCapability, str, uuid } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import type { BookingStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/bookings/:id/cancel — cancel on behalf of ops (§11.1, §20.12).
 *
 * `booking.cancel.any` is the gate: ops, admin and super_admin hold it; support
 * does not, which is why a support agent cancels by asking ops rather than by
 * being handed the capability.
 *
 * The fee is computed here with the same `quoteCancellation()` the customer
 * path uses, so the two can never disagree about what a cancellation costs.
 * §11.2's waiver is the parameter: an ops cancellation is not the customer's
 * fault, so the default is to waive. `chargeCustomer: true` applies §11.1's
 * ladder instead, for the case where the customer asked for it offline.
 *
 * The withdrawal of the holding professional and the release of their calendar
 * happen inside `admin_cancel_booking` (0034), in the same statement — a
 * cancelled booking must not leave a professional's slot reserved.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.bookings.cancel', async (requestId) => {
    const auth = await requireCapability(req, 'booking.cancel.any');
    const bookingId = uuid(params.id, 'id');

    const body = await readBody(req);
    const reasonCode = str(body.reasonCode ?? 'ops_cancelled', 'reasonCode', { max: 60 });
    const note = optionalStr(body.note, 'note', { max: 500 });
    const chargeCustomer = body.chargeCustomer === true;

    const supabase = createServerClient();
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('id, status, total_amount, scheduled_start_at, arrived_at')
      .eq('id', bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) {
      throw new ApiHttpError('NOT_FOUND', 'That booking was not found.', 404);
    }

    const hoursBefore = booking.scheduled_start_at
      ? (Date.parse(booking.scheduled_start_at) - Date.now()) / 3_600_000
      : Number.POSITIVE_INFINITY;

    const quote = quoteCancellation({
      amount: parseNumeric(booking.total_amount),
      hoursBefore,
      arrived: booking.arrived_at != null,
      cancelledBy: chargeCustomer ? 'customer' : 'ops',
    });

    const { data: cancelled, error: rpcError } = await supabase.rpc('admin_cancel_booking', {
      p_booking_id: bookingId,
      p_reason_code: reasonCode,
      p_fee: numericLiteral(toPaise(quote.fee)),
      p_note: note,
      p_actor: auth.userId,
      p_actor_role: auth.role,
    });
    if (rpcError) {
      // 0011's trigger raises ILLEGAL_TRANSITION for a move §8.2 does not allow
      // (a completed job, a booking already refunded). That is a 409, not a 500:
      // the request was well-formed, the state refused it.
      if (rpcError.code === 'P0001' || /ILLEGAL_TRANSITION/.test(rpcError.message)) {
        throw new ApiHttpError('ILLEGAL_TRANSITION', 'This booking cannot be cancelled in its current state.', 409);
      }
      throw rpcError;
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'booking.cancel_admin',
      entityType: 'booking',
      entityId: bookingId,
      before: { status: booking.status as BookingStatus },
      after: { status: 'cancelled', reasonCode, fee: quote.fee, waived: quote.waived, band: quote.band },
      metadata: { note, chargeCustomer },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({
      booking: cancelled,
      fee: quote.fee,
      refund: quote.refund,
      waived: quote.waived,
      band: quote.band,
    });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
