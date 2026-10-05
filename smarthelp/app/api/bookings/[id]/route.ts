import { NextRequest } from 'next/server'
import { ok, err } from '@/lib/api'
import { uuid } from '@/lib/validation'
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer'
import { statusPresentation, isReschedulableStatus } from '@/lib/status'
import { createServerClient } from '@/lib/supabaseServer'
import type { BookingStatus } from '@/lib/supabase'

/**
 * One booking, for the page that tracks it.
 *
 * The presentation is resolved here rather than in the browser: `statusPresentation`
 * turns a status into the label, the badge tone and the position on the
 * customer's stepper, and it is derived from the same transition table the
 * database enforces. A client that recomputed any of it would be a second copy of
 * a table that is already duplicated once.
 *
 * The items and the status history come along for the ride because §20.6's screen
 * needs both and three round trips to render one page is three chances to show a
 * spinner. They are separate rows rather than a join, so this reads them in
 * parallel and lets Postgres do the two small queries concurrently.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { auth, customerId } = await requireBookingCustomer(req)
    const id = uuid(params.id, 'id')
    // `customerId` is a `customers.id`, not `auth.userId` — see the note on
    // `getBookingForCaller`. Passing the profile id compares two unrelated
    // identifiers and refuses the customer their own booking.
    const booking = await getBookingForCaller(id, customerId, auth.role)
    const status = booking.status as BookingStatus
    const presentation = statusPresentation(status)

    const supabase = createServerClient()
    const [items, history] = await Promise.all([
      supabase
        .from('booking_items')
        .select('service_id, service_name, quantity, duration_minutes, line_total')
        .eq('booking_id', id)
        .order('created_at', { ascending: true }),
      supabase
        .from('booking_status_history')
        .select('from_status, to_status, actor_role, note, created_at')
        .eq('booking_id', id)
        .order('created_at', { ascending: true }),
    ])

    if (items.error) throw items.error
    if (history.error) throw history.error

    return ok({
      booking,
      status: presentation,
      cancellable: presentation.customerCancellable,
      // Asked here rather than in the browser so the panel that is drawn and the
      // move the route will honour come from one list — see `isReschedulableStatus`.
      reschedulable: isReschedulableStatus(status) && booking.booking_type === 'scheduled',
      items: items.data ?? [],
      history: history.data ?? [],
    })
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to get booking', 500)
  }
}