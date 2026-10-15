import { ApiHttpError, created, handle } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createServiceDuration, getAdminService } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, int, num, requireCapability, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/services/:id/durations (§7, §24, §31.1).
 * `service.manage` adds a duration ladder rung to a service that exists.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.services.durations.create', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const serviceId = uuid(params.id, 'id');
    const body = await readBody(req);

    const supabase = createServerClient();
    const detail = await getAdminService(serviceId, supabase);
    if (!detail) {
      throw new ApiHttpError('NOT_FOUND', 'That service was not found.', 404);
    }

    const minutes = int(body.minutes, 'minutes', { min: 10, max: 1440 });
    const priceRaw = body.price;
    const price = priceRaw === undefined || priceRaw === null ? null : num(priceRaw, 'price', { min: 0 });
    const multRaw = body.priceMultiplier;
    const priceMultiplier = multRaw === undefined || multRaw === null ? null : num(multRaw, 'priceMultiplier', { min: 0.01 });
    if (price === null && priceMultiplier === null) {
      fail({ price: 'Give a price or a multiplier.' });
    }
    const isActive = body.isActive === undefined ? true : body.isActive === true;

    const duration = await createServiceDuration(serviceId, { minutes, price, priceMultiplier, isActive }, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.duration.create',
      entityType: 'service_durations',
      entityId: duration.id,
      after: { service_id: serviceId, minutes, price, price_multiplier: priceMultiplier, is_active: isActive },
      metadata: {},
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ duration });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}