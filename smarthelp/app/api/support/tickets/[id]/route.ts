import { ApiHttpError, handle, ok } from '@/lib/api';
import { requireCustomer } from '@/lib/addressServer';
import { getMyTicket } from '@/lib/supportCustomerServer';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/support/tickets/:id — one owned ticket and its visible thread (§25.9).
 *
 * `getMyTicket` returns `null` for a ticket the caller did not raise, and the
 * route answers `404` rather than `403`: whether somebody else's ticket exists is
 * not a fact this endpoint should confirm. Internal staff notes are filtered out
 * in the module before anything is returned.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'support.tickets.get', async () => {
    const { auth } = await requireCustomer(req);
    const id = uuid(params.id, 'id');

    const result = await getMyTicket(id, auth.userId);
    if (!result) {
      throw new ApiHttpError('NOT_FOUND', 'That support ticket was not found.', 404);
    }

    return ok(result);
  });
}
