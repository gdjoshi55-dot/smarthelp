import { refundCapturedBooking, type CapturedRefund } from './refundServer';
import type { Database } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The server half of Phase 5's matching engine (§9.1, §9.4, §8.2).
 *
 * The matching itself lives in Postgres — `run_matching_sweep()` / `match_booking()`
 * (0032, broadcast by 0036) — because the two things that must not be raced (who
 * gets the offer, and the booking's state) are decided there, under an advisory
 * lock, next to the partial unique index that is the double-accept guarantee.
 * This module is the thin, honest boundary: it calls the engine and does the one
 * thing SQL cannot, which is pay money back through Razorpay (§12.3).
 *
 * ## Broadcast, since 0036
 *
 * One booking is offered to *every* eligible professional at once, best-ranked
 * first, and the first acceptance wins (0036). `run_matching_sweep`'s `matched`
 * tally therefore counts bookings that received one or more offers, not offers
 * — the engine reports how many via `offered_count` / `professional_ids`.
 *
 * ## Why the refund lives here and not in the RPC
 *
 * Reaching the gateway is an HTTP call to a third party; putting it inside a
 * transaction that holds `pg_advisory_xact_lock` would hold a database lock for
 * the length of a network round trip and, worse, would make an exhausted search
 * transactional with a payment — a failure mode where the booking is cancelled
 * but the refund half-happened. The engine's job ends at "this search is
 * exhausted, the booking is `cancelled`"; the refund is a separate, idempotent
 * step that can be retried, and it is recorded on the booking by the cancel
 * path's own RPCs. `refundCapturedBooking(fee = 0)` is that step, unchanged
 * from the customer-cancellation case: nobody provided a service, so no fee is
 * withheld and the customer gets everything back.
 *
 * ## Why a sweep rather than a cron
 *
 * §25.11 schedules the sweeper, but a scheduler is infrastructure this codebase
 * does not run yet. So the sweep is invoked where a booking's staleness is
 * first observable — the professional's inbox read — and it is written to be
 * idempotent (a booking with a live offer is a noop), so the day a cron exists
 * it calls the very same RPC and nothing here changes.
 */

type ServerClient = SupabaseClient<Database>;

/** The four things `match_booking()` can decide (§0032). */
export type MatchOutcomeKind = 'offered' | 'searching' | 'exhausted' | 'noop';

export interface MatchOutcome {
  outcome: MatchOutcomeKind;
  booking_id: string;
  /**
   * The best-ranked professional offered the job, when `outcome === 'offered'`.
   * A broadcast offers to many; this is the head of the list, kept for callers
   * that want a single name and for the pre-0036 shape.
   */
  professional_id?: string;
  /** Every professional offered the job this round, best-ranked first. */
  professional_ids?: string[];
  /** How many offers the round issued (== `professional_ids.length`). */
  offered_count?: number;
  /** Single-offer assignment id from the pre-0036 engine; unused by broadcast. */
  assignment_id?: string;
  round_no?: number;
}

/** What one pass of the sweeper did, for a route that wants to report it. */
export interface SweepSummary {
  /** Bookings that received an offer this pass. */
  matched: number;
  /** Bookings still inside their search window with no candidate yet. */
  searching: number;
  /** Searches that closed empty and were cancelled for want of a professional. */
  exhausted: number;
  /** Of those, the ones whose captured payment was actually refunded. */
  refunded: number;
}

export interface MatchingOptions {
  /** Audit/ops context for a refund, if one is issued. */
  ipAddress?: string | null;
  /**
   * The test seam. Defaults to the real §12.3 refund; a suite passes a spy so
   * the assertion is "fee 0, this booking" without a gateway stand-in.
   */
  refund?: typeof refundCapturedBooking;
}

/**
 * Pay back a booking whose search exhausted.
 *
 * `feeRupees: 0` is the whole difference from a customer cancellation — §11.1's
 * fee exists to compensate for a booking abandoned after dispatch, and a search
 * that found nobody abandoned nothing. The refund never executes above the
 * support limit for approval because `planRefund({ auto: true })` says so, and
 * it is `auto` precisely here: there is no human to ask and a cancelled booking
 * must not wait for one.
 */
async function refundExhausted(
  supabase: ServerClient,
  outcome: MatchOutcome,
  opts: MatchingOptions
): Promise<CapturedRefund | null> {
  const refund = opts.refund ?? refundCapturedBooking;
  return refund({
    supabase,
    bookingId: outcome.booking_id,
    feeRupees: 0,
    reasonCode: 'no_professional_available',
    note: `automatic refund: no professional was available for booking ${outcome.booking_id}`,
    ipAddress: opts.ipAddress ?? null,
  });
}

/**
 * Expire stale offers and match every waiting booking (§25.11's sweep).
 *
 * The RPC already expired every stale offer globally before matching, so a
 * booking whose offer timed out is re-offered in the same pass rather than
 * waiting for the next inbox open. Each returned outcome is tallied; an
 * `exhausted` one is refunded here.
 */
export async function runMatchingSweep(
  supabase: ServerClient,
  opts: MatchingOptions = {}
): Promise<SweepSummary> {
  const { data, error } = await supabase.rpc('run_matching_sweep');
  if (error) throw error;

  const outcomes = (data ?? []) as unknown as MatchOutcome[];
  const summary: SweepSummary = { matched: 0, searching: 0, exhausted: 0, refunded: 0 };

  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case 'offered':
        summary.matched += 1;
        break;
      case 'searching':
        summary.searching += 1;
        break;
      case 'exhausted': {
        summary.exhausted += 1;
        const refund = await refundExhausted(supabase, outcome, opts);
        if (refund) summary.refunded += 1;
        break;
      }
      default:
        break;
    }
  }

  return summary;
}

/**
 * Match one booking, now (§8.2's reassignment cascade).
 *
 * The decline route calls this after tombstoning an offer so the job is
 * re-offered to the next-ranked professional immediately, instead of sitting in
 * `searching` until the next inbox open. The exhausted branch refunds exactly
 * as the sweep does — one code path, so a decline that empties the field is not
 * a second, differently-behaved way to run out of candidates.
 */
export async function matchBooking(
  supabase: ServerClient,
  bookingId: string,
  opts: MatchingOptions = {}
): Promise<MatchOutcome> {
  const { data, error } = await supabase.rpc('match_booking', { p_booking_id: bookingId });
  if (error) throw error;

  const outcome = (data ?? {
    outcome: 'noop',
    booking_id: bookingId,
  }) as unknown as MatchOutcome;

  if (outcome.outcome === 'exhausted') {
    await refundExhausted(supabase, outcome, opts);
  }

  return outcome;
}
