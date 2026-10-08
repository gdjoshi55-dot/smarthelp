import { ok, handle, ApiHttpError } from '@/lib/api';
import { audit } from '@/lib/audit';
import { createServerClient } from '@/lib/supabaseServer';
import { createRazorpayClient } from '@/lib/razorpayClient';
import type { Payment } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/cron/reconcile-payments` — the phase's only cron (§25.11).
 *
 * A customer who paid while the webhook was down is invisible to every route
 * and every screen: the booking sits `payment_pending`, the rows sit `created`,
 * and no human inside the product can tell a "paid but unreported" from a
 * "never paid". This pass looks at exactly that population — payments still
 * waiting more than 10 minutes (`idx_payments_status` serves it) — and asks the
 * gateway, once per row, what happened.
 *
 * ## The guard fails closed — a deliberate deviation from the reference
 *
 * SmartPOS's cron guard is `if (cronSecret) { … }`: with the variable unset it
 * skips the check and runs. SmartHelp has no cron route today and an empty
 * `vercel.json`, so there is no existing behaviour to preserve, and an
 * unauthenticated reconciliation pass — which *reads* payment rows and *writes*
 * `success` — fails open for no reason. So this route answers 503 when
 * `CRON_SECRET` is unset. The three channels otherwise mirror the reference
 * exactly, in precedence: `Authorization: Bearer`, then `x-cron-secret`, then
 * `?secret=`.
 *
 * ## One writer, three outcomes, and the fourth thing that must never happen
 *
 * Every write funnels through the exact same places the webhook uses —
 * `confirm_booking_payment` for success, a guarded status update for failure —
 * which is what keeps "the two writers agree" a test rather than an aspiration:
 *
 * | Gateway says | Resolution | Write |
 * |---|---|---|
 * | order `paid` | success | `confirm_booking_payment`, audit `payment.reconciled` |
 * | order `expired` | failed | `payments.status='failed'`, audit `payment.failed`; the booking stays `payment_pending` so the customer can pay again |
 * | still `created` / `attempted` / `partially_paid` | still pending | no write, counted |
 * | unreachable / 5xx / rate-limited | non-outcome | **no write**, counted `unreachable`, alert |
 *
 * The fourth row is the load-bearing one: a pass that wrote rows because the
 * gateway answered with a 503 would *confirm payments that never happened*.
 * Anything that is not a usable gateway answer is counted `unreachable` and
 * left untouched for the next pass. `partially_paid` has no `payment_status`
 * value, so it is treated as still pending.
 *
 * ## Alerts, and only the two that matter
 *
 * Two conditions are worth a page's attention, and both are audit rows
 * (`payment.reconcile.alert`) plus a `console.warn`, because `lib/audit.ts` is
 * this phase's loud channel and inventing a notification pathway is out of
 * scope: `unreachable > 0` for the pass, and a `stillPending` row whose payment
 * is older than `RECONCILE_STALE_MINUTES` (60) — a second threshold above the
 * 10-minute scan window, so a customer who simply has not paid yet never
 * alerts, while a payment stuck for an hour does. A `stillPending` row between
 * 10 and 60 minutes is counted in the response and does not alert.
 *
 * The reconcile call that confirms on behalf of a missed webhook has no
 * `gateway_payment_id` or signature to store — an order fetch does not see the
 * payment — so both are null in `confirm_booking_payment`, and the note says
 * the order id it came from. The webhook stores those two columns when it runs;
 * this pass only ever fills the gap for a row the webhook never reached.
 */

const SCAN_WINDOW_MINUTES = 10;
const RECONCILE_STALE_MINUTES = 60;

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function oldestOf(rows: Payment[]): string | null {
  let oldest: string | null = null;
  for (const row of rows) {
    if (oldest === null || row.created_at < oldest) oldest = row.created_at;
  }
  return oldest;
}

export async function GET(req: Request) {
  return handle(req, 'cron.reconcile-payments', async () => handleCron(req));
}

/** Split out so the guard and the pass are each independently tested. */
async function handleCron(req: Request) {
  // The fail-closed guard, in the reference's three-channel precedence. The
  // route is only reachable by Vercel's schedule, but "only reachable by" is
  // not an authentication boundary.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new ApiHttpError(
      'SERVICE_UNAVAILABLE',
      'CRON_SECRET is not set. The reconciliation cron will not run without it.',
      503
    );
  }
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    req.headers.get('x-cron-secret') ||
    new URL(req.url).searchParams.get('secret') ||
    '';
  if (provided !== cronSecret) {
    throw new ApiHttpError('UNAUTHENTICATED', 'The provided cron secret does not match.', 401);
  }

  const supabase = createServerClient();

  // The scan window: still-waiting payments older than 10 minutes, so a payment
  // the webhook is *about* to confirm is never racing this pass.
  const { data: waiting, error: readError } = await supabase
    .from('payments')
    .select('*')
    .in('status', ['created', 'pending'])
    .lt('created_at', isoMinutesAgo(SCAN_WINDOW_MINUTES));
  if (readError) throw readError;

  const rows = (waiting ?? []) as Payment[];
  if (rows.length === 0) {
    return ok({ resolved: 0, failed: 0, stillPending: 0, unreachable: 0 });
  }

  // Only bookings still waiting to be paid are in scope: a cancelled booking's
  // stuck payment is an operator problem, not a confirmation machine.
  const { data: bookingRows, error: bookingError } = await supabase
    .from('bookings')
    .select('id, status')
    .in(
      'id',
      rows.map((row) => row.booking_id).filter((id): id is string => id !== null)
    );
  if (bookingError) throw bookingError;
  const pendingIds = new Set(
    (bookingRows ?? []).filter((b) => b.status === 'payment_pending').map((b) => b.id)
  );
  const scope = rows.filter((row) => row.booking_id !== null && pendingIds.has(row.booking_id));

  const client = createRazorpayClient({
    keyId:
      process.env.RAZORPAY_KEY_ID ||
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
      'missing-key-id',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? 'missing-key-secret',
  });

  let resolved = 0;
  let failed = 0;
  let stillPending = 0;
  let unreachable = 0;
  const unreachableRows: Payment[] = [];
  const stillRows: Payment[] = [];

  for (const row of scope) {
    // Scope guarantees both, and narrowing them makes the RPC arguments below
    // line up with the function's non-null parameters.
    if (!row.booking_id || !row.gateway_order_id) continue;
    let order: Awaited<ReturnType<typeof client.fetchOrder>>;
    try {
      order = await client.fetchOrder(row.gateway_order_id);
    } catch {
      // Socket refused, 5xx, rate-limited, or an unreadable answer — the one
      // case where the pass must NOT write. Counted, alerted, left for the
      // next pass.
      unreachable += 1;
      unreachableRows.push(row);
      continue;
    }

    if (order.status === 'paid') {
      const { error } = await supabase.rpc('confirm_booking_payment', {
        p_payment_id: row.id,
        p_gateway_order_id: row.gateway_order_id,
        p_booking_id: row.booking_id,
        // An order fetch cannot see the payment id or its signature; the
        // webhook stores both when it runs, and this pass only fills the gap
        // for a webhook that never did.
        p_gateway_payment_id: null,
        p_gateway_signature: null,
        p_note: `payment reconciled by cron (order ${row.gateway_order_id} is paid)`,
      });
      if (error) throw error;
      resolved += 1;
      await audit(supabase, {
        actorProfileId: null,
        action: 'payment.reconciled',
        entityType: 'payments',
        entityId: row.id,
        metadata: { orderId: row.gateway_order_id, gatewayStatus: 'paid' },
        requestId: req.headers.get('x-request-id') ?? null,
        ipAddress: null,
      });
    } else if (order.status === 'expired') {
      const { error } = await supabase
        .from('payments')
        .update({ status: 'failed', failure_reason: 'Order expired at the gateway before payment.' })
        .eq('id', row.id)
        .in('status', ['created', 'pending']);
      if (error) throw error;
      failed += 1;
      await audit(supabase, {
        actorProfileId: null,
        action: 'payment.failed',
        entityType: 'payments',
        entityId: row.id,
        metadata: { reason: 'order expired', orderId: row.gateway_order_id },
        requestId: req.headers.get('x-request-id') ?? null,
        ipAddress: null,
      });
    } else {
      // `created`, `attempted`, `partially_paid` — none of them money-in.
      // Counted; the older-than-60-minute subset alerts.
      stillPending += 1;
      stillRows.push(row);
    }
  }

  if (unreachableRows.length > 0) {
    const oldest = oldestOf(unreachableRows);
    await audit(supabase, {
      actorProfileId: null,
      action: 'payment.reconcile.alert',
      entityType: 'payments',
      entityId: null,
      metadata: { condition: 'unreachable', count: unreachableRows.length, oldest },
      requestId: req.headers.get('x-request-id') ?? null,
      ipAddress: null,
    });
    console.warn(
      `[reconcile-payments] ${req.headers.get('x-request-id') ?? '?'}: ${unreachableRows.length} payment(s) unreachable — queued for next pass`
    );
  }

  const staleCutoff = new Date(Date.now() - RECONCILE_STALE_MINUTES * 60_000).toISOString();
  const stale = stillRows.filter((row) => row.created_at < staleCutoff);
  if (stale.length > 0) {
    const oldest = oldestOf(stale);
    await audit(supabase, {
      actorProfileId: null,
      action: 'payment.reconcile.alert',
      entityType: 'payments',
      entityId: null,
      metadata: { condition: 'stillPending', count: stale.length, oldest },
      requestId: req.headers.get('x-request-id') ?? null,
      ipAddress: null,
    });
    console.warn(
      `[reconcile-payments] ${req.headers.get('x-request-id') ?? '?'}: ${stale.length} payment(s) still pending past ${RECONCILE_STALE_MINUTES} minutes`
    );
  }

  return ok({ resolved, failed, stillPending, unreachable });
}