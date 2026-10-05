import { createServerClient } from './supabaseServer'
import { requireCustomer } from './addressServer'
import { ApiHttpError } from './api'
import { canTransition } from './status'
import type { BookingStatus, UserRole } from './supabase'

/** Roles that answer for the marketplace rather than for one account. */
const STAFF_ROLES: readonly UserRole[] = ['admin', 'support', 'ops', 'super_admin']

/**
 * The server half of a booking state change.
 *
 * `enforce_booking_transition()` in 0011 is the enforcement — this is the guard
 * that turns a refusal into a sentence instead of a Postgres error code. It
 * cannot *grant* a move the trigger would refuse, so a Route Handler that skips
 * it still cannot produce `refunded -> paid`.
 */
export async function getBookingById(id: string) {
  const supabase = createServerClient()
  const { data, error } = await supabase.from('bookings').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

/**
 * Load a booking the caller is entitled to, or refuse.
 *
 * `bookings` has `bookings_select_own`, so RLS would answer this correctly —
 * and none of it helps, because every Route Handler in this app reaches Postgres
 * through `createServerClient()`, and the service role bypasses RLS entirely.
 * `GET /api/bookings/[id]/invoice` therefore authenticated the caller and then
 * returned any booking in the table by id, which is an identifier a caller can
 * simply choose. So the check has to be here, in the one function every route
 * already reaches for.
 *
 * `customerId` is a **`customers.id`, not a `profiles.id`**: `bookings.customer_id`
 * references `public.customers(id)`, and the caller's profile id is a different
 * row. Passing `auth.userId` here compares two unrelated identifiers and refuses
 * every booking to its own owner — which is what the first version of
 * `getBookingForCaller`'s callers did, and why this note exists.
 *
 * Staff answer for any booking, which is what the admin console is for. A
 * professional is not staff: their own bookings are Phase 4's concern and this
 * helper does not guess at them.
 */
export async function getBookingForCaller(id: string, customerId: string, role: UserRole) {
  const booking = await getBookingById(id)
  if (!booking) throw new ApiHttpError('NOT_FOUND', 'Booking not found', 404)
  if (booking.customer_id === customerId || STAFF_ROLES.includes(role)) return booking
  throw new ApiHttpError('FORBIDDEN', 'This booking belongs to another account.', 403)
}

/**
 * The caller's `customers.id`, from their profile.
 *
 * Kept beside `getBookingForCaller` because the two are always needed together
 * and getting the pairing wrong fails closed — the customer is refused their own
 * booking — which reads as a broken app rather than a bug report.
 */
export async function requireBookingCustomer(req: Request) {
  const { auth, customer } = await requireCustomer(req);
  return { auth, customerId: customer.id };
}

/**
 * Move a booking to `to`, refusing anything §8.2 does not allow.
 *
 * The write is versioned (§28.1): `where id and version`, so two devices acting
 * on the same booking cannot both win. The `version` *value* is deliberately
 * absent from the payload — `bump_booking_version()` is a BEFORE UPDATE trigger
 * that owns the increment, and writing it here as well would double-bump the row
 * and make the lock compare against a number no caller ever read.
 *
 * It goes through `transition_booking()` (0028) rather than a table update because
 * the actor and note have to reach `booking_status_history`, and 0011's trigger
 * reads them from *transaction-local* settings. PostgREST cannot set those in the
 * same transaction as the update it accompanies, which is why every call to this
 * function used to record its actor as nothing at all: the argument was accepted,
 * validated as a string, and dropped. Inside the function `set_config(..., true)`
 * does both in one statement.
 *
 * The state machine is unaffected: the function writes `status` like any other
 * caller, so an illegal move still raises `ILLEGAL_TRANSITION` from the trigger.
 */
export async function transitionBooking(
  bookingId: string,
  to: BookingStatus,
  actor: string,
  note?: string,
  role: UserRole = 'customer'
) {
  const booking = await getBookingById(bookingId)
  if (!booking) throw new ApiHttpError('NOT_FOUND', 'Booking not found', 404)

  const from = booking.status as BookingStatus
  if (!canTransition(from, to)) {
    throw new ApiHttpError(
      'ILLEGAL_TRANSITION',
      `A booking cannot go from ${from.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}.`,
      409,
      { from, to }
    )
  }

  const supabase = createServerClient()
  const { data, error } = await supabase.rpc('transition_booking', {
    p_booking_id: bookingId,
    p_to: to,
    p_actor: actor,
    p_actor_role: role,
    p_note: note ?? null,
    p_expected_version: booking.version,
    p_window_from: null,
    p_window_to: null,
  })
  if (error) throw error
  if (!data) {
    throw new ApiHttpError(
      'STALE_VERSION',
      'This booking changed while you were looking at it. Reload and try again.',
      409
    )
  }
  return data
}