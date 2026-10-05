import { NextRequest } from 'next/server'
import { ok, err, ApiHttpError } from '@/lib/api'
import { uuid } from '@/lib/validation'
import { requireCapability } from '@/lib/validation'
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer'
import { assertSlotAvailable } from '@/lib/bookingAvailability'
import { buildQuote } from '@/lib/bookingQuote'
import { quoteRescheduleFee } from '@/lib/cancellation'
import { isReschedulableStatus } from '@/lib/status'
import { createServerClient } from '@/lib/supabaseServer'
import { parseNumeric } from '@/lib/money'
import { readIdempotencyKey, withIdempotency } from '@/lib/idempotency'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/bookings/[id]/reschedule — move a booking to a new time.
 *
 * The old implementation called `transitionBooking(id, 'draft')`, which is a
 * status change the state machine forbids from every reachable Phase 2 status —
 * so the route was a 409 with a confusing message, wearing a "simplified"
 * comment instead of admitting it. A reschedule is not a status change at all:
 * `§8.2` has no reschedule edge because the booking stays exactly where it is.
 *
 * What it actually is:
 *
 *   1. capability  `booking.create` guards it rather than a new capability
 *                  string — §3.2 covers create, cancel and reschedule in one row,
 *                  so inventing `booking.reschedule.own` would put a grant in the
 *                  table the specification does not describe.
 *   2. ownership  before anything else.
 *   3. `version`   the client sends the version it read. Two devices rescheduling
 *                  the same booking produce one winner and one `STALE_VERSION`,
 *                  never two bookings.
 *   4. slot       re-run through the Phase 1 engine, because a promise made at
 *                  quote time is not a reservation.
 *   5. re-quote   a new time can cross a peak window, so `pricing_snapshot` is
 *                  rewritten and the returned breakdown is the new one. The
 *                  frozen price of a paid booking is not retroactively applied to
 *                  a change the customer asked for; the §11.3 reschedule fee is
 *                  returned *before* confirmation.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await requireCapability(req, 'booking.create')
    const { customerId } = await requireBookingCustomer(req)
    const id = uuid(params.id, 'id')
    const body = await req.json().catch(() => ({}))
    const supabase = createServerClient()

    if (body.scheduledStartAt == null || Number.isNaN(Date.parse(body.scheduledStartAt))) {
      return err('VALIDATION_ERROR', 'Pick a valid date and time.', 400, {
        fields: { scheduledStartAt: 'Pick a valid date and time' },
      })
    }
    const newStart = new Date(body.scheduledStartAt).toISOString()

    // `version` is required rather than defaulted. Silently reading the current
    // row would make the optimistic lock a no-op and both devices would win.
    const version = Number(body.version)
    if (!Number.isInteger(version) || version < 1) {
      return err('VALIDATION_ERROR', 'Reload the booking and try again.', 400, {
        fields: { version: 'This booking has changed; reload it' },
      })
    }

    const booking = await getBookingForCaller(id, customerId, auth.role)

    if (booking.version !== version) {
      return err(
        'STALE_VERSION',
        'This booking changed while you were looking at it. Reload and try again.',
        409,
        { currentVersion: booking.version }
      )
    }

    // Once the professional is on the road the time is no longer the thing that
    // can change. `isReschedulableStatus` is the same list the detail route uses to
    // decide whether to draw the panel, so the button and the route cannot
    // disagree: before this the route refused only `cancelled`/`closed`/`refunded`
    // and would have honoured a move for a booking that was already under way.
    if (!isReschedulableStatus(booking.status)) {
      return err('INVALID_STATE', 'This booking can no longer be rescheduled.', 409, {
        status: booking.status,
      })
    }

    if (booking.booking_type !== 'scheduled') {
      return err('INVALID_STATE', 'An instant booking cannot be moved to a new time.', 409, {
        bookingType: booking.booking_type,
      })
    }

    if (booking.scheduled_start_at === newStart) {
      return err('VALIDATION_ERROR', 'That is already the booked time.', 400, {
        fields: { scheduledStartAt: 'Choose a different time' },
      })
    }

    // Re-quote from the booking's own items. The customer is not choosing the
    // services again here, so the lines come from `booking_items` — which is the
    // frozen catalogue, exactly as §16 #19 says a paid booking is held to.
    const { data: items, error: itemsError } = await supabase
      .from('booking_items')
      .select('service_id, duration_minutes, quantity')
      .eq('booking_id', id)

    if (itemsError) throw itemsError
    if (!items || items.length === 0) {
      return err('INVALID_STATE', 'This booking has no services on it to reschedule.', 409)
    }

    const quote = await buildQuote({
      items: items.map((row) => ({
        serviceId: row.service_id,
        durationMinutes: row.duration_minutes,
        quantity: row.quantity,
      })),
      couponCode: booking.discount_code,
      bookingType: booking.booking_type,
    })

    // §11.3's fee, for a booking that already has a professional. On today's data
    // none do, so this is `free_until_assigned` — which is the honest answer
    // rather than a fee invented to look busy.
    const fee = quoteRescheduleFee({
      amount: parseNumeric(booking.total_amount),
      hoursBefore: (new Date(booking.scheduled_start_at!).getTime() - Date.now()) / 3_600_000,
      cancelledBy: 'customer',
      assigned: booking.professional_id != null,
    })

    await assertSlotAvailable({
      serviceId: items[0].service_id,
      localityId: booking.locality_id,
      startAt: newStart,
      durationMinutes: quote.durationMinutes,
    })

    interface RescheduleBody {
      booking: unknown
      breakdown?: unknown
      rescheduleFee?: number
      feeBand?: string
    }

    const outcome = await withIdempotency<RescheduleBody>({
      key: readIdempotencyKey(req),
      operation: 'bookings.reschedule',
      actorProfileId: auth.userId,
      payload: { id, scheduledStartAt: newStart, version },
      required: false,
      run: async (): Promise<{ status: number; body: RescheduleBody }> => {
        const scheduledEndAt = new Date(
          new Date(newStart).getTime() + quote.durationMinutes * 60_000
        ).toISOString()

        const { data, error } = await supabase
          .from('bookings')
          .update({
            scheduled_start_at: newStart,
            scheduled_end_at: scheduledEndAt,
            duration_minutes: quote.durationMinutes,
            pricing_snapshot: quote.breakdown.snapshot,
          })
          .eq('id', id)
          .eq('version', version)
          .select('*')
          .maybeSingle()

        if (error) throw error
        if (!data) {
          // Lost the race between the version read and the write. Thrown rather
          // than returned so the caller gets the real error envelope — and so the
          // ledger is *not* completed, which is right: the client should re-read
          // the booking and retry with the fresh version, not replay a 409.
          throw new ApiHttpError(
            'STALE_VERSION',
            'This booking changed while you were looking at it. Reload and try again.',
            409
          )
        }

        return { status: 200, body: { booking: data, breakdown: quote.breakdown, rescheduleFee: fee.fee, feeBand: fee.band } }
      },
    })

    if (outcome.kind === 'rejected') return outcome.response
    if (outcome.kind === 'replay') return ok(outcome.body, outcome.status, outcome.headers)
    return ok(outcome.body, outcome.status, outcome.headers)
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to reschedule booking', 500)
  }
}