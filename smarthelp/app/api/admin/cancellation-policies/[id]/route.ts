import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { deleteCancellationPolicy, updateCancellationPolicy } from '@/lib/policyServer';
import { createServerClient } from '@/lib/supabaseServer';
import { requireCapability, uuid } from '@/lib/validation';
import { validateCancellationPolicyInput } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH/DELETE /api/admin/cancellation-policies/:id (§24, §31.1).
 *
 * The console edits one ladder band at a time; existence is checked first so a
 * missing id is a 404 with no write (D3).
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.cancellation_policies.update', async (requestId) => {
    const auth = await requireCapability(req, 'pricing.manage');
    const id = uuid(params.id, 'id');
    const body = await readBody(req);

    const supabase = createServerClient();
    const before = await loadPolicy(id, supabase);
    const input = validateCancellationPolicyInput(body);
    const policy = await updateCancellationPolicy(id, input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'cancellation_policy.update',
      entityType: 'cancellation_policies',
      entityId: id,
      before: { fee_type: before.fee_type, fee_value: before.fee_value, is_active: before.is_active },
      after: { fee_type: policy.fee_type, fee_value: policy.fee_value, is_active: policy.is_active },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ policy });
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.cancellation_policies.delete', async (requestId) => {
    const auth = await requireCapability(req, 'pricing.manage');
    const id = uuid(params.id, 'id');

    const supabase = createServerClient();
    const before = await loadPolicy(id, supabase);
    await deleteCancellationPolicy(id, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'cancellation_policy.delete',
      entityType: 'cancellation_policies',
      entityId: id,
      before: { fee_type: before.fee_type, fee_value: before.fee_value },
      metadata: { id },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ deleted: true });
  });
}

async function loadPolicy(
  id: string,
  supabase: ReturnType<typeof createServerClient>
): Promise<{ fee_type: string; fee_value: unknown; is_active: boolean }> {
  const { data, error } = await supabase
    .from('cancellation_policies')
    .select('fee_type, fee_value, is_active')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('NOT_FOUND', 'That cancellation policy was not found.', 404);
  }
  return data;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}