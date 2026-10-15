import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { deleteServiceDuration, updateServiceDuration } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { num, requireCapability, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH/DELETE /api/admin/services/:id/durations/:durationId (§7, §24, §31.1).
 * The service-areas console edits and drops ladder rungs; `service.manage`
 * gates both, and a missing rung is a 404 with no write (D3).
 */
export async function PATCH(req: Request, { params }: { params: { id: string; durationId: string } }) {
  return handle(req, 'admin.services.durations.update', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const durationId = uuid(params.durationId, 'durationId');
    const body = await readBody(req);

    const supabase = createServerClient();
    const before = await loadDuration(durationId, supabase);

    const patch: Record<string, unknown> = {};
    if (body.minutes !== undefined) patch.minutes = body.minutes;
    if (body.price !== undefined) patch.price = body.price === null ? null : num(body.price, 'price', { min: 0 });
    if (body.priceMultiplier !== undefined)
      patch.priceMultiplier = body.priceMultiplier === null ? null : num(body.priceMultiplier, 'priceMultiplier', { min: 0.01 });
    if (body.isActive !== undefined) patch.isActive = body.isActive === true;

    const duration = await updateServiceDuration(durationId, patch, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.duration.update',
      entityType: 'service_durations',
      entityId: durationId,
      before: { minutes: before.minutes, is_active: before.is_active },
      after: { minutes: duration.minutes, is_active: duration.is_active },
      metadata: { patch },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ duration });
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string; durationId: string } }) {
  return handle(req, 'admin.services.durations.delete', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const durationId = uuid(params.durationId, 'durationId');

    const supabase = createServerClient();
    const before = await loadDuration(durationId, supabase);
    await deleteServiceDuration(durationId, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.duration.delete',
      entityType: 'service_durations',
      entityId: durationId,
      before: { minutes: before.minutes, service_id: before.service_id },
      metadata: {},
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ deleted: true });
  });
}

async function loadDuration(
  durationId: string,
  supabase: ReturnType<typeof createServerClient>
): Promise<{ minutes: number; service_id: string; is_active: boolean }> {
  const { data, error } = await supabase
    .from('service_durations')
    .select('minutes, service_id, is_active')
    .eq('id', durationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('NOT_FOUND', 'That duration rung was not found.', 404);
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