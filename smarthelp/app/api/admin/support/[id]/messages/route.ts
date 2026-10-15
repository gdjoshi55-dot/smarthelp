import { ApiHttpError, created, handle } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { addSupportMessage, getSupportTicket } from '@/lib/supportServer';
import { notifyTicketUpdate } from '@/lib/notificationHooks';
import { createServerClient } from '@/lib/supabaseServer';
import { readJson, requireCapability, str, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/support/:id/messages — add a message to a ticket thread
 * (§24, §31.1, D4).
 *
 * `ticket.write` gates it. The ticket must exist first — a message on a missing
 * ticket is a 404 with no write (D3), not a row pointing at nothing. `isInternal`
 * marks a staff-only note; it is stored, not derived, so the caller is explicit
 * about who the message is for.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.support.message', async (requestId) => {
    const auth = await requireCapability(req, 'ticket.write');
    const ticketId = uuid(params.id, 'id');
    const body = await readJson(req);

    const supabase = createServerClient();
    const existing = await getSupportTicket(ticketId, supabase);
    if (!existing) {
      throw new ApiHttpError('NOT_FOUND', 'That support ticket was not found.', 404);
    }

    const text = str(body.body, 'body', { min: 1, max: 4000 });
    const isInternal = body.isInternal === true;

    const message = await addSupportMessage(
      ticketId,
      { authorProfileId: auth.userId, body: text, isInternal },
      supabase
    );

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: isInternal ? 'support.note' : 'support.reply',
      entityType: 'support_messages',
      entityId: message.id,
      metadata: { ticket_id: ticketId, is_internal: isInternal },
      ipAddress: clientIp(req),
      requestId,
    });

    // A visible reply reaches the person who raised the ticket (§27.5
    // TICKET_UPDATE). An internal note never leaves the console.
    if (!isInternal) {
      await notifyTicketUpdate(ticketId, existing.ticket.raisedById);
    }

    return created({ message });
  });
}
