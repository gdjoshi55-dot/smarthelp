import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, validateSignUpStart } from '@/lib/validation';
import { deliverOtp, issueOtp, OTP_RESEND_SECONDS, OTP_TTL_MINUTES } from '@/lib/otp';
import { createServerClient } from '@/lib/supabaseServer';
import { maskEmail } from '@/lib/authServer';
import { audit, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/sign-up/start
 *
 * The first half of sign-up, and the only part that can be spammed. It proves
 * the person controls the mailbox and stops there: no auth user, no profile,
 * no password. The account is not created until `/complete` has seen a good
 * code for this address, so an address that bounces costs nothing and cannot
 * be squatted by someone who never proved they own it.
 *
 * The password is deliberately absent from this request. It is held in the
 * browser until the code comes back, and is sent exactly once.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.sign-up-start', async (requestId) => {
    const body = await readJson(req);
    const { email: address, role } = validateSignUpStart(body);

    const supabase = createServerClient();

    // uniq_profiles_email is a partial unique index on lower(email), so this is
    // an index lookup. A phone-first account has a synthetic address and a NULL
    // email, so it is not in here and cannot be signed into this way — those
    // accounts keep the old sign-in until they set a password.
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

    let code: string;
    try {
      ({ code } = await issueOtp(address, 'email', 'signup'));
    } catch (e: any) {
      if (e?.code === 'OTP_THROTTLED') {
        throw new ApiHttpError(
          'RATE_LIMITED',
          'A code was just sent to this address. Wait a minute, then ask for another.',
          429,
          { retryAfterSeconds: OTP_RESEND_SECONDS }
        );
      }
      throw e;
    }

    let delivery;
    try {
      delivery = await deliverOtp(address, 'email', code, 'signup');
    } catch (e: any) {
      console.error('sign-up code delivery failed:', e?.message ?? e);
      throw new ApiHttpError(
        'INTERNAL_ERROR',
        'We could not send the code just now. Please try again in a minute.',
        502
      );
    }

    // Sign-up is not a session, so there is no profile id to hang the row off
    // yet. Only the outcome and the role are recorded — never the password,
    // and not the name, because an audit table is not where a stranger's
    // typed details belong.
    await audit(supabase, {
      actorProfileId: null,
      action: 'auth.signup_code_requested',
      entityType: 'profiles',
      metadata: { channel: 'email', purpose: 'signup', role },
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok(
      {
        channel: 'email',
        target: maskEmail(address),
        expiresInSeconds: OTP_TTL_MINUTES * 60,
        resendInSeconds: OTP_RESEND_SECONDS,
        // Echoed only when no SMTP is configured, i.e. a developer's own
        // machine. Never when a real mailbox could have received it.
        devCode: delivery.provider === 'console' ? code : undefined,
      },
      200
    );
  });
}

export const GET = () =>
  NextResponse.json(
    { success: false, error: 'Use POST', code: 'VALIDATION_ERROR' } as const,
    { status: 405 }
  );
