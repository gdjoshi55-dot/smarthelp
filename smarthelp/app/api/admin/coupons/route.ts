import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createCoupon, listAdminCoupons } from '@/lib/adminCouponServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, int, num, oneOf, optionalStr, parsePaging, requireAuth, requireCapability, str, uuid } from '@/lib/validation';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const DISCOUNT_TYPES = ['percentage', 'fixed'] as const;
const COUPON_STATUSES = ['active', 'expired'] as const;

/**
 * GET/POST /api/admin/coupons — the promo-code console (§9, §24, §31.1).
 *
 * Any staff member reads the list; only `coupon.manage` (admin, super_admin)
 * creates a coupon. Validators mirror what `loadCoupon`/`pricing.ts` enforce on
 * the customer path, so a coupon the console saves can never be one the cart
 * quietly ignores.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.coupons.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const q = url.searchParams.get('q');
    const status = url.searchParams.get('status');

    const result = await listAdminCoupons(
      {
        q: q ? str(q, 'q', { max: 40 }) : undefined,
        status: status ? oneOf(status, 'status', COUPON_STATUSES) : undefined,
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}

export async function POST(req: Request) {
  return handle(req, 'admin.coupons.create', async (requestId) => {
    const auth = await requireCapability(req, 'coupon.manage');
    const body = await readBody(req);
    const input = validateCouponInput(body);

    const supabase = createServerClient();
    const coupon = await createCoupon(input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'coupon.create',
      entityType: 'coupons',
      entityId: coupon.id,
      after: { code: coupon.code, discount_type: coupon.discount_type, is_active: coupon.is_active },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ coupon });
  });
}

export function validateCouponInput(body: Record<string, unknown>) {
  const code = str(body.code, 'code', { min: 1, max: 32 }).toUpperCase();
  const discountType = oneOf(body.discountType, 'discountType', DISCOUNT_TYPES);
  const discountValue = num(body.discountValue, 'discountValue', {
    min: 0.01,
    ...(discountType === 'percentage' ? { max: 100 } : {}),
  });
  const maxDiscount =
    body.maxDiscount === undefined || body.maxDiscount === null
      ? null
      : num(body.maxDiscount, 'maxDiscount', { min: 0 });
  const minBookingAmount = num(body.minBookingAmount ?? 0, 'minBookingAmount', { min: 0 });
  const maxDiscountPctOfTotal = num(body.maxDiscountPctOfTotal ?? 100, 'maxDiscountPctOfTotal', { min: 0, max: 100 });

  const validFrom = isoInstant(body.validFrom, 'validFrom', { required: true });
  const validTo = body.validTo === undefined || body.validTo === null ? null : isoInstant(body.validTo, 'validTo', {});
  if (validTo !== null && validTo <= validFrom) {
    fail({ validTo: 'A coupon must be valid until after it becomes valid.' });
  }

  return {
    code,
    description: body.description === undefined ? null : optionalStr(body.description, 'description', { max: 120 }),
    discountType,
    discountValue,
    maxDiscount,
    minBookingAmount,
    maxDiscountPctOfTotal,
    validFrom,
    validTo,
    usageLimit: body.usageLimit === undefined || body.usageLimit === null ? null : int(body.usageLimit, 'usageLimit', { min: 1 }),
    perUserLimit: body.perUserLimit === undefined ? 1 : int(body.perUserLimit, 'perUserLimit', { min: 1, max: 100 }),
    applicableServices: optionalUuids(body.applicableServices, 'applicableServices'),
    applicableCities: optionalPincodes(body.applicableCities, 'applicableCities'),
    firstTimeOnly: body.firstTimeOnly === true,
    isActive: body.isActive === undefined ? true : body.isActive === true,
  };
}

function optionalUuids(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail({ [field]: 'Not a list' });
  return value.map((v) => uuid(v, field));
}

function optionalPincodes(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail({ [field]: 'Not a list' });
  const out: string[] = [];
  for (const v of value) {
    const s = str(v, field, { min: 6, max: 6 });
    if (!/^\d{6}$/.test(s)) fail({ [field]: 'Pincodes are six digits' });
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function isoInstant(value: unknown, field: string, opts: { required?: boolean }): string {
  if (value === undefined || value === null || value === '') {
    if (opts.required) fail({ [field]: 'Required' });
    return null as unknown as string;
  }
  const s = str(value, field, { max: 40 });
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) fail({ [field]: 'Enter a valid date' });
  return new Date(parsed).toISOString();
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}