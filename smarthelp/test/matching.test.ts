import { describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { matchBooking, runMatchingSweep } from '@/lib/matchingServer';
import type { CapturedRefund, RefundCapturedBookingArgs } from '@/lib/refundServer';

/**
 * The matching engine's JS half (§9.1, §8.2, §12.3).
 *
 * The decisions that make the engine correct — one acceptance per booking, the
 * broadcast fan-out, the state hops — are made in Postgres under an advisory
 * lock and are covered by the SQL and the route suites. What this file pins down is
 * the one thing SQL cannot do: the *refund* when a search exhausts. An exhausted
 * outcome must pay back the captured amount with no fee withheld, never above
 * the support limit (it is `auto`), and never twice into the caller's hands by
 * mistake on a non-exhausted outcome.
 */

const BOOKING_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
const OTHER_PRO = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

/**
 * A Supabase client whose two RPCs answer with the given payloads.
 *
 * `run_matching_sweep` returns a set (a list of outcomes); `match_booking`
 * returns one. Passing one argument for both keeps the fake small and the two
 * call sites are distinguished by the function name in the responder.
 */
function client(sweepOutcomes: unknown, singleOutcome?: unknown) {
  return fakeSupabase(
    new FakeSupabase(
      {},
      {
        run_matching_sweep: () => ({ data: sweepOutcomes, error: null }),
        match_booking: () => ({
          data: singleOutcome ?? sweepOutcomes,
          error: null,
        }),
      }
    )
  );
}

function refundSpy() {
  return vi.fn(
    async (_args: RefundCapturedBookingArgs): Promise<CapturedRefund | null> => ({
      id: 'refund-1',
      amount: 499,
      currency: 'INR',
      status: 'completed',
      route: 'gateway',
    })
  );
}

describe('runMatchingSweep', () => {
  it('tallies the outcomes the engine returned', async () => {
    const supabase = client([
      { outcome: 'offered', booking_id: BOOKING_ID, professional_id: OTHER_PRO },
      { outcome: 'searching', booking_id: 'b2' },
      { outcome: 'noop', booking_id: 'b3' },
    ]);

    const summary = await runMatchingSweep(supabase, { refund: refundSpy() });

    expect(summary).toEqual({ matched: 1, searching: 1, exhausted: 0, refunded: 0 });
  });

  it('refunds an exhausted search in full — fee 0, never held for approval', async () => {
    const refund = refundSpy();
    const supabase = client([{ outcome: 'exhausted', booking_id: BOOKING_ID }]);

    const summary = await runMatchingSweep(supabase, { refund, ipAddress: '203.0.113.9' });

    expect(summary).toEqual({ matched: 0, searching: 0, exhausted: 1, refunded: 1 });
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: BOOKING_ID,
        feeRupees: 0,
        reasonCode: 'no_professional_available',
        ipAddress: '203.0.113.9',
      })
    );
  });

  it('does not refund when nothing exhausted', async () => {
    const refund = refundSpy();
    const supabase = client([{ outcome: 'offered', booking_id: BOOKING_ID }]);

    await runMatchingSweep(supabase, { refund });

    expect(refund).not.toHaveBeenCalled();
  });

  it('treats a booking with no captured payment as refunded: zero', async () => {
    // `refundCapturedBooking` returns null when there is nothing captured; the
    // sweep must not count that as a refund it performed.
    const refund = vi.fn(
      async (_args: RefundCapturedBookingArgs): Promise<CapturedRefund | null> => null
    );
    const supabase = client([{ outcome: 'exhausted', booking_id: BOOKING_ID }]);

    const summary = await runMatchingSweep(supabase, { refund });

    expect(summary).toEqual({ matched: 0, searching: 0, exhausted: 1, refunded: 0 });
  });
});

describe('matchBooking', () => {
  it('returns the engine outcome and cascades an offer', async () => {
    const supabase = client(null, {
      outcome: 'offered',
      booking_id: BOOKING_ID,
      professional_id: OTHER_PRO,
      round_no: 2,
    });

    const outcome = await matchBooking(supabase, BOOKING_ID, { refund: refundSpy() });

    expect(outcome).toEqual({
      outcome: 'offered',
      booking_id: BOOKING_ID,
      professional_id: OTHER_PRO,
      round_no: 2,
    });
  });

  it('refunds when a single-booking match exhausts', async () => {
    const refund = refundSpy();
    const supabase = client(null, { outcome: 'exhausted', booking_id: BOOKING_ID });

    await matchBooking(supabase, BOOKING_ID, { refund });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0][0]).toMatchObject({ bookingId: BOOKING_ID, feeRupees: 0 });
  });

  it('falls back to noop when the RPC returns nothing', async () => {
    const supabase = fakeSupabase(
      new FakeSupabase({}, { match_booking: () => ({ data: null, error: null }) })
    );

    const outcome = await matchBooking(supabase, BOOKING_ID, { refund: refundSpy() });

    expect(outcome).toEqual({ outcome: 'noop', booking_id: BOOKING_ID });
  });
});
