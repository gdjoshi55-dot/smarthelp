import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, validatePasswordResetComplete } from '@/lib/validation';
import { verifyOtp } from '@/lib/otp';
import { createServerClient } from '@/lib/supabaseServer';
import { requireActiveProfile } from '@/lib/sessionServer';
import { audit, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password-reset/complete
 *
 * The only place a SmartHelp password is ever changed.
 *
 * Order matters: the code is checked first, then the account, then the write.
 * Checking the account first would let someone with no code learn whether an
 * address is registered; checking the code first means a wrong code is the
 * answer you get, whatever the address turns out to be.
 *
 * `admin.updateUserById` is used rather than Supabase's own reset link because
 * the code was already consumed by SmartHelp's ledger. Issuing a second secret
 * afterwards would leave two live credentials for one account.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.password-reset-complete', async (requestId) => {
    const body = await readJson(req);
    const { email: address, code, password } = validatePasswordResetComplete(body);

    const outcome = await verifyOtp(address, 'password_reset', code);
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

    const profile = await requireActiveProfile(address);
    const supabase = createServerClient();

    const { error } = await supabase.auth.admin.updateUserById(profile.id, { password });
    if (error) {
      console.error('password reset write failed:', error.message);
      throw new ApiHttpError(
        'INTERNAL_ERROR',
        'We could not set your new password. Please try again.',
        500
      );
    }

    // The new password is never recorded — only that it changed, and when.
    await audit(supabase, {
      actorProfileId: profile.id,
      action: 'auth.password_reset',
      entityType: 'profiles',
      entityId: profile.id,
      metadata: { method: 'email_code' },
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok({ email: address, reset: true });
  });
}

export const GET = () =>
  NextResponse.json(
    { success: false, error: 'Use POST', code: 'VALIDATION_ERROR' } as const,
    { status: 405 }
  );
