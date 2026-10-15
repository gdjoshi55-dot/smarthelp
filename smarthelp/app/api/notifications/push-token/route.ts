import { handle, ok, created } from '@/lib/api';
import { registerDevice, removeDevice } from '@/lib/notificationServer';
import { readJson, requireAuth, oneOf, str } from '@/lib/validation';
import type { NotificationDevice } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLATFORMS: NotificationDevice['platform'][] = ['web', 'ios', 'android'];

/**
 * POST /api/notifications/push-token — register a push token (§25.9, D1).
 *
 * There is no FCM/APNs provider yet, so registering a token does not by itself
 * deliver anything: it fills the registry a later integration reads, and it is
 * what the browser/web-push path will key on. The row is still the source of
 * truth for "which devices does this profile have".
 */
export async function POST(req: Request) {
  return handle(req, 'notifications.pushToken', async () => {
    const auth = await requireAuth(req);
    const body = await readJson(req);
    const token = str(body.token, 'token', { min: 8, max: 4096 });
    const platform = oneOf(body.platform ?? 'web', 'platform', PLATFORMS);

    const device = await registerDevice(auth.userId, token, platform);
    return created({ device });
  });
}

/**
 * DELETE /api/notifications/push-token — forget a token on sign-out.
 *
 * The complement of the registration: a shared device that signs out must stop
 * receiving another profile's notifications.
 */
export async function DELETE(req: Request) {
  return handle(req, 'notifications.pushToken.delete', async () => {
    const auth = await requireAuth(req);
    // A missing body is a token-less request, which `str` rejects as a
    // validation error — the same answer as an empty token.
    const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
    const token = str(body.token, 'token', { min: 8, max: 4096 });
    await removeDevice(auth.userId, token);
    return ok({ removed: true });
  });
}
