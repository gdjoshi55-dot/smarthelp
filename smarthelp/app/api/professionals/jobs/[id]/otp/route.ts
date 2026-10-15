import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  requireVerifiedProfessional,
  getProBookingForCaller,
  stripProBooking,
} from '@/lib/professionalServer';
import { otpIsExpired, otpIsLocked } from '@/lib/serviceOtp';
import { notifyServiceStarted } from '@/lib/notificationHooks';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { fail, readJson, str, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/jobs/:id/otp — start the job with the customer's code
 * (§10.1, §22.3, Pitfall 5).
 *
 * The professional never mints, sees or stores the code: they prove the
 * customer knows it by typing it, and SQL does the constant-time comparison
 * against `bookings.otp_hash` inside `verify_service_otp` (0029). A wrong,
 * expired or locked attempt returns **one** generic 403 with the same body —
 * distinguishing them to the caller would turn the endpoint into an oracle for
 * probing. Which of the three it was reaches the log, and nothing else.
 *
 * Zero rows is the only signal SQL gives, and it is enough: the route re-reads
 * the booking afterwards, so success carries the server's `started_at`/`ends_at`
 * (the client's timer anchors on those, never the device clock).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'professionals.jobs.otp', async (requestId) => {
    const { auth, professional } = await requireVerifiedProfessional(req);
    const bookingId = uuid(params.id, 'id');

    const booking = await getProBookingForCaller(bookingId, professional.id, auth.role);

    const body = await readJson(req);
    const length = PLATFORM_DEFAULTS.serviceOtpLength;
    const code = str(body.code, 'code', { min: 1, max: 16, trim: false }).replace(/[\s-]/g, '');
    if (!/^[0-9]+$/.test(code) || code.length !== length) {
      fail({ code: `Enter the ${length}-digit code` });
    }

    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('verify_service_otp', {
      p_booking_id: bookingId,
      p_code: code,
      p_max_attempts: PLATFORM_DEFAULTS.otpMaxAttempts,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      // Server-side only: say *why* in the log, never in the response.
      const now = new Date().toISOString();
      const reason = otpIsLocked(booking.otp_locked_until, now)
        ? 'OTP_LOCKED'
        : otpIsExpired(booking.otp_expires_at, now)
        ? 'OTP_EXPIRED'
        : 'OTP_INVALID';
      console.warn(`[${requestId}] professionals.jobs.otp rejected (${reason})`);
      throw new ApiHttpError(
        'OTP_INVALID',
        'Invalid or expired code. Ask the customer for the current code, or request a new one if it has expired.',
        403
      );
    }

    const fresh = await getProBookingForCaller(bookingId, professional.id, auth.role);
    // The timer is armed; the customer hears it started (§27.5 SERVICE_STARTED).
    await notifyServiceStarted(bookingId);
    return ok({ job: stripProBooking(fresh as Record<string, unknown>, 'accepted') });
  });
}
