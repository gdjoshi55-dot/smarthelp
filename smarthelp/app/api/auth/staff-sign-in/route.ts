import { NextResponse } from 'next/server';
import { handle, ok } from '@/lib/api';
import { readJson, validateStaffSignIn } from '@/lib/validation';
import { signInWithPasswordAndGrant } from '@/lib/sessionServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/staff-sign-in
 *
 * Kept as a second door into the same code, narrowed to the four operations
 * roles. `/api/auth/sign-in` serves every role and is what the sign-in form
 * uses; this one exists for the admin entry points that must never fall
 * through to a customer dashboard, and answers 403 where sign-in would have
 * returned a customer session.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.staff-sign-in', async (requestId) => {
    const body = await readJson(req);
    const { email, password } = validateStaffSignIn(body);

    const grant = await signInWithPasswordAndGrant({
      email,
      password,
      requestId,
      req,
      allow: 'staff',
    });

    return ok({
      session: grant.session,
      profile: grant.profile,
      role: grant.role,
      roleLabel: grant.roleLabel,
      capabilities: grant.capabilities,
    });
  });
}

export const GET = () =>
  NextResponse.json(
    { success: false, error: 'Use POST', code: 'VALIDATION_ERROR' } as const,
    { status: 405 }
  );
