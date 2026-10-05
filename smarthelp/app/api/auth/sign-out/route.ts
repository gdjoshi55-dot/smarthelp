import { handle, ok } from '@/lib/api';
import { requireAuth } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { audit, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/sign-out
 *
 * Revokes the refresh token server-side, so a stolen refresh token dies with
 * the session. The browser also clears its local copy, but that is the
 * cosmetic half; this is the half that matters.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.sign-out', async (requestId) => {
    const auth = await requireAuth(req);
    const supabase = createServerClient();

    const { error } = await supabase.auth.admin.signOut(auth.accessToken);
    if (error) {
      // Already revoked is a success from the user's point of view.
      console.warn(`[${requestId}] sign-out revoke returned: ${error.message}`);
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'auth.sign_out',
      entityType: 'profiles',
      entityId: auth.userId,
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok({ revoked: !error });
  });
}
