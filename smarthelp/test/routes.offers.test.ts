import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as listOffers } from '@/app/api/professionals/offers/route';
import { POST as acceptOffer } from '@/app/api/professionals/offers/[id]/accept/route';
import { POST as declineOffer } from '@/app/api/professionals/offers/[id]/decline/route';
import { GET as listJobs } from '@/app/api/professionals/me/jobs/route';

/**
 * The professional's offer inbox and job list (§14.3, §20.7, P4-04).
 *
 * Two things are load-bearing here and neither is about the happy path. First,
 * the §14.3 privacy gate: an offer the professional has not accepted may carry
 * the area and the price, and nothing else — no phone, no street address, no
 * `otp_hash`. Second, the ownership re-check: every route reaches Postgres with
 * the service role, so a cross-professional id must be a 404 with zero writes,
 * not a leaked row.
 *
 * The `otp_hash` assertion is copied onto every payload test on purpose — it is
 * Pitfall 1, and the day it fails is the day a job payload started leaking.
 */

const USER_ID = '00000000-0000-4000-8000-000000000011';
const TOKEN = 'pro-token';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_PROF_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const CUSTOMER_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const ASSIGN_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const BOOKING_ID = 'ffffffff-1111-4111-8111-ffffffffffff';

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

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGN_ID,
    booking_id: BOOKING_ID,
    professional_id: PROF_ID,
    status: 'offered',
    // Far future, so the accept path's lazy-expiry gate passes.
    expires_at: '2999-01-01T00:00:00.000Z',
    distance_km: 3.2,
    score: 0.9,
    was_favourite: false,
    was_repeat: false,
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20260601-00001',
    customer_id: CUSTOMER_ID,
    professional_id: PROF_ID,
    status: 'assigned',
    booking_type: 'instant',
    version: 3,
    scheduled_start_at: '2026-06-02T09:00:00.000Z',
    scheduled_end_at: '2026-06-02T10:00:00.000Z',
    duration_minutes: 60,
    address_snapshot: {
      area: 'Indiranagar',
      line1: '12 MG Road',
      city: 'Bengaluru',
      phone: '+919000000000',
    },
    total_amount: '499.00',
    professional_gross: '400.00',
    currency: 'INR',
    otp_hash: 'deadbeefdeadbeef',
    created_at: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function bookingItem(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: BOOKING_ID,
    service_name: 'Deep Cleaning',
    created_at: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}, rpcs: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({ data: PROFILE, error: null }),
      professionals: () => ({ data: [professional()], error: null }),
      booking_assignments: () => ({ data: [assignment()], error: null }),
      bookings: () => ({ data: [booking()], error: null }),
      booking_items: () => ({ data: [bookingItem()], error: null }),
      ...overrides,
    },
    {
      run_matching_sweep: () => ({ data: [], error: null }),
      match_booking: () => ({
        data: { outcome: 'offered', booking_id: BOOKING_ID, professional_id: OTHER_PROF_ID },
        error: null,
      }),
      accept_offer: () => ({ data: assignment({ status: 'accepted' }), error: null }),
      decline_offer: () => ({ data: assignment({ status: 'rejected' }), error: null }),
      ...rpcs,
    }
  );
}

function request(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers,
  });
}

const params = { params: { id: ASSIGN_ID } };
const body = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  fake = build();
});

// ── The inbox read ──────────────────────────────────────────

describe('GET /api/professionals/offers', () => {
  it('needs a session', async () => {
    const res = await listOffers(request('/api/professionals/offers'));
    expect(res.status).toBe(401);
  });

  it('refuses an unverified professional', async () => {
    fake = build({
      professionals: () => ({ data: [professional({ verification_status: 'submitted' })], error: null }),
    });
    const res = await listOffers(request('/api/professionals/offers', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(403);
    expect(json.code).toBe('FORBIDDEN');
  });

  it('sweeps, lazily expires the caller\'s stale offers, then reads live ones', async () => {
    await listOffers(request('/api/professionals/offers', { token: TOKEN }));

    expect(fake.rpcCalls.some((c) => c.fn === 'run_matching_sweep')).toBe(true);

    const expire = fake.writesTo('booking_assignments').find((w) => w.op === 'update');
    expect(expire?.payload).toEqual({ status: 'expired' });
    expect(expire?.filters).toContainEqual(['professional_id', PROF_ID]);
    expect(expire?.filters).toContainEqual(['status', 'offered']);

    const read = fake.calls.find(
      (c) => c.table === 'booking_assignments' && c.op === 'select'
    );
    expect(read?.filters).toContainEqual(['professional_id', PROF_ID]);
    expect(read?.filters).toContainEqual(['status', 'offered']);
  });

  it('returns the OfferCard contract and nothing private (§14.3)', async () => {
    const res = await listOffers(request('/api/professionals/offers', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.offers).toHaveLength(1);
    expect(json.data.offers[0]).toEqual({
      id: ASSIGN_ID,
      bookingId: BOOKING_ID,
      serviceName: 'Deep Cleaning',
      scheduledStartAt: '2026-06-02T09:00:00.000Z',
      scheduledEndAt: '2026-06-02T10:00:00.000Z',
      area: 'Indiranagar',
      quotedPrice: '400.00',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const text = JSON.stringify(json);
    expect(text).not.toContain('otp_hash');
    expect(text).not.toContain('deadbeef');
    expect(text).not.toContain('phone');
    expect(text).not.toContain('MG Road');
    expect(text).not.toContain('address_snapshot');
    expect(text).not.toContain('customer_name');
  });

  it('returns an empty inbox without a second query when there are no offers', async () => {
    fake = build({ booking_assignments: () => ({ data: [], error: null }) });
    const res = await listOffers(request('/api/professionals/offers', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.offers).toEqual([]);
    expect(fake.calls.some((c) => c.table === 'bookings')).toBe(false);
  });
});

// ── Accept ──────────────────────────────────────────────────

describe('POST /api/professionals/offers/[id]/accept', () => {
  it('accepts through the RPC and reveals the job, still without otp_hash', async () => {
    const res = await acceptOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/accept`, { method: 'POST', token: TOKEN }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(200);

    const rpc = fake.rpcCalls.find((c) => c.fn === 'accept_offer');
    expect(rpc?.args).toEqual({ p_assignment_id: ASSIGN_ID, p_professional_id: PROF_ID });

    expect(json.data.job.status).toBe('assigned');
    expect(JSON.stringify(json)).not.toContain('otp_hash');
    expect(JSON.stringify(json)).not.toContain('deadbeef');
  });

  it('409s a schedule overlap (PROFESSIONAL_UNAVAILABLE) without a 500', async () => {
    fake = build({}, {
      accept_offer: () => ({
        data: null,
        error: { message: 'PROFESSIONAL_UNAVAILABLE', code: '23P01' },
      }),
    });
    const res = await acceptOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/accept`, { method: 'POST', token: TOKEN }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(409);
    expect(json.code).toBe('PROFESSIONAL_UNAVAILABLE');
  });

  it('409s an offer someone else already took', async () => {
    fake = build({}, { accept_offer: () => ({ data: null, error: null }) });
    const res = await acceptOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/accept`, { method: 'POST', token: TOKEN }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(409);
    expect(json.code).toBe('ASSIGNMENT_TAKEN');
  });

  it('refuses an already-expired offer before calling the RPC', async () => {
    fake = build({
      booking_assignments: () => ({
        data: [assignment({ expires_at: '2000-01-01T00:00:00.000Z' })],
        error: null,
      }),
    });
    const res = await acceptOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/accept`, { method: 'POST', token: TOKEN }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('404s another professional\'s offer with zero writes', async () => {
    fake = build({
      booking_assignments: () => ({
        data: [assignment({ professional_id: OTHER_PROF_ID })],
        error: null,
      }),
    });
    const res = await acceptOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/accept`, { method: 'POST', token: TOKEN }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.writesTo('booking_assignments')).toHaveLength(0);
  });
});

// ── Decline ─────────────────────────────────────────────────

describe('POST /api/professionals/offers/[id]/decline', () => {
  it('records the reason through the RPC', async () => {
    const res = await declineOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/decline`, {
        method: 'POST',
        body: { reason: 'Too far from my area' },
        token: TOKEN,
      }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.declined).toBe(true);

    const rpc = fake.rpcCalls.find((c) => c.fn === 'decline_offer');
    expect(rpc?.args).toEqual({
      p_assignment_id: ASSIGN_ID,
      p_professional_id: PROF_ID,
      p_reason: 'Too far from my area',
    });
  });

  it('cascades to the next-ranked professional through match_booking (§8.2)', async () => {
    const res = await declineOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/decline`, {
        method: 'POST',
        body: { reason: 'Too far from my area' },
        token: TOKEN,
      }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.reassigned).toBe(true);

    const cascade = fake.rpcCalls.find((c) => c.fn === 'match_booking');
    expect(cascade?.args).toEqual({ p_booking_id: BOOKING_ID });
  });

  it('reports a decline that exhausted the search (no reassignment)', async () => {
    fake = build({}, {
      match_booking: () => ({ data: { outcome: 'exhausted', booking_id: BOOKING_ID }, error: null }),
    });
    const res = await declineOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/decline`, {
        method: 'POST',
        body: {},
        token: TOKEN,
      }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.reassigned).toBe(false);
  });

  it('allows a decline with no reason (the RPC defaults it to null)', async () => {
    const res = await declineOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/decline`, {
        method: 'POST',
        body: {},
        token: TOKEN,
      }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.declined).toBe(true);

    const rpc = fake.rpcCalls.find((c) => c.fn === 'decline_offer');
    expect(rpc?.args).toEqual({
      p_assignment_id: ASSIGN_ID,
      p_professional_id: PROF_ID,
      p_reason: null,
    });
  });

  it('404s another professional\'s offer with zero writes', async () => {
    fake = build({
      booking_assignments: () => ({
        data: [assignment({ professional_id: OTHER_PROF_ID })],
        error: null,
      }),
    });
    const res = await declineOffer(
      request(`/api/professionals/offers/${ASSIGN_ID}/decline`, {
        method: 'POST',
        body: { reason: 'Not my service' },
        token: TOKEN,
      }),
      params
    );
    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.writesTo('booking_assignments')).toHaveLength(0);
  });
});

// ── The jobs list ───────────────────────────────────────────

describe('GET /api/professionals/me/jobs', () => {
  it('returns the caller\'s live jobs, filtered by owner', async () => {
    const res = await listJobs(request('/api/professionals/me/jobs', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.jobs).toHaveLength(1);
    expect(json.data.jobs[0]).toMatchObject({ id: BOOKING_ID, status: 'assigned' });

    const read = fake.calls.find((c) => c.table === 'bookings');
    expect(read?.filters).toContainEqual(['professional_id', PROF_ID]);

    expect(JSON.stringify(json)).not.toContain('otp_hash');
    expect(JSON.stringify(json)).not.toContain('deadbeef');
  });
});
