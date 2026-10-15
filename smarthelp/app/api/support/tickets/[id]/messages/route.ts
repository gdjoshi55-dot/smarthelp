import { created, handle } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { addMyTicketMessage } from '@/lib/supportCustomerServer';
import { notifyTicketUpdate } from '@/lib/notificationHooks';
import { createServerClient } from '@/lib/supabaseServer';
import { readJson, str, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/support/tickets/:id/messages — reply to an owned ticket (§25.9).
 *
 * `is_internal` is never read from the body: a customer message is public to the
 * thread by construction. Ownership and the closed-ticket refusal live in the
 * module; this route is the doorway. A reply pings the assigned agent, if there
 * is one, so a support thread does not go quiet.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'support.tickets.message', async (requestId) => {
    const { auth } = await requireCustomer(req);
    const id = uuid(params.id, 'id');
    const body = await readJson(req);
    const text = str(body.body, 'body', { min: 1, max: 4000 });

    const supabase = createServerClient();
    const { message, assignedTo } = await addMyTicketMessage(id, auth.userId, text, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'support.ticket.reply',
      entityType: 'support_messages',
      entityId: message.id,
      metadata: { ticket_id: id },
      ipAddress: clientIp(req),
      requestId,
    });

    if (assignedTo) {
      await notifyTicketUpdate(id, assignedTo);
    }

    return created({ message });
  });
}
