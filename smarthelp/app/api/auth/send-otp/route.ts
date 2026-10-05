import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, validateSendOtp } from '@/lib/validation';
import { deliverOtp, issueOtp, OTP_RESEND_SECONDS, OTP_TTL_MINUTES } from '@/lib/otp';
import { createServerClient } from '@/lib/supabaseServer';
import { ensureAuthUserForPhone } from '@/lib/authServer';
import { audit, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/send-otp
 *
 * Issues a one-time code and delivers it. Public by design — a caller has no
 * session yet — so the abuse control is the ledger itself: a 60 second resend
 * throttle, a 10 minute TTL, 3 attempts and a 15 minute lockout, all enforced
 * in SQL so two concurrent requests cannot both slip through.
 *
 * For a phone that has never signed in, this is also the sign-up: the auth
 * user and the profile are created here, with the role limited to `customer`
 * or `professional`. A staff role is never accepted from this endpoint.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.send-otp', async (requestId) => {
    const body = await readJson(req);
    const { channel, purpose, target } = validateSendOtp(body);

    // A login code is only ever sent to a phone; an email code is for staff MFA.
    if (purpose === 'login' && channel !== 'phone') {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'Enter your mobile number to sign in.',
        400,
        { fields: { phone: 'Use your 10-digit mobile number' } }
      );
    }
    if (purpose === 'staff_login' && channel !== 'email') {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'Staff sign-in uses a code sent to your email address.',
        400
      );
    }

    // Provision on first contact, so verify has something to verify against.
    if (channel === 'phone' && purpose === 'login') {
      const role = body.role === 'professional' ? 'professional' : 'customer';
      const fullName =
        typeof body.full_name === 'string' && body.full_name.trim().length >= 2
          ? body.full_name.trim().slice(0, 120)
          : 'SmartHelp member';

      const { userId } = await ensureAuthUserForPhone({ phone: target, fullName, role });

      const supabase = createServerClient();
      await audit(supabase, {
        actorProfileId: userId,
        action: 'auth.otp_requested',
        entityType: 'profiles',
        entityId: userId,
        metadata: { channel, purpose, role },
        ipAddress: clientIp(req),
        userAgent: req.headers.get('user-agent'),
        requestId,
      });
    }

    // The resend throttle is an expected answer, not a fault: a client that
    // asks twice gets 429 with the wait, rather than a generic 500.
    let code: string;
    try {
      ({ code } = await issueOtp(target, channel, purpose));
    } catch (e: any) {
      if (e?.code === 'OTP_THROTTLED') {
        throw new ApiHttpError(
          'RATE_LIMITED',
          'A code was just sent to this number. Wait a minute, then ask for another.',
          429,
          { retryAfterSeconds: OTP_RESEND_SECONDS }
        );
      }
      throw e;
    }

    let delivery;
    try {
      delivery = await deliverOtp(target, channel, code, purpose);
    } catch (e: any) {
      console.error('OTP delivery failed:', e?.message ?? e);
      throw new ApiHttpError(
        'INTERNAL_ERROR',
        'We could not send the code just now. Please try again in a minute.',
        502
      );
    }

    return ok(
      {
        channel,
        target: channel === 'phone' ? target : maskEmail(target),
        expiresInSeconds: OTP_TTL_MINUTES * 60,
        resendInSeconds: 60,
        // The code is echoed only when there is no provider to deliver it, i.e.
        // a developer's local machine. Never when SMS or SMTP is configured.
        devCode: delivery.provider === 'console' ? code : undefined,
      },
      200
    );
  });
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export const GET = () =>
  NextResponse.json(
    { success: false, error: 'Use POST', code: 'VALIDATION_ERROR' } as const,
    { status: 405 }
  );
