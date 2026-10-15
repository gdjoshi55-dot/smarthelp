import { handle, ok } from '@/lib/api';
import { markAllRead } from '@/lib/notificationServer';
import { requireAuth } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/notifications/read-all — clear the bell (§25.9).
 *
 * The companion to `POST /api/notifications/:id/read`, and the reason the
 * server module has a `markAllRead`: clearing a badge one request per row is
 * the kind of thing that works in a demo and disappoints in production. Scoped
 * to the caller's own `in_app` rows, so it can only ever clear the badge it was
 * asked to.
 */
export async function POST(req: Request) {
  return handle(req, 'notifications.readAll', async () => {
    const auth = await requireAuth(req);
    const marked = await markAllRead(auth.userId);
    return ok({ marked });
  });
}
