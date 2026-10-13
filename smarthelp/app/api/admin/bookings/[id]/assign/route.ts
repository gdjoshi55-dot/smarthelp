import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { getAssignableProfessional } from '@/lib/adminServer';
import { createServerClient } from '@/lib/supabaseServer';
import { getPlatformSettings } from '@/lib/settingsServer';
import { optionalStr, requireCapability, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/bookings/:id/assign — put a chosen professional on a booking
 * (§9.4, §20.12).
 *
 * `booking.assign` is the gate (ops, admin, super_admin). The professional must
 * be verified before the call; `admin_assign_booking` (0034) re-checks it under
 * its advisory lock, but refusing here is what gives the console a readable
 * message instead of an `outcome` string.
 *
 * The offer it raises is an ordinary `offered` row with the platform's
 * `offerTtlMinutes` (a `platform_settings` row since Phase 6), so the
 * professional accepts it through the normal flow. Ops raises the chance; it
 * does not forge an acceptance.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.bookings.assign', async (requestId) => {
    const auth = await requireCapability(req, 'booking.assign');
    const bookingId = uuid(params.id, 'id');

    const body = await readBody(req);
    const professionalId = uuid(body.professionalId, 'professionalId');
    const note = optionalStr(body.note, 'note', { max: 500 });

    const supabase = createServerClient();

    const { data: booking, error } = await supabase
      .from('bookings')
      .select('id, status, professional_id')
      .eq('id', bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) {
      throw new ApiHttpError('NOT_FOUND', 'That booking was not found.', 404);
    }

    const professional = await getAssignableProfessional(professionalId, supabase);
    if (!professional) {
      throw new ApiHttpError('NOT_FOUND', 'That professional was not found.', 404);
    }
    if (professional.verificationStatus !== 'verified') {
      throw new ApiHttpError(
        'PROFESSIONAL_UNAVAILABLE',
        'That professional is not verified and cannot be assigned.',
        422
      );
    }

    const settings = await getPlatformSettings(supabase);

    const { data: outcome, error: rpcError } = await supabase.rpc('admin_assign_booking', {
      p_booking_id: bookingId,
      p_professional_id: professionalId,
      p_offer_ttl_minutes: settings.offerTtlMinutes,
      p_note: note,
      p_actor: auth.userId,
      p_actor_role: auth.role,
    });
    if (rpcError) throw rpcError;

    const result = (outcome ?? { outcome: 'noop' }) as { outcome: string; assignment_id?: string };

    if (result.outcome === 'not_found') {
      throw new ApiHttpError('NOT_FOUND', 'That booking was not found.', 404);
    }
    if (result.outcome === 'professional_not_found') {
      throw new ApiHttpError('NOT_FOUND', 'That professional was not found.', 404);
    }
    if (result.outcome === 'professional_unverified') {
      throw new ApiHttpError(
        'PROFESSIONAL_UNAVAILABLE',
        'That professional is not verified and cannot be assigned.',
        422
      );
    }
    if (result.outcome === 'invalid_state') {
      throw new ApiHttpError(
        'INVALID_STATE',
        'This booking can only be assigned before the professional is on the way.',
        409
      );
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'booking.assign_admin',
      entityType: 'booking',
      entityId: bookingId,
      before: { professionalId: booking.professional_id, status: booking.status },
      after: { professionalId, status: 'assigned' },
      metadata: { note, assignmentId: result.assignment_id, professionalName: professional.name },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ bookingId, professionalId, assignmentId: result.assignment_id ?? null });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
