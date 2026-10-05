import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, validateSignUpComplete } from '@/lib/validation';
import { verifyOtp } from '@/lib/otp';
import { createServerClient } from '@/lib/supabaseServer';
import { signInWithPasswordAndGrant } from '@/lib/sessionServer';
import { audit, clientIp } from '@/lib/audit';
import { isOwnerLogin } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/sign-up/complete
 *
 * The verified half of sign-up. A good code for this address is the only thing
 * that gets an auth user created, and the password arrives here for the first
 * and only time.
 *
 * `admin.createUser` mints no session, so a real password sign-in follows
 * immediately. That is what makes the hand-off safe: the account is proven to
 * work with the password it was just given before the browser is told anything.
 *
 * `handle_new_user()` (0001) provisions the profile and the customers row, and
 * honours `user_metadata.role` for exactly two values — `customer` and
 * `professional`. A staff role in this request is not a privilege: the
 * validator rejects it before this point and the trigger ignores it after.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.sign-up-complete', async (requestId) => {
    const body = await readJson(req);
    const { email: address, role, fullName, code, password, phone } =
      validateSignUpComplete(body);

    const outcome = await verifyOtp(address, 'signup', code);
    switch (outcome) {
      case 'ok':
        break;
      case 'expired':
        throw new ApiHttpError('OTP_EXPIRED', 'That code has expired. Ask for a new one.');
      case 'locked':
        throw new ApiHttpError('OTP_LOCKED', 'Too many wrong attempts. Try again in 15 minutes.', 429, {
          retryAfterSeconds: 15 * 60,
        });
      default:
        throw new ApiHttpError('OTP_INVALID', 'That code is not right. Check it and try again.');
    }

    const supabase = createServerClient();

    // Re-checked here, not only in /start: the start step can be minutes old
    // and the ledger holds one open code per (target, purpose), so an address
    // that registered in between must not produce a second account.
    const { data: taken } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', address)
      .maybeSingle();
    if (taken) {
      throw new ApiHttpError(
        'ACCOUNT_EXISTS',
        'There is already an account with that email address. Sign in instead, or reset your password.',
        409,
        { fields: { email: 'This email is already registered' } }
      );
    }

    // email_confirm: true because /start already proved the address over SMTP.
    // Leaving it false would make Supabase send a second confirmation email
    // and park the account as unconfirmed, which the sign-in form would then
    // reject for no reason the person can act on.
    // `phone` is optional and omitted entirely when blank, so the trigger's
    // `coalesce(new.phone, meta->>'phone')` falls through to NULL. It also
    // discards a number that is malformed or already bound to another profile,
    // so the account is still created and the phone is simply not stored.
    const created = await supabase.auth.admin.createUser({
      email: address,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role,
        email: address,
        ...(phone ? { phone } : {}),
      },
    });

    if (created.error || !created.data?.user) {
      // A duplicate here means the address was taken between the two checks.
      // Anything else is a real fault, and the message does not say which —
      // it just sends them back to the sign-in form. The reason is logged,
      // because "we could not finish creating your account" on its own is not
      // something anyone can act on.
      const duplicate = /already|registered|exists/i.test(created.error?.message ?? '');
      console.error('createUser failed:', created.error?.message ?? 'no user returned');
      throw new ApiHttpError(
        duplicate ? 'ACCOUNT_EXISTS' : 'INTERNAL_ERROR',
        duplicate
          ? 'There is already an account with that email address. Sign in instead.'
          : 'We could not finish creating your account. Please try again.',
        duplicate ? 409 : 500
      );
    }

    // Open a real session with the password that was just set, so a signup that
    // reports success has actually been proven end to end. The anon client
    // does the sign-in — the service-role client is for the create above and
    // would bypass the very check this is making.
    let grant;
    try {
      grant = await signInWithPasswordAndGrant({ email: address, password, requestId, req });
    } catch (e: any) {
      console.error('sign-in after sign-up failed:', e?.message ?? e);
      throw new ApiHttpError(
        'INTERNAL_ERROR',
        'Your account was created, but we could not sign you in. Please sign in now.',
        500
      );
    }

    await audit(supabase, {
      actorProfileId: grant.profile.id,
      action: 'auth.signup',
      entityType: 'profiles',
      entityId: grant.profile.id,
      after: { role: grant.profile.role, email: address },
      metadata: { role, owner: isOwnerLogin(address) },
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok(
      {
        session: grant.session,
        profile: grant.profile,
        role: grant.role,
        roleLabel: grant.roleLabel,
        capabilities: grant.capabilities,
      },
      201
    );
  });
}

export const GET = () =>
  NextResponse.json(
    { success: false, error: 'Use POST', code: 'VALIDATION_ERROR' } as const,
    { status: 405 }
  );
