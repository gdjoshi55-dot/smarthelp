import { handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireVerifiedProfessional, PRO_JOB_COLUMNS, stripProBooking } from '@/lib/professionalServer';
import { runMatchingSweep } from '@/lib/matchingServer';
import { clientIp } from '@/lib/audit';
import type { Offer } from '@/lib/professionalClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/professionals/offers — the offer inbox (§14.3, P4-04).
 *
 * A verified professional only: an unverified one sees the KYC gate, not the
 * inbox (Interaction Contract 11), and the server makes that refusal
 * unbypassable with `requireVerifiedProfessional`.
 *
 * Three steps, in order:
 *   1. `runMatchingSweep()` (0032) is Phase 5's producer: it expires every stale
 *      offer, then matches every waiting booking and re-offers the ones whose
 *      offer was declined or timed out. It is invoked on the read so a
 *      professional who opens the app after a payment sees the offer without
 *      waiting for the §25.11 cron this codebase does not run yet. It is
 *      idempotent — a booking with a live offer is a noop — so the cron, when it
 *      exists, calls the same RPC.
 *   2. The caller's stale offers are still expired lazily here too (Pitfall 6):
 *      the sweep's global expiry already ran, but this is a belt against the
 *      window between that statement and this read, and it keeps the countdown
 *      the card renders from sitting against an offer the accept path would refuse.
 *   3. The live offers are read and joined in JS to the booking and its items —
 *      the repo joins in TypeScript (separate single-table queries), never with
 *      a PostgREST embedded select.
 *
 * The payload is the OfferCard contract exactly (UI-SPEC OQ-4): service name,
 * window, area only, quoted price, `expiresAt`. It carries **no** phone, full
 * address or customer name — that is the §14.3 privacy gate, and
 * `stripProBooking(..., 'offered')` is what enforces the offer-stage trimming
 * even before the fields are picked.
 */
export async function GET(req: Request) {
  return handle(req, 'professionals.offers.list', async () => {
    const { professional } = await requireVerifiedProfessional(req);
    const supabase = createServerClient();

    await runMatchingSweep(supabase, { ipAddress: clientIp(req) });

    const nowIso = new Date().toISOString();

    // Lazy expiry: a stale offer is a tombstone, and the read is what writes it.
    await supabase
      .from('booking_assignments')
      .update({ status: 'expired' })
      .eq('professional_id', professional.id)
      .eq('status', 'offered')
      .lt('expires_at', nowIso);

    const { data: assignments, error } = await supabase
      .from('booking_assignments')
      .select('id, booking_id, status, expires_at, distance_km, score, was_favourite, was_repeat')
      .eq('professional_id', professional.id)
      .eq('status', 'offered')
      .gt('expires_at', nowIso)
      .order('expires_at', { ascending: true });
    if (error) throw error;

    const rows = assignments ?? [];
    const bookingIds = [...new Set(rows.map((a) => a.booking_id))];
    if (bookingIds.length === 0) {
      return ok({ offers: [], serverNow: new Date().toISOString() });
    }

    const [bookingsRes, itemsRes] = await Promise.all([
      supabase.from('bookings').select(PRO_JOB_COLUMNS).in('id', bookingIds),
      supabase
        .from('booking_items')
        .select('booking_id, service_name, created_at')
        .in('booking_id', bookingIds)
        .order('created_at', { ascending: true }),
    ]);
    if (bookingsRes.error) throw bookingsRes.error;
    if (itemsRes.error) throw itemsRes.error;

    // `PRO_JOB_COLUMNS` is a runtime string, so supabase-js cannot resolve the
    // row type the way it does an inline literal; the cast restores the shape
    // without loosening the column list (same pattern as `professionalServer`).
    const bookingRows = (bookingsRes.data ?? []) as unknown as Record<string, unknown>[];
    const itemRows = (itemsRes.data ?? []) as unknown as {
      booking_id: string;
      service_name: string;
    }[];

    const bookingById = new Map(bookingRows.map((b) => [b.id as string, b]));
    const serviceByBooking = new Map<string, string>();
    for (const item of itemRows) {
      if (!serviceByBooking.has(item.booking_id)) {
        serviceByBooking.set(item.booking_id, item.service_name);
      }
    }

    const offers: Offer[] = [];
    for (const assignment of rows) {
      const booking = bookingById.get(assignment.booking_id);
      if (!booking) continue;
      const safe = stripProBooking(booking, 'offered');
      offers.push({
        id: assignment.id,
        bookingId: assignment.booking_id,
        serviceName: serviceByBooking.get(assignment.booking_id) ?? 'Service',
        scheduledStartAt: (safe.scheduled_start_at as string | null) ?? null,
        scheduledEndAt: (safe.scheduled_end_at as string | null) ?? null,
        area: (safe.area as string | null) ?? null,
        quotedPrice: String(safe.professional_gross ?? safe.total_amount ?? '0'),
        expiresAt: assignment.expires_at,
      });
    }

    // `serverNow` anchors the card countdown to server time (Interaction
    // Contract 2 / §22.3: no `Date.now()` deltas in the UI). It is re-sent on
    // every poll, so the remaining time re-anchors rather than drifting.
    return ok({ offers, serverNow: new Date().toISOString() });
  });
}
