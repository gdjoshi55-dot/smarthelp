import { createServerClient } from './supabaseServer';
import { requireAuth, type AuthContext } from './validation';
import { getBookingById } from './bookingServer';
import { ApiHttpError } from './api';
import type { Professional, UserRole } from './supabase';

/**
 * The professional's half of the server model (Phase 4).
 *
 * This is the deliberate analog of `lib/bookingServer.ts`, and
 * `getBookingForCaller`'s doc comment hands the professional case here on
 * purpose: a professional is not staff, and a booking's `professional_id` is a
 * `professionals.id`, not a `profiles.id`, so the customer helper must not
 * guess at it.
 *
 * The two rules every route in this phase inherits from this module:
 *
 *   1. **Ownership is re-checked in the route, never left to RLS.** Every pro
 *      Route Handler reaches Postgres through `createServerClient()`, and the
 *      service role bypasses RLS. A query filtered by `professional_id` in the
 *      route is what keeps professional A out of professional B's rows.
 *
 *   2. **One function owns the strip list.** `stripProBooking` is the only
 *      place a pro/staff booking payload is shaped, so `otp_hash` (Pitfall 1,
 *      P4-10) and pre-accept customer details (§14.3) are removed once rather
 *      than remembered per route.
 */

/** Roles that answer for the marketplace rather than for one account. */
const STAFF_ROLES: readonly UserRole[] = ['admin', 'support', 'ops', 'super_admin'];

/**
 * The columns a professional route may read from `professionals`.
 *
 * Explicit, never `select('*')`: the row carries `commission_pct` and live
 * coordinates, and a route that read them by accident would ship them to a
 * screen. `public_professionals` (0005) is the browser-safe view; this list is
 * what the server needs to make a decision.
 */
export const PRO_COLUMNS = [
  'id',
  'profile_id',
  'verification_status',
  'availability_status',
  'is_available_today',
  'current_lat',
  'current_lng',
  'location_updated_at',
  'service_radius_km',
  'commission_pct',
  'rating',
  'rating_count',
  'completed_jobs',
  'cancelled_jobs',
  'no_shows',
  'total_offers',
  'accepted_offers',
  'experience_months',
  'kyc_verified_at',
].join(', ');

/**
 * The caller, and their `professionals` row.
 *
 * The mirror of `requireCustomer` (`lib/addressServer.ts`): `requireAuth` has
 * already rejected a suspended account and a missing profile, so this refuses
 * the roles that have no professional row — because every ownership check below
 * would otherwise silently match nothing, which reads as "you have no jobs"
 * rather than "jobs are not a thing your account has".
 */
export async function requireProfessional(req: Request): Promise<{
  auth: AuthContext;
  professional: Professional;
}> {
  const auth = await requireAuth(req);
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from('professionals')
    .select(PRO_COLUMNS)
    .eq('profile_id', auth.userId)
    .maybeSingle();

  if (error) throw error;
  // `PRO_COLUMNS` is a runtime string, so supabase-js cannot resolve the row
  // type from it the way it does an inline literal; the cast restores the
  // generated `Professional` shape without loosening the column list.
  const professional = (data ?? null) as unknown as Professional | null;
  if (!professional) {
    throw new ApiHttpError(
      'FORBIDDEN',
      'This action belongs to a professional account. This account does not have one.',
      403
    );
  }

  return { auth, professional };
}

/**
 * The verification gate (Interaction Contract 11).
 *
 * An unverified professional sees the KYC banner and the inbox does not open;
 * the UI derives that from `verification_status`, and this is the server half
 * that makes the same refusal unbypassable. The message is the one the banner
 * renders, so the screen and the API agree on what is wrong.
 */
export async function requireVerifiedProfessional(req: Request): Promise<{
  auth: AuthContext;
  professional: Professional;
}> {
  const { auth, professional } = await requireProfessional(req);
  if (professional.verification_status !== 'verified') {
    throw new ApiHttpError(
      'FORBIDDEN',
      'Your identity is not verified yet. Upload your documents to start taking jobs.',
      403,
      { verificationStatus: professional.verification_status }
    );
  }
  return { auth, professional };
}

/**
 * Load a booking the professional is entitled to, or a 404.
 *
 * A professional sees a job once they own it (`bookings.professional_id`).
 * Staff answer for any booking. Anyone else gets the same 404 as a booking that
 * does not exist, so the route never confirms that somebody else's job id is
 * real (Interaction Contract 6 / Pitfall 9).
 */
export async function getProBookingForCaller(
  id: string,
  professionalId: string,
  role: UserRole
) {
  const booking = await getBookingById(id);
  if (!booking) throw new ApiHttpError('NOT_FOUND', 'Booking not found', 404);
  if (booking.professional_id === professionalId || STAFF_ROLES.includes(role)) {
    return booking;
  }
  throw new ApiHttpError('NOT_FOUND', 'That job was not found on your account.', 404);
}

// ── The one strip function ──────────────────────────────────────

/**
 * The explicit column list every professional route reads from `bookings`.
 *
 * `otp_hash` is absent deliberately, and so are `otp_attempts`,
 * `otp_generations` and `otp_verified_at`: none of the job-flow screens needs
 * them, and a column that is not selected cannot leak. `otp_expires_at` is
 * carried because the customer-facing track read needs it; the professional
 * payload strips it below.
 */
export const PRO_JOB_COLUMNS = [
  'id',
  'booking_number',
  'customer_id',
  'professional_id',
  'status',
  'booking_type',
  'version',
  'scheduled_start_at',
  'scheduled_end_at',
  'duration_minutes',
  'address_id',
  'address_snapshot',
  'locality_id',
  'subtotal',
  'platform_fee',
  'discount',
  'discount_code',
  'tax',
  'tax_rate',
  'total_amount',
  'professional_gross',
  'currency',
  'otp_expires_at',
  'started_at',
  'ends_at',
  'ended_at',
  'actual_duration_minutes',
  'accepted_at',
  'arrived_at',
  'completed_at',
  'cancelled_at',
  'cancellation_reason_code',
  'notes',
  'created_at',
  'updated_at',
].join(', ');

/**
 * Which stage a payload is being shaped for.
 *
 * `offered` is before the professional has taken the job: §14.3 says they get
 * the locality and the area, never the phone number or the full address.
 * `accepted` unlocks those once the job is theirs.
 */
export type ProBookingStage = 'offered' | 'accepted';

/** Keys that are never part of any professional payload, at any stage. */
const NEVER_FOR_PRO = ['otp_hash', 'otp_attempts', 'otp_generations', 'otp_verified_at'];

/** Keys hidden until the job is accepted (§14.3). */
const OFFER_HIDDEN = [
  'address_snapshot',
  'address_id',
  'notes',
  'customer_phone',
  'customer_name',
  'customer_full_name',
  'otp_expires_at',
];

/**
 * Shape one booking for a professional (or staff) payload.
 *
 * This is the single function Pitfall 13 exists for: `otp_hash` reached a live
 * table with a row policy that admitted every professional, so a payload that
 * omitted it *by habit* was one forgotten route away from disclosure. It also
 * carries the pre-accept field filter — for an offer, the area survives as
 * `area`/`locality` and the exact street address does not.
 */
export function stripProBooking(
  booking: Record<string, unknown>,
  stage: ProBookingStage
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...booking };

  for (const key of NEVER_FOR_PRO) delete out[key];

  if (stage === 'offered') {
    const snapshot = booking.address_snapshot as Record<string, unknown> | undefined;
    if (snapshot && typeof snapshot === 'object') {
      out.area = snapshot.area ?? null;
      out.city = snapshot.city ?? null;
      out.locality = snapshot.locality ?? snapshot.area ?? null;
    }
    const fullName = (booking.customer_name ?? booking.customer_full_name) as
      | string
      | undefined;
    if (fullName) out.customer_first_name = fullName.trim().split(/\s+/)[0];
    for (const key of OFFER_HIDDEN) delete out[key];
  }

  return out;
}
