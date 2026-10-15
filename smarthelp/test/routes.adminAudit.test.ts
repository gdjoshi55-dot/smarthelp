import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as listAudit } from '@/app/api/admin/audit/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = 'aaaaaaaa-0001-4111-8111-aaaaaaaaaa01';
const TOKEN = 'staff-token';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' | 'super_admin' = 'admin';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function auditRow(overrides: Record<string, any> = {}) {
  return {
    id: 'bbbbbbbb-0001-4111-8111-bbbbbbbbbb01',
    actor_profile_id: ACTOR_ID,
    actor_role: 'admin',
    action: 'refund.execute',
    entity_type: 'refunds',
    entity_id: 'cccccccc-0001-4111-8111-cccccccccc01',
    before_state: { status: 'requested' },
    after_state: { status: 'completed' },
    metadata: { note: 'duplicate charge' },
    ip_address: '203.0.113.7',
    user_agent: 'vitest',
    request_id: 'req-1',
    created_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function build() {
  return new FakeSupabase({
    profiles: () => ({
      data: [
        { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Admin One', phone: null, email: null },
        { id: ACTOR_ID, full_name: 'Ops Two' },
      ],
      error: null,
    }),
    audit_logs: () => ({ data: [auditRow()], error: null }),
  });
}

function request(url: string, init: { method?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers });
}

const json = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  staffRole = 'admin';
  fake = build();
});

describe('GET /api/admin/audit', () => {
  it('needs a session', async () => {
    const res = await listAudit(request('/api/admin/audit'));
    expect(res.status).toBe(401);
  });

  it('forbids an ops user — the trail is audit.read, admin only', async () => {
    staffRole = 'ops';
    const res = await listAudit(request('/api/admin/audit', { token: TOKEN }));
    expect(res.status).toBe(403);
  });

  it('returns the trail to an admin, with the actor name resolved', async () => {
    const res = await listAudit(request('/api/admin/audit', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.logs).toHaveLength(1);
    expect(body.data.logs[0].action).toBe('refund.execute');
    expect(body.data.logs[0].actorName).toBe('Ops Two');
    expect(body.data.logs[0].after).toEqual({ status: 'completed' });
    expect(body.data.total).toBe(1);
  });

  it('rejects a malformed date filter', async () => {
    const res = await listAudit(request('/api/admin/audit?from=not-a-date', { token: TOKEN }));
    expect(res.status).toBe(400);
  });
});
