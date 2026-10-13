import { handle, ok } from '@/lib/api';
import { oneOf, fail, parsePaging, requireAuth, str } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { listAdminBookings } from '@/lib/adminServer';
import type { BookingStatus, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const BOOKING_STATUSES = [
  'draft',
  'payment_pending',
  'paid',
  'searching',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'otp_verified',
  'in_progress',
  'extension_requested',
  'completed',
  'cancelled',
  'refund_pending',
  'refunded',
  'disputed',
  'no_show',
  'closed',
] as const;

/**
 * GET /api/admin/bookings — the booking queue (§20.12).
 *
 * Filterable by `status`, by a booking-number substring (`q`), and by a
 * `created_at` window (`from`/`to`), and paginated. Every filter is validated
 * before it reaches the query; the service-role client would otherwise run
 * whatever a caller typed.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.bookings.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const result = await listAdminBookings(
      {
        status: status ? (oneOf(status, 'status', BOOKING_STATUSES) as BookingStatus) : undefined,
        q: q ? str(q, 'q', { max: 40 }) : undefined,
        from: from ? isoInstant(from, 'from') : undefined,
        to: to ? isoInstant(to, 'to') : undefined,
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}

function isoInstant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail({ [field]: 'Enter a valid date' });
  return new Date(parsed).toISOString();
}
