import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as dashboard } from '@/app/api/admin/dashboard/route';
import { GET as listBookings } from '@/app/api/admin/bookings/route';
import { GET as getBooking } from '@/app/api/admin/bookings/[id]/route';
import { POST as cancelBooking } from '@/app/api/admin/bookings/[id]/cancel/route';
import { POST as assignBooking } from '@/app/api/admin/bookings/[id]/assign/route';
import { GET as listProfessionals } from '@/app/api/admin/professionals/route';
import { GET as getProfessional } from '@/app/api/admin/professionals/[id]/route';

/**
 * The admin console's Route Handlers (Phase 6, Wave A).
 *
 * Two properties carry the wave and are asserted here rather than in a
 * screenshot test:
 *
 *   The gate. Reads are staff-only; the two writes ask for `booking.cancel.any`
 *   and `booking.assign` respectively, so a support agent can read the queue but
 *   cannot cancel or assign — the capability table decides, not the screen.
 *
 *   The service-role scope. Every read goes through `lib/adminServer`, which
 *   uses the service role; a missing id is a 404 with no write (D3), and the
 *   cancel/assign writes travel through the 0034 RPCs with the actor attached.
 */

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'staff-token';
const BOOKING_ID = 'cccccccc-0001-4111-8111-cccccccccc01';
const MISSING_ID = 'cccccccc-0009-4111-8111-cccccccccc09';
const PROF_ID = 'dddddddd-0001-4111-8111-dddddddddd01';
const PROFILE_ID = 'eeeeeeee-0001-4111-8111-eeeeeeeeee01';
const CUSTOMER_ID = 'ffffffff-0001-4111-8111-fffffffff001';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' = 'ops';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function staffProfile() {
  return {
    id: AUTH_USER_ID,
    role: staffRole,
    status: 'active',
    full_name: 'Ops One',
    phone: '+919876500000',
    email: 'ops@smarthelp.test',
  };
}

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20260601-00001',
    customer_id: CUSTOMER_ID,
    professional_id: null,
    status: 'searching',
    booking_type: 'scheduled',
    version: 1,
    subtotal: '500.00',
    platform_fee: '20.00',
    discount: '0.00',
    tax: '90.00',
    total_amount: '500.00',
    currency: 'INR',
    scheduled_start_at: '2031-04-04T10:00:00+05:30',
    arrived_at: null,
    cancelled_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function professionalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROF_ID,
    profile_id: PROFILE_ID,
    employee_code: 'EMP-1',
    verification_status: 'verified',
    training_status: 'completed',
    availability_status: 'online',
    is_available_today: true,
    rating: 4.6,
    rating_count: 12,
    total_offers: 5,
    accepted_offers: 3,
    completed_jobs: 3,
    cancelled_jobs: 0,
    no_shows: 0,
    experience_months: 24,
    commission_pct: '0.2',
    suspended_reason: null,
    kyc_verified_at: null,
    onboarded_at: null,
    created_at: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          staffProfile(),
          { id: PROFILE_ID, role: 'professional', status: 'active', full_name: 'Ravi Kumar', phone: null, email: null },
          { id: 'aaaa0000-0000-4000-8000-0000000000c1', role: 'customer', status: 'active', full_name: 'Asha Rao', phone: null, email: null },
        ],
        error: null,
      }),
      bookings: () => ({
        data: [bookingRow(), bookingRow({ id: 'cccccccc-0002-4111-8111-cccccccccc02', status: 'cancelled', total_amount: '50.00' })],
        error: null,
      }),
      customers: () => ({
        data: [{ id: CUSTOMER_ID, profile_id: 'aaaa0000-0000-4000-8000-0000000000c1' }],
        error: null,
      }),
      professionals: () => ({ data: [professionalRow()], error: null }),
      booking_items: () => ({
        data: [{ booking_id: BOOKING_ID, service_name: 'Deep Cleaning' }],
        error: null,
      }),
      platform_settings: () => ({ data: [], error: null }),
      ...overrides,
    },
    {
      admin_cancel_booking: () => ({ data: bookingRow({ status: 'cancelled' }), error: null }),
      admin_assign_booking: () => ({
        data: { outcome: 'assigned', booking_id: BOOKING_ID, professional_id: PROF_ID, assignment_id: 'a1' },
        error: null,
      }),
      write_audit: () => ({ data: 'audit-1', error: null }),
      ...(overrides.rpcs ?? {}),
    }
  );
}

function request(url: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

const json = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  fake = build();
  staffRole = 'ops';
});

describe('GET /api/admin/dashboard', () => {
  it('needs a session', async () => {
    const res = await dashboard(request('/api/admin/dashboard'));
    expect(res.status).toBe(401);
  });

  it('answers a staff member with the day’s shape', async () => {
    const res = await dashboard(request('/api/admin/dashboard', { token: TOKEN }));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.bookings).toMatchObject({ awaitingProfessional: 0, inProgress: 0 });
    // The cancelled row is excluded from the day's GMV.
    expect(body.data.gmvToday).toBe(500);
    expect(body.data.professionals.total).toBe(0);
  });
});

describe('GET /api/admin/bookings', () => {
  it('needs a session', async () => {
    const res = await listBookings(request('/api/admin/bookings'));
    expect(res.status).toBe(401);
  });

  it('lets a support agent read the queue', async () => {
    staffRole = 'support';
    const res = await listBookings(request('/api/admin/bookings', { token: TOKEN }));
    expect(res.status).toBe(200);
  });

  it('returns the page with display names attached', async () => {
    const res = await listBookings(request('/api/admin/bookings?status=searching', { token: TOKEN }));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.bookings[0]).toMatchObject({
      id: BOOKING_ID,
      bookingNumber: 'SH-20260601-00001',
      customerName: 'Asha Rao',
      serviceName: 'Deep Cleaning',
      totalAmount: 500,
    });
  });

  it('rejects an unknown status filter', async () => {
    const res = await listBookings(request('/api/admin/bookings?status=bogus', { token: TOKEN }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/bookings/:id', () => {
  it('404s a booking that does not exist, and writes nothing', async () => {
    const res = await getBooking(request(`/api/admin/bookings/${MISSING_ID}`, { token: TOKEN }), {
      params: { id: MISSING_ID },
    });
    expect(res.status).toBe(404);
    expect(fake.writesTo('bookings')).toHaveLength(0);
  });

  it('returns the whole booking file', async () => {
    const res = await getBooking(request(`/api/admin/bookings/${BOOKING_ID}`, { token: TOKEN }), {
      params: { id: BOOKING_ID },
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.booking.id).toBe(BOOKING_ID);
    expect(body.data.items).toHaveLength(1);
  });
});

describe('POST /api/admin/bookings/:id/cancel', () => {
  it('forbids a support agent — no booking.cancel.any', async () => {
    staffRole = 'support';
    const res = await cancelBooking(
      request(`/api/admin/bookings/${BOOKING_ID}/cancel`, { method: 'POST', token: TOKEN, body: {} }),
      { params: { id: BOOKING_ID } }
    );
    expect(res.status).toBe(403);
    expect(fake.rpcCalls.some((c) => c.fn === 'admin_cancel_booking')).toBe(false);
  });

  it('cancels as ops, waiving the fee, and audits', async () => {
    const res = await cancelBooking(
      request(`/api/admin/bookings/${BOOKING_ID}/cancel`, {
        method: 'POST',
        token: TOKEN,
        body: { reasonCode: 'ops_cancelled', note: 'customer called' },
      }),
      { params: { id: BOOKING_ID } }
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.waived).toBe(true);
    expect(body.data.fee).toBe(0);

    const call = fake.rpcCalls.find((c) => c.fn === 'admin_cancel_booking');
    expect(call?.args).toMatchObject({
      p_booking_id: BOOKING_ID,
      p_reason_code: 'ops_cancelled',
      p_fee: '0.00',
      p_actor: AUTH_USER_ID,
      p_actor_role: 'ops',
    });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});

describe('POST /api/admin/bookings/:id/assign', () => {
  it('refuses an unverified professional', async () => {
    fake = build({ professionals: () => ({ data: [professionalRow({ verification_status: 'submitted' })], error: null }) });
    const res = await assignBooking(
      request(`/api/admin/bookings/${BOOKING_ID}/assign`, {
        method: 'POST',
        token: TOKEN,
        body: { professionalId: PROF_ID },
      }),
      { params: { id: BOOKING_ID } }
    );
    expect(res.status).toBe(422);
    expect(fake.rpcCalls.some((c) => c.fn === 'admin_assign_booking')).toBe(false);
  });

  it('assigns a verified professional through the 0034 RPC', async () => {
    const res = await assignBooking(
      request(`/api/admin/bookings/${BOOKING_ID}/assign`, {
        method: 'POST',
        token: TOKEN,
        body: { professionalId: PROF_ID, note: 'manual' },
      }),
      { params: { id: BOOKING_ID } }
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ bookingId: BOOKING_ID, professionalId: PROF_ID });

    const call = fake.rpcCalls.find((c) => c.fn === 'admin_assign_booking');
    // The offer TTL comes from platform_settings (15 by default).
    expect(call?.args).toMatchObject({ p_offer_ttl_minutes: 15, p_professional_id: PROF_ID });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});

describe('GET /api/admin/professionals', () => {
  it('needs a session', async () => {
    const res = await listProfessionals(request('/api/admin/professionals'));
    expect(res.status).toBe(401);
  });

  it('returns the roster', async () => {
    const res = await listProfessionals(
      request('/api/admin/professionals?verificationStatus=verified', { token: TOKEN })
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.professionals[0]).toMatchObject({ id: PROF_ID, name: 'Ravi Kumar' });
  });
});

describe('GET /api/admin/professionals/:id', () => {
  it('404s an unknown professional', async () => {
    const res = await getProfessional(
      request(`/api/admin/professionals/${MISSING_ID}`, { token: TOKEN }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
  });

  it('returns the professional file', async () => {
    const res = await getProfessional(
      request(`/api/admin/professionals/${PROF_ID}`, { token: TOKEN }),
      { params: { id: PROF_ID } }
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.professional.id).toBe(PROF_ID);
  });
});
