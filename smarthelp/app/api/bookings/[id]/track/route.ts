import { handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { getBookingForTrack } from '@/lib/bookingServer';
import { requireCustomer } from '@/lib/addressServer';
import { requireProfessional, stripProBooking } from '@/lib/professionalServer';
import { statusPresentation } from '@/lib/status';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { requireAuth, uuid } from '@/lib/validation';
import type { BookingStatus } from '@/lib/supabase';
import { haversineKm } from '@/lib/geo';

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
 * A straight line is shorter than the drive, so the first-pass ETA scales it to
 * an approximate road distance and divides by a realistic city speed. The map
 * replaces this with Google's own route duration as soon as it has one.
 */
const ETA_ROAD_FACTOR = 1.3;
const ETA_AVERAGE_SPEED_KMH = 22;

/**
 * The professional's coordinates, or null.
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

    // The professional's live pin, or null.
    let proLocation: { lat: number; lng: number } | null = null;
    let etaMinutes: number | null = null;
    let distanceKm: number | null = null;
    if (booking.professional_id) {
      const { data: pro, error } = await supabase
        .from('professionals')
        .select(PRO_LOCATION_COLUMNS)
        .eq('id', booking.professional_id)
        .maybeSingle();
      if (error) throw error;
      proLocation = freshLocation(pro, now);

      if (proLocation && status === 'on_the_way') {
        const snapshot = (booking.address_snapshot as any) || {};
        const destLat = typeof snapshot.lat === 'number' ? snapshot.lat : null;
        const destLng = typeof snapshot.lng === 'number' ? snapshot.lng : null;
        if (destLat != null && destLng != null) {
          // First-pass ETA, before the tracking map has calculated the real
          // driving route. Coordinates are straight-line distance; the road
          // factor and city speed turn that into a usable arrival estimate.
          const straightKm = haversineKm(proLocation, { lat: destLat, lng: destLng });
          const roadKm = straightKm * ETA_ROAD_FACTOR;
          distanceKm = Math.round(roadKm * 10) / 10;
          etaMinutes = Math.max(1, Math.round((roadKm / ETA_AVERAGE_SPEED_KMH) * 60));
        }
      }
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
      extensionAvailable: false,
      extendedMinutes: 0,
      proLocation,
      etaMinutes,
      distanceKm,
      ...otpBlock,
    });
  });
}
