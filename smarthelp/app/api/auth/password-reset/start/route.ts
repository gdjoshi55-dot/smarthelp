import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, validatePasswordResetStart } from '@/lib/validation';
import { deliverOtp, issueOtp, OTP_RESEND_SECONDS, OTP_TTL_MINUTES } from '@/lib/otp';
import { createServerClient } from '@/lib/supabaseServer';
import { maskEmail } from '@/lib/authServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password-reset/start
 *
 * Sends a code that proves control of a mailbox, for the password reset to
 * follow. It creates and changes nothing.
 *
 * The response is deliberately the same 200 whether or not the address is
 * registered: an unknown address returns success without sending anything, so
 * this endpoint cannot be used to find out who has an account. The delay that
 * a real send takes is not the protection here — the identical response is.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.password-reset-start', async () => {
    const body = await readJson(req);
    const { email: address } = validatePasswordResetStart(body);

    const supabase = createServerClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, status')
      .eq('email', address)
      .maybeSingle();

    // Unknown or suspended: the caller learns nothing and the ledger stays
    // empty, so there is not even a throttle signature to probe against.
    let devCode: string | undefined;
    if (profile && profile.status === 'active') {
      let code: string;
      try {
        ({ code } = await issueOtp(address, 'email', 'password_reset'));
      } catch (e: any) {
        if (e?.code === 'OTP_THROTTLED') {
          // A real throttle, so a real wait. Still the same shape as success.
          return ok(
            {
              channel: 'email',
              target: maskEmail(address),
              expiresInSeconds: OTP_TTL_MINUTES * 60,
              resendInSeconds: OTP_RESEND_SECONDS,
            },
            200
          );
        }
        throw e;
      }

      try {
        const delivery = await deliverOtp(address, 'email', code, 'password_reset');
        devCode = delivery.provider === 'console' ? code : undefined;
      } catch (e: any) {
        console.error('password-reset code delivery failed:', e?.message ?? e);
        throw new ApiHttpError(
          'INTERNAL_ERROR',
          'We could not send the code just now. Please try again in a minute.',
          502
        );
      }
    }

    return ok(
      {
        channel: 'email',
        target: maskEmail(address),
        expiresInSeconds: OTP_TTL_MINUTES * 60,
        resendInSeconds: OTP_RESEND_SECONDS,
        devCode,
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
