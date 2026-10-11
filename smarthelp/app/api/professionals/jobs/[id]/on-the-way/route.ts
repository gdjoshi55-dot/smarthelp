import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  requireVerifiedProfessional,
  getProBookingForCaller,
  stripProBooking,
} from '@/lib/professionalServer';
import { audit, clientIp } from '@/lib/audit';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/jobs/:id/on-the-way — "I'm on my way" (§20.8).
 *
 * The first action of a job run: `accepted -> on_the_way`, one legal hop from
 * the 0011 table. The phase 4 chain reads `accepted -> on_the_way -> arrived
 * -> …`, but `arrive_job` (0029) only ever started from `on_the_way` and
 * nothing set it — so an accepted job sat with no first button, and everything
 * after it was unreachable. This is that writer.
 *
 * `start_journey` is the compare-and-set: a stale `version` read comes back
 * null → `STALE_VERSION`, and a booking that is not `accepted` raises
 * `ILLEGAL_TRANSITION` from the 0011 trigger; both map to 409. No geofence
 * here — the street address matters at arrival (the `arrive` route applies
 * it), not when the professional leaves for the job.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.jobs.on_the_way', async (requestId) => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const bookingId = uuid(params.id, 'id');

    const booking = await getProBookingForCaller(bookingId, professional.id, auth.role);

    const supabase = createServerClient();
    const { data: started, error } = await supabase.rpc('start_journey', {
      p_booking_id: bookingId,
      p_professional_id: professional.id,
      p_expected_version: booking.version,
    });
    if (error) {
      if (/ILLEGAL_TRANSITION/.test(error.message)) {
        throw new ApiHttpError(
          'ILLEGAL_TRANSITION',
          'This job is not awaiting your travel, so it cannot be started now.',
          409
        );
      }
      throw error;
    }
    if (!started) {
      throw new ApiHttpError(
        'STALE_VERSION',
        'This job changed while you were looking at it. Reload and try again.',
        409
      );
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'job.on_the_way',
      entityType: 'booking',
      entityId: bookingId,
      before: { status: 'accepted' },
      after: { status: 'on_the_way' },
      metadata: { professionalId: professional.id },
      ipAddress: clientIp(req),
      requestId,
    });

    const fresh = await getProBookingForCaller(bookingId, professional.id, auth.role);
    return ok({ job: stripProBooking(fresh as Record<string, unknown>, 'accepted') });
  });
}