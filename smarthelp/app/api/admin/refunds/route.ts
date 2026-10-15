import { handle, ok } from '@/lib/api';
import { listAdminRefunds } from '@/lib/adminServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, oneOf, parsePaging, requireAuth, str } from '@/lib/validation';
import type { RefundStatus, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const REFUND_STATUSES = ['requested', 'approved', 'rejected', 'completed', 'failed'] as const;

/**
 * GET /api/admin/refunds — the refunds console (§22, §25.10, §31.1).
 *
 * Any staff member can read the queue; only `refund.execute` can run a refund.
 * Filters: `status`, a booking-number substring (`q`), a `requested_at` window
 * (`from`/`to`), paginated — all validated before the service-role query runs.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.refunds.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const result = await listAdminRefunds(
      {
        status: status ? oneOf(status, 'status', REFUND_STATUSES) : undefined,
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