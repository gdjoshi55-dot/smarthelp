import { handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional, PRO_JOB_COLUMNS, stripProBooking } from '@/lib/professionalServer';
import type { BookingStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/professionals/me/jobs — the professional's live jobs (§20.7, P4-04).
 *
 * "Live" is the accepted-and-running set: `accepted` through `in_progress`. A
 * terminal job (completed, cancelled, no_show) is history, not the home page's
 * "today" card, and a `refunded`/`payment_pending` booking is never a
 * professional's to see.
 *
 * The read uses `requireProfessional`, not the verified gate: an unverified
 * professional has no jobs, so gating the read would only hide an empty list.
 * The payload goes through `stripProBooking(..., 'accepted')` — the job is
 * already theirs, so the address is included and `otp_hash` is not (Pitfall 1).
 */
const LIVE_STATUSES: BookingStatus[] = [
  'accepted',
  'on_the_way',
  'arrived',
  'otp_verified',
  'in_progress',
];

export async function GET(req: Request) {
  return handle(req, 'professionals.jobs.list', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from('bookings')
      .select(PRO_JOB_COLUMNS)
      .eq('professional_id', professional.id)
      .in('status', LIVE_STATUSES)
      .order('scheduled_start_at', { ascending: true });
    if (error) throw error;

    // `PRO_JOB_COLUMNS` is a runtime string (see `professionalServer`): cast the
    // rows back to their shape without loosening the column list.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const jobs = rows.map((booking) => stripProBooking(booking, 'accepted'));

    // The instant this read happened. The job screen's running-service timer is
    // `ends_at − serverNow` (Interaction Contract 2), so the timer must be
    // anchored on the server's clock rather than the device's — the same reason
    // `GET /api/professionals/offers` carries `serverNow`.
    return ok({ jobs, serverNow: new Date().toISOString() });
  });
}
