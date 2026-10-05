import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as listAddresses, POST as createAddress } from '@/app/api/customers/me/addresses/route';
import {
  PUT as updateAddress,
  DELETE as deleteAddress,
} from '@/app/api/customers/me/addresses/[id]/route';
import { POST as setDefaultAddress } from '@/app/api/customers/me/addresses/[id]/default/route';

/**
 * The customer's saved places (§5.2, §20.1).
 *
 * An address is the most private row in the product, so the tests here are as
 * much about refusal as about saving: who may read a row, who may write one,
 * and what the server does with the fields a client could not be trusted to
 * decide on its own — the locality, the precision of the pin, and which row is
 * the default.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'test-token';
const CUSTOMER_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const ADDRESS_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const OTHER_ADDRESS_ID = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';
const LOCALITY_ID = '5c1a0f0e-1111-4111-8111-aaaaaaaaaaaa';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const LOCALITY = {
  id: LOCALITY_ID,
  city_id: 'city-blr',
  name: 'Indiranagar',
  lat: 12.9784,
  lng: 77.6408,
  radius_km: 5,
  is_active: true,
};

const OTHER_LOCALITY = {
  id: '5c1a0f0e-3333-4333-8333-cccccccccccc',
  city_id: 'city-blr',
  name: 'HSR Layout',
  lat: 12.9116,
  lng: 77.6389,
  radius_km: 4,
  is_active: true,
};

function address(overrides: Record<string, unknown> = {}) {
  return {
    id: ADDRESS_ID,
    customer_id: CUSTOMER_ID,
    locality_id: LOCALITY_ID,
    label: 'Home',
    address_type: 'home',
    line1: '12, 4th Cross',
    line2: 'Shanti Residency',
    area: 'Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
    lat: 12.9784,
    lng: 77.6408,
    landmark: null,
    access_notes: 'Gate code 4821',
    location_precision: 'exact',
    is_default: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const PROFILE = {
  id: USER_ID,
  role: 'customer',
  status: 'active',
  full_name: 'Asha Rao',
  phone: '+919876543210',
  email: null,
};

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({ data: PROFILE, error: null }),
      cities: () => ({
        data: [
          {
            id: 'city-blr',
            name: 'Bengaluru',
            state: 'Karnataka',
            time_zone: 'Asia/Kolkata',
            is_active: true,
          },
        ],
        error: null,
      }),
      localities: () => ({ data: [LOCALITY, OTHER_LOCALITY], error: null }),
      // Indiranagar is served, HSR Layout exists but nobody covers it yet.
      service_areas: () => ({
        data: [{ locality_id: LOCALITY_ID, is_active: true }],
        error: null,
      }),
      customers: () => ({ data: { id: CUSTOMER_ID }, error: null }),
      addresses: () => ({ data: [address()], error: null }),
      ...overrides,
    },
    { set_default_address: () => ({ data: ADDRESS_ID, error: null }), write_audit: () => ({ data: null, error: null }) }
  );
}

function request(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
    ...(init.token ? { headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${init.token}` } } : {}),
  });
}

const body = async (res: Response) => (await res.json()) as any;

const validBody = {
  label: 'Home',
  address_type: 'home',
  line1: '12, 4th Cross',
  line2: 'Shanti Residency',
  area: 'Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
  lat: 12.9784,
  lng: 77.6408,
  access_notes: 'Gate code 4821',
};

beforeEach(() => {
  fake = build();
});

// ── Reading ─────────────────────────────────────────────────

describe('GET /api/customers/me/addresses', () => {
  it('needs a session', async () => {
    const res = await listAddresses(request('/api/customers/me/addresses'));
    const json = await body(res);
    expect(res.status).toBe(401);
    expect(json.code).toBe('UNAUTHENTICATED');
  });

  it('returns only the caller\'s rows, with the coverage badge', async () => {
    const res = await listAddresses(request('/api/customers/me/addresses', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.addresses).toHaveLength(1);
    expect(json.data.addresses[0]).toMatchObject({
      label: 'Home',
      coverage: 'covered',
      locality: { id: LOCALITY_ID, name: 'Indiranagar' },
      formatted: '12, 4th Cross, Shanti Residency, Indiranagar, Bengaluru, 560038',
      isDefault: true,
    });
    expect(json.data.defaultAddressId).toBe(ADDRESS_ID);
  });

  it('badges an address whose locality exists but nobody serves yet', async () => {
    fake = build({ addresses: () => ({ data: [address({ locality_id: OTHER_LOCALITY.id })], error: null }) });
    const json = await body(
      await listAddresses(request('/api/customers/me/addresses', { token: TOKEN }))
    );
    // A resolvable locality is not the same thing as a covered one: the badge is
    // about service_areas, not about the geography table.
    expect(json.data.addresses[0].locality).toMatchObject({ name: 'HSR Layout' });
    expect(json.data.addresses[0].coverage).toBe('not_yet_available');
  });

  it('badges an address whose locality row is gone', async () => {
    fake = build({ addresses: () => ({ data: [address({ locality_id: null })], error: null }) });
    const json = await body(
      await listAddresses(request('/api/customers/me/addresses', { token: TOKEN }))
    );
    expect(json.data.addresses[0].coverage).toBe('not_yet_available');
    expect(json.data.addresses[0].locality).toBeNull();
  });

  it('refuses an account with no customer profile', async () => {
    fake = build({ customers: () => ({ data: null, error: null }) });
    const res = await listAddresses(request('/api/customers/me/addresses', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(403);
    expect(json.code).toBe('FORBIDDEN');
  });
});

// ── Creating ────────────────────────────────────────────────

describe('POST /api/customers/me/addresses', () => {
  it('saves an address, resolves its locality and marks the first one default', async () => {
    fake = build({ addresses: () => ({ data: [], error: null }) });
    const res = await createAddress(
      request('/api/customers/me/addresses', { method: 'POST', body: validBody, token: TOKEN })
    );
    const json = await body(res);
    expect(res.status).toBe(201);

    const insert = fake.writesTo('addresses')[0];
    expect(insert?.payload).toMatchObject({
      customer_id: CUSTOMER_ID,
      area: 'Indiranagar',
      locality_id: LOCALITY_ID,
      location_precision: 'exact',
      is_default: true,
    });
    // A first address is born default, so there is nothing to switch and no RPC
    // to call: the flag and the uniqueness guarantee are satisfied by the insert.
    expect(fake.rpcCalls.map((c) => c.fn)).not.toContain('set_default_address');
    expect(json.data.locationPrecision).toBe('exact');
    expect(json.data.address.coverage).toBe('covered');
  });

  it('does not steal the default when a later address is saved', async () => {
    const res = await createAddress(
      request('/api/customers/me/addresses', { method: 'POST', body: validBody, token: TOKEN })
    );
    const insert = fake.writesTo('addresses')[0];
    expect(insert?.payload).toMatchObject({ is_default: false });
    expect(fake.rpcCalls.map((c) => c.fn)).not.toContain('set_default_address');
    expect(res.status).toBe(201);
  });

  it('switches the default after the row exists, never during the insert', async () => {
    const res = await createAddress(
      request('/api/customers/me/addresses', {
        method: 'POST',
        body: { ...validBody, is_default: true },
        token: TOKEN,
      })
    );
    const json = await body(res);
    // The row has to be inserted without the flag: a second `is_default: true`
    // would break the unique partial index before the RPC ever ran.
    expect(fake.writesTo('addresses')[0]?.payload).toMatchObject({ is_default: false });
    const calls = fake.rpcCalls.filter((c) => c.fn === 'set_default_address');
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_address_id).toBe(json.data.address.id);
    expect(res.status).toBe(201);
  });

  it('fills the pin from the locality centre when no coordinates were given', async () => {
    fake = build({ addresses: () => ({ data: [], error: null }) });
    const { lat, lng, ...withoutPin } = validBody;
    const json = await body(
      await createAddress(
        request('/api/customers/me/addresses', { method: 'POST', body: withoutPin, token: TOKEN })
      )
    );
    const insert = fake.writesTo('addresses')[0];
    expect(insert?.payload).toMatchObject({
      lat: LOCALITY.lat,
      lng: LOCALITY.lng,
      location_precision: 'locality_centre',
    });
    // The client has to be able to warn that the pin is approximate.
    expect(json.data.locationPrecision).toBe('locality_centre');
  });

  it('refuses an area it cannot place, rather than inventing a point', async () => {
    // No coordinates either: this is the person who declined the location
    // prompt and typed something we have never heard of.
    const { lat, lng, ...noPin } = validBody;
    const res = await createAddress(
      request('/api/customers/me/addresses', {
        method: 'POST',
        body: { ...noPin, area: 'Atlantis' },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.details.fields.area).toMatch(/not a locality/i);
    expect(fake.writesTo('addresses')).toHaveLength(0);
  });

  it('refuses half a coordinate pair', async () => {
    const res = await createAddress(
      request('/api/customers/me/addresses', {
        method: 'POST',
        body: { ...validBody, lng: undefined },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.details.fields.lng).toBeTruthy();
  });

  it('refuses a four-digit pincode', async () => {
    const res = await createAddress(
      request('/api/customers/me/addresses', {
        method: 'POST',
        body: { ...validBody, pincode: '5600' },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
  });

  it('rejects an address type it does not have', async () => {
    const res = await createAddress(
      request('/api/customers/me/addresses', {
        method: 'POST',
        body: { ...validBody, address_type: 'spaceship' },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.details.fields.address_type).toBeTruthy();
  });
});

// ── Editing ─────────────────────────────────────────────────

describe('PUT /api/customers/me/addresses/[id]', () => {
  it('moves the address when the new area is one we know', async () => {
    const res = await updateAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, {
        method: 'PUT',
        body: { area: 'HSR Layout' },
        token: TOKEN,
      }),
      { params: { id: ADDRESS_ID } }
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(fake.writesTo('addresses')[0]?.payload).toMatchObject({
      area: 'HSR Layout',
      locality_id: OTHER_LOCALITY.id,
      // The pin followed the text, and the precision says so — the old pin
      // belonged to Indiranagar and claiming it was exact would be a lie.
      lat: OTHER_LOCALITY.lat,
      lng: OTHER_LOCALITY.lng,
      location_precision: 'locality_centre',
    });
    expect(json.data.address.locality).toMatchObject({ name: 'HSR Layout' });
  });

  it('keeps an exact pin when the patch brings its own', async () => {
    await updateAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, {
        method: 'PUT',
        body: { area: 'HSR Layout', lat: 12.9101, lng: 77.6401 },
        token: TOKEN,
      }),
      { params: { id: ADDRESS_ID } }
    );
    expect(fake.writesTo('addresses')[0]?.payload).toMatchObject({
      locality_id: OTHER_LOCALITY.id,
      lat: 12.9101,
      location_precision: 'exact',
    });
  });

  it('refuses an edit that moves the address somewhere it cannot place', async () => {
    // The old locality is not carried across: an address the server cannot place
    // is one it cannot say anything honest about.
    const res = await updateAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, {
        method: 'PUT',
        body: { area: 'Indiranaagr' },
        token: TOKEN,
      }),
      { params: { id: ADDRESS_ID } }
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.details.fields.area).toMatch(/not a locality/i);
    expect(fake.writesTo('addresses')).toHaveLength(0);
  });

  it('keeps an exact pin when only the flat number is edited', async () => {
    await updateAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, {
        method: 'PUT',
        body: { line1: '14, 4th Cross' },
        token: TOKEN,
      }),
      { params: { id: ADDRESS_ID } }
    );
    const update = fake.writesTo('addresses')[0];
    expect(update?.payload).toEqual({ line1: '14, 4th Cross' });
  });

  it('refuses to unset the default through an edit', async () => {
    const res = await updateAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, {
        method: 'PUT',
        body: { is_default: false },
        token: TOKEN,
      }),
      { params: { id: ADDRESS_ID } }
    );
    const json = await body(res);
    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
  });

  it('refuses an empty patch', async () => {
    const res = await updateAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, { method: 'PUT', body: {}, token: TOKEN }),
      { params: { id: ADDRESS_ID } }
    );
    expect(res.status).toBe(400);
  });

  it('404s an address belonging to somebody else', async () => {
    fake = build({ addresses: () => ({ data: [], error: null }) });
    const res = await updateAddress(
      request(`/api/customers/me/addresses/${OTHER_ADDRESS_ID}`, {
        method: 'PUT',
        body: { line1: 'Somewhere else' },
        token: TOKEN,
      }),
      { params: { id: OTHER_ADDRESS_ID } }
    );
    const json = await body(res);
    expect(res.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
    expect(fake.writesTo('addresses')).toHaveLength(0);
  });
});

// ── Deleting ────────────────────────────────────────────────

describe('DELETE /api/customers/me/addresses/[id]', () => {
  it('deletes the row, filtered by the owner', async () => {
    const res = await deleteAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, { method: 'DELETE', token: TOKEN }),
      { params: { id: ADDRESS_ID } }
    );
    expect(res.status).toBe(200);
    const del = fake.writesTo('addresses')[0];
    expect(del?.op).toBe('delete');
    expect(del?.filters).toContainEqual(['customer_id', CUSTOMER_ID]);
  });

  it('promotes the oldest survivor when the default is deleted', async () => {
    // The read that finds the survivor filters only on the customer, so the
    // fixture answers it with a different row than the one being deleted.
    fake = build({
      addresses: (call: any) =>
        call.filters.some(([column]: [string]) => column === 'id')
          ? { data: [address()], error: null }
          : { data: [{ id: OTHER_ADDRESS_ID, customer_id: CUSTOMER_ID }], error: null },
    });
    await deleteAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}`, { method: 'DELETE', token: TOKEN }),
      { params: { id: ADDRESS_ID } }
    );
    const promoted = fake.rpcCalls.find((c) => c.fn === 'set_default_address');
    expect(promoted?.args.p_address_id).toBe(OTHER_ADDRESS_ID);
  });

  it('404s an address that is not there', async () => {
    fake = build({ addresses: () => ({ data: [], error: null }) });
    const res = await deleteAddress(
      request(`/api/customers/me/addresses/${OTHER_ADDRESS_ID}`, { method: 'DELETE', token: TOKEN }),
      { params: { id: OTHER_ADDRESS_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.writesTo('addresses')).toHaveLength(0);
  });
});

// ── Setting the default ─────────────────────────────────────

describe('POST /api/customers/me/addresses/[id]/default', () => {
  it('switches the default through the RPC, in one call', async () => {
    const res = await setDefaultAddress(
      request(`/api/customers/me/addresses/${ADDRESS_ID}/default`, { method: 'POST', token: TOKEN }),
      { params: { id: ADDRESS_ID } }
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.address.isDefault).toBe(true);
    const calls = fake.rpcCalls.filter((c) => c.fn === 'set_default_address');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      p_customer_id: CUSTOMER_ID,
      p_address_id: ADDRESS_ID,
    });
    // No direct write: the whole switch is the RPC's transaction.
    expect(fake.writesTo('addresses')).toHaveLength(0);
  });

  it('404s before calling the RPC when the address is not the caller\'s', async () => {
    fake = build({ addresses: () => ({ data: [], error: null }) });
    const res = await setDefaultAddress(
      request(`/api/customers/me/addresses/${OTHER_ADDRESS_ID}/default`, {
        method: 'POST',
        token: TOKEN,
      }),
      { params: { id: OTHER_ADDRESS_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});
