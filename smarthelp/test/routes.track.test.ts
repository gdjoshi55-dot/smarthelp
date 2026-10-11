import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as getTrack } from '@/app/api/bookings/[id]/track/route';
import { POST as mintOtp } from '@/app/api/bookings/[id]/otp/regenerate/route';
import { POST as postLocation } from '@/app/api/professionals/me/location/route';

/**
 * The live view and the location ping (C2, §10.2, §19.4, D3, D6).
 *
 * Three properties are worth a test each, and they are the reason this file
 * exists rather than an addition to the professionals suite:
 *
 *   1. **The clock is the server's.** `serverNow` and `remainingSeconds` come
 *      from the same instant, so a device cannot be told the wrong number.
 *   2. **The payload is a projection.** `otp_hash`, the OTP counters and the
 *      plaintext code never appear — not for the professional, and not for the
 *      customer who just minted one.
 *   3. **Ownership is a single 404.** A stranger's job id is indistinguishable
 *      from a job that does not exist, because the payload carries live
 *      coordinates.
 */

const USER_ID = '00000000-0000-4000-8000-000000000011';
const TOKEN = 'track-token';
const CUSTOMER_ID = 'cccccccc-0000-4000-8000-0000000000c1';
const OTHER_CUSTOMER_ID = 'cccccccc-0000-4000-8000-0000000000c2';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_PROF_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const BOOKING_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';

const PROFILE = {
  id: USER_ID,
  role: 'customer',
  status: 'active',
  full_name: 'Asha Rao',
  phone: '+919876543210',
  email: null,
};

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function professionalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROF_ID,
    profile_id: USER_ID,
    verification_status: 'verified',
    availability_status: 'busy',
    is_available_today: true,
    current_lat: null,
    current_lng: null,
    location_updated_at: null,
    ...overrides,
  };
}

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20260201-90001',
    customer_id: CUSTOMER_ID,
    professional_id: PROF_ID,
    status: 'on_the_way',
    booking_type: 'instant',
    version: 3,
    scheduled_start_at: '2026-02-01T04:00:00.000Z',
    duration_minutes: 60,
    subtotal: 500,
    total_amount: 590,
    currency: 'INR',
    otp_hash: 'deadbeef',
    otp_attempts: 0,
    otp_generations: 0,
    otp_verified_at: null,
    otp_expires_at: null,
    otp_locked_until: null,
    started_at: null,
    ends_at: null,
    ended_at: null,
    notes: null,
    ...overrides,
  };
}

function build(
  options: {
    role?: string;
    booking?: Record<string, unknown> | null;
    professional?: Record<string, unknown>;
    history?: unknown[];
    rpcs?: Record<string, (call: { args: Record<string, unknown> }) => { data: unknown; error: unknown }>;
  } = {}
) {
  const {
    role = 'customer',
    booking = bookingRow(),
    professional = professionalRow(),
    history = [
      { booking_id: BOOKING_ID, to_status: 'accepted', created_at: '2026-02-01T03:50:00.000Z' },
      { booking_id: BOOKING_ID, to_status: 'on_the_way', created_at: '2026-02-01T03:55:00.000Z' },
    ],
    rpcs,
  } = options;

  return new FakeSupabase(
    {
      profiles: () => ({ data: { ...PROFILE, role }, error: null }),
      customers: () => ({ data: { id: CUSTOMER_ID, profile_id: USER_ID }, error: null }),
      professionals: () => ({ data: [professional], error: null }),
      bookings: () => ({ data: booking ? [booking] : [], error: null }),
      booking_status_history: () => ({ data: history, error: null }),
    } as any,
    rpcs as any
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

const body = async (res: Response) => (await res.json()) as any;
const track = (token = TOKEN) =>
  getTrack(request(`/api/bookings/${BOOKING_ID}/track`, { token }), {
    params: { id: BOOKING_ID },
  });

beforeEach(() => {
  fake = build();
});

describe('GET /api/bookings/[id]/track', () => {
  it('needs a session', async () => {
    const res = await getTrack(request(`/api/bookings/${BOOKING_ID}/track`), {
      params: { id: BOOKING_ID },
    });
    expect(res.status).toBe(401);
  });

  it('stamps the clock on the server', async () => {
    const endsAt = '2999-01-01T00:00:00.000Z';
    fake = build({ booking: bookingRow({ status: 'in_progress', ends_at: endsAt }) });

    const json = await body(await track());

    expect(json.data.status).toBe('in_progress');
    expect(json.data.endsAt).toBe(endsAt);
    expect(typeof json.data.serverNow).toBe('string');
    // Both numbers come from the same instant, so they must agree exactly — no
    // tolerance, because there is no second clock involved.
    const expected = Math.max(0, Math.round((Date.parse(endsAt) - Date.parse(json.data.serverNow)) / 1000));
    expect(json.data.remainingSeconds).toBe(expected);
    expect(json.data.presentation.label).toBe('In progress');
  });

  it('reports no remaining time before the job starts', async () => {
    fake = build({ booking: bookingRow({ status: 'accepted' }) });
    const json = await body(await track());
    expect(json.data.remainingSeconds).toBeNull();
    expect(json.data.startedAt).toBeNull();
  });

  it('carries the compact timeline, oldest first', async () => {
    const json = await body(await track());
    expect(json.data.timeline).toEqual([
      { status: 'accepted', at: '2026-02-01T03:50:00.000Z' },
      { status: 'on_the_way', at: '2026-02-01T03:55:00.000Z' },
    ]);
  });

  it('never projects otp_hash, the counters, or the lock into the booking', async () => {
    fake = build({ booking: bookingRow({ status: 'arrived', otp_generations: 2 }) });
    const json = await body(await track());

    expect(json.data.booking.otp_hash).toBeUndefined();
    expect(json.data.booking.otp_attempts).toBeUndefined();
    expect(json.data.booking.otp_generations).toBeUndefined();
    expect(json.data.booking.otp_verified_at).toBeUndefined();
    expect(json.data.booking.otp_locked_until).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('deadbeef');
  });

  it('exposes the OTP expiry and remaining generations only at arrived', async () => {
    fake = build({ booking: bookingRow({ status: 'on_the_way', otp_generations: 1 }) });
    const early = await body(await track());
    expect(early.data.otpExpiresAt).toBeUndefined();
    expect(early.data.otpGenerationsRemaining).toBeUndefined();

    fake = build({
      booking: bookingRow({
        status: 'arrived',
        otp_generations: 1,
        otp_expires_at: '2026-02-01T04:15:00.000Z',
      }),
    });
    const arrived = await body(await track());
    expect(arrived.data.otpExpiresAt).toBe('2026-02-01T04:15:00.000Z');
    expect(arrived.data.otpGenerationsRemaining).toBe(2);
    // The expiry is lifted out, not echoed on the booking row.
    expect(arrived.data.booking.otp_expires_at).toBeUndefined();
  });

  it('does not leak a freshly minted code into the track payload', async () => {
    fake = build({
      booking: bookingRow({ status: 'arrived' }),
      rpcs: {
        issue_service_otp: () => ({
          data: { id: BOOKING_ID, otp_expires_at: '2026-02-01T04:15:00.000Z' },
          error: null,
        }),
      },
    });

    const minted = await body(
      await mintOtp(request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, {
        method: 'POST',
        token: TOKEN,
      }), { params: { id: BOOKING_ID } })
    );
    expect(minted.data.code).toMatch(/^[0-9]{4}$/);

    const json = await body(await track());
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(minted.data.code);
    expect(serialized).not.toContain('deadbeef');
  });

  it('gives the owning professional the same view, with their live pin', async () => {
    fake = build({
      role: 'professional',
      booking: bookingRow({
        status: 'arrived',
        otp_expires_at: '2026-02-01T04:15:00.000Z',
      }),
      professional: professionalRow({
        current_lat: 12.9784,
        current_lng: 77.6405,
        location_updated_at: new Date().toISOString(),
      }),
    });

    const res = await track();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.status).toBe('arrived');
    expect(json.data.proLocation).toEqual({ lat: 12.9784, lng: 77.6405 });
    // The professional never sees the customer's OTP block.
    expect(json.data.otpExpiresAt).toBeUndefined();
    expect(json.data.otpGenerationsRemaining).toBeUndefined();
  });

  it('answers proLocation null when the professional has never pinged', async () => {
    fake = build({ booking: bookingRow({ status: 'on_the_way' }) });
    const json = await body(await track());
    expect(json.data.proLocation).toBeNull();
  });

  it('answers proLocation null for a stale pin', async () => {
    fake = build({
      booking: bookingRow({ status: 'on_the_way' }),
      professional: professionalRow({
        current_lat: 12.9784,
        current_lng: 77.6405,
        location_updated_at: '2000-01-01T00:00:00.000Z',
      }),
    });
    const json = await body(await track());
    expect(json.data.proLocation).toBeNull();
  });

  it('leaves remainingSeconds null before the job has an end', async () => {
    fake = build({ booking: bookingRow({ status: 'accepted' }) });
    const json = await body(await track());
    expect(json.data.remainingSeconds).toBeNull();
  });

  it('gives a third party the same 404 as a booking that does not exist', async () => {
    fake = build({ booking: bookingRow({ customer_id: OTHER_CUSTOMER_ID }) });
    const res = await track();
    const json = await body(res);
    expect(res.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('refuses a professional who does not own the job', async () => {
    fake = build({
      role: 'professional',
      booking: bookingRow({ professional_id: OTHER_PROF_ID }),
    });
    const res = await track();
    expect(res.status).toBe(404);
  });

  it('404s a booking that is not there', async () => {
    fake = build({ booking: null });
    const res = await track();
    const json = await body(res);
    expect(res.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('lets staff read any booking', async () => {
    fake = build({
      role: 'admin',
      booking: bookingRow({ customer_id: OTHER_CUSTOMER_ID, professional_id: OTHER_PROF_ID }),
    });
    const res = await track();
    expect(res.status).toBe(200);
  });
});

describe('POST /api/professionals/me/location', () => {
  const post = (body: unknown) =>
    postLocation(
      request('/api/professionals/me/location', { method: 'POST', body, token: TOKEN })
    );

  it('records the pin and stamps the time on the server', async () => {
    fake = build({ role: 'professional' });

    const res = await post({ lat: 12.9784, lng: 77.6405 });
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ updated: true });

    const write = fake.writesTo('professionals')[0];
    expect(write?.op).toBe('update');
    expect(write?.filters).toContainEqual(['id', PROF_ID]);
    expect(write?.payload).toMatchObject({ current_lat: 12.9784, current_lng: 77.6405 });
    expect(typeof (write?.payload as any).location_updated_at).toBe('string');
  });

  it('drops a ping inside the throttle window without writing', async () => {
    fake = build({
      role: 'professional',
      professional: professionalRow({ location_updated_at: new Date().toISOString() }),
    });

    const res = await post({ lat: 12.9784, lng: 77.6405 });
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ updated: false });
    expect(fake.writesTo('professionals')).toHaveLength(0);
  });

  it('accepts a ping once the window has passed', async () => {
    fake = build({
      role: 'professional',
      professional: professionalRow({
        location_updated_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    });

    const res = await post({ lat: 12.9784, lng: 77.6405 });
    const json = await body(res);

    expect(json.data).toEqual({ updated: true });
    expect(fake.writesTo('professionals')).toHaveLength(1);
  });

  it('refuses coordinates that are not numbers, before writing', async () => {
    fake = build({ role: 'professional' });
    const res = await post({ lat: 'near the park', lng: 77.6405 });
    expect(res.status).toBe(400);
    expect(fake.writesTo('professionals')).toHaveLength(0);
  });
});
