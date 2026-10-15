import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createService, listAdminServices } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, int, num, oneOf, optionalStr, parsePaging, requireAuth, requireCapability, str, uuid } from '@/lib/validation';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const PRICING_TYPES = ['hourly', 'flat', 'per_unit'] as const;

/**
 * GET/POST /api/admin/services — the catalogue editor (§7, §24, §31.1).
 *
 * Staff read the catalogue; `service.manage` (admin, super_admin) creates.
 * The validators mirror what the booking-quote engine reads, so a service the
 * console saves can be quoted — under the same invariant: `per_unit` services
 * must carry a unit label and price.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.services.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const q = url.searchParams.get('q');
    const categoryId = url.searchParams.get('categoryId');
    const isActiveRaw = url.searchParams.get('isActive');

    const result = await listAdminServices(
      {
        q: q ? str(q, 'q', { max: 80 }) : undefined,
        categoryId: categoryId ? uuid(categoryId, 'categoryId') : undefined,
        isActive: isActiveRaw === null ? undefined : isActiveRaw === 'true',
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}

export async function POST(req: Request) {
  return handle(req, 'admin.services.create', async (requestId) => {
    const auth = await requireCapability(req, 'service.manage');
    const body = await readBody(req);
    const input = validateServiceInput(body);

    const supabase = createServerClient();
    const detail = await createService(input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'service.create',
      entityType: 'services',
      entityId: detail.service.id,
      after: { name: detail.service.name, slug: detail.service.slug, pricing_type: detail.service.pricing_type },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ service: detail });
  });
}

export function validateServiceInput(body: Record<string, unknown>) {
  const pricingType = oneOf(body.pricingType, 'pricingType', PRICING_TYPES);
  const unitLabel = body.unitLabel === undefined ? null : optionalStr(body.unitLabel, 'unitLabel', { max: 20 });
  const unitPrice = body.unitPrice === undefined || body.unitPrice === null
    ? null
    : num(body.unitPrice, 'unitPrice', { min: 0 });
  if (pricingType === 'per_unit' && (unitLabel === null || unitPrice === null)) {
    fail({ unitLabel: 'A per-unit service needs a unit label and price.' });
  }

  const minDurationMin = body.minDurationMin === undefined ? 30 : int(body.minDurationMin, 'minDurationMin', { min: 10, max: 1440 });
  const maxDurationMin = body.maxDurationMin === undefined ? 480 : int(body.maxDurationMin, 'maxDurationMin', { min: 10, max: 1440 });
  if (maxDurationMin < minDurationMin) {
    fail({ maxDurationMin: 'Cannot be shorter than the minimum duration.' });
  }

  const durations = body.durations === undefined ? undefined : validateDurations(body.durations);

  return {
    categoryId: uuid(body.categoryId, 'categoryId'),
    name: str(body.name, 'name', { min: 1, max: 80 }),
    shortDescription: body.shortDescription === undefined ? null : optionalStr(body.shortDescription, 'shortDescription', { max: 300 }),
    description: body.description === undefined ? null : optionalStr(body.description, 'description', { max: 2000 }),
    imageUrl: body.imageUrl === undefined ? null : optionalStr(body.imageUrl, 'imageUrl', { max: 300 }),
    basePrice: num(body.basePrice, 'basePrice', { min: 0 }),
    pricingType,
    unitLabel,
    unitPrice,
    minDurationMin,
    maxDurationMin,
    prepMinutes: body.prepMinutes === undefined ? 15 : int(body.prepMinutes, 'prepMinutes', { min: 0, max: 480 }),
    maxActiveJobs: body.maxActiveJobs === undefined ? 3 : int(body.maxActiveJobs, 'maxActiveJobs', { min: 1, max: 100 }),
    materialsIncluded: body.materialsIncluded === true,
    materialsNote: body.materialsNote === undefined ? null : optionalStr(body.materialsNote, 'materialsNote', { max: 200 }),
    requiresPhotoProof: body.requiresPhotoProof === true,
    sortOrder: body.sortOrder === undefined ? 0 : int(body.sortOrder, 'sortOrder', { min: -10_000, max: 10_000 }),
    isActive: body.isActive === undefined ? true : body.isActive === true,
    durations,
  };
}

function validateDurations(value: unknown) {
  if (!Array.isArray(value)) fail({ durations: 'Not a list' });
  return value.map((d) => {
    if (typeof d !== 'object' || d === null) fail({ durations: 'Not a list of durations' });
    const minutes = int((d as Record<string, unknown>).minutes, 'durations.minutes', { min: 10, max: 1440 });
    const priceRaw = (d as Record<string, unknown>).price;
    const price = priceRaw === undefined || priceRaw === null ? null : num(priceRaw, 'durations.price', { min: 0 });
    const multRaw = (d as Record<string, unknown>).priceMultiplier;
    const priceMultiplier = multRaw === undefined || multRaw === null ? null : num(multRaw, 'durations.priceMultiplier', { min: 0.01 });
    return {
      minutes,
      price,
      priceMultiplier,
      isActive: (d as Record<string, unknown>).isActive === undefined ? true : (d as Record<string, unknown>).isActive === true,
    };
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}