import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/bookingClient.ts`, the browser's only authenticated fetch wrapper.
 *
 * This file exists because of a bug it would have caught. Every route test in
 * this suite builds its own `Request` with an `Authorization` header, so all of
 * them passed while the real application sent none: `credentials: 'include'`
 * carries cookies, the Supabase browser client persists to `localStorage`, and
 * `requireAuth` reads only the header. A signed-in customer therefore saw
 * "Please sign in to continue." on their own bookings page — 489 tests, none of
 * which imported the module that was broken.
 *
 * So the assertions here are about the *transport*, not about pricing: that the
 * session reaches the wire, that it is the caller's own token, and that a
 * missing session produces the server's 401 rather than a client-side throw.
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
  BookingApiError,
  cancelBooking,
  createBooking,
  createIdempotencyKey,
  fetchBooking,
  fetchBookings,
  quoteBooking,
  rescheduleBooking,
} from '@/lib/bookingClient';

/** The last `fetch` call, as the arguments the browser would have been given. */
function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('no fetch was made');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
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
    timestamp: '2026-10-03T00:00:00.000Z',
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  getSession.mockReset();
  jsonResponse = { success: true, data: { bookings: [], total: 0, limit: 25, offset: 0 } };
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

describe('the booking client sends the caller\'s session', () => {
  it('attaches the bearer token on a read', async () => {
    await fetchBookings();
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('reads the token per call, so a refreshed session is not a stale header', async () => {
    await fetchBookings();
    getSession.mockResolvedValue({
      data: { session: { access_token: 'refreshed-token' } },
    });
    await fetchBookings();
    expect(headersOf(lastCall().init).authorization).toBe('Bearer refreshed-token');
  });

  it('attaches it on every authenticated verb, not just the one that was noticed', async () => {
    const id = 'b1b1b1b1-1111-4111-8111-111111111111';
    const item = {
      serviceId: '2f2d0b8e-6a3c-4a1e-9f5a-1c2b3d4e5f60',
      durationMinutes: 60,
      quantity: 1,
    };

    await fetchBookings();
    await fetchBooking(id);
    await quoteBooking({ items: [item] });
    await createBooking(
      {
        addressId: 'c3c3c3c3-3333-4333-8333-333333333333',
        bookingType: 'instant',
        items: [item],
      },
      createIdempotencyKey()
    );
    await cancelBooking(id, 'customer_request');
    await rescheduleBooking(id, '2026-10-04T09:00:00.000Z', 3);

    // One missed header is one feature broken, so every export is checked rather
    // than the list and the rest assumed to share a code path.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    }
  });

  it('sends no token when there is no session, and lets the route answer 401', async () => {
    // The honest failure: a header that is present but empty would be a token
    // the server cannot verify, and a throw here would replace a correct 401
    // with an error no page handles.
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => errorBody('UNAUTHENTICATED', 'Please sign in to continue.'),
    });

    await expect(fetchBookings()).rejects.toThrow('Please sign in to continue.');
    expect(headersOf(lastCall().init).authorization).toBeUndefined();

    const error = await fetchBookings().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookingApiError);
    expect((error as BookingApiError).code).toBe('UNAUTHENTICATED');
    expect((error as BookingApiError).status).toBe(401);
  });

  it('keeps the other headers, and lets a caller override the token', async () => {
    await createBooking(
      {
        addressId: 'c3c3c3c3-3333-4333-8333-333333333333',
        bookingType: 'instant',
        items: [
          {
            serviceId: '2f2d0b8e-6a3c-4a1e-9f5a-1c2b3d4e5f60',
            durationMinutes: 60,
            quantity: 1,
          },
        ],
      },
      'idem-key-1'
    );

    const { init } = lastCall();
    const headers = headersOf(init);
    expect(headers['idempotency-key']).toBe('idem-key-1');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
  });

  it('unwraps `data` and builds the filter query', async () => {
    jsonResponse = {
      success: true,
      data: { bookings: [{ id: 'x' }], total: 1, limit: 20, offset: 40 },
    };
    const result = await fetchBookings({ status: 'payment_pending', limit: 20, offset: 40 });
    expect(result.total).toBe(1);
    expect(lastCall().url).toBe(
      '/api/bookings?status=payment_pending&limit=20&offset=40'
    );
  });

  it('reports an unreachable server as a network error, not as a failed booking', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await fetchBookings().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookingApiError);
    expect((error as BookingApiError).code).toBe('NETWORK_ERROR');
    expect((error as BookingApiError).status).toBe(0);
  });

  it('carries PRICE_CHANGED through with its code and fields intact', async () => {
    // The three recoverable errors are the reason this module owns the transport:
    // a component that saw only a string would throw away the fresh breakdown.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () =>
        errorBody('PRICE_CHANGED', 'The price changed while you were deciding.', {
          total: 1499,
        }),
    });

    const error = (await fetchBookings().catch((e: unknown) => e)) as BookingApiError;
    expect(error.code).toBe('PRICE_CHANGED');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ total: 1499 });
  });
});

describe('the idempotency key', () => {
  it('is in the shape the ledger accepts', () => {
    const key = createIdempotencyKey();
    expect(key).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  });

  it('differs per attempt, because a reused key is a replay by definition', () => {
    const keys = new Set(Array.from({ length: 50 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it('still matches the charset without `crypto.randomUUID`', () => {
    const original = globalThis.crypto;
    // A non-secure origin has no `randomUUID`; the fallback must not emit a key
    // the ledger's validator rejects, or checkout 409s on its own key.
    vi.stubGlobal('crypto', { ...original, randomUUID: undefined });
    expect(createIdempotencyKey()).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
    vi.stubGlobal('crypto', original);
  });
});