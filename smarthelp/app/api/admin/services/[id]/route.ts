import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { getAdminService, updateService } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { requireAuth, requireCapability, uuid } from '@/lib/validation';
import { validateServiceInput } from '../route';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET/PATCH /api/admin/services/:id (§7, §24, §31.1).
 *
 * The edit screen's read (staff-wide) and update (`service.manage`). Existence
 * is checked up front; a bad id is a 404 and nothing is written (D3).
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.services.detail', async () => {
    await requireAuth(req, [...STAFF]);
    const id = uuid(params.id, 'id');

    const supabase = createServerClient();
    const detail = await getAdminService(id, supabase);
    if (!detail) {
      throw new ApiHttpError('NOT_FOUND', 'That service was not found.', 404);
    }
    return ok({ service: detail });
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.services.update', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const id = uuid(params.id, 'id');
    const body = await readBody(req);

    const supabase = createServerClient();
    const before = await getAdminService(id, supabase);
    if (!before) {
      throw new ApiHttpError('NOT_FOUND', 'That service was not found.', 404);
    }

    const input = validateServiceInput(body);
    const service = await updateService(id, input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.update',
      entityType: 'services',
      entityId: id,
      before: { name: before.service.name, pricing_type: before.service.pricing_type, is_active: before.service.is_active },
      after: { name: service.name, pricing_type: service.pricing_type, is_active: service.is_active },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ service: await getAdminService(id, supabase) });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}