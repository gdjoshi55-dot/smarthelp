import { ApiHttpError, created, handle } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createServiceArea, getAdminService } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { int, requireCapability, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/services/:id/areas (§7, §24, §31.1).
 * `service.manage` opens a service in one more locality. The locality must
 * exist and the service must exist; both are checked before the write (D3).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.services.areas.create', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const serviceId = uuid(params.id, 'id');
    const body = await readBody(req);

    const supabase = createServerClient();
    const detail = await getAdminService(serviceId, supabase);
    if (!detail) {
      throw new ApiHttpError('NOT_FOUND', 'That service was not found.', 404);
    }

    const localityId = uuid(body.localityId, 'localityId');
    const { data: locality, error: localityError } = await supabase
      .from('localities')
      .select('id, name')
      .eq('id', localityId)
      .maybeSingle();
    if (localityError) throw localityError;
    if (!locality) {
      throw new ApiHttpError('NOT_FOUND', 'That locality was not found.', 404);
    }

    const area = await createServiceArea(
      serviceId,
      {
        localityId,
        leadMinutes: body.leadMinutes === undefined ? 0 : int(body.leadMinutes, 'leadMinutes', { min: 0, max: 480 }),
        slotCapacity: body.slotCapacity === undefined ? 8 : int(body.slotCapacity, 'slotCapacity', { min: 1, max: 100 }),
        isActive: body.isActive === undefined ? true : body.isActive === true,
      },
      supabase
    );

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.area.create',
      entityType: 'service_areas',
      entityId: area.id,
      after: { service_id: serviceId, locality: locality.name, lead_minutes: area.lead_minutes, slot_capacity: area.slot_capacity },
      metadata: {},
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ area });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}