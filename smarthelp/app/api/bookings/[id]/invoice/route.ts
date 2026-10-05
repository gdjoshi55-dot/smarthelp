import { NextRequest } from 'next/server'
import { ok, err } from '@/lib/api'
import { uuid } from '@/lib/validation'
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer'
import { parseNumeric } from '@/lib/money'
import { createServerClient } from '@/lib/supabaseServer'

/**
 * The printable receipt (§20.6's invoice panel).
 *
 * It reads the frozen columns on the booking row rather than re-running the
 * pricing engine: §16 #19 freezes the price at booking time, so a total
 * recomputed from today's catalogue would be a different number from the one the
 * customer paid, on the document that is supposed to prove it.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { auth, customerId } = await requireBookingCustomer(req)
    const id = uuid(params.id, 'id')
    // Ownership first: the service-role client bypasses RLS, so nothing below
    // this line can be trusted to have filtered somebody else's booking out.
    const booking = await getBookingForCaller(id, customerId, auth.role)

    const supabase = createServerClient()
    const { data: items, error } = await supabase
      .from('booking_items')
      .select('service_id, service_name, quantity, duration_minutes, line_total')
      .eq('booking_id', id)
      .order('created_at', { ascending: true })
    if (error) throw error

    return ok({
      booking,
      invoice: {
        bookingId: id,
        bookingNumber: booking.booking_number,
        amount: booking.total_amount,
        // Parsed here as well so the receipt can show a cancellation fee without
        // the component having to know that `numeric` is a string on the wire.
        cancellationFee: parseNumeric(booking.cancellation_fee),
        items: items ?? [],
      },
    })
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to get invoice', 500)
  }
}