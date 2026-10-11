import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  requireVerifiedProfessional,
  getProBookingForCaller,
  stripProBooking,
} from '@/lib/professionalServer';
import { audit, clientIp } from '@/lib/audit';
import { str, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/jobs/:id/no-show — record that the job could not run.
 *
 * The reason is mandatory: `no_show_job` (0029) refuses an empty one, and the
 * audit row below is the provenance T-4-08 asks for. The RPC also writes the
 * reason into the booking's transition note, so `booking_status_history` carries
 * the actor and the text even if this route's audit write were to be lost.
 *
 * Hard rule 2 / D8: **there is deliberately no refund or wallet path here.** A
 * professional never cancels their own job into money moving back; that
 * resolution is ops' (Phase 5/6). `no_show_job` touches no refund and no wallet,
 * and the live-db test proves it by asserting the absence of those rows.
 *
 * Ownership is re-checked before the RPC so a cross-professional id is a 404
 * with zero writes. A booking the state machine refuses to move (anything
 * already `completed`, `cancelled` or terminal) raises `ILLEGAL_TRANSITION`,
 * which is answered 409.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.jobs.no_show', async (requestId) => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const bookingId = uuid(params.id, 'id');

    const booking = await getProBookingForCaller(bookingId, professional.id, auth.role);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = str(body.reason, 'reason', { min: 1, max: 500 });

    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('no_show_job', {
      p_booking_id: bookingId,
      p_professional_id: professional.id,
      p_reason: reason,
    });
    if (error) {
      if (/ILLEGAL_TRANSITION|NO_SHOW_REASON_REQUIRED/.test(error.message)) {
        throw new ApiHttpError(
          'ILLEGAL_TRANSITION',
          'This job can no longer be marked as a no-show.',
          409
        );
      }
      throw error;
    }
    if (!data) {
      throw new ApiHttpError('INVALID_STATE', 'This job is no longer available.', 409);
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'job.no_show',
      entityType: 'booking',
      entityId: bookingId,
      before: { status: booking.status },
      after: { status: 'no_show' },
      metadata: { reason },
      ipAddress: clientIp(req),
      requestId,
    });

    const fresh = await getProBookingForCaller(bookingId, professional.id, auth.role);
    return ok({ job: stripProBooking(fresh as Record<string, unknown>, 'accepted') });
  });
}
