import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/sessionHeaders.ts` — how a browser call proves who it is.
 *
 * Both of its callers shipped without it and both failed the same way: the
 * bookings list answered a signed-in customer with "Please sign in to continue.",
 * and the checkout address picker quietly showed no saved addresses. Neither was
 * caught by a route test, because a route test builds its own `Request` with the
 * header already attached. This asserts the header itself, which is the only
 * place the whole class of bug can be caught.
 */

const getSession = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: () => getSession() } },
}));

import { authorizationHeader } from '@/lib/sessionHeaders';

beforeEach(() => {
  getSession.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the browser authorization header', () => {
  it('is the session\'s own access token, as a bearer', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    expect(await authorizationHeader()).toEqual({ authorization: 'Bearer tok-abc' });
  });

  it('is omitted, not empty, when nobody is signed in', async () => {
    // An empty string would reach `requireAuth` as a header present but
    // unverifiable, which is a different failure with a different message.
    getSession.mockResolvedValue({ data: { session: null } });
    expect(await authorizationHeader()).toEqual({});
  });

  it('is omitted when the session exists without a token', async () => {
    getSession.mockResolvedValue({ data: { session: {} } });
    expect(await authorizationHeader()).toEqual({});
  });

  it('asks Supabase on every call rather than caching', async () => {
    // `autoRefreshToken` rotates the access token in place; a cached header would
    // keep sending the one that just expired, and the symptom would be a session
    // that signs the user out at random intervals.
    getSession.mockResolvedValue({ data: { session: { access_token: 'first' } } });
    expect((await authorizationHeader()).authorization).toBe('Bearer first');

    getSession.mockResolvedValue({ data: { session: { access_token: 'second' } } });
    expect((await authorizationHeader()).authorization).toBe('Bearer second');

    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('never invents a token when Supabase reports one alongside an error', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'network' },
    });
    expect(await authorizationHeader()).toEqual({});
  });
});