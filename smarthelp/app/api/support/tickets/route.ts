import { created, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { createMyTicket, listMyTickets } from '@/lib/supportCustomerServer';
import { createServerClient } from '@/lib/supabaseServer';
import { oneOf, optionalStr, parsePaging, readJson, str, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The categories the customer form offers; the column itself is free text. */
const CATEGORIES = ['booking', 'payment', 'professional', 'account', 'safety', 'other'] as const;

/**
 * GET /api/support/tickets — the caller's own tickets (§25.9).
 *
 * Customer-scoped: `requireCustomer` resolves the `customers.id` and the list is
 * filtered by `raised_by` in the module, never by a query string. Staff read the
 * queue from `/api/admin/support`, which is a different screen with a different
 * question behind it.
 */
export async function GET(req: Request) {
  return handle(req, 'support.tickets.list', async () => {
    const { auth } = await requireCustomer(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const { tickets, total } = await listMyTickets(auth.userId, { limit, offset });
    return ok({ tickets, total, limit, offset });
  });
}

/**
 * POST /api/support/tickets — open a ticket (§25.9).
 *
 * A ticket is "help me". The opening message is written in the same call so a
 * ticket is never an empty shell. A `bookingId` is optional, but if one is given
 * it must be the caller's own booking — otherwise a customer could attach a
 * ticket to a stranger's job and read its booking context back out of the thread.
 */
export async function POST(req: Request) {
  return handle(req, 'support.tickets.create', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const body = await readJson(req);

    const subject = str(body.subject, 'subject', { min: 3, max: 160 });
    const category = oneOf(body.category ?? 'other', 'category', CATEGORIES);
    const message = str(body.message, 'message', { min: 1, max: 4000 });
    const bookingIdRaw = optionalStr(body.bookingId, 'bookingId', { max: 64 });

    const supabase = createServerClient();

    // `bookings.customer_id` references `customers(id)`, not the profile id, so the
    // ownership check is against the resolved customer row. A bookingId that is
    // not the caller's is dropped rather than refused: the ticket is still valid,
    // it just does not carry somebody else's booking context.
    let bookingId: string | null = null;
    if (bookingIdRaw) {
      const candidate = uuid(bookingIdRaw, 'bookingId');
      const { data: owned, error } = await supabase
        .from('bookings')
        .select('id')
        .eq('id', candidate)
        .eq('customer_id', customer.id)
        .maybeSingle();
      if (error) throw error;
      if (owned) bookingId = candidate;
    }

    const { ticket, message: firstMessage } = await createMyTicket({
      raisedBy: auth.userId,
      subject,
      category,
      bookingId,
      message,
    });

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'support.ticket.create',
      entityType: 'support_tickets',
      entityId: ticket.id,
      metadata: { category, booking_id: bookingId },
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ ticket, messages: [firstMessage] });
  });
}
