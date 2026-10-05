import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/addressClient.ts`, the browser's transport for `/api/customers/me/addresses`.
 *
 * This file exists because of the gap it would have closed. The POST endpoint, its
 * RLS and `validateAddressInput` were built in Phase 1 and all of them are correct;
 * no component ever called them, so a signed-in customer with no saved address
 * reached checkout and could not finish it — 489 tests, none of which imported the
 * module that was missing. Every route test here builds its own `Request` with the
 * `Authorization` header already attached, so the server half was proven and the
 * browser half was not exercised at all. That is the same gap
 * `test/bookingClient.test.ts` was written for.
 *
 * So the assertions are about the transport and the payload: that the session
 * reaches the wire on both verbs, that the body carries only what
 * `validateAddressInput` reads — `customer_id` cannot be sent at all — that the
 * coordinates travel as a pair or not at all, and that a failure arrives with the
 * field names the form puts its messages under.
 *
 * There is no render test for `AddressForm`, and there cannot be one:
 * `vitest.config.ts` runs `environment: 'node'`, includes only files under
 * `test/`, and the project has no jsdom and no testing-library. Anything worth
 * asserting about this bug is therefore reachable from here by construction, which
 * is why the payload shaping lives in a module rather than in the component's
 * event handler.
 */

const ACCESS_TOKEN = 'access-token-for-arushmita';

const getSession = vi.fn();
let jsonResponse: unknown;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
    },
  },
}));

import {
  AddressApiError,
  createAddress,
  fetchAddresses,
  type CreateAddressInput,
} from '@/lib/addressClient';

/** A complete, valid payload, so each test can vary exactly one thing from it. */
const ADDRESS: CreateAddressInput = {
  line1: '12, 4th Cross',
  area: 'Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
};

/** The last `fetch` call, as the arguments the browser would have been given. */
function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('no fetch was made');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

/** The JSON body of the last call, parsed. */
function lastBody(): Record<string, unknown> {
  const init = lastCall().init;
  if (typeof init.body !== 'string') throw new Error('no body was sent');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** The body `err()` in lib/api.ts actually produces — flat, not nested. */
function errorBody(
  code: string,
  message: string,
  details?: Record<string, unknown>
): unknown {
  return {
    success: false,
    error: message,
    code,
    ...(details ? { details } : {}),
    requestId: 'server',
    timestamp: '2026-10-04T00:00:00.000Z',
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  getSession.mockReset();
  jsonResponse = { success: true, data: { addresses: [], defaultAddressId: null } };
  getSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN } } });
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => jsonResponse,
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the address client sends the caller's session", () => {
  it('attaches the bearer token on a read', async () => {
    await fetchAddresses();
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('attaches it on the create as well, which is the call that never existed', async () => {
    await createAddress(ADDRESS);
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('checks both verbs rather than assuming they share a code path', async () => {
    // One missed header is one feature broken, and the read is the one that was
    // already fixed — so the create is the one that has to be asserted on its own.
    await fetchAddresses();
    await createAddress(ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    }
  });

  it('reads the token per call, so a refreshed session is not a stale header', async () => {
    await createAddress(ADDRESS);
    getSession.mockResolvedValue({ data: { session: { access_token: 'refreshed-token' } } });
    await createAddress(ADDRESS);
    expect(headersOf(lastCall().init).authorization).toBe('Bearer refreshed-token');
  });

  it('sends no token when there is no session, and lets the route answer 401', async () => {
    // The honest failure: a header that is present but empty is a token the server
    // cannot verify, and a throw here would replace a correct 401 with an error no
    // page handles. Signed-out is a normal state on the pages this is called from.
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => errorBody('UNAUTHENTICATED', 'Please sign in to continue.'),
    });

    await expect(fetchAddresses()).rejects.toThrow('Please sign in to continue.');
    expect(headersOf(lastCall().init).authorization).toBeUndefined();

    const error = await createAddress(ADDRESS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressApiError);
    expect((error as AddressApiError).code).toBe('UNAUTHENTICATED');
    expect((error as AddressApiError).status).toBe(401);
  });

  it('keeps the JSON headers and the credentials, and posts to the collection', async () => {
    await createAddress(ADDRESS);
    const { url, init } = lastCall();
    expect(url).toBe('/api/customers/me/addresses');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(headersOf(init)['content-type']).toBe('application/json');
    expect(headersOf(init).accept).toBe('application/json');
  });

  it('carries the abort signal, so the picker can cancel on unmount', async () => {
    const controller = new AbortController();
    await fetchAddresses(controller.signal);
    expect(lastCall().init.signal).toBe(controller.signal);
  });

  it('reports an unreachable server as a network error, not as a failed save', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await createAddress(ADDRESS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressApiError);
    expect((error as AddressApiError).code).toBe('NETWORK_ERROR');
    expect((error as AddressApiError).status).toBe(0);
  });
});

describe('the create payload', () => {
  it('carries exactly the fields validateAddressInput reads', async () => {
    await createAddress({
      ...ADDRESS,
      label: 'Home',
      addressType: 'home',
      line2: '3rd floor',
      landmark: 'Opposite the metro station',
      accessNotes: 'Gate code 4821',
      isDefault: true,
      lat: 12.971199,
      lng: 77.640567,
    });

    // The allow-list *is* the assertion. `customer_id` is not on it and cannot be
    // sent, so ownership stays the server's to decide from the session; a body
    // built by spreading the input could carry it the day somebody adds the field.
    expect(Object.keys(lastBody()).sort()).toEqual([
      'access_notes',
      'address_type',
      'area',
      'city',
      'is_default',
      'label',
      'landmark',
      'lat',
      'line1',
      'line2',
      'lng',
      'pincode',
      'state',
    ]);
    expect(lastBody()).not.toHaveProperty('customer_id');
  });

  it('translates the three snake_case fields the server reads', async () => {
    // A browser form should not have to know that `validateAddressInput` reads
    // `access_notes` and `address_type`; this is the only place that does.
    await createAddress({ ...ADDRESS, addressType: 'work', accessNotes: 'Ring twice' });
    expect(lastBody()).toMatchObject({
      address_type: 'work',
      access_notes: 'Ring twice',
    });
    expect(lastBody()).not.toHaveProperty('accessNotes');
    expect(lastBody()).not.toHaveProperty('addressType');
  });

  it('sends only the five required fields when nothing optional was given', async () => {
    await createAddress(ADDRESS);
    expect(Object.keys(lastBody()).sort()).toEqual([
      'area',
      'city',
      'line1',
      'pincode',
      'state',
    ]);
  });

  it('omits a blank optional field rather than sending an empty string', async () => {
    // `optionalStr` treats '' and null the same, but a key that is absent is what
    // makes the wire body readable — and `is_default: false` would be a claim
    // about a row that does not exist yet.
    await createAddress({ ...ADDRESS, line2: '   ', accessNotes: '', isDefault: false });
    const body = lastBody();
    expect(body).not.toHaveProperty('line2');
    expect(body).not.toHaveProperty('access_notes');
    expect(body).not.toHaveProperty('is_default');
  });

  it('sends the required fields trimmed, which is what the row will hold', async () => {
    // `validateAddressInput` trims on the way in, so the padding is dropped
    // either way — but a body that carries it cannot be asserted on, and the
    // six-digit pincode check runs against the trimmed value.
    await createAddress({ ...ADDRESS, line1: '  12, 4th Cross  ', pincode: ' 560038 ' });
    expect(lastBody()).toMatchObject({ line1: '12, 4th Cross', pincode: '560038' });
  });

  it('sends the coordinates as a pair', async () => {
    await createAddress({ ...ADDRESS, lat: 12.971199, lng: 77.640567 });
    expect(lastBody()).toMatchObject({ lat: 12.971199, lng: 77.640567 });
  });

  it('drops a half-sent point rather than forwarding it', async () => {
    // `validateAddressInput` refuses one of the pair, and the server's own answer
    // for "no coordinates" is the centre of the locality it resolved — which it
    // reports back as `locationPrecision`. Dropping is the honest third option:
    // a pincode that matched an area is better than an error for a coordinate the
    // form never collected.
    await createAddress({ ...ADDRESS, lat: 12.971199 });
    const body = lastBody();
    expect(body).not.toHaveProperty('lat');
    expect(body).not.toHaveProperty('lng');

    await createAddress({ ...ADDRESS, lng: 77.640567 });
    expect(lastBody()).not.toHaveProperty('lng');
  });
});

describe('the answers come back usable', () => {
  it('unwraps the list and names the default', async () => {
    jsonResponse = {
      success: true,
      data: {
        addresses: [{ id: 'a1', label: 'Home', formatted: '12, 4th Cross', isDefault: true }],
        defaultAddressId: 'a1',
      },
    };
    const result = await fetchAddresses();
    expect(result.addresses).toHaveLength(1);
    expect(result.defaultAddressId).toBe('a1');
  });

  it('returns the created address and how precisely it could be placed', async () => {
    // `locationPrecision` is what lets the caller say "the centre of your area"
    // rather than pretending it has a pin.
    jsonResponse = {
      success: true,
      data: { address: { id: 'a1', label: 'Home' }, locationPrecision: 'locality_centre' },
    };
    const result = await createAddress(ADDRESS);
    expect(result.address.id).toBe('a1');
    expect(result.locationPrecision).toBe('locality_centre');
  });

  it('carries the field errors through, under the names the form uses', async () => {
    // This is the answer that makes the form's inputs fill themselves in. It is
    // keyed by wire field name, so `AddressForm` never needs a mapping.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () =>
        errorBody('VALIDATION_ERROR', 'We could not match "Jayanagar" to a service area.', {
          fields: { area: 'Not a locality we recognise' },
        }),
    });

    const error = (await createAddress(ADDRESS).catch((e: unknown) => e)) as AddressApiError;
    expect(error).toBeInstanceOf(AddressApiError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.status).toBe(400);
    expect(error.fields).toEqual({ area: 'Not a locality we recognise' });
  });

  it('reports a FORBIDDEN the way the route writes it', async () => {
    // `requireCustomer` refuses an account with no customer profile, and the
    // message is the honest one — so it must survive rather than become a
    // generic "could not save this address".
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () =>
        errorBody(
          'FORBIDDEN',
          'Addresses belong to a customer account. This account does not have one.'
        ),
    });

    const error = (await createAddress(ADDRESS).catch((e: unknown) => e)) as AddressApiError;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toContain('does not have one');
    expect(error.fields).toBeNull();
  });
});
