import { NextRequest } from 'next/server'
import { ok, err } from '@/lib/api'
import { uuid, str } from '@/lib/validation'
import { requireCapability } from '@/lib/validation'
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer'
import { quoteCancellation } from '@/lib/cancellation'
import { isCancellationReason } from '@/lib/status'
import { createServerClient } from '@/lib/supabaseServer'
import { parseNumeric } from '@/lib/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireCapability(req, 'booking.cancel.own')
    const { auth, customerId } = await requireBookingCustomer(req)
    const id = uuid(params.id, 'id')
    const body = await req.json().catch(() => ({}))
// The codes come from `status.ts`, which already holds §16's list the cancel
    // dialog renders. A second list here would be a second thing to forget to update.
    const reasonCode = str(body.reasonCode || 'changed_mind', 'reasonCode', { max: 60 })
    const freeText = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

    if (!isCancellationReason(reasonCode)) {
      return err('VALIDATION_ERROR', 'Choose a cancellation reason.', 400, {
        fields: { reasonCode: 'Not a recognised reason' },
      })
    }

    // Ownership first. `transitionBooking` guards the *state machine*, not who is
    // asking, and the service-role client bypasses RLS — so without this check
    // any signed-in session could cancel any booking whose id it could name.
    const booking = await getBookingForCaller(id, customerId, auth.role)

    // Idempotent in the friendly direction: a customer who taps Cancel twice
    // means "cancel it", not "charge me twice". The fee is never re-derived on a
    // second press — the row already holds the one that was charged.
    if (booking.status === 'cancelled') {
      return ok({
        booking,
        cancellationFee: parseNumeric(booking.cancellation_fee),
        alreadyCancelled: true,
      })
    }

    // §11.1's ladder, against the amount actually captured. A Phase 2 booking has
    // captured nothing, so `total_amount` is the basis and the fee is what the
    // customer would owe were this paid — stated before they confirm, not
    // discovered afterwards.
    const scheduledStart = booking.scheduled_start_at ? new Date(booking.scheduled_start_at) : null
    const hoursBefore = scheduledStart
      ? (scheduledStart.getTime() - Date.now()) / 3_600_000
      : Number.POSITIVE_INFINITY

    const fee = quoteCancellation({
      amount: parseNumeric(booking.total_amount),
      hoursBefore,
      arrived: booking.arrived_at != null,
      cancelledBy: 'customer',
    })

    const supabase = createServerClient()

    // One statement for the facts and the move. These were two requests — annotate
    // the fee, then transition — so a failure between them left a booking that read
    // `cancelled` with no fee and no reason against it, which is the shape of a
    // refund dispute. The function is still the trigger's: it writes `status`, and
    // `enforce_booking_transition()` still decides whether the move is legal, and
    // records the actor that this route has already authenticated.
    const { data: cancelled, error: cancelError } = await supabase.rpc('cancel_booking', {
      p_booking_id: id,
      p_expected_version: booking.version,
      p_reason_code: reasonCode,
      p_fee: Number(fee.fee.toFixed(2)),
      p_note: `${reasonCode}${freeText ? `: ${freeText}` : ''}`,
      p_actor: auth.userId,
      p_actor_role: auth.role,
    })

    if (cancelError) throw cancelError
    if (!cancelled) {
      return err(
        'STALE_VERSION',
        'This booking changed while you were looking at it. Reload and try again.',
        409
      )
    }

    // `notes` is deliberately untouched: the customer's free text is their booking
    // note, and the function does not overwrite it. The reason has its own column
    // and the free text goes into the history note, so nothing is lost.
    const result = cancelled

    return ok({
      booking: result,
      cancellationFee: fee.fee,
      refund: fee.refund,
      band: fee.band,
      waived: fee.waived,
    })
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to cancel booking', 500)
  }
}