import { handle, ok } from '@/lib/api';
import { readJson, validateSignIn } from '@/lib/validation';
import { signInWithPasswordAndGrant } from '@/lib/sessionServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/sign-in
 *
 * Email + password, for every role. This replaces `/api/auth/staff-sign-in`:
 * a customer, a professional and an admin now all arrive at the same form, so
 * the endpoint cannot be the thing that tells them apart. The role is read
 * from the database and sent back with the session, and the client uses it to
 * choose the landing page.
 *
 * This replaced the passwordless phone code, which is why the password is
 * checked here rather than in the browser — Supabase Auth is the only thing
 * that ever sees it.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.sign-in', async (requestId) => {
    const body = await readJson(req);
    const { email, password } = validateSignIn(body);

    const grant = await signInWithPasswordAndGrant({ email, password, requestId, req });

    return ok({
      session: grant.session,
      profile: grant.profile,
      role: grant.role,
      roleLabel: grant.roleLabel,
      capabilities: grant.capabilities,
    });
  });
}
