import { handle, ok } from '@/lib/api';
import { listAdminDisputes } from '@/lib/supportServer';
import { createServerClient } from '@/lib/supabaseServer';
import { oneOf, parsePaging, requireAuth, str } from '@/lib/validation';
import type { DisputeStatus, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const STATUSES = ['open', 'investigating', 'resolved', 'rejected'] as const;

/**
 * GET /api/admin/disputes — the dispute queue (§24, §25.10, §31.1).
 *
 * Any staff member reads the queue; adjudicating one is `dispute.resolve`
 * (ops/admin) in the route below. Filters: `status` and a booking-number
 * substring (`q`), paginated.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.disputes.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');

    const result = await listAdminDisputes(
      {
        status: status ? (oneOf(status, 'status', STATUSES) as DisputeStatus) : undefined,
        q: q ? str(q, 'q', { max: 40 }) : undefined,
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}
