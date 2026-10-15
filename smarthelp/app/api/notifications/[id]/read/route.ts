import { ApiHttpError, handle, ok } from '@/lib/api';
import { markRead } from '@/lib/notificationServer';
import { requireAuth, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/notifications/:id/read — mark one notification read (§25.9).
 *
 * Scoped to the caller's own rows: a guessed id returns the same 404 as an id
 * that never existed, so the endpoint is not a way to probe whose
 * notifications exist.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'notifications.read', async () => {
    const auth = await requireAuth(req);
    const id = uuid(params.id, 'id');

    const item = await markRead(id, auth.userId);
    if (!item) {
      throw new ApiHttpError('NOT_FOUND', 'That notification was not found.', 404);
    }
    return ok({ id: item.id, status: item.status, readAt: item.read_at });
  });
}
