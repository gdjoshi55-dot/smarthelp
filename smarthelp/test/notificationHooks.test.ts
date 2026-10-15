import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { NOTIFICATION_CODES } from '@/lib/notifications';
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyKycDecision,
  notifyNewOffer,
  notifyOfferAccepted,
  notifyProArrived,
  notifyProAssigned,
  notifyProOnTheWay,
  notifyRefundProcessed,
  notifyServiceCompleted,
  notifyServiceStarted,
  notifyTicketUpdate,
} from '@/lib/notificationHooks';

/**
 * The catalogue fires (§27.5, §31.1).
 *
 * Every booking lifecycle the product has is wired to exactly one hook, and each
 * hook dispatches exactly the code the catalogue names. The hooks are unit-tested
 * here with `notify` spied, so this is a statement about *dispatch* — which code,
 * to whom — not about the transport, which `notifications.test.ts` owns.
 *
 * Two invariants beyond the happy path:
 *   * A hook whose recipient cannot be resolved dispatches nothing (a booking
 *     with no customer profile is not a notification for `null`).
 *   * Every code a hook dispatches is in `NOTIFICATION_CODES`, so a typo in a
 *     hook is a test failure rather than a row that references a code the
 *     catalogue does not define.
 *
 * The reminder codes (`SERVICE_ENDING_SOON`, `NEW_JOB_REMINDER`,
 * `RATING_REMINDER`) and `OTP_LOGIN` are dispatched elsewhere — in SQL and the
 * auth flow respectively — so they are listed as "not a hook" on purpose.
 */

const BOOKING_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
const CUSTOMER_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CUSTOMER_PROFILE = '00000000-0000-4000-8000-0000000000c1';
const PRO_PROFILE = '00000000-0000-4000-8000-0000000000a1';

let fake: FakeSupabase;
let notifySpy: ReturnType<typeof vi.fn>;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

vi.mock('@/lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notifications')>();
  return { ...actual, notify: vi.fn() };
});

import { notify } from '@/lib/notifications';

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase({
    bookings: () => ({
      data: {
        id: BOOKING_ID,
        booking_number: 'SH-20260601-00001',
        customer_id: CUSTOMER_ID,
        professional_id: PROF_ID,
        scheduled_start_at: '2026-06-02T09:00:00.000Z',
        total_amount: '499.00',
      },
      error: null,
    }),
    customers: () => ({ data: { profile_id: CUSTOMER_PROFILE }, error: null }),
    professionals: () => ({ data: { profile_id: PRO_PROFILE }, error: null }),
    profiles: () => ({ data: { full_name: 'Ravi Kumar' }, error: null }),
    booking_items: () => ({ data: [{ service_id: 'ssssssss-1111-4111-8111-ssssssssssss' }], error: null }),
    services: () => ({ data: { name: 'Deep Cleaning' }, error: null }),
    support_tickets: () => ({ data: { subject: 'Refund not received' }, error: null }),
    ...overrides,
  });
}

beforeEach(() => {
  fake = build();
  notifySpy = notify as unknown as ReturnType<typeof vi.fn>;
  notifySpy.mockClear();
});

/** The code passed to `notify` on the Nth call. */
const codes = () => notifySpy.mock.calls.map((c) => c[0].code);
const recipients = () => notifySpy.mock.calls.map((c) => c[0].recipientId);

describe('each lifecycle hook fires its catalogue code', () => {
  it('BOOKING_CONFIRMED reaches the customer', async () => {
    await notifyBookingConfirmed(BOOKING_ID);
    expect(codes()).toEqual(['BOOKING_CONFIRMED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });

  it('PRO_ACCEPTED reaches the customer', async () => {
    await notifyOfferAccepted(BOOKING_ID);
    expect(codes()).toEqual(['PRO_ACCEPTED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });

  it('PRO_ASSIGNED reaches the customer', async () => {
    await notifyProAssigned(BOOKING_ID);
    expect(codes()).toEqual(['PRO_ASSIGNED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });

  it('PRO_ON_THE_WAY reaches the customer', async () => {
    await notifyProOnTheWay(BOOKING_ID);
    expect(codes()).toEqual(['PRO_ON_THE_WAY']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });

  it('PRO_ARRIVED reaches the customer', async () => {
    await notifyProArrived(BOOKING_ID);
    expect(codes()).toEqual(['PRO_ARRIVED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });

  it('SERVICE_STARTED reaches the customer', async () => {
    await notifyServiceStarted(BOOKING_ID);
    expect(codes()).toEqual(['SERVICE_STARTED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });

  it('SERVICE_COMPLETED reaches the customer and EARNING_CREATED the professional', async () => {
    await notifyServiceCompleted(BOOKING_ID);
    expect(codes()).toEqual(['SERVICE_COMPLETED', 'EARNING_CREATED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE, PRO_PROFILE]);
  });

  it('BOOKING_CANCELLED reaches both participants', async () => {
    await notifyBookingCancelled(BOOKING_ID, 'customer_request');
    expect(codes()).toEqual(['BOOKING_CANCELLED', 'BOOKING_CANCELLED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE, PRO_PROFILE]);
    expect(notifySpy.mock.calls[0][0].payload.reason).toBe('customer_request');
  });

  it('REFUND_PROCESSED reaches the customer with the amount and destination', async () => {
    await notifyRefundProcessed(BOOKING_ID, '₹499', 'your original payment method');
    expect(codes()).toEqual(['REFUND_PROCESSED']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
    expect(notifySpy.mock.calls[0][0].payload).toMatchObject({
      amount: '₹499',
      destination: 'your original payment method',
    });
  });

  it('NEW_OFFER reaches the professional named by the matching round', async () => {
    await notifyNewOffer(PROF_ID, BOOKING_ID);
    expect(codes()).toEqual(['NEW_OFFER']);
    expect(recipients()).toEqual([PRO_PROFILE]);
  });

  it('KYC_APPROVED and KYC_REJECTED reach the professional', async () => {
    await notifyKycDecision(PROF_ID, true);
    await notifyKycDecision(PROF_ID, false, 'Blurred document');
    expect(codes()).toEqual(['KYC_APPROVED', 'KYC_REJECTED']);
    expect(recipients()).toEqual([PRO_PROFILE, PRO_PROFILE]);
    expect(notifySpy.mock.calls[1][0].payload.reason).toBe('Blurred document');
  });

  it('TICKET_UPDATE reaches the ticket raiser', async () => {
    await notifyTicketUpdate('tttttttt-1111-4111-8111-tttttttttttt', CUSTOMER_PROFILE);
    expect(codes()).toEqual(['TICKET_UPDATE']);
    expect(recipients()).toEqual([CUSTOMER_PROFILE]);
  });
});

describe('the hooks never dispatch a code the catalogue does not define', () => {
  it('every dispatched code is in NOTIFICATION_CODES', async () => {
    await notifyBookingConfirmed(BOOKING_ID);
    await notifyOfferAccepted(BOOKING_ID);
    await notifyProAssigned(BOOKING_ID);
    await notifyProOnTheWay(BOOKING_ID);
    await notifyProArrived(BOOKING_ID);
    await notifyServiceStarted(BOOKING_ID);
    await notifyServiceCompleted(BOOKING_ID);
    await notifyBookingCancelled(BOOKING_ID);
    await notifyRefundProcessed(BOOKING_ID, '₹1', 'x');
    await notifyNewOffer(PROF_ID, BOOKING_ID);
    await notifyKycDecision(PROF_ID, true);
    await notifyTicketUpdate('tttttttt-1111-4111-8111-tttttttttttt', CUSTOMER_PROFILE);

    for (const code of codes()) {
      expect(NOTIFICATION_CODES).toContain(code);
    }
  });
});

describe('a hook with no resolvable recipient is quiet', () => {
  it('BOOKING_CONFIRMED dispatches nothing when the customer has no profile', async () => {
    fake = build({ customers: () => ({ data: null, error: null }) });
    await notifyBookingConfirmed(BOOKING_ID);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('a missing booking dispatches nothing', async () => {
    fake = build({ bookings: () => ({ data: null, error: null }) });
    await notifyBookingConfirmed(BOOKING_ID);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('TICKET_UPDATE with no recipient dispatches nothing', async () => {
    await notifyTicketUpdate('tttttttt-1111-4111-8111-tttttttttttt', null);
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
