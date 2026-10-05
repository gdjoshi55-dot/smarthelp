import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, validateVerifyOtp } from '@/lib/validation';
import { verifyOtp } from '@/lib/otp';
import { createServerClient } from '@/lib/supabaseServer';
import { ensureAuthUserForPhone, issueSessionHandshake } from '@/lib/authServer';
import { audit, clientIp } from '@/lib/audit';
import { isOwnerLogin } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/verify-otp
 *
 * Verifies the code against `otp_requests`, then hands back a one-time
 * `token_hash`. The client exchanges that for a session with
 * `supabase.auth.verifyOtp({ token_hash, type: 'email' })`. Splitting it this
 * way keeps the decision (is this code good?) on the server, where the ledger,
 * the attempt counter and the lockout are, and leaves only the session
 * handshake in the browser.
 *
 * A wrong code and an expired code return the same message on purpose: the
 * difference is a log line, not a hint for someone guessing.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.verify-otp', async (requestId) => {
    const body = await readJson(req);
    const { channel, purpose, target, code } = validateVerifyOtp(body);

    const outcome = await verifyOtp(target, purpose, code);

    const failWith = (
      apiCode: 'OTP_INVALID' | 'OTP_EXPIRED' | 'OTP_LOCKED',
      message: string
    ): never => {
      throw new ApiHttpError(apiCode, message, undefined, {
        ...(apiCode === 'OTP_LOCKED' ? { retryAfterSeconds: 15 * 60 } : {}),
      });
    };

    switch (outcome) {
      case 'ok':
        break;
      case 'expired':
        return failWith('OTP_EXPIRED', 'That code has expired. Ask for a new one.');
      case 'locked':
        return failWith('OTP_LOCKED', 'Too many wrong attempts. Try again in 15 minutes.');
      case 'invalid':
        return failWith('OTP_INVALID', 'That code is not right. Check it and try again.');
      default:
        return failWith('OTP_INVALID', 'We did not recognise that code. Ask for a new one.');
    }

    // NEXT_PUBLIC_BASE_URL is the SmartPOS name for this and is preferred, so a
    // .env copied across from smartpos-main works unchanged. NEXT_PUBLIC_APP_URL
    // is still honoured for deployments that only have that one.
    const appUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      new URL(req.url).origin;

    if (channel === 'phone') {
      const role = body.role === 'professional' ? 'professional' : 'customer';
      const fullName =
        typeof body.full_name === 'string' && body.full_name.trim().length >= 2
          ? body.full_name.trim().slice(0, 120)
          : 'SmartHelp member';

      const { userId, email } = await ensureAuthUserForPhone({ phone: target, fullName, role });
      const { tokenHash } = await issueSessionHandshake(email, `${appUrl}/login`);

      const supabase = createServerClient();
      await audit(supabase, {
        actorProfileId: userId,
        action: 'auth.login',
        entityType: 'profiles',
        entityId: userId,
        metadata: { channel, purpose },
        ipAddress: clientIp(req),
        userAgent: req.headers.get('user-agent'),
        requestId,
      });

      return ok({ tokenHash, email, channel });
    }

    // Email codes are only for staff MFA, so the user must already exist and
    // must already hold a staff role.
    const supabase = createServerClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, status, full_name, email')
      .eq('email', target)
      .maybeSingle();

    if (!profile) {
      throw new ApiHttpError(
        'UNAUTHENTICATED',
        'No account exists for that email address.',
        401
      );
    }
    if (!['admin', 'super_admin', 'ops', 'support'].includes(profile.role)) {
      throw new ApiHttpError(
        'FORBIDDEN',
        'Staff sign-in is for the operations team. Customers sign in with a mobile number.',
        403
      );
    }
    if (profile.status !== 'active') {
      throw new ApiHttpError('FORBIDDEN', 'This account is not active.', 403);
    }

    const { tokenHash } = await issueSessionHandshake(target, `${appUrl}/login`);
    await promoteOwnerIfAllowListed(supabase, profile.id, profile.email, requestId, req);

    return ok({ tokenHash, email: target, channel });
  });
}

/**
 * The one way an account becomes super_admin: signing in with the login named
 * in SMARTHELP_OWNER_LOGIN (the server-only variable — see lib/owner.ts). It
 * can be removed afterwards, never granted to anyone else.
 */
async function promoteOwnerIfAllowListed(
  supabase: ReturnType<typeof createServerClient>,
  profileId: string,
  email: string | null,
  requestId: string,
  req: Request
) {
  if (!isOwnerLogin(email)) return;
  if (email) {
    await supabase
      .from('profiles')
      .update({ email })
      .eq('id', profileId);
  }
  const { data: current } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', profileId)
    .maybeSingle();
  if (!current || current.role === 'super_admin') return;

  const { error } = await supabase
    .from('profiles')
    .update({ role: 'super_admin' })
    .eq('id', profileId);
  if (!error) {
    await audit(supabase, {
      actorProfileId: profileId,
      action: 'auth.owner_bootstrap',
      entityType: 'profiles',
      entityId: profileId,
      before: { role: current.role },
      after: { role: 'super_admin' },
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });
  }
}

