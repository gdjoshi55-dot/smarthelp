import { ok, handle } from '@/lib/api';
import { assertCronSecret } from '@/lib/cronGuard';
import { createServerClient } from '@/lib/supabaseServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/cron/service-reminders` — the every-15-minute reminder pass (§25.11).
 *
 * Two things happen to a booking that is about to start or about to end, and
 * both are the professional's to act on:
 *
 *   SERVICE_ENDING_SOON — an `in_progress` job whose `ends_at` is within 15 min.
 *   NEW_JOB_REMINDER    — an `assigned` / `on_the_way` / `arrived` job whose
 *                         `scheduled_start_at` is within 60 min (and, in a
 *                         second, disjoint window, within 15 min).
 *
 * The work lives in `run_service_reminders()` (0041), not here, and deliberately
 * so: those are Realtime-only codes (`['in_app','push']`), and for those
 * channels *writing the row is the delivery*. That lets the whole pass — the
 * `pg_advisory_xact_lock` that serialises a manual trigger against the schedule
 * (§28.1), the idempotency guard, and the inserts — run in one transaction, so
 * the lock actually holds and two overlapping passes cannot both claim a
 * booking. This route is the thin authenticated shell around it, exactly as the
 * reconciliation route is for `confirm_booking_payment`.
 */
export async function GET(req: Request) {
  return handle(req, 'cron.service-reminders', async () => {
    assertCronSecret(req);
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('run_service_reminders');
    if (error) throw error;
    return ok({ sent: (data as { sent: number } | null)?.sent ?? 0 });
  });
}
