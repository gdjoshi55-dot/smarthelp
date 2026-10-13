import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { requireCapability, str, uuid } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/professionals/:id/suspend — suspend or reactivate (§20.13, §22).
 *
 * `pro.suspend` is the gate (admin and super_admin only; ops can read the roster
 * but not pull someone off the marketplace). Suspension is two rows, and both
 * matter: the profile's `status` is what `requireAuth` reads, so a suspended
 * professional cannot sign in; the professionals row records the reason the
 * console shows. Availability is also forced offline, because a suspended
 * professional must not be a matching candidate.
 *
 * Reactivation clears the reason and restores the profile. It does not put the
 * professional back online — that is theirs to choose, and doing it for them
 * would return them to the pool without their presence being real.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.professionals.suspend', async (requestId) => {
    const auth = await requireCapability(req, 'pro.suspend');
    const professionalId = uuid(params.id, 'id');

    const body = await readBody(req);
    const suspended = body.suspended !== false;
    const reason = suspended ? str(body.reason, 'reason', { max: 500 }) : null;

    const supabase = createServerClient();
    const { data: professional, error } = await supabase
      .from('professionals')
      .select('id, profile_id, suspended_reason, availability_status')
      .eq('id', professionalId)
      .maybeSingle();
    if (error) throw error;
    if (!professional) {
      throw new ApiHttpError('NOT_FOUND', 'That professional was not found.', 404);
    }

    const { error: proError } = await supabase
      .from('professionals')
      .update(
        suspended
          ? { suspended_reason: reason, availability_status: 'offline', is_available_today: false }
          : { suspended_reason: null }
      )
      .eq('id', professionalId);
    if (proError) throw proError;

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ status: suspended ? 'suspended' : 'active' })
      .eq('id', professional.profile_id);
    if (profileError) throw profileError;

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: suspended ? 'professional.suspend' : 'professional.reactivate',
      entityType: 'professional',
      entityId: professionalId,
      before: { suspendedReason: professional.suspended_reason },
      after: { suspendedReason: reason },
      metadata: { reason },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ professionalId, suspended, profileStatus: suspended ? 'suspended' : 'active' });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
