import { handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { getBookingForTrack } from '@/lib/bookingServer';
import { requireCustomer } from '@/lib/addressServer';
import { requireProfessional, stripProBooking } from '@/lib/professionalServer';
import { statusPresentation } from '@/lib/status';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { requireAuth, uuid } from '@/lib/validation';
import type { BookingStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/bookings/:id/track — the live view both sides of a booking poll
 * (§10.2, §25.6, D6, closing Phase 2's deferral).
 *
 * Two rules decide everything here. First, **the clock is the server's**: every
 * timer field is computed from `new Date()` at response time, never trusted from
 * the device, so a phone with a skewed clock still shows the right "5:20 left"
 * (Interaction Contract 2). Second, **the payload is a projection, not the row**:
 * it is shaped through `stripProBooking`, so `otp_hash` and the OTP counters can
 * never appear no matter who asks (Pitfall 1, P4-10), and the one OTP fact a
 * customer legitimately needs — the expiry — is lifted out as a top-level field
 * and only while the booking is `arrived`.
 *
 * Ownership is one function (`getBookingForTrack`): the customer is resolved
 * from their `customers` row and the professional from their `professionals`
 * row, and a caller who is neither gets the same 404 as a booking that does not
 * exist. The payload carries the professional's live coordinates, so confirming
 * that a stranger's job id is real would be a reference check nobody needs.
 */
const PRO_LOCATION_COLUMNS = 'current_lat, current_lng, location_updated_at';

/**
 * The professional's coordinates, or null.
 *
 * `null` is the honest answer for "we do not know where they are": no ping yet,
 * a ping too old to be a claim about the present, or a row that carries one
 * coordinate and not the other. No ETA is derived from the result — no travel
 * model exists, and a made-up number is worse than a missing one (D6).
 */
function freshLocation(
  pro:
    | { current_lat?: number | null; current_lng?: number | null; location_updated_at?: string | null }
    | null,
  now: Date
): { lat: number; lng: number } | null {
  if (!pro) return null;
  const lat = pro.current_lat ?? null;
  const lng = pro.current_lng ?? null;
  if (lat == null || lng == null || !pro.location_updated_at) return null;

  const ageMs = now.getTime() - new Date(pro.location_updated_at).getTime();
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs > PLATFORM_DEFAULTS.proLocationFreshMinutes * 60_000) return null;

  return { lat: Number(lat), lng: Number(lng) };
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'bookings.track', async () => {
    const auth = await requireAuth(req);
    const bookingId = uuid(params.id, 'id');

    // Whichever side of the booking is calling, resolve their own row once and
    // let `getBookingForTrack` make the single ownership decision.
    let customerId: string | null = null;
    let professionalId: string | null = null;
    if (auth.role === 'customer') {
      customerId = (await requireCustomer(req)).customer.id;
    } else if (auth.role === 'professional') {
      professionalId = (await requireProfessional(req)).professional.id;
    }

    const booking = await getBookingForTrack(bookingId, { customerId, professionalId }, auth.role);
    const status = booking.status as BookingStatus;
    const supabase = createServerClient();

    const now = new Date();
    const serverNow = now.toISOString();

    // The professional's live pin, or null. Read from `professionals`, the one
    // table that owns it; the row is not selected into the payload.
    let proLocation: { lat: number; lng: number } | null = null;
    if (booking.professional_id) {
      const { data: pro, error } = await supabase
        .from('professionals')
        .select('current_lat, current_lng, location_updated_at')
        .eq('id', booking.professional_id)
        .maybeSingle();
      if (error) throw error;
      proLocation = freshLocation(pro, now);
    }

    // A compact timeline, newest last, so the poll can keep the ladder current
    // without a second detail fetch. `booking_status_history` carries no PII.
    const { data: history, error: historyError } = await supabase
      .from('booking_status_history')
      .select('to_status, created_at')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true });
    if (historyError) throw historyError;

    const startedAt = booking.started_at ?? null;
    const endsAt = booking.ends_at ?? null;
    const remainingSeconds = endsAt
      ? Math.max(0, Math.round((new Date(endsAt).getTime() - now.getTime()) / 1000))
      : null;

    // The customer's OTP block, only at `arrived`: the expiry the countdown runs
    // against, and how many of the three generations are left, so the UI can
    // disable "Get a new code" before the round trip rather than after. The code
    // itself is never here — it exists only in a mint response (D3).
    const generations = (booking.otp_generations as number | null) ?? 0;
    const otpBlock =
      auth.role === 'customer' && status === 'arrived'
        ? {
            otpExpiresAt: booking.otp_expires_at ?? null,
            otpGenerationsRemaining: Math.max(
              0,
              PLATFORM_DEFAULTS.otpMaxGenerations - generations
            ),
          }
        : {};

    // One strip function owns every booking payload that is not the customer's
    // own detail read: `otp_hash`, the attempt/generation counters and the
    // verified-at stamp are removed here for both caller roles. The expiry and
    // lockout are lifted out (or dropped) deliberately rather than echoed.
    const safeBooking = stripProBooking(booking as Record<string, unknown>, 'accepted');
    delete safeBooking.otp_expires_at;
    delete safeBooking.otp_locked_until;

    return ok({
      booking: safeBooking,
      status,
      presentation: statusPresentation(status),
      timeline: (history ?? []).map((h) => ({ status: h.to_status, at: h.created_at })),
      startedAt,
      endsAt,
      serverNow,
      remainingSeconds,
      // D5: extensions are deferred. The fields ship so the client's shape is
      // final now and re-enabling later is additive.
      extensionAvailable: false,
      extendedMinutes: 0,
      proLocation,
      ...otpBlock,
    });
  });
}
