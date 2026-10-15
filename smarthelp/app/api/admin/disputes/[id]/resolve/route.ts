import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { getAdminDispute, resolveDispute } from '@/lib/supportServer';
import { createServerClient } from '@/lib/supabaseServer';
import { optionalStr, oneOf, readJson, requireCapability, uuid } from '@/lib/validation';
import type { DisputeStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DECISIONS = ['investigating', 'resolved', 'rejected'] as const;

/**
 * POST /api/admin/disputes/:id/resolve — adjudicate a dispute (§24, §25.10,
 * §31.1, D4).
 *
 * `dispute.resolve` (ops/admin) is the gate. The decision is one of
 * `investigating`/`resolved`/`rejected`; `resolved_by` and `resolved_at` are
 * stamped by the server module, not the caller. The dispute must exist first, so
 * a bad id is a 404 with no write (D3).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.disputes.resolve', async (requestId) => {
    const auth = await requireCapability(req, 'dispute.resolve');
    const id = uuid(params.id, 'id');
    const body = await readJson(req);
    const supabase = createServerClient();

    const status = oneOf(body.status, 'status', DECISIONS) as DisputeStatus;
    const resolution = optionalStr(body.resolution, 'resolution', { max: 2000 });

    // Existence is checked directly, then the update runs: a missing row must
    // not fall through to a `.single()` that would surface as a 500.
    const { data: before, error } = await supabase
      .from('disputes')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!before) {
      throw new ApiHttpError('NOT_FOUND', 'That dispute was not found.', 404);
    }

    await resolveDispute(id, { status, resolution, resolvedBy: auth.userId }, supabase);
    const dispute = await getAdminDispute(id, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'dispute.resolve',
      entityType: 'disputes',
      entityId: id,
      before: { status: before.status },
      after: { status, resolution },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ dispute });
  });
}
