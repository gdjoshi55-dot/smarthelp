import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as listDisputes } from '@/app/api/admin/disputes/route';
import { POST as resolveDisputeRoute } from '@/app/api/admin/disputes/[id]/resolve/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const RAISER_ID = 'aaaaaaaa-0001-4111-8111-aaaaaaaaaa01';
const DISPUTE_ID = 'bbbbbbbb-0001-4111-8111-bbbbbbbbbb01';
const MISSING_ID = 'bbbbbbbb-0009-4111-8111-bbbbbbbbbb09';
const BOOKING_ID = 'cccccccc-0001-4111-8111-cccccccccc01';
const TOKEN = 'staff-token';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' | 'super_admin' = 'ops';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function disputeRow(overrides: Record<string, any> = {}) {
  return {
    id: DISPUTE_ID,
    booking_id: BOOKING_ID,
    raised_by: RAISER_ID,
    reason: 'Charged for a service not delivered',
    description: 'The clean never happened.',
    status: 'open',
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function build() {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Ops One', phone: null, email: null },
          { id: RAISER_ID, full_name: 'Maya Customer' },
        ],
        error: null,
      }),
      disputes: () => ({ data: [disputeRow()], error: null }),
      bookings: () => ({ data: [{ id: BOOKING_ID, booking_number: 'SH-2002' }], error: null }),
    },
    {
      write_audit: () => ({ data: 'audit-1', error: null }),
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
  staffRole = 'ops';
  fake = build();
});

describe('GET /api/admin/disputes', () => {
  it('needs a session', async () => {
    const res = await listDisputes(request('/api/admin/disputes'));
    expect(res.status).toBe(401);
  });

  it('returns the queue with the booking number and raiser name', async () => {
    const res = await listDisputes(request('/api/admin/disputes', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.disputes).toHaveLength(1);
    expect(body.data.disputes[0].reason).toBe('Charged for a service not delivered');
    expect(body.data.disputes[0].bookingNumber).toBe('SH-2002');
    expect(body.data.disputes[0].raisedByName).toBe('Maya Customer');
    expect(body.data.total).toBe(1);
  });
});

describe('POST /api/admin/disputes/:id/resolve', () => {
  it('forbids a support agent — dispute.resolve is ops/admin', async () => {
    staffRole = 'support';
    const res = await resolveDisputeRoute(
      request(`/api/admin/disputes/${DISPUTE_ID}/resolve`, { method: 'POST', token: TOKEN, body: { status: 'resolved' } }),
      { params: { id: DISPUTE_ID } }
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('404s a dispute that does not exist, and writes nothing', async () => {
    const res = await resolveDisputeRoute(
      request(`/api/admin/disputes/${MISSING_ID}/resolve`, { method: 'POST', token: TOKEN, body: { status: 'resolved' } }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('rejects an unknown decision', async () => {
    const res = await resolveDisputeRoute(
      request(`/api/admin/disputes/${DISPUTE_ID}/resolve`, { method: 'POST', token: TOKEN, body: { status: 'open' } }),
      { params: { id: DISPUTE_ID } }
    );
    expect(res.status).toBe(400);
  });

  it('resolves a dispute as ops, stamping the resolver, and audits it', async () => {
    const res = await resolveDisputeRoute(
      request(`/api/admin/disputes/${DISPUTE_ID}/resolve`, {
        method: 'POST',
        token: TOKEN,
        body: { status: 'resolved', resolution: 'Refunded in full' },
      }),
      { params: { id: DISPUTE_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'disputes');
    const payload = updated?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ status: 'resolved', resolution: 'Refunded in full', resolved_by: AUTH_USER_ID });
    expect(typeof payload?.resolved_at).toBe('string');
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});
