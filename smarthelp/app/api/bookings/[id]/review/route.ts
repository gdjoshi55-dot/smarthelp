import { NextRequest } from 'next/server'
import { ok, err } from '@/lib/api'
import { uuid, int, optionalStr } from '@/lib/validation'
import { requireAuth } from '@/lib/validation'
import { getBookingForCaller } from '@/lib/bookingServer'
import type { BookingStatus } from '@/lib/supabase'

/**
 * Leave a rating for a finished booking (§18.1).
 *
 * Three facts are asserted by the row rather than by this handler:
 * `customer_id` must be the booking's customer, `professional_id` must be the
 * professional who did it, and the booking must have finished. All three are in
 * `validate_rating_booking()` (0017) because a rating is what every
 * professional's public score is computed from, and application-level checks are
 * only as strong as the least careful future caller.
 *
 * What this handler owes that the trigger cannot is a sentence. It also has to
 * *supply* the two identity columns rather than have them defaulted, because the
 * trigger compares them against the booking row before it fills anything in —
 * so they come from the booking, never from the request body. A body that named
 * its own `customer_id` would let one customer rate on another's behalf, and the
 * trigger would catch it as a 409 rather than as the FORBIDDEN it is.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await requireAuth(req)
    const id = uuid(params.id, 'id')
    const body = await req.json().catch(() => null)
    if (!body) return err('VALIDATION_ERROR', 'Invalid JSON', 400)

    const overall = int(body.overall ?? body.rating, 'overall', { min: 1, max: 5 })
    const comment = optionalStr(body.comment ?? body.review, 'comment', { max: 1000 })

    const booking = await getBookingForCaller(id, auth.userId, auth.role)
    if (booking.professional_id === null) {
      return err('INVALID_STATE', 'This booking has no professional to rate.', 409)
    }
    // `closed` is included because a rating is what normally closes a completed
    // booking: gating on `closed` alone would make the first rating impossible.
    if (!['completed', 'closed'].includes(booking.status as BookingStatus)) {
      return err(
        'INVALID_STATE',
        'You can rate a booking once the service is finished.',
        409
      )
    }

    const supabase = await import('@/lib/supabaseServer').then((m) => m.createServerClient())
    const { data, error } = await supabase
      .from('ratings')
      .insert({
        booking_id: id,
        customer_id: booking.customer_id,
        professional_id: booking.professional_id,
        overall,
        comment: comment || null,
      })
      .select()
      .maybeSingle()
    if (error) {
      // `unique (booking_id)` means a second rating is a client mistake, not a
      // server fault, and it is the common one: the button was pressed twice.
      if (error.code === '23505') {
        return err('INVALID_STATE', 'You have already rated this booking.', 409)
      }
      return err('INVALID_STATE', error.message, 409)
    }
    return ok({ rating: data }, 201)
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to submit review', 500)
  }
}