import { handle, ok } from '@/lib/api';
import { listTemplates } from '@/lib/notificationServer';
import { parsePaging, requireAuth } from '@/lib/validation';
import type { NotificationChannel, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const CHANNELS: NotificationChannel[] = ['push', 'sms', 'email', 'in_app', 'whatsapp'];

/**
 * GET /api/admin/notification-templates — the message catalogue (§25.10).
 *
 * Any staff member may read it (support needs to know what a customer was
 * sent); only `notification.manage` — held by admin — may edit it, in the
 * sibling `[id]` route.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.notificationTemplates.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url, 100, 200);

    const channelParam = url.searchParams.get('channel');
    const channel =
      channelParam && CHANNELS.includes(channelParam as NotificationChannel)
        ? (channelParam as NotificationChannel)
        : undefined;
    const activeParam = url.searchParams.get('isActive');

    const { templates, total } = await listTemplates({
      code: url.searchParams.get('code') ?? undefined,
      channel,
      locale: url.searchParams.get('locale') ?? undefined,
      isActive: activeParam === null ? undefined : activeParam === 'true',
      limit,
      offset,
    });
    return ok({ templates, total });
  });
}
