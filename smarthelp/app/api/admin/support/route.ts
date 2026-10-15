import { handle, ok } from '@/lib/api';
import { listSupportTickets } from '@/lib/supportServer';
import { createServerClient } from '@/lib/supabaseServer';
import { oneOf, parsePaging, requireAuth, str, uuid } from '@/lib/validation';
import type { SupportTicketPriority, SupportTicketStatus, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/**
 * GET /api/admin/support — the support queue (§24, §31.1).
 *
 * Any staff member reads it (`ticket.read.all` is held by all four staff roles);
 * writing a ticket or a message is `ticket.write` in the routes below. Filters:
 * `status`, `priority`, `assignedTo`, and a subject substring (`q`), paginated.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.support.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const status = url.searchParams.get('status');
    const priority = url.searchParams.get('priority');
    const assignedTo = url.searchParams.get('assignedTo');
    const q = url.searchParams.get('q');

    const result = await listSupportTickets(
      {
        status: status ? (oneOf(status, 'status', STATUSES) as SupportTicketStatus) : undefined,
        priority: priority ? (oneOf(priority, 'priority', PRIORITIES) as SupportTicketPriority) : undefined,
        assignedTo: assignedTo ? uuid(assignedTo, 'assignedTo') : undefined,
        q: q ? str(q, 'q', { max: 120 }) : undefined,
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}
