import { handle, ok } from '@/lib/api';
import { requireAuth } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { getDashboardSummary } from '@/lib/adminServer';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET /api/admin/dashboard — the operations overview (§20.11).
 *
 * Read-only, so the gate is the staff role in the database rather than a
 * finer capability: support, ops and admin all see the dashboard (their
 * `ROLE_SECTIONS` each begin with it), and the numbers are aggregate, not
 * per-record. Every write in this tree is capability-gated separately.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.dashboard', async () => {
    await requireAuth(req, [...STAFF]);
    const summary = await getDashboardSummary(createServerClient());
    return ok(summary);
  });
}
