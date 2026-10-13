import { ApiHttpError, handle, ok } from '@/lib/api';
import { requireAuth, uuid } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { getAdminBooking } from '@/lib/adminServer';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET /api/admin/bookings/:id — one booking, with its whole history (§20.12).
 *
 * A missing id is a 404 and writes nothing (D3). The payload is the raw rows:
 * the booking, its items, the status timeline, every offer, the payments and
 * the refunds — the evidence an ops analyst works from.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.bookings.get', async () => {
    await requireAuth(req, [...STAFF]);
    const bookingId = uuid(params.id, 'id');

    const detail = await getAdminBooking(bookingId, createServerClient());
    if (!detail) {
      throw new ApiHttpError('NOT_FOUND', 'That booking was not found.', 404);
    }

    return ok(detail);
  });
}
