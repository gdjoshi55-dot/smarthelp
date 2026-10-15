import { ok, handle } from '@/lib/api';
import { assertCronSecret } from '@/lib/cronGuard';
import { createServerClient } from '@/lib/supabaseServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/cron/rating-reminders` — the evening rating nudge (§25.11).
 *
 * Runs once a day at 19:13 and asks every customer whose booking reached
 * `completed` today (Asia/Kolkata) to rate it (`RATING_REMINDER`). A booking is
 * nudged at most once: `run_rating_reminders()` (0041) takes the same
 * `pg_advisory_xact_lock` and `not exists` guard as the service pass, and the
 * code is Realtime-only, so writing the row is the delivery.
 *
 * The guard fails closed (§25.11, D5): an unset `CRON_SECRET` is a `503`, not a
 * silent skip.
 */
export async function GET(req: Request) {
  return handle(req, 'cron.rating-reminders', async () => {
    assertCronSecret(req);
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('run_rating_reminders');
    if (error) throw error;
    return ok({ sent: (data as { sent: number } | null)?.sent ?? 0 });
  });
}
