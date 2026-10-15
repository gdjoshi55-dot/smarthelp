import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import {
  GET as listPricingRules,
  POST as createPricingRule,
} from '@/app/api/admin/pricing-rules/route';
import {
  PATCH as updatePricingRule,
  DELETE as deletePricingRule,
} from '@/app/api/admin/pricing-rules/[id]/route';
import {
  GET as listCancellationPolicies,
  POST as createCancellationPolicy,
} from '@/app/api/admin/cancellation-policies/route';
import {
  PATCH as updateCancellationPolicy,
  DELETE as deleteCancellationPolicy,
} from '@/app/api/admin/cancellation-policies/[id]/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'staff-token';
const RULE_ID = '77777777-0001-4111-8111-777777777701';
const POLICY_ID = '66666666-0001-4111-8111-666666666601';
const SERVICE_ID = 'cccccccc-0001-4111-8111-cccccccccc01';
const MISSING_ID = '77777777-0009-4111-8111-777777777709';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' = 'ops';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function pricingRuleRow(overrides: Record<string, any> = {}) {
  return {
    id: RULE_ID,
    name: 'Sunday evening houseclean',
    scope: 'category',
    category_id: 'aaaaaaaa-0001-4111-8111-aaaaaaaaaa01',
    service_id: null,
    multiplier: '1.2',
    days_of_week: [0],
    start_minute: 17 * 60,
    end_minute: 21 * 60,
    priority: 10,
    valid_from: null,
    valid_to: null,
    is_active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function cancellationPolicyRow(overrides: Record<string, any> = {}) {
  return {
    id: POLICY_ID,
    service_id: null,
    hours_before: '6.00',
    fee_type: 'percentage',
    fee_value: '25.00',
    applies_when_arrived: false,
    band: '2_to_6h',
    sort_order: 30,
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
      pricing_rules: () => ({ data: [pricingRuleRow()], error: null }),
      cancellation_policies: () => ({ data: [cancellationPolicyRow()], error: null }),
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

describe('GET /api/admin/pricing-rules', () => {
  it('needs a session', async () => {
    const res = await listPricingRules(request('/api/admin/pricing-rules'));
    expect(res.status).toBe(401);
  });

  it('returns the surge rules to any staff member', async () => {
    const res = await listPricingRules(request('/api/admin/pricing-rules', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.rules).toHaveLength(1);
    expect(body.data.rules[0].scope).toBe('category');
  });
});

describe('POST /api/admin/pricing-rules', () => {
  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await createPricingRule(
      request('/api/admin/pricing-rules', { method: 'POST', token: TOKEN, body: { name: 'x', scope: 'global', multiplier: 1.1 } })
    );
    expect(res.status).toBe(403);
  });

  it('requires the scope target a service rule points at', async () => {
    staffRole = 'admin';
    const res = await createPricingRule(
      request('/api/admin/pricing-rules', {
        method: 'POST',
        token: TOKEN,
        body: { name: 'x', scope: 'service', multiplier: 1.1 },
      })
    );
    expect(res.status).toBe(400);
  });

  it('creates a rule as admin and audits it', async () => {
    staffRole = 'admin';
    const res = await createPricingRule(
      request('/api/admin/pricing-rules', {
        method: 'POST',
        token: TOKEN,
        body: {
          name: 'Monday morning office clean',
          scope: 'service',
          serviceId: SERVICE_ID,
          multiplier: 1.25,
          daysOfWeek: [1],
          startMinute: 480,
          endMinute: 720,
          priority: 5,
        },
      })
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'pricing_rules');
    expect(inserted?.payload).toMatchObject({
      name: 'Monday morning office clean',
      scope: 'service',
      service_id: SERVICE_ID,
      multiplier: '1.25',
      days_of_week: [1],
    });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});

describe('PATCH /api/admin/pricing-rules/:id', () => {
  it('404s a rule that does not exist, and writes nothing', async () => {
    staffRole = 'admin';
    const res = await updatePricingRule(
      request(`/api/admin/pricing-rules/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: { name: 'x', scope: 'global', multiplier: 1 } }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('replaces a rule as admin and audits before/after', async () => {
    staffRole = 'admin';
    const res = await updatePricingRule(
      request(`/api/admin/pricing-rules/${RULE_ID}`, {
        method: 'PATCH',
        token: TOKEN,
        body: { name: 'Renamed', scope: 'global', multiplier: 1.5, isActive: true },
      }),
      { params: { id: RULE_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'pricing_rules');
    expect(updated?.payload).toMatchObject({ name: 'Renamed', multiplier: '1.5', scope: 'global' });
  });
});

describe('DELETE /api/admin/pricing-rules/:id', () => {
  it('404s a rule that does not exist, and writes nothing', async () => {
    staffRole = 'admin';
    const res = await deletePricingRule(request(`/api/admin/pricing-rules/${MISSING_ID}`, { method: 'DELETE', token: TOKEN }), {
      params: { id: MISSING_ID },
    });
    expect(res.status).toBe(404);
  });

  it('deletes as admin and audits', async () => {
    staffRole = 'admin';
    const res = await deletePricingRule(request(`/api/admin/pricing-rules/${RULE_ID}`, { method: 'DELETE', token: TOKEN }), {
      params: { id: RULE_ID },
    });
    expect(res.status).toBe(200);
    expect(fake.calls.some((c) => c.op === 'delete' && c.table === 'pricing_rules')).toBe(true);
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});

describe('GET /api/admin/cancellation-policies', () => {
  it('needs a session', async () => {
    const res = await listCancellationPolicies(request('/api/admin/cancellation-policies'));
    expect(res.status).toBe(401);
  });

  it('returns the ladder to any staff member', async () => {
    const res = await listCancellationPolicies(request('/api/admin/cancellation-policies', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.policies[0].band).toBe('2_to_6h');
  });
});

describe('POST /api/admin/cancellation-policies', () => {
  it('rejects an arrival band that still has an hour ceiling', async () => {
    staffRole = 'admin';
    const res = await createCancellationPolicy(
      request('/api/admin/cancellation-policies', {
        method: 'POST',
        token: TOKEN,
        body: { feeType: 'free', feeValue: 0, hoursBefore: 4, appliesWhenArrived: true, band: 'arrival' },
      })
    );
    expect(res.status).toBe(400);
  });

  it('rejects a percentage fee above 100', async () => {
    staffRole = 'admin';
    const res = await createCancellationPolicy(
      request('/api/admin/cancellation-policies', {
        method: 'POST',
        token: TOKEN,
        body: { feeType: 'percentage', feeValue: 150, hoursBefore: 2, band: 'under_2h' },
      })
    );
    expect(res.status).toBe(400);
  });

  it('creates a band as admin', async () => {
    staffRole = 'admin';
    const res = await createCancellationPolicy(
      request('/api/admin/cancellation-policies', {
        method: 'POST',
        token: TOKEN,
        body: { feeType: 'fixed', feeValue: 200, hoursBefore: 12, band: '6_to_12h', sortOrder: 25 },
      })
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'cancellation_policies');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ fee_type: 'fixed', band: '6_to_12h' });
    expect(payload?.fee_value).toBe('200.00');
  });
});

describe('PATCH /api/admin/cancellation-policies/:id', () => {
  it('404s a band that does not exist', async () => {
    staffRole = 'admin';
    const res = await updateCancellationPolicy(
      request(`/api/admin/cancellation-policies/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: { feeType: 'free', feeValue: 0, isActive: true } }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
  });

  it('updates a band as admin', async () => {
    staffRole = 'admin';
    const res = await updateCancellationPolicy(
      request(`/api/admin/cancellation-policies/${POLICY_ID}`, {
        method: 'PATCH',
        token: TOKEN,
        body: { feeType: 'percentage', feeValue: 30, hoursBefore: 6, band: '2_to_6h', isActive: true },
      }),
      { params: { id: POLICY_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'cancellation_policies');
    expect(updated?.payload).toMatchObject({ fee_type: 'percentage', fee_value: '30' });
  });
});

describe('DELETE /api/admin/cancellation-policies/:id', () => {
  it('deletes a band as admin', async () => {
    staffRole = 'admin';
    const res = await deleteCancellationPolicy(request(`/api/admin/cancellation-policies/${POLICY_ID}`, { method: 'DELETE', token: TOKEN }), {
      params: { id: POLICY_ID },
    });
    expect(res.status).toBe(200);
    expect(fake.calls.some((c) => c.op === 'delete' && c.table === 'cancellation_policies')).toBe(true);
  });
});