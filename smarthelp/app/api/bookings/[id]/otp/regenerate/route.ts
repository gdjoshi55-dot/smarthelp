import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer';
import { generateServiceOtp, hashServiceOtp } from '@/lib/serviceOtp';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/bookings/:id/otp/regenerate — mint the customer's service code
 * (§10.1, §25.6, D3).
 *
 * The plaintext of a service code exists for exactly one moment, in this
 * response. Only its SHA-256 digest reaches `bookings.otp_hash` (via
 * `issue_service_otp`, 0029), so the code can never be read back — a customer
 * who refreshes after expiry asks for a new one, and the generation cap bounds
 * how often. The professional's route (above) never sees a plaintext mint, by
 * construction.
 *
 * Customer-only: a professional token is refused here, because the whole point
 * of the code is that it comes from the customer, not from the app.
 *
 * Nothing in this file logs the code; if a log site is ever added it must use
 * `redactOtpForLog` or log a fixed description instead.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'bookings.otp.regenerate', async () => {
    const { auth, customerId } = await requireBookingCustomer(req);
    const bookingId = uuid(params.id, 'id');

    const booking = await getBookingForCaller(bookingId, customerId, auth.role);

    if (booking.status !== 'arrived') {
      throw new ApiHttpError(
        'INVALID_STATE',
        'A start code can only be issued once the professional has arrived.',
        409
      );
    }

    const generations = (booking.otp_generations as number | null) ?? 0;
    if (generations >= PLATFORM_DEFAULTS.otpMaxGenerations) {
      throw new ApiHttpError(
        'INVALID_STATE',
        'New code limit reached — ask support.',
        409
      );
    }

    const code = generateServiceOtp();
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('issue_service_otp', {
      p_booking_id: bookingId,
      p_code_hash: hashServiceOtp(code),
      p_ttl_minutes: PLATFORM_DEFAULTS.otpTtlMinutes,
    });
    if (error) throw error;
    if (!data) {
      throw new ApiHttpError(
        'INVALID_STATE',
        'New code limit reached — ask support.',
        409
      );
    }

    return ok({ code, expiresAt: data.otp_expires_at });
  });
}
