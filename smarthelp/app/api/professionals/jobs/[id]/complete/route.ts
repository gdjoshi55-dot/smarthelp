import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  requireVerifiedProfessional,
  getProBookingForCaller,
  stripProBooking,
} from '@/lib/professionalServer';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/jobs/:id/complete — finish the job (§10.4).
 *
 * `complete_job` (0029) is a single multi-effect statement: it moves
 * `in_progress -> completed`, stamps `ended_at`/`actual_duration_minutes` from
 * the **server clock**, closes the schedule window, bumps `completed_jobs` and
 * inserts the pending `professional_earnings` row (D4). This route's whole job
 * is to authenticate, prove ownership, and hand the RPC the booking's current
 * version.
 *
 * The version is read here rather than sent by the client: the client contract
 * (`completeJob(id)`) is body-less, and the booking is owned by one professional
 * whose only writer is this route. The RPC's version guard is still the
 * authority — a row that moved between the read and the write returns NULL,
 * which is a `STALE_VERSION` rather than a silent overwrite. A booking that is
 * not running raises `ILLEGAL_TRANSITION` from the 0011 trigger, which is how a
 * double-complete becomes a 409 instead of a second earning row.
 *
 * The RPC returns the full `bookings` row, `otp_hash` included, so the response
 * is re-read through the column-limited path and stripped rather than echoed.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.jobs.complete', async () => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const bookingId = uuid(params.id, 'id');

    const booking = await getProBookingForCaller(bookingId, professional.id, auth.role);

    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('complete_job', {
      p_booking_id: bookingId,
      p_professional_id: professional.id,
      p_expected_version: booking.version,
    });
    if (error) {
      if (/ILLEGAL_TRANSITION/.test(error.message)) {
        throw new ApiHttpError(
          'ILLEGAL_TRANSITION',
          'This job is not running, so it cannot be completed.',
          409
        );
      }
      throw error;
    }
    if (!data) {
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
