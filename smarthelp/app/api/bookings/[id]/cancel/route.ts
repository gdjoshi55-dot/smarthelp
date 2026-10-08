import { NextRequest } from 'next/server'
import { ok, err } from '@/lib/api'
import { uuid, str } from '@/lib/validation'
import { requireCapability } from '@/lib/validation'
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer'
import { quoteCancellation } from '@/lib/cancellation'
import { isCancellationReason } from '@/lib/status'
import { createServerClient } from '@/lib/supabaseServer'
import { paymentAmountPaise } from '@/lib/paymentServer'
import { executeRefund } from '@/lib/refundServer'
import { clientIp } from '@/lib/audit'
import { parseNumeric, toPaise } from '@/lib/money'
import type { Payment } from '@/lib/supabase'

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

    // §11.1's refund, actually paid out. `quoteCancellation` says what the fee
    // is and what would be owed back; when money was truly captured, "would be
    // owed" has to become a refund rather than a number in a JSON body. The
    // automatic refund is never held for approval — `executeRefund` runs
    // `planRefund({ auto: true })` — because there is no human asking for it and
    // a cancelled booking must not be stranded waiting for one.
    const autoRefund = await refundIfPaid(supabase, id, fee.fee, req)

    return ok({
      booking: result,
      cancellationFee: fee.fee,
      refund: fee.refund,
      band: fee.band,
      waived: fee.waived,
      autoRefund,
    })
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to cancel booking', 500)
  }
}

/**
 * Give back what a paid-then-cancelled booking is owed, or nothing.
 *
 * A booking with no captured payment (the common Phase 2 case, and every
 * unpaid one) has nothing to refund, so this returns `null` and the response
 * carries `autoRefund: null`. When money *was* captured, the refundable part is
 * the captured amount less §11.1's fee, computed in paise — never re-derived in
 * floats at the boundary, where a ₹306.80 fee could land a paisa off.
 *
 * The `assertRefundable()` inside `executeRefund()` is the second line of
 * defence against refunding more than remains; the `> 0` here is what stops a
 * zero-value ledger row when the fee equals the captured amount exactly.
 */
async function refundIfPaid(
  supabase: ReturnType<typeof createServerClient>,
  bookingId: string,
  feeRupees: number,
  req: NextRequest
) {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('status', 'success')
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  const payment = data as Payment
  const amountPaise = paymentAmountPaise(payment) - toPaise(feeRupees)
  if (amountPaise <= 0) return null

  const refund = await executeRefund({
    supabase,
    payment,
    amountPaise,
    reasonCode: 'booking_cancelled',
    note: `automatic refund on cancellation of booking ${bookingId}`,
    auto: true,
    requestedBy: null,
    ipAddress: clientIp(req),
  })

  return {
    id: refund.id,
    amount: parseNumeric(refund.amount),
    currency: refund.currency,
    status: refund.status,
    route: refund.route,
  }
}