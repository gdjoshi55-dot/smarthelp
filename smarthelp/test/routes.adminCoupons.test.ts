import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as listCoupons, POST as createCoupon } from '@/app/api/admin/coupons/route';
import { GET as getCoupon, PATCH as updateCoupon } from '@/app/api/admin/coupons/[id]/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'staff-token';
const COUPON_ID = 'dddddddd-0001-4111-8111-dddddddddd01';
const MISSING_ID = 'dddddddd-0009-4111-8111-dddddddddd09';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' = 'ops';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function couponRow(overrides: Record<string, any> = {}) {
  return {
    id: COUPON_ID,
    code: 'SAVE25',
    description: '25% off a first clean',
    discount_type: 'percentage',
    discount_value: '25',
    max_discount: '500.00',
    min_booking_amount: '1000.00',
    max_discount_pct_of_total: '100',
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_to: '2026-12-31T00:00:00.000Z',
    usage_limit: 100,
    usage_count: 3,
    per_user_limit: 1,
    applicable_services: [],
    applicable_cities: [],
    first_time_only: true,
    is_active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Ops One', phone: null, email: null },
        ],
        error: null,
      }),
      coupons: () => ({ data: [couponRow()], error: null }),
      coupon_usage: () => ({
        data: [
          {
            id: 'eeeeeeee-0001-4111-8111-eeeeeeeeee01',
            coupon_id: COUPON_ID,
            customer_id: 'ffffffff-0001-4111-8111-ffffffffff01',
            booking_id: 'ffffffff-0002-4111-8111-ffffffffff02',
            discount_amount: '250.00',
            used_at: '2026-06-05T10:00:00.000Z',
          },
        ],
        error: null,
      }),
      ...overrides,
    },
    {
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

describe('GET /api/admin/coupons', () => {
  it('needs a session', async () => {
    const res = await listCoupons(request('/api/admin/coupons'));
    expect(res.status).toBe(401);
  });

  it('returns the coupons to any staff member, parsed to numbers', async () => {
    const res = await listCoupons(request('/api/admin/coupons', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.coupons).toHaveLength(1);
    expect(body.data.coupons[0].code).toBe('SAVE25');
    expect(body.data.coupons[0].discountValue).toBe(25);
    expect(body.data.coupons[0].maxDiscount).toBe(500);
  });
});

describe('POST /api/admin/coupons', () => {
  const validBody = {
    code: 'save25',
    discountType: 'percentage',
    discountValue: 25,
    validFrom: '2026-06-01T00:00:00.000Z',
  };

  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await createCoupon(request('/api/admin/coupons', { method: 'POST', token: TOKEN, body: validBody }));
    expect(res.status).toBe(403);
  });

  it('rejects a percentage discount above 100', async () => {
    staffRole = 'admin';
    const res = await createCoupon(
      request('/api/admin/coupons', { method: 'POST', token: TOKEN, body: { ...validBody, discountValue: 150 } })
    );
    expect(res.status).toBe(400);
  });

  it('rejects a window that ends before it starts', async () => {
    staffRole = 'admin';
    const res = await createCoupon(
      request('/api/admin/coupons', {
        method: 'POST',
        token: TOKEN,
        body: { ...validBody, validFrom: '2026-06-02T00:00:00.000Z', validTo: '2026-06-01T00:00:00.000Z' },
      })
    );
    expect(res.status).toBe(400);
  });

  it('creates a coupon as admin, upper-casing the code and auditing it', async () => {
    staffRole = 'admin';
    const res = await createCoupon(
      request('/api/admin/coupons', {
        method: 'POST',
        token: TOKEN,
        body: { ...validBody, description: 'First-clean offer', maxDiscount: 500, usageLimit: 100 },
      })
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'coupons');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      code: 'SAVE25',
      discount_type: 'percentage',
      discount_value: '25',
      max_discount: '500.00',
      usage_limit: 100,
    });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });

  it('writes a fixed discount as paise-exact money', async () => {
    staffRole = 'admin';
    const res = await createCoupon(
      request('/api/admin/coupons', {
        method: 'POST',
        token: TOKEN,
        body: { code: 'FLAT200', discountType: 'fixed', discountValue: 200, validFrom: '2026-06-01T00:00:00.000Z' },
      })
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'coupons');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload?.discount_value).toBe('200.00');
  });
});

describe('GET /api/admin/coupons/:id', () => {
  it('needs a session', async () => {
    const res = await getCoupon(request(`/api/admin/coupons/${COUPON_ID}`), { params: { id: COUPON_ID } });
    expect(res.status).toBe(401);
  });

  it('404s a coupon that does not exist', async () => {
    const res = await getCoupon(request(`/api/admin/coupons/${MISSING_ID}`, { token: TOKEN }), {
      params: { id: MISSING_ID },
    });
    expect(res.status).toBe(404);
  });

  it('returns the coupon with its usage rows', async () => {
    const res = await getCoupon(request(`/api/admin/coupons/${COUPON_ID}`, { token: TOKEN }), {
      params: { id: COUPON_ID },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.coupon.code).toBe('SAVE25');
    expect(body.data.coupon.maxDiscountPctOfTotal).toBe(100);
    expect(body.data.coupon.usage).toHaveLength(1);
    expect(body.data.coupon.usage[0].discount_amount).toBe('250.00');
  });
});

describe('PATCH /api/admin/coupons/:id', () => {
  const validBody = {
    code: 'save25',
    discountType: 'percentage',
    discountValue: 30,
    validFrom: '2026-06-01T00:00:00.000Z',
  };

  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await updateCoupon(
      request(`/api/admin/coupons/${COUPON_ID}`, { method: 'PATCH', token: TOKEN, body: validBody }),
      { params: { id: COUPON_ID } }
    );
    expect(res.status).toBe(403);
  });

  it('404s a coupon that does not exist, and writes nothing', async () => {
    staffRole = 'admin';
    const res = await updateCoupon(
      request(`/api/admin/coupons/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: validBody }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('updates a coupon as admin and audits before/after', async () => {
    staffRole = 'admin';
    const res = await updateCoupon(
      request(`/api/admin/coupons/${COUPON_ID}`, {
        method: 'PATCH',
        token: TOKEN,
        body: { ...validBody, discountType: 'fixed', discountValue: 150, isActive: false },
      }),
      { params: { id: COUPON_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'coupons');
    const payload = updated?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ discount_type: 'fixed', discount_value: '150.00', is_active: false });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});
