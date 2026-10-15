import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { getAdminCoupon, updateCoupon } from '@/lib/adminCouponServer';
import { createServerClient } from '@/lib/supabaseServer';
import { requireAuth, requireCapability, uuid } from '@/lib/validation';
import { validateCouponInput } from '../route';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET/PATCH /api/admin/coupons/:id (§9, §24, §31.1).
 *
 * The detail screen's read (staff-wide) and the update (coupon.manage). PATCH
 * carries the full validated coupon form — the console edits one coupon at a
 * time — and both paths check existence up front so a bad id is a 404 with no
 * write (D3).
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.coupons.detail', async () => {
    await requireAuth(req, [...STAFF]);
    const id = uuid(params.id, 'id');

    const supabase = createServerClient();
    const coupon = await getAdminCoupon(id, supabase);
    if (!coupon) {
      throw new ApiHttpError('NOT_FOUND', 'That coupon was not found.', 404);
    }
    return ok({ coupon });
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.coupons.update', async (requestId) => {
    const auth = await requireCapability(req, 'coupon.manage');
    const id = uuid(params.id, 'id');
    const body = await readBody(req);

    const supabase = createServerClient();
    const before = await getAdminCoupon(id, supabase);
    if (!before) {
      throw new ApiHttpError('NOT_FOUND', 'That coupon was not found.', 404);
    }

    // The console sends discountType and discountValue together (see
    // `updateCoupon`'s invariant); validateCouponInput always returns both, so
    // a discount_value can never be re-typed under the wrong unit.
    const input = validateCouponInput(body);

    const coupon = await updateCoupon(id, input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'coupon.update',
      entityType: 'coupons',
      entityId: id,
      before: { code: before.code, discount_type: before.discountType, is_active: before.isActive },
      after: { code: coupon.code, discount_type: coupon.discount_type, is_active: coupon.is_active },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ coupon });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}