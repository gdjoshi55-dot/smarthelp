import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { getSupportTicket, updateSupportTicket } from '@/lib/supportServer';
import { createServerClient } from '@/lib/supabaseServer';
import { optionalStr, oneOf, readJson, requireAuth, requireCapability, uuid } from '@/lib/validation';
import type { SupportTicketPriority, SupportTicketStatus, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/**
 * GET /api/admin/support/:id — one ticket and its thread (§24, §31.1).
 *
 * A bad id answers 404 with no write, the same contract as every other detail
 * route in the console (D3).
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.support.get', async () => {
    await requireAuth(req, [...STAFF]);
    const id = uuid(params.id, 'id');

    const detail = await getSupportTicket(id, createServerClient());
    if (!detail) {
      throw new ApiHttpError('NOT_FOUND', 'That support ticket was not found.', 404);
    }
    return ok(detail);
  });
}

/**
 * PATCH /api/admin/support/:id — triage a ticket (§24, §31.1, D4).
 *
 * `ticket.write` gates it. Only the triage fields can move: status, priority,
 * assignee and the closing resolution. `resolved_at` is derived by the server
 * module so the stamp cannot disagree with the status.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.support.update', async (requestId) => {
    const auth = await requireCapability(req, 'ticket.write');
    const id = uuid(params.id, 'id');
    const body = await readJson(req);
    const supabase = createServerClient();

    const before = await getSupportTicket(id, supabase);
    if (!before) {
      throw new ApiHttpError('NOT_FOUND', 'That support ticket was not found.', 404);
    }

    const patch: {
      status?: SupportTicketStatus;
      priority?: SupportTicketPriority;
      assignedTo?: string | null;
      resolution?: string | null;
    } = {};
    if (body.status !== undefined) patch.status = oneOf(body.status, 'status', STATUSES) as SupportTicketStatus;
    if (body.priority !== undefined)
      patch.priority = oneOf(body.priority, 'priority', PRIORITIES) as SupportTicketPriority;
    if (body.assignedTo !== undefined)
      patch.assignedTo = body.assignedTo === null ? null : uuid(body.assignedTo, 'assignedTo');
    if (body.resolution !== undefined)
      patch.resolution = optionalStr(body.resolution, 'resolution', { max: 2000 }) ?? null;

    const ticket = await updateSupportTicket(id, patch, supabase);
    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'support.update',
      entityType: 'support_tickets',
      entityId: id,
      before: {
        status: before.ticket.status,
        priority: before.ticket.priority,
        assigned_to: before.ticket.assignedToId,
      },
      after: patch as Record<string, unknown>,
      ipAddress: clientIp(req),
      requestId,
    });

    const detail = await getSupportTicket(ticket.id, supabase);
    return ok(detail ?? { ticket, messages: [] });
  });
}
