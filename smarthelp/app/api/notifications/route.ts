import { handle, ok } from '@/lib/api';
import { listNotifications } from '@/lib/notificationServer';
import { parsePaging, requireAuth } from '@/lib/validation';
import type { NotificationChannel } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANNELS: NotificationChannel[] = ['push', 'sms', 'email', 'in_app', 'whatsapp'];

/**
 * GET /api/notifications — the bell's page and its badge (§25.9, §27.1).
 *
 * Defaults to the `in_app` channel: that is the surface the bell shows and the
 * only one "read" means anything for. A caller may name another channel to see
 * the delivery history, which is what a debug or support view wants.
 */
export async function GET(req: Request) {
  return handle(req, 'notifications.list', async () => {
    const auth = await requireAuth(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url, 25, 100);

    const channelParam = url.searchParams.get('channel');
    const channel =
      channelParam && CHANNELS.includes(channelParam as NotificationChannel)
        ? (channelParam as NotificationChannel)
        : undefined;
    if (channelParam && !channel) {
      // Naming a channel that does not exist is the caller's mistake, not an
      // empty page — say so rather than silently returning nothing.
      return ok({ items: [], unread: 0, total: 0, ignoredChannel: channelParam });
    }

    const result = await listNotifications(auth.userId, {
      channel,
      unreadOnly: url.searchParams.get('unreadOnly') === 'true',
      limit,
      offset,
    });
    return ok(result);
  });
}
