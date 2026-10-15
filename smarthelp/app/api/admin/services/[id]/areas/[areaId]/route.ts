import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { deleteServiceArea, updateServiceArea } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { int, requireCapability, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH/DELETE /api/admin/services/:id/areas/:areaId (§7, §24, §31.1).
 * Deactivating an area is the usual operation (a locality temporarily drops
 * out); hard delete is the escape hatch. `service.manage` gates both.
 */
export async function PATCH(req: Request, { params }: { params: { id: string; areaId: string } }) {
  return handle(req, 'admin.services.areas.update', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const areaId = uuid(params.areaId, 'areaId');
    const body = await readBody(req);

    const supabase = createServerClient();
    const before = await loadArea(areaId, supabase);

    const patch: Record<string, unknown> = {};
    if (body.leadMinutes !== undefined)
      patch.leadMinutes = int(body.leadMinutes, 'leadMinutes', { min: 0, max: 480 });
    if (body.slotCapacity !== undefined)
      patch.slotCapacity = int(body.slotCapacity, 'slotCapacity', { min: 1, max: 100 });
    if (body.isActive !== undefined) patch.isActive = body.isActive === true;

    const area = await updateServiceArea(areaId, patch, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.area.update',
      entityType: 'service_areas',
      entityId: areaId,
      before: { lead_minutes: before.lead_minutes, slot_capacity: before.slot_capacity, is_active: before.is_active },
      after: { lead_minutes: area.lead_minutes, slot_capacity: area.slot_capacity, is_active: area.is_active },
      metadata: { patch },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ area });
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string; areaId: string } }) {
  return handle(req, 'admin.services.areas.delete', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const areaId = uuid(params.areaId, 'areaId');

    const supabase = createServerClient();
    const before = await loadArea(areaId, supabase);
    await deleteServiceArea(areaId, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.area.delete',
      entityType: 'service_areas',
      entityId: areaId,
      before: { locality_id: before.locality_id, is_active: before.is_active },
      metadata: {},
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ deleted: true });
  });
}

async function loadArea(
  areaId: string,
  supabase: ReturnType<typeof createServerClient>
): Promise<{ locality_id: string; lead_minutes: number; slot_capacity: number; is_active: boolean }> {
  const { data, error } = await supabase
    .from('service_areas')
    .select('locality_id, lead_minutes, slot_capacity, is_active')
    .eq('id', areaId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('NOT_FOUND', 'That service area was not found.', 404);
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