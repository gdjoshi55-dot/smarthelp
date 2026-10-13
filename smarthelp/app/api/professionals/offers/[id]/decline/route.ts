import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireVerifiedProfessional } from '@/lib/professionalServer';
import { matchBooking } from '@/lib/matchingServer';
import { audit, clientIp } from '@/lib/audit';
import { optionalStr, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/offers/:id/decline — turn the job down (§24.8, P4-04).
 *
 * The `:id` is a `booking_assignments.id`. A decline is a tombstone
 * (`rejected`). The job was broadcast to every eligible professional (0036), so
 * a single decline is usually not the end of the round: `matchBooking()` sees
 * the other live offers and no-ops. It only cascades once the *last* offer has
 * been answered — walking the booking `assigned -> searching` (§8.2) and
 * broadcasting a fresh round, or refunding the booking outright if the search
 * window has passed and no candidate remains. Doing that check here rather than
 * waiting for the next inbox open is what keeps the round from languishing.
 *
 * The reason is optional: `decline_offer`'s `p_reason` defaults to null, and the
 * UI-SPEC's decline confirmation carries no reason field (only cancel/no-show
 * requires one). When the professional does send one it lands on `decline_reason`.
 *
 * Ownership is re-checked here so a cross-pro id is a 404 with zero writes: the
 * RPC filters by `professional_id` too, but a route that leaned on that alone
 * would still have issued the call.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.offers.decline', async (requestId) => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const assignmentId = uuid(params.id, 'id');

    const body = await readBody(req);
    const reason = optionalStr(body.reason, 'reason', { max: 200 });

    const supabase = createServerClient();

    const { data: assignment, error: readError } = await supabase
      .from('booking_assignments')
      .select('id, booking_id, status, professional_id')
      .eq('id', assignmentId)
      .eq('professional_id', professional.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!assignment) {
      throw new ApiHttpError('NOT_FOUND', 'That offer was not found on your account.', 404);
    }

    const { data: declined, error: rpcError } = await supabase.rpc('decline_offer', {
      p_assignment_id: assignmentId,
      p_professional_id: professional.id,
      p_reason: reason,
    });
    if (rpcError) throw rpcError;
    if (!declined) {
      throw new ApiHttpError(
        'INVALID_STATE',
        'This offer is no longer available. It may have expired or already been answered.',
        409
      );
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'offer.declined',
      entityType: 'booking_assignment',
      entityId: assignmentId,
      before: { status: 'offered' },
      after: { status: 'rejected' },
      metadata: { professionalId: professional.id, reason },
      ipAddress: clientIp(req),
      requestId,
    });

    // §8.2's cascade, but only once the round is empty: `matchBooking` no-ops
    // while other professionals still hold a live offer, and otherwise owns the
    // `assigned -> searching -> assigned` walk and the exhausted-refund branch.
    // This route stays a tombstone plus a nudge.
    const cascade = await matchBooking(supabase, assignment.booking_id, {
      ipAddress: clientIp(req),
    });

    return ok({ declined: true, reassigned: cascade.outcome === 'offered' });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
