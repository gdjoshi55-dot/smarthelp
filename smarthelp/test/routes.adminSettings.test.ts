import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as getSettings, PUT as putSettings } from '@/app/api/admin/settings/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'staff-token';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' | 'super_admin' = 'admin';
let settingRows: { key: string; value: unknown }[] = [];

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function build() {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Admin One', phone: null, email: null },
        ],
        error: null,
      }),
      platform_settings: () => ({ data: settingRows, error: null }),
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
  staffRole = 'admin';
  settingRows = [
    { key: 'currency', value: 'INR' },
    { key: 'supportRefundLimit', value: 1500 },
  ];
  fake = build();
});

describe('GET /api/admin/settings', () => {
  it('needs a session', async () => {
    const res = await getSettings(request('/api/admin/settings'));
    expect(res.status).toBe(401);
  });

  it('returns every key, with the stored rows applied over the defaults', async () => {
    const res = await getSettings(request('/api/admin/settings', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.settings.currency).toBe('INR');
    expect(body.data.settings.supportRefundLimit).toBe(1500);
    // A key with no row falls back to its default rather than reading undefined.
    expect(typeof body.data.settings.taxRate).toBe('number');
  });
});

describe('PUT /api/admin/settings', () => {
  it('forbids an ops user — this is role.manage, admin only', async () => {
    staffRole = 'ops';
    const res = await putSettings(
      request('/api/admin/settings', { method: 'PUT', token: TOKEN, body: { supportRefundLimit: 2000 } })
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('rejects a body with no recognised keys', async () => {
    const res = await putSettings(
      request('/api/admin/settings', { method: 'PUT', token: TOKEN, body: { nonsense: 1 } })
    );
    expect(res.status).toBe(400);
  });

  it('rejects a negative number', async () => {
    const res = await putSettings(
      request('/api/admin/settings', { method: 'PUT', token: TOKEN, body: { supportRefundLimit: -5 } })
    );
    expect(res.status).toBe(400);
  });

  it('writes each key as its declared type and audits the batch', async () => {
    const res = await putSettings(
      request('/api/admin/settings', {
        method: 'PUT',
        token: TOKEN,
        body: { supportRefundLimit: 2000, currency: 'USD' },
      })
    );
    expect(res.status).toBe(200);

    const upserts = fake.calls.filter((c) => c.op === 'upsert' && c.table === 'platform_settings');
    const byKey = Object.fromEntries(
      upserts.map((c) => [(c.payload as any).key, (c.payload as any).value])
    );
    expect(byKey.supportRefundLimit).toBe(2000);
    expect(byKey.currency).toBe('USD');

    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});
