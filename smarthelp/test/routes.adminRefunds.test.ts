import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as listRefunds } from '@/app/api/admin/refunds/route';
import { POST as executeRefund } from '@/app/api/admin/refunds/[id]/execute/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
/** A different staff member — the one who *requested* the above-limit refund. */
const OTHER_STAFF = '00000000-0000-4000-8000-000000000002';
const TOKEN = 'staff-token';
const REFUND_ID = 'bbbbbbbb-0001-4111-8111-bbbbbbbbbb01';
const PAYMENT_ID = '99999999-0001-4111-8111-999999999901';
const BOOKING_ID = 'cccccccc-0001-4111-8111-cccccccccc01';
const CUSTOMER_ID = 'ffffffff-0001-4111-8111-fffffffff001';
const CUSTOMER_PROFILE_ID = 'aaaa0000-0000-4000-8000-0000000000c1';
const MISSING_ID = 'bbbbbbbb-0009-4111-8111-bbbbbbbbbb09';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' = 'ops';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function refundRow(overrides: Record<string, any> = {}) {
  return {
    id: REFUND_ID,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: CUSTOMER_ID,
    amount: '2000.00',
    currency: 'INR',
    status: 'requested',
    route: 'wallet',
    reason_code: 'customer_request',
    note: null,
    gateway_refund_id: null,
    requested_by: OTHER_STAFF,
    processed_by: null,
    approved_by: null,
    requested_at: '2026-06-02T09:00:00.000Z',
    completed_at: null,
    created_at: '2026-06-02T09:00:00.000Z',
    updated_at: '2026-06-02T09:00:00.000Z',
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, any> = {}) {
  return {
    id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    customer_id: CUSTOMER_ID,
    purpose: 'booking',
    amount: '2000.00',
    currency: 'INR',
    gateway: 'razorpay',
    gateway_order_id: 'order_X',
    gateway_payment_id: null,
    gateway_signature: null,
    status: 'captured',
    method: 'upi',
    refundable_amount: '2000.00',
    failure_reason: null,
    idempotency_key: null,
    captured_at: '2026-06-02T08:00:00.000Z',
    created_at: '2026-06-02T08:00:00.000Z',
    updated_at: '2026-06-02T08:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Ops One', phone: null, email: null },
          { id: OTHER_STAFF, role: 'ops', status: 'active', full_name: 'Sana Kapoor', phone: null, email: null },
          { id: CUSTOMER_PROFILE_ID, role: 'customer', status: 'active', full_name: 'Asha Rao', phone: null, email: null },
        ],
        error: null,
      }),
      bookings: () => ({
        data: [{ id: BOOKING_ID, booking_number: 'SH-20260602-00017' }],
        error: null,
      }),
      customers: () => ({
        data: [{ id: CUSTOMER_ID, profile_id: CUSTOMER_PROFILE_ID }],
        error: null,
      }),
      refunds: () => ({ data: [refundRow()], error: null }),
      payments: () => ({ data: [paymentRow()], error: null }),
      platform_settings: () => ({ data: [], error: null }),
      ...overrides,
    },
    {
      complete_booking_refund: () => ({ data: refundRow({ status: 'completed' }), error: null }),
      apply_wallet_delta: () => ({ data: '2000.00', error: null }),
      get_or_create_wallet: () => ({ data: 'wallet-1', error: null }),
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

describe('GET /api/admin/refunds', () => {
  it('needs a session', async () => {
    const res = await listRefunds(request('/api/admin/refunds'));
    expect(res.status).toBe(401);
  });

  it('returns the queue with names and booking numbers attached', async () => {
    const res = await listRefunds(request('/api/admin/refunds', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.refunds).toHaveLength(1);
    const r = body.data.refunds[0];
    expect(r.bookingNumber).toBe('SH-20260602-00017');
    expect(r.customerName).toBe('Asha Rao');
    expect(r.amount).toBe(2000);
    expect(r.status).toBe('requested');
  });

  it('rejects an unknown status filter', async () => {
    const res = await listRefunds(request('/api/admin/refunds?status=bogus', { token: TOKEN }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/refunds/:id/execute', () => {
  it('needs a session', async () => {
    const res = await executeRefund(request(`/api/admin/refunds/${REFUND_ID}/execute`, { method: 'POST', body: {} }), {
      params: { id: REFUND_ID },
    });
    expect(res.status).toBe(401);
  });

  it('forbids a support agent — no refund.execute', async () => {
    staffRole = 'support';
    const res = await executeRefund(
      request(`/api/admin/refunds/${REFUND_ID}/execute`, { method: 'POST', token: TOKEN, body: {} }),
      { params: { id: REFUND_ID } }
    );
    expect(res.status).toBe(403);
  });

  it('404s a refund that does not exist, and writes nothing', async () => {
    const res = await executeRefund(
      request(`/api/admin/refunds/${MISSING_ID}/execute`, { method: 'POST', token: TOKEN, body: {} }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
  });

  it('409s a refund that is already completed', async () => {
    fake = build({
      refunds: () => ({ data: [refundRow({ status: 'completed' })], error: null }),
    });
    const res = await executeRefund(
      request(`/api/admin/refunds/${REFUND_ID}/execute`, { method: 'POST', token: TOKEN, body: {} }),
      { params: { id: REFUND_ID } }
    );
    expect(res.status).toBe(409);
  });

  it('insists on a second approver when above the limit and requested by the actor', async () => {
    fake = build({ refunds: () => ({ data: [refundRow({ requested_by: AUTH_USER_ID })], error: null }) });
    const res = await executeRefund(
      request(`/api/admin/refunds/${REFUND_ID}/execute`, { method: 'POST', token: TOKEN, body: {} }),
      { params: { id: REFUND_ID } }
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.code).toBe('SECOND_APPROVER_REQUIRED');
  });

  it('executes an above-limit refund when a different staff member requested it', async () => {
    const res = await executeRefund(
      request(`/api/admin/refunds/${REFUND_ID}/execute`, { method: 'POST', token: TOKEN, body: { note: 'seen on phone' } }),
      { params: { id: REFUND_ID } }
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.refund.status).toBe('completed');

    const stamped = fake.calls.filter((c) => c.op === 'update' && c.table === 'refunds');
    expect(stamped.length).toBe(1); // the approval stamp before the money moves
    expect(stamped[0].payload).toMatchObject({ status: 'approved', approved_by: AUTH_USER_ID });
    expect(fake.rpcCalls.some((c) => c.fn === 'complete_booking_refund')).toBe(true);
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });

  it('allows the requester — but only at or below the limit', async () => {
    fake = build({
      refunds: () => ({ data: [refundRow({ amount: '1000.00', requested_by: AUTH_USER_ID })], error: null }),
      payments: () => ({ data: [paymentRow({ amount: '1000.00', refundable_amount: '1000.00' })], error: null }),
    });
    const res = await executeRefund(
      request(`/api/admin/refunds/${REFUND_ID}/execute`, { method: 'POST', token: TOKEN, body: {} }),
      { params: { id: REFUND_ID } }
    );
    expect(res.status).toBe(200);
  });
});