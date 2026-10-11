import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  requireVerifiedProfessional,
  getProBookingForCaller,
  stripProBooking,
} from '@/lib/professionalServer';
import { audit, clientIp } from '@/lib/audit';
import { haversineKm } from '@/lib/geo';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { latitude, longitude, optionalStr, readJson, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/jobs/:id/arrive — the geofenced arrival (§20.8, D7).
 *
 * The professional's device supplies its own coordinates; the distance is
 * computed **on the server** against the booking's frozen `address_snapshot`,
 * never trusted from the client. Inside `defaultArrivalRadiusM` the arrival is
 * taken. Outside it — or when the address carries no coordinates to measure
 * against, which is not the same as "close enough" — the arrival is refused
 * unless a manual override reason is given.
 *
 * An override is the threat, not the arrival: the `write_audit` row is written
 * **before** the RPC so an override that somehow fails downstream is still on
 * the record. `arrive_job` (0029) is the authority on the state machine
 * (`on_the_way -> arrived`); its NULL means the version moved, and a wrong state
 * raises `ILLEGAL_TRANSITION` from the 0011 trigger. The RPC returns the full
 * `bookings` row including `otp_hash`, so the response is re-read through the
 * column-limited path and stripped rather than echoed.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.jobs.arrive', async (requestId) => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const bookingId = uuid(params.id, 'id');

    const booking = await getProBookingForCaller(bookingId, professional.id, auth.role);

    const body = await readJson(req);
    const lat = latitude(body.lat, 'lat');
    const lng = longitude(body.lng, 'lng');
    const overrideReason = optionalStr(body.overrideReason, 'overrideReason', { max: 500 });

    const snapshot = (booking.address_snapshot ?? {}) as Record<string, unknown>;
    const destLat = Number(snapshot.lat);
    const destLng = Number(snapshot.lng);
    const hasDest = Number.isFinite(destLat) && Number.isFinite(destLng);

    const radiusM = PLATFORM_DEFAULTS.defaultArrivalRadiusM;
    const distanceM = hasDest
      ? Math.round(haversineKm({ lat, lng }, { lat: destLat, lng: destLng }) * 1000)
      : null;
    const outside = !hasDest || distanceM === null || distanceM > radiusM;

    if (outside && !overrideReason) {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'You are not at the job address yet. Move closer, or confirm arrival with a reason.',
        422,
        { reason: 'outside_arrival_radius', distanceM, radiusM }
      );
    }

    const supabase = createServerClient();

    if (outside && overrideReason) {
      await audit(supabase, {
        actorProfileId: auth.userId,
        action: 'job.arrival_override',
        entityType: 'booking',
        entityId: bookingId,
        after: { status: 'arrived' },
        metadata: {
          reason: overrideReason,
          distanceM,
          radiusM,
          professionalId: professional.id,
        },
        ipAddress: clientIp(req),
        requestId,
      });
    }

    const { data: arrived, error } = await supabase.rpc('arrive_job', {
      p_booking_id: bookingId,
      p_professional_id: professional.id,
      p_expected_version: booking.version,
    });
    if (error) {
      if (/ILLEGAL_TRANSITION/.test(error.message)) {
        throw new ApiHttpError(
          'ILLEGAL_TRANSITION',
          'This job is not on the way, so arrival cannot be confirmed.',
          409
        );
      }
      throw error;
    }
    if (!arrived) {
      throw new ApiHttpError(
        'STALE_VERSION',
        'This job changed while you were looking at it. Reload and try again.',
        409
      );
    }

    const fresh = await getProBookingForCaller(bookingId, professional.id, auth.role);
    return ok({ job: stripProBooking(fresh as Record<string, unknown>, 'accepted') });
  });
}
