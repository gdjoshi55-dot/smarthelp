import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  requireVerifiedProfessional,
  getProBookingForCaller,
  stripProBooking,
} from '@/lib/professionalServer';
import { audit, clientIp } from '@/lib/audit';
import { notifyOfferAccepted } from '@/lib/notificationHooks';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/offers/:id/accept — take the job (§24.8, P4-04).
 *
 * The `:id` is a `booking_assignments.id` (the offer), not a booking id. The
 * route does three things the RPC cannot: it re-checks ownership through the
 * service role (the RPC also filters by `professional_id`, but a cross-pro id
 * must be a 404 with **zero writes**, which is the route's guarantee), it maps
 * the RPC's three refuse modes to the client's copy, and it writes the audit row.
 *
 * `accept_offer` is the compare-and-set: a second tap, an expired offer, or a
 * stale id all make it return null → `ASSIGNMENT_TAKEN`. An overlap with another
 * booking raises `PROFESSIONAL_UNAVAILABLE` (23P01) from 0013's exclusion
 * constraint. Both are 409, per the Copywriting Contract.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.offers.accept', async (requestId) => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const assignmentId = uuid(params.id, 'id');
    const supabase = createServerClient();

    const { data: assignment, error: readError } = await supabase
      .from('booking_assignments')
      .select('id, booking_id, professional_id, status, expires_at')
      .eq('id', assignmentId)
      .eq('professional_id', professional.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!assignment) {
      throw new ApiHttpError('NOT_FOUND', 'That offer was not found on your account.', 404);
    }
    if (
      assignment.status !== 'offered' ||
      new Date(assignment.expires_at as string).getTime() <= Date.now()
    ) {
      throw new ApiHttpError(
        'INVALID_STATE',
        'This offer is no longer available. It may have expired or already been answered.',
        409
      );
    }

    const { data: accepted, error: rpcError } = await supabase.rpc('accept_offer', {
      p_assignment_id: assignmentId,
      p_professional_id: professional.id,
    });
    if (rpcError) {
      if (rpcError.code === '23P01' || /PROFESSIONAL_UNAVAILABLE/.test(rpcError.message)) {
        throw new ApiHttpError(
          'PROFESSIONAL_UNAVAILABLE',
          'That time overlaps another job.',
          409
        );
      }
      throw rpcError;
    }
    if (!accepted) {
      throw new ApiHttpError('ASSIGNMENT_TAKEN', 'Another professional took this job.', 409);
    }

    const booking = await getProBookingForCaller(
      accepted.booking_id,
      professional.id,
      auth.role
    );

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'offer.accepted',
      entityType: 'booking_assignment',
      entityId: assignmentId,
      before: { status: 'offered' },
      after: { status: 'accepted', bookingId: accepted.booking_id },
      metadata: { professionalId: professional.id },
      ipAddress: clientIp(req),
      requestId,
    });

    // The customer hears their professional accepted (§27.5 PRO_ACCEPTED).
    await notifyOfferAccepted(accepted.booking_id);

    // The address unlocks now the job is theirs (Interaction Contract 6); the
    // phone stays a job-detail concern (B3), and `otp_hash` is never selected.
    return ok({ job: stripProBooking(booking as Record<string, unknown>, 'accepted') });
  });
}
