import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as listEarnings } from '@/app/api/professionals/me/earnings/route';

/**
 * The earnings ledger read (§25.7). Two things are load-bearing.
 *
 * First, scoping: the route reads through `getEarnings`, which filters
 * `professional_earnings` by `professional_id` and nothing else, so a
 * professional whose id is not the caller's sees an empty ledger by
 * construction — there is no "customer A's row rendered into B's response"
 * branch to test because the query never selects one.
 *
 * Second, money: `net_amount` is `numeric`, which PostgREST returns as a JSON
 * string. The summary is a *sum of the list*, not a second source of truth, so
 * asserting on the route's own figure catches a float sum silently — a ₹320.00
 * plus a ₹200.00 totalling ₹520.00 expects paise-dollar rounding to never move
 * the total.
 */

const USER_ID = '00000000-0000-4000-8000-000000000011';
const TOKEN = 'pro-token';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const BOOKING_IDS = {
  available: 'bbbbbbbb-0001-4111-8111-bbbbbbbbb001',
  pending: 'bbbbbbbb-0002-4111-8111-bbbbbbbbb002',
  paid: 'bbbbbbbb-0003-4111-8111-bbbbbbbbb003',
  reversed: 'bbbbbbbb-0004-4111-8111-bbbbbbbbb004',
};

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const PROFILE = {
  id: USER_ID,
  role: 'professional',
  status: 'active',
  full_name: 'Ravi Kumar',
  phone: '+919876543210',
  email: null,
};

function professional(overrides: Record<string, unknown> = {}) {
  return {
    id: PROF_ID,
    profile_id: USER_ID,
    verification_status: 'verified',
    availability_status: 'online',
    is_available_today: true,
    ...overrides,
  };
}

function earning(
  bookingId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: `eeeeeeee-${bookingId.slice(0, 13)}`,
    professional_id: PROF_ID,
    booking_id: bookingId,
    gross_amount: '250.00',
    commission_amount: '50.00',
    net_amount: '200.00',
    bonus_amount: '0.00',
    status: 'pending',
    available_at: null,
    reversed_reason: null,
    created_at: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function booking(id: string, bookingNumber: string) {
  return { id, booking_number: bookingNumber };
}

function bookingItem(bookingId: string, serviceName: string) {
  return { booking_id: bookingId, service_name: serviceName };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({ data: PROFILE, error: null }),
      professionals: () => ({ data: [professional()], error: null }),
      professional_earnings: () => ({
        data: [
          earning(BOOKING_IDS.available, {
            status: 'available',
            gross_amount: '400.00',
            commission_amount: '80.00',
            net_amount: '320.00',
            available_at: '2026-06-10T00:00:00.000Z',
            created_at: '2026-06-02T10:00:00.000Z',
          }),
          earning(BOOKING_IDS.pending, {
            status: 'pending',
            created_at: '2026-06-03T10:00:00.000Z',
          }),
          earning(BOOKING_IDS.paid, {
            status: 'paid',
            gross_amount: '100.00',
            commission_amount: '20.00',
            net_amount: '80.00',
            created_at: '2026-06-05T10:00:00.000Z',
          }),
          earning(BOOKING_IDS.reversed, {
            status: 'reversed',
            gross_amount: '60.00',
            commission_amount: '12.00',
            net_amount: '48.00',
            reversed_reason: 'Refunded after a customer dispute.',
            created_at: '2026-06-06T10:00:00.000Z',
          }),
        ],
        error: null,
      }),
      bookings: () => ({
        data: [
          booking(BOOKING_IDS.available, 'SH-20260602-00042'),
          booking(BOOKING_IDS.pending, 'SH-20260603-00009'),
          booking(BOOKING_IDS.paid, 'SH-20260605-00013'),
          booking(BOOKING_IDS.reversed, 'SH-20260606-00001'),
        ],
        error: null,
      }),
      booking_items: () => ({
        data: [
          bookingItem(BOOKING_IDS.available, 'Deep Cleaning'),
          bookingItem(BOOKING_IDS.pending, 'Bathroom Cleaning'),
          bookingItem(BOOKING_IDS.paid, 'Kitchen Deep Clean'),
          bookingItem(BOOKING_IDS.reversed, 'Balcony Clean'),
        ],
        error: null,
      }),
      ...overrides,
    }
  );
}

function request(url: string, init: { method?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(`http://localhost${url}`, {
    method: init?.method ?? 'GET',
    headers,
  });
}

const body = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  fake = build();
});

describe('GET /api/professionals/me/earnings', () => {
  it('needs a session', async () => {
    const res = await listEarnings(request('/api/professionals/me/earnings'));
    expect(res.status).toBe(401);
  });

  it('refuses an account with no professional row', async () => {
    fake = build({ professionals: () => ({ data: [], error: null }) });
    const res = await listEarnings(request('/api/professionals/me/earnings', { token: TOKEN }));
    expect(res.status).toBe(403);
  });

  it('lets an unverified professional read the ledger (requireProfessional, not the gate)', async () => {
    fake = build({
      professionals: () => ({ data: [professional({ verification_status: 'submitted' })], error: null }),
    });
    const res = await listEarnings(request('/api/professionals/me/earnings', { token: TOKEN }));
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.data.summary).toBeDefined();
  });

  it('reads only the caller\'s ledger rows', async () => {
    await listEarnings(request('/api/professionals/me/earnings', { token: TOKEN }));
    const read = fake.calls.find(
      (c) => c.table === 'professional_earnings' && c.op === 'select'
    );
    expect(read?.eqFilters).toContainEqual(['professional_id', PROF_ID]);
  });

  it('returns the enriched ledger and an exact paise-summed summary', async () => {
    const res = await listEarnings(request('/api/professionals/me/earnings', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);

    expect(json.data.earnings).toHaveLength(4);
    expect(json.data.summary).toEqual({
      lifetimeGross: 810,
      lifetimeNet: 648,
      heldNet: 520,
      availableNet: 320,
      paidNet: 80,
      reversedNet: 48,
      counts: { pending: 1, available: 1, paid: 1, reversed: 1 },
    });

    const available = json.data.earnings.find(
      (e: any) => e.bookingId === BOOKING_IDS.available
    );
    expect(available).toMatchObject({
      bookingNumber: 'SH-20260602-00042',
      serviceName: 'Deep Cleaning',
      grossAmount: 400,
      commissionAmount: 80,
      netAmount: 320,
      status: 'available',
      availableAt: '2026-06-10T00:00:00.000Z',
    });

    const reversed = json.data.earnings.find(
      (e: any) => e.bookingId === BOOKING_IDS.reversed
    );
    expect(reversed.reversedReason).toBe('Refunded after a customer dispute.');
    expect(json.data.serverNow).toBeDefined();
    expect(JSON.stringify(json)).not.toContain('otp_hash');
  });

  it('returns an empty ledger without the enrichment queries', async () => {
    fake = build({ professional_earnings: () => ({ data: [], error: null }) });
    const res = await listEarnings(request('/api/professionals/me/earnings', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.earnings).toEqual([]);
    expect(json.data.summary).toEqual({
      lifetimeGross: 0,
      lifetimeNet: 0,
      heldNet: 0,
      availableNet: 0,
      paidNet: 0,
      reversedNet: 0,
      counts: { pending: 0, available: 0, paid: 0, reversed: 0 },
    });
    expect(fake.calls.some((c) => c.table === 'bookings')).toBe(false);
    expect(fake.calls.some((c) => c.table === 'booking_items')).toBe(false);
  });

  it('falls back to null booking data when a booking is gone or has no lines', async () => {
    fake = build({
      bookings: () => ({
        data: [
          booking(BOOKING_IDS.available, 'SH-20260602-00042'),
          booking(BOOKING_IDS.pending, 'SH-20260603-00009'),
          booking(BOOKING_IDS.paid, 'SH-20260605-00013'),
        ],
        error: null,
      }),
      booking_items: () => ({
        data: [
          bookingItem(BOOKING_IDS.available, 'Deep Cleaning'),
          // The `paid` booking exists but its service line is missing; the
          // `reversed` booking has vanished from `bookings` entirely.
        ],
        error: null,
      }),
    });
    const res = await listEarnings(request('/api/professionals/me/earnings', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);

    const byId = new Map<string, any>(
      json.data.earnings.map((e: any) => [e.bookingId, e] as [string, any])
    );
    expect(byId.get(BOOKING_IDS.available).bookingNumber).toBe('SH-20260602-00042');
    expect(byId.get(BOOKING_IDS.available).serviceName).toBe('Deep Cleaning');
    expect(byId.get(BOOKING_IDS.paid).bookingNumber).toBe('SH-20260605-00013');
    expect(byId.get(BOOKING_IDS.paid).serviceName).toBeNull();
    expect(byId.get(BOOKING_IDS.reversed).bookingNumber).toBeNull();
    expect(byId.get(BOOKING_IDS.reversed).serviceName).toBeNull();
  });
});