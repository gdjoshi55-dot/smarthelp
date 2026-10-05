import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, str } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/auth/refresh
 *
 * Exchanges a refresh token for a new access token, server-side, so a caller
 * that cannot hold a Supabase client (a cron, a webhook retry, a native shell)
 * still gets a session. The browser normally refreshes on its own through the
 * supabase-js client and does not need this.
 */
export async function PUT(req: Request) {
  return handle(req, 'auth.refresh', async () => {
    const body = await readJson(req);
    const refreshToken = str(body.refresh_token, 'refresh_token', { min: 20, max: 400 });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new ApiHttpError('INTERNAL_ERROR', 'Authentication is not configured.', 500);
    }

    const { createClient } = await import('@supabase/supabase-js');
    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) {
      throw new ApiHttpError(
        'UNAUTHENTICATED',
        'Your session has expired. Please sign in again.',
        401
      );
    }

    return ok({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  });
}
