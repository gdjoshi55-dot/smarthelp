import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as listServices, POST as createService } from '@/app/api/admin/services/route';
import { GET as getService, PATCH as updateService } from '@/app/api/admin/services/[id]/route';
import { POST as createDuration } from '@/app/api/admin/services/[id]/durations/route';
import {
  PATCH as updateDuration,
  DELETE as deleteDuration,
} from '@/app/api/admin/services/[id]/durations/[durationId]/route';
import { POST as createArea } from '@/app/api/admin/services/[id]/areas/route';
import { PATCH as updateArea, DELETE as deleteArea } from '@/app/api/admin/services/[id]/areas/[areaId]/route';
import { GET as listLocalities } from '@/app/api/admin/localities/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'staff-token';
const SERVICE_ID = 'cccccccc-0001-4111-8111-cccccccccc01';
const CATEGORY_ID = 'aaaaaaaa-0001-4111-8111-aaaaaaaaaa01';
const DURATION_ID = 'bbbbbbbb-0001-4111-8111-bbbbbbbbbb01';
const AREA_ID = 'bbbbbbbb-0002-4111-8111-bbbbbbbbbb02';
const LOCALITY_ID = 'bbbbbbbb-0003-4111-8111-bbbbbbbbbb03';
const CITY_ID = 'bbbbbbbb-0004-4111-8111-bbbbbbbbbb04';
const MISSING_ID = 'cccccccc-0009-4111-8111-cccccccccc09';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' = 'ops';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function serviceRow(overrides: Record<string, any> = {}) {
  return {
    id: SERVICE_ID,
    category_id: CATEGORY_ID,
    name: 'Deep house clean',
    slug: 'deep-house-clean',
    short_description: 'Top-to-bottom clean',
    description: null,
    image_url: null,
    base_price: 1499,
    pricing_type: 'hourly',
    unit_label: null,
    unit_price: null,
    min_duration_min: 60,
    max_duration_min: 480,
    prep_minutes: 15,
    max_active_jobs: 3,
    materials_included: false,
    materials_note: null,
    requires_photo_proof: false,
    sort_order: 0,
    is_active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function durationRow(overrides: Record<string, any> = {}) {
  return {
    id: DURATION_ID,
    service_id: SERVICE_ID,
    minutes: 120,
    price: '2999.00',
    price_multiplier: null,
    is_active: true,
    ...overrides,
  };
}

function areaRow(overrides: Record<string, any> = {}) {
  return {
    id: AREA_ID,
    locality_id: LOCALITY_ID,
    service_id: SERVICE_ID,
    lead_minutes: 60,
    slot_capacity: 8,
    is_active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Admin One', phone: null, email: null },
        ],
        error: null,
      }),
      // A slug-uniqueness probe (`.eq('slug', …)`) must miss, or `uniqueSlug`
      // would walk its whole suffix ladder. Everything else is the fixture row.
      services: (call: { eqFilters: [string, unknown][] }) =>
        call.eqFilters.some(([col]) => col === 'slug') ? { data: [], error: null } : { data: [serviceRow()], error: null },
      service_categories: () => ({ data: [{ id: CATEGORY_ID, name: 'Home Cleaning' }], error: null }),
      service_durations: () => ({ data: [durationRow()], error: null }),
      service_areas: () => ({ data: [areaRow()], error: null }),
      localities: () => ({ data: [{ id: LOCALITY_ID, name: 'Indiranagar', city_id: CITY_ID, is_active: true }], error: null }),
      cities: () => ({ data: [{ id: CITY_ID, name: 'Bengaluru' }], error: null }),
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

describe('GET /api/admin/services', () => {
  it('needs a session', async () => {
    const res = await listServices(request('/api/admin/services'));
    expect(res.status).toBe(401);
  });

  it('returns the catalogue to any staff member, with category names', async () => {
    const res = await listServices(request('/api/admin/services', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.services).toHaveLength(1);
    expect(body.data.services[0].name).toBe('Deep house clean');
    expect(body.data.services[0].categoryName).toBe('Home Cleaning');
    expect(body.data.services[0].basePrice).toBe(1499);
  });
});

describe('POST /api/admin/services', () => {
  const validBody = { categoryId: CATEGORY_ID, name: 'Deep house clean', basePrice: 1499, pricingType: 'hourly' };

  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await createService(request('/api/admin/services', { method: 'POST', token: TOKEN, body: validBody }));
    expect(res.status).toBe(403);
  });

  it('rejects a per-unit service with no unit label or price', async () => {
    staffRole = 'admin';
    const res = await createService(
      request('/api/admin/services', {
        method: 'POST',
        token: TOKEN,
        body: { ...validBody, pricingType: 'per_unit' },
      })
    );
    expect(res.status).toBe(400);
  });

  it('creates a service as admin, deriving the slug and auditing it', async () => {
    staffRole = 'admin';
    const res = await createService(
      request('/api/admin/services', {
        method: 'POST',
        token: TOKEN,
        body: { ...validBody, durations: [{ minutes: 60, price: 999 }] },
      })
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'services');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ name: 'Deep house clean', slug: 'deep-house-clean', category_id: CATEGORY_ID, base_price: 1499 });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);

    const durationInsert = fake.calls.find((c) => c.op === 'insert' && c.table === 'service_durations');
    const durations = durationInsert?.payload as Record<string, unknown>[] | undefined;
    expect(durations).toHaveLength(1);
    expect(durations?.[0]).toMatchObject({ minutes: 60, price: '999.00' });
  });
});

describe('GET /api/admin/services/:id', () => {
  it('needs a session', async () => {
    const res = await getService(request(`/api/admin/services/${SERVICE_ID}`), { params: { id: SERVICE_ID } });
    expect(res.status).toBe(401);
  });

  it('404s a service that does not exist', async () => {
    const res = await getService(request(`/api/admin/services/${MISSING_ID}`, { token: TOKEN }), {
      params: { id: MISSING_ID },
    });
    expect(res.status).toBe(404);
  });

  it('returns the service with durations and locality-named areas', async () => {
    const res = await getService(request(`/api/admin/services/${SERVICE_ID}`, { token: TOKEN }), {
      params: { id: SERVICE_ID },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.service.service.name).toBe('Deep house clean');
    expect(body.data.service.categoryName).toBe('Home Cleaning');
    expect(body.data.service.durations).toHaveLength(1);
    expect(body.data.service.areas[0].localityName).toBe('Indiranagar');
  });
});

describe('PATCH /api/admin/services/:id', () => {
  const validBody = { categoryId: CATEGORY_ID, name: 'Renamed clean', basePrice: 1799, pricingType: 'hourly' };

  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await updateService(
      request(`/api/admin/services/${SERVICE_ID}`, { method: 'PATCH', token: TOKEN, body: validBody }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(403);
  });

  it('404s a service that does not exist, and writes nothing', async () => {
    staffRole = 'admin';
    const res = await updateService(
      request(`/api/admin/services/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: validBody }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('renames a service as admin, re-deriving the slug and auditing', async () => {
    staffRole = 'admin';
    const res = await updateService(
      request(`/api/admin/services/${SERVICE_ID}`, { method: 'PATCH', token: TOKEN, body: validBody }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'services');
    const payload = updated?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ name: 'Renamed clean', slug: 'renamed-clean', base_price: 1799 });
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});

describe('POST /api/admin/services/:id/durations', () => {
  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await createDuration(
      request(`/api/admin/services/${SERVICE_ID}/durations`, { method: 'POST', token: TOKEN, body: { minutes: 90, price: 799 } }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(403);
  });

  it('rejects a rung with neither a price nor a multiplier', async () => {
    staffRole = 'admin';
    const res = await createDuration(
      request(`/api/admin/services/${SERVICE_ID}/durations`, { method: 'POST', token: TOKEN, body: { minutes: 90 } }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(400);
  });

  it('404s a service that does not exist', async () => {
    staffRole = 'admin';
    const res = await createDuration(
      request(`/api/admin/services/${MISSING_ID}/durations`, { method: 'POST', token: TOKEN, body: { minutes: 90, price: 799 } }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
  });

  it('adds a rung as admin', async () => {
    staffRole = 'admin';
    const res = await createDuration(
      request(`/api/admin/services/${SERVICE_ID}/durations`, { method: 'POST', token: TOKEN, body: { minutes: 90, price: 799 } }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'service_durations');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ service_id: SERVICE_ID, minutes: 90, price: '799.00' });
  });
});

describe('PATCH/DELETE /api/admin/services/:id/durations/:durationId', () => {
  it('404s a missing rung on PATCH', async () => {
    staffRole = 'admin';
    const res = await updateDuration(
      request(`/api/admin/services/${SERVICE_ID}/durations/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: { minutes: 90 } }),
      { params: { id: SERVICE_ID, durationId: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('updates a rung as admin', async () => {
    staffRole = 'admin';
    const res = await updateDuration(
      request(`/api/admin/services/${SERVICE_ID}/durations/${DURATION_ID}`, { method: 'PATCH', token: TOKEN, body: { minutes: 180, price: 4999 } }),
      { params: { id: SERVICE_ID, durationId: DURATION_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'service_durations');
    const payload = updated?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ minutes: 180, price: '4999.00' });
  });

  it('deletes a rung as admin', async () => {
    staffRole = 'admin';
    const res = await deleteDuration(
      request(`/api/admin/services/${SERVICE_ID}/durations/${DURATION_ID}`, { method: 'DELETE', token: TOKEN }),
      { params: { id: SERVICE_ID, durationId: DURATION_ID } }
    );
    expect(res.status).toBe(200);
    expect(fake.calls.some((c) => c.op === 'delete' && c.table === 'service_durations')).toBe(true);
  });
});

describe('POST /api/admin/services/:id/areas', () => {
  it('forbids a support agent', async () => {
    staffRole = 'support';
    const res = await createArea(
      request(`/api/admin/services/${SERVICE_ID}/areas`, { method: 'POST', token: TOKEN, body: { localityId: LOCALITY_ID } }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(403);
  });

  it('404s a locality that does not exist', async () => {
    staffRole = 'admin';
    const res = await createArea(
      request(`/api/admin/services/${SERVICE_ID}/areas`, { method: 'POST', token: TOKEN, body: { localityId: MISSING_ID } }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(404);
  });

  it('adds an area as admin', async () => {
    staffRole = 'admin';
    const res = await createArea(
      request(`/api/admin/services/${SERVICE_ID}/areas`, {
        method: 'POST',
        token: TOKEN,
        body: { localityId: LOCALITY_ID, leadMinutes: 45, slotCapacity: 6 },
      }),
      { params: { id: SERVICE_ID } }
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'service_areas');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ service_id: SERVICE_ID, locality_id: LOCALITY_ID, lead_minutes: 45, slot_capacity: 6 });
  });
});

describe('PATCH/DELETE /api/admin/services/:id/areas/:areaId', () => {
  it('404s a missing area on PATCH', async () => {
    staffRole = 'admin';
    const res = await updateArea(
      request(`/api/admin/services/${SERVICE_ID}/areas/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: { isActive: false } }),
      { params: { id: SERVICE_ID, areaId: MISSING_ID } }
    );
    expect(res.status).toBe(404);
  });

  it('updates an area as admin', async () => {
    staffRole = 'admin';
    const res = await updateArea(
      request(`/api/admin/services/${SERVICE_ID}/areas/${AREA_ID}`, { method: 'PATCH', token: TOKEN, body: { slotCapacity: 4, isActive: false } }),
      { params: { id: SERVICE_ID, areaId: AREA_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'service_areas');
    const payload = updated?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ slot_capacity: 4, is_active: false });
  });

  it('deletes an area as admin', async () => {
    staffRole = 'admin';
    const res = await deleteArea(
      request(`/api/admin/services/${SERVICE_ID}/areas/${AREA_ID}`, { method: 'DELETE', token: TOKEN }),
      { params: { id: SERVICE_ID, areaId: AREA_ID } }
    );
    expect(res.status).toBe(200);
    expect(fake.calls.some((c) => c.op === 'delete' && c.table === 'service_areas')).toBe(true);
  });
});

describe('GET /api/admin/localities', () => {
  it('needs a session', async () => {
    const res = await listLocalities(request('/api/admin/localities'));
    expect(res.status).toBe(401);
  });

  it('returns localities with their city name', async () => {
    const res = await listLocalities(request('/api/admin/localities', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.localities[0]).toMatchObject({ id: LOCALITY_ID, name: 'Indiranagar', city: 'Bengaluru' });
  });
});
