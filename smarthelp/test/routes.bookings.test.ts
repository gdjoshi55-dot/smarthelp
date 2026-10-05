import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { POST as createBooking, GET as listBookings } from '@/app/api/bookings/route';
import { POST as quoteBooking } from '@/app/api/bookings/quote/route';
import { POST as cancelBooking } from '@/app/api/bookings/[id]/cancel/route';
import { POST as rescheduleBooking } from '@/app/api/bookings/[id]/reschedule/route';
import { GET as getBookingDetail } from '@/app/api/bookings/[id]/route';
import { GET as getInvoice } from '@/app/api/bookings/[id]/invoice/route';
import { ApiHttpError } from '@/lib/api';
import { issueQuoteToken } from '@/lib/quoteToken';
import { PRICE_FEES } from './helpers/bookingFixtures';

/**
 * The booking routes (§25.6) — create, list, cancel, reschedule.
 *
 * These tests are about three things, in this order:
 *
 *   1. **The server owns the money.** A client that quotes itself ₹1 must not
 *      get a ₹1 booking, and a client whose total no longer matches what it was
 *      shown is refused rather than quietly charged the new figure.
 *   2. **The ledger is what makes create safe.** One key, one booking, whatever
 *      the client does.
 *   3. **Ownership is checked by the route, not by RLS.** Every handler here
 *      reaches Postgres through the service-role client, which bypasses RLS
 *      entirely, so a missing `getBookingForCaller` is a real breach rather than
 *      a latent one.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'test-token';
const CUSTOMER_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const ADDRESS_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const SERVICE_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
const BOOKING_ID = 'abababab-1111-4111-8111-abababababab';
const LOCALITY_ID = '5c1a0f0e-1111-4111-8111-aaaaaaaaaaaa';
const KEY = 'idem-key-create-0001';
const KEY2 = 'idem-key-create-0002';

const OTHER_SERVICE = 'ffffffff-2222-4222-8222-ffffffffffff';

let fake: FakeSupabase;
let tables: Record<string, (call: RecordedCall) => { data: any; error: null }>;
let rpcs: Record<string, (call: RecordedCall) => { data: any; error: null }>;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

/**
 * The slot re-check is stubbed here so the create tests describe *the route*, not
 * the availability engine.
 *
 * The engine's own derivation is covered in `test/availability.test.ts`, and the
 * adapter that turns a booking into an availability query in
 * `test/bookingAvailability.test.ts`. What has to be asserted here is that the
 * route calls it, with the service, the locality on the address, the instant and
 * the duration — and that a refusal becomes a 422 with nothing written.
 */
const assertSlotAvailable = vi.fn<(check: unknown) => Promise<void>>(async () => {});
vi.mock('@/lib/bookingAvailability', () => ({
  assertSlotAvailable: (...args: unknown[]) => assertSlotAvailable(...(args as [unknown])),
}));

/** `requireCustomer` reads `customers` by the caller's profile id. */
const CUSTOMER_ROW = { id: CUSTOMER_ID, profile_id: USER_ID };

function service(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ID,
    category_id: 'cat-1',
    name: 'Deep cleaning',
    slug: 'deep-cleaning',
    base_price: 500,
    pricing_type: 'hourly',
    unit_label: null,
    unit_price: null,
    min_duration_min: 30,
    max_duration_min: 240,
    prep_minutes: 0,
    max_active_jobs: 2,
    is_active: true,
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20261003-00001',
    customer_id: CUSTOMER_ID,
    professional_id: null,
    address_id: ADDRESS_ID,
    address_snapshot: {},
    locality_id: LOCALITY_ID,
    city_id: null,
    booking_type: 'scheduled',
    status: 'payment_pending',
    version: 1,
    scheduled_start_at: '2026-12-01T10:00:00.000Z',
    scheduled_end_at: '2026-12-01T11:00:00.000Z',
    duration_minutes: 60,
    subtotal: '500.00',
    platform_fee: '20.00',
    discount: '0.00',
    discount_code: null,
    tax: '93.60',
    tax_rate: '0.1800',
    total_amount: '613.60',
    professional_gross: '470.40',
    commission_pct: '0.2000',
    currency: 'INR',
    quote_token: null,
    pricing_snapshot: {},
    arrived_at: null,
    cancelled_at: null,
    cancellation_reason_code: null,
    cancellation_fee: '0.00',
    completed_at: null,
    closed_at: null,
    notes: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const ADDRESS = {
  id: ADDRESS_ID,
  customer_id: CUSTOMER_ID,
  locality_id: LOCALITY_ID,
  label: 'Home',
  address_type: 'home',
  line1: '12, 4th Cross',
  line2: null,
  area: 'Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
  lat: 12.9784,
  lng: 77.6408,
  landmark: null,
  access_notes: null,
  location_precision: 'exact',
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/bookings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function getReq(url = 'http://localhost/api/bookings'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } });
}

/** The default shape: one active service, an owned address, a fresh claim. */
function prime(over: {
  services?: unknown[];
  bookings?: unknown[];
  claim?: string;
  profile?: Record<string, unknown>;
} = {}) {
  tables = {
    profiles: () => ({ data: [over.profile ?? { id: USER_ID, role: 'customer', status: 'active' }], error: null }),
    customers: () => ({ data: [CUSTOMER_ROW], error: null }),
    addresses: () => ({ data: [ADDRESS], error: null }),
    services: () => ({ data: over.services ?? [service()], error: null }),
    service_durations: () => ({ data: [], error: null }),
    coupons: () => ({ data: [], error: null }),
    // `booking_id` has to be on the fixture: the fake applies `.eq()`, and a row
    // without it is filtered away — which the route would correctly read as a
    // booking with no items on it.
    booking_items: () => ({
      data: [
        {
          id: 'item-1',
          booking_id: BOOKING_ID,
          service_id: SERVICE_ID,
          duration_minutes: 60,
          quantity: 1,
        },
      ],
      error: null,
    }),
    bookings: () => ({ data: over.bookings ?? [booking()], error: null }),
  };

  rpcs = {
    claim_idempotency_key: () => ({ data: { outcome: over.claim ?? 'claimed' }, error: null }),
    complete_idempotency_key: () => ({ data: null, error: null }),
    next_booking_number: () => ({ data: 'SH-20261003-00001', error: null }),
    write_audit: () => ({ data: null, error: null }),

    // 0028. One statement each, so the fake simulates the transaction rather than
    // three requests: the writes are noted so assertions can still talk about
    // rows, and the returned row is what the function would hand back.
    create_booking: (call) => {
      const args = call.args ?? {};
      const money = (args.p_money ?? {}) as Record<string, unknown>;
      fake.noteWrite('bookings', 'insert', { ...money, ...args });
      for (const item of (args.p_items ?? []) as unknown[]) {
        fake.noteWrite('booking_items', 'insert', { ...(item as object), booking_id: BOOKING_ID });
      }
      fake.noteWrite('bookings', 'update', { status: 'payment_pending' });
      return {
        data: {
          ...booking(),
          status: 'payment_pending',
          // The hop through the trigger bumped it, exactly as it does on a real
          // database.
          version: 2,
          ...money,
        },
        error: null,
      };
    },
    cancel_booking: (call) => {
      const args = call.args ?? {};
      const row = {
        ...booking(),
        status: 'cancelled',
        cancelled_at: '2026-10-03T00:00:00.000Z',
        cancellation_reason_code: (args.p_reason_code as string) ?? null,
        cancellation_fee: Number(args.p_fee ?? 0).toFixed(2),
        version: 2,
      };
      fake.noteWrite('bookings', 'update', {
        status: 'cancelled',
        cancellation_reason_code: row.cancellation_reason_code,
        cancellation_fee: row.cancellation_fee,
      });
      return { data: row, error: null };
    },
    transition_booking: (call) => {
      const args = call.args ?? {};
      const row = { ...booking(), status: args.p_to, version: 2 };
      fake.noteWrite('bookings', 'update', { status: args.p_to });
      return { data: row, error: null };
    },
  };

  fake = new FakeSupabase(tables as any, rpcs as any);
}

beforeEach(() => {
  prime();
  assertSlotAvailable.mockClear();
});

describe('POST /api/bookings — create', () => {
  it('prices from the database and lands in payment_pending', async () => {
    prime();
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);

const rpcCall = fake.rpcCalls.find((c) => c.fn === 'create_booking');
    expect(rpcCall).toBeDefined();
    const money = (rpcCall!.args.p_money ?? {}) as Record<string, unknown>;

    // 500 x 1h, fee floor 20, 18% tax on 520 -> 613.60. Every figure came from
    // `services.base_price`, not from the request body.
    expect(money.subtotal).toBe('500.00');
    expect(money.platform_fee).toBe('20.00');
    expect(money.total_amount).toBe('613.60');
    expect(money.currency).toBe('INR');
    // The actor is passed in rather than left to the trigger's `auth.uid()`
    // fallback, which is null on every privileged write — so the history row for
    // the `draft -> payment_pending` hop can name the customer who asked for it.
    expect(rpcCall!.args.p_actor).toBe(USER_ID);
    expect(rpcCall!.args.p_actor_role).toBe('customer');
    expect((rpcCall!.args.p_address_snapshot as Record<string, unknown>).line1).toBe(
      '12, 4th Cross'
    );

    // Born `draft` (the column default) and moved to `payment_pending`, in one
    // transaction — which is what the history will show.
    const created = body.data.booking;
    expect(created.status).toBe('payment_pending');
    expect(created.version).toBe(2);

    expect(fake.writesTo('booking_items')).toHaveLength(1);
  });

  it('refuses a total the client invented', async () => {
    prime();
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
          expectedTotal: 1,
        },
        { 'idempotency-key': KEY }
      )
    );

    // §7.2's gate. The client's ₹1 is never stored and never wins.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PRICE_CHANGED');
    expect(body.details.currentTotal).toBe(613.6);

    // And nothing was written.
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('ignores a basePrice the client tries to smuggle in', async () => {
    prime();
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60, basePrice: 1, label: 'Cheap' }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(201);
    const call = fake.rpcCalls.find((c) => c.fn === 'create_booking');
    expect((call!.args.p_money as Record<string, unknown>).subtotal).toBe('500.00');
  });

  it('stores the quote token it was given, so the row can name where its total came from', async () => {
    prime();
    const token = issueQuoteToken({
      items: [{ serviceId: SERVICE_ID, durationMinutes: 60, quantity: 1 }],
      couponCode: null,
      bookingType: 'scheduled',
      total: 613.6,
    })!;

    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
          quoteToken: token,
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(201);
    expect(fake.rpcCalls.find((c) => c.fn === 'create_booking')!.args.p_quote_token).toBe(token);
  });

  it('refuses a forged quote token without writing anything', async () => {
    prime();
    const token = issueQuoteToken({
      items: [{ serviceId: SERVICE_ID, durationMinutes: 60, quantity: 1 }],
      couponCode: null,
      bookingType: 'scheduled',
      total: 613.6,
    })!;

    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
          // One character changed. The signature covers the payload, so this is
          // not a quote with a typo — it is a quote nobody issued.
          quoteToken: token.slice(0, -4) + 'AAAA',
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.fields.quoteToken).toBeTruthy();
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('refuses a real quote token presented with a different cart', async () => {
    prime();
    const token = issueQuoteToken({
      items: [{ serviceId: SERVICE_ID, durationMinutes: 60, quantity: 1 }],
      couponCode: null,
      bookingType: 'scheduled',
      total: 613.6,
    })!;

    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          // A genuine, unexpired, correctly signed token — for a 30-minute slot
          // instead of the 60 it was issued for. The signature is happy; the
          // agreement is not, and this is the case `expectedTotal` alone would
          // miss, since the client can simply omit it.
          items: [{ serviceId: SERVICE_ID, durationMinutes: 30 }],
          quoteToken: token,
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PRICE_CHANGED');
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('demands an Idempotency-Key', async () => {
    prime();
    const res = await createBooking(
      req({
        addressId: ADDRESS_ID,
        bookingType: 'scheduled',
        scheduledStartAt: '2026-12-01T10:00:00.000Z',
        items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('answers a replay with the stored body and does not write twice', async () => {
    prime({ claim: 'replay' });
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Idempotent-Replay')).toBe('true');
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('tells a same-key-different-body request apart from a race', async () => {
    prime({ claim: 'conflict' });
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(body.details.reason).toBe('conflict');
  });

  it('reports an in-flight duplicate as a race, with a retry hint', async () => {
    prime({ claim: 'in_flight' });
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.details.reason).toBe('in_flight');
  });

  it('refuses an address that is not the caller\'s', async () => {
    // `addresses` returns nothing, which is what "not yours" looks like from the
    // service-role client — there is no RLS to turn it into an empty set for us.
    prime();
    fake = new FakeSupabase({ ...tables, addresses: () => ({ data: [], error: null }) } as any, rpcs as any);

    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.fields.addressId).toBeTruthy();
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('refuses a service that is no longer active', async () => {
    prime({ services: [service({ is_active: false })] });

    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(400);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('requires a time for a scheduled booking', async () => {
    prime();
    const res = await createBooking(
      req(
        { addressId: ADDRESS_ID, bookingType: 'scheduled', items: [{ serviceId: SERVICE_ID }] },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.fields.scheduledStartAt).toBeTruthy();
  });

  it('will not create a recurring booking in a phase that cannot honour one', async () => {
    prime();
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'recurring',
          items: [{ serviceId: SERVICE_ID }],
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(400);
  });

  it('re-checks the slot it was offered, at the locality on the address', async () => {
    prime();
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(201);
    // The check is what makes the promise true: the availability screen offered
    // this instant minutes ago, and it can be asked again before it is confirmed.
    expect(assertSlotAvailable).toHaveBeenCalledWith({
      serviceId: SERVICE_ID,
      localityId: LOCALITY_ID,
      startAt: '2026-12-01T10:00:00.000Z',
      durationMinutes: 60,
    });
  });

  it('refuses a slot that went while the customer was deciding, and writes nothing', async () => {
    prime();
    assertSlotAvailable.mockRejectedValueOnce(
      new ApiHttpError('NO_SLOT_AVAILABLE', 'That time is no longer available. Pick another.', 422)
    );

    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('NO_SLOT_AVAILABLE');
    // Checked before the insert, so there is no orphan booking and no key spent.
    expect(fake.writesTo('bookings')).toHaveLength(0);
    expect(fake.writesTo('booking_items')).toHaveLength(0);
  });

  it('checks every service on the booking, not only the first', async () => {
    prime({ services: [service(), service({ id: OTHER_SERVICE, name: 'Bathroom deep clean' })] });
    await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'scheduled',
          scheduledStartAt: '2026-12-01T10:00:00.000Z',
          items: [
            { serviceId: SERVICE_ID, durationMinutes: 60 },
            { serviceId: OTHER_SERVICE, durationMinutes: 60 },
          ],
        },
        { 'idempotency-key': KEY }
      )
    );

    // A two-service booking is only bookable if both can be done, and a check that
    // looked at the first line would happily accept a day the second cannot serve.
    expect(assertSlotAvailable).toHaveBeenCalledTimes(2);
    expect(assertSlotAvailable.mock.calls.map((c) => (c[0] as any).serviceId)).toEqual([
      SERVICE_ID,
      OTHER_SERVICE,
    ]);
  });

  it('does not check a slot for an instant booking', async () => {
    prime();
    const res = await createBooking(
      req(
        {
          addressId: ADDRESS_ID,
          bookingType: 'instant',
          items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }],
        },
        { 'idempotency-key': KEY }
      )
    );

    expect(res.status).toBe(201);
    // An instant booking has no instant to check; Phase 5 matches it to a
    // professional, and that is where "can somebody come now" is answered.
    expect(assertSlotAvailable).not.toHaveBeenCalled();
  });
});

describe('GET /api/bookings — list', () => {
  it('reads only the caller\'s own bookings', async () => {
    prime();
    const res = await listBookings(getReq());
    expect(res.status).toBe(200);

    const call = fake.calls.find((c) => c.table === 'bookings' && c.op === 'select')!;
    expect(call.eqFilters).toContainEqual(['customer_id', CUSTOMER_ID]);
  });

  it('ignores a customer_id in the query string', async () => {
    prime();
    await listBookings(getReq('http://localhost/api/bookings?customer_id=someone-else'));

    const call = fake.calls.find((c) => c.table === 'bookings' && c.op === 'select')!;
    // The service-role client would honour the parameter. The route filters on
    // the authenticated customer instead, and this is the assertion that says so.
    expect(call.filters).not.toContainEqual(['customer_id', 'someone-else']);
    expect(call.eqFilters).toContainEqual(['customer_id', CUSTOMER_ID]);
  });
});

describe('POST /api/bookings/quote', () => {
  it('quotes without writing anything', async () => {
    prime();
    const res = await quoteBooking(
      new Request('http://localhost/api/bookings/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ serviceId: SERVICE_ID, durationMinutes: 60 }] }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote.total).toBe(613.6);
    expect(body.data.quote.snapshot.engineVersion).toBeGreaterThan(0);
    // Reads only: no writes anywhere. The route prices without spending an
    // idempotency key or creating a row, which is what lets checkout re-quote
    // on every keystroke.
    expect(fake.calls.every((c) => c.op === 'select')).toBe(true);
  });

  it('needs at least one service', async () => {
    prime();
    const res = await quoteBooking(
      new Request('http://localhost/api/bookings/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [] }),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/bookings/[id]/cancel', () => {
  function cancelReq(body: unknown): NextRequest {
    return new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('records the reason, the fee and the time, then cancels', async () => {
    prime();
    const res = await cancelBooking(cancelReq({ reasonCode: 'changed_mind' }), {
      params: { id: BOOKING_ID },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.booking.status).toBe('cancelled');

    const call = fake.rpcCalls.find((c) => c.fn === 'cancel_booking');
    const args = call!.args;

    // One statement, so there is no window in which the booking reads `cancelled`
    // with no reason and no fee against it.
    expect(args.p_reason_code).toBe('changed_mind');
    // Scheduled two months out, so §11.1's top band: no fee.
    expect(args.p_fee).toBe(0);
    expect(args.p_actor).toBe(USER_ID);
    expect(args.p_actor_role).toBe('customer');
    // The version it read is the one it writes against.
    expect(args.p_expected_version).toBe(1);
  });

  it('charges §11.1\'s late band when the start is imminent', async () => {
    prime({ bookings: [booking({ scheduled_start_at: '2026-01-01T00:10:00.000Z' })] });
    const res = await cancelBooking(cancelReq({ reasonCode: 'changed_mind' }), {
      params: { id: BOOKING_ID },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.cancellationFee).toBeGreaterThan(0);
    expect(body.data.band).toBeTruthy();
  });

  it('is idempotent in the friendly direction', async () => {
    prime({ bookings: [booking({ status: 'cancelled', cancellation_fee: '306.80' })] });
    const res = await cancelBooking(cancelReq({ reasonCode: 'changed_mind' }), {
      params: { id: BOOKING_ID },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyCancelled).toBe(true);
    // The stored fee is returned, not a second one derived.
    expect(body.data.cancellationFee).toBe(306.8);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('refuses a reason it does not recognise', async () => {
    prime();
    const res = await cancelBooking(cancelReq({ reasonCode: 'because_i_said_so' }), {
      params: { id: BOOKING_ID },
    });

    expect(res.status).toBe(400);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('will not let another customer cancel it', async () => {
    prime({ bookings: [booking({ customer_id: 'somebody-else' })] });
    const res = await cancelBooking(cancelReq({ reasonCode: 'changed_mind' }), {
      params: { id: BOOKING_ID },
    });

    // The service-role client bypasses RLS, so this check is the only thing
    // standing between a signed-in session and somebody else's booking.
    expect(res.status).toBe(403);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });
});

describe('POST /api/bookings/[id]/reschedule', () => {
  function rescheduleReq(body: unknown): NextRequest {
    return new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/reschedule`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('moves the window and re-quotes', async () => {
    prime();
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z', version: 1 }),
      { params: { id: BOOKING_ID } }
    );

    // The old implementation transitioned to `draft`, which the state machine
    // forbids from every reachable status — so this used to be a 409 for a reason
    // that had nothing to do with what the caller asked.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.breakdown.total).toBe(613.6);

    const update = fake.writesTo('bookings').find((c) => c.op === 'update')!;
    const row = update.payload as Record<string, unknown>;
    expect(row.scheduled_start_at).toBe('2026-12-02T14:00:00.000Z');
    expect(row.scheduled_end_at).toBe('2026-12-02T15:00:00.000Z');
    // §11.3's fee, returned before confirmation. Nothing is assigned yet.
    expect(body.data.rescheduleFee).toBe(0);
  });

  it('loses to a second device rather than double-booking', async () => {
    prime();
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z', version: 99 }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('STALE_VERSION');
    expect(body.details.currentVersion).toBe(1);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('will not move a cancelled booking', async () => {
    prime({ bookings: [booking({ status: 'cancelled' })] });
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z', version: 1 }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(409);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('will not move a booking whose professional has already set off', async () => {
    prime({ bookings: [booking({ status: 'in_progress', professional_id: 'pro-1' })] });
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z', version: 1 }),
      { params: { id: BOOKING_ID } }
    );

    // The route used to refuse only `cancelled`/`closed`/`refunded`, so a booking
    // mid-job could be moved to a new time and the professional would never find
    // out. The list that gates this is the same one the detail route uses to decide
    // whether to draw the panel — `isReschedulableStatus`.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('INVALID_STATE');
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('will not move an instant booking to a time', async () => {
    prime({
      bookings: [booking({ booking_type: 'instant', scheduled_start_at: null })],
    });
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z', version: 1 }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(409);
  });

  it('needs a version', async () => {
    prime();
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z' }),
      { params: { id: BOOKING_ID } }
    );

    // Defaulting it would make the optimistic lock a no-op and both devices win.
    expect(res.status).toBe(400);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('refuses to move someone else\'s booking', async () => {
    prime({ bookings: [booking({ customer_id: 'somebody-else' })] });
    const res = await rescheduleBooking(
      rescheduleReq({ scheduledStartAt: '2026-12-02T14:00:00.000Z', version: 1 }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(403);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });
});

describe('GET /api/bookings/[id] and /invoice — ownership', () => {
  function detailReq(url = `http://localhost/api/bookings/${BOOKING_ID}`): NextRequest {
    return new NextRequest(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  }

  it('serves the owner their own booking', async () => {
    prime();
    const res = await getBookingDetail(detailReq(), { params: { id: BOOKING_ID } });

    // This is the assertion that caught the bug. `bookings.customer_id` is a
    // `customers.id`; both read routes used to pass `auth.userId` (a
    // `profiles.id`) to `getBookingForCaller`, so every customer was refused their
    // own booking with a 403 and nobody noticed, because nothing read the route.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.booking.id).toBe(BOOKING_ID);
    expect(body.data.status.label).toBeTruthy();
    // The panel is drawn from this flag, so it has to be true for the state the
    // button appears in — and false once the professional is on the way.
    expect(body.data.reschedulable).toBe(true);
  });

  it('tells the page not to offer a move once the job is under way', async () => {
    prime({ bookings: [booking({ status: 'in_progress', professional_id: 'pro-1' })] });
    const res = await getBookingDetail(detailReq(), { params: { id: BOOKING_ID } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reschedulable).toBe(false);
  });

  it('serves the owner their invoice', async () => {
    prime();
    const res = await getInvoice(
      detailReq(`http://localhost/api/bookings/${BOOKING_ID}/invoice`),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // The receipt is built from the frozen columns, so the amount is the one that
    // was paid rather than a fresh quote.
    expect(body.data.invoice.amount).toBe('613.60');
    expect(body.data.invoice.bookingNumber).toBe('SH-20261003-00001');
  });

  it('refuses another customer both of them', async () => {
    prime({ bookings: [booking({ customer_id: 'somebody-else' })] });

    const detail = await getBookingDetail(detailReq(), { params: { id: BOOKING_ID } });
    const invoice = await getInvoice(
      detailReq(`http://localhost/api/bookings/${BOOKING_ID}/invoice`),
      { params: { id: BOOKING_ID } }
    );

    // The service-role client bypasses RLS, so this refusal is the only thing
    // between a session and a stranger's address snapshot and invoice.
    expect(detail.status).toBe(403);
    expect(invoice.status).toBe(403);
  });

  it('404s rather than 403s for a booking that does not exist', async () => {
    prime({ bookings: [] });
    const res = await getBookingDetail(detailReq(), { params: { id: BOOKING_ID } });
    expect(res.status).toBe(404);
  });
});

describe('PRICE_FEES', () => {
  it('documents the money the booking tests assert on', () => {
    // A guard against the fixtures drifting from the engine: if a fee default
    // changes, these numbers move with it rather than silently going stale.
    expect(PRICE_FEES.subtotal).toBe(500);
    expect(PRICE_FEES.total).toBe(613.6);
  });
});