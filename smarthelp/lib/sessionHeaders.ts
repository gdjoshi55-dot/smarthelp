import { supabase } from './supabase';

/**
 * The `Authorization` header for a browser-initiated API call.
 *
 * ## Why this exists
 *
 * `requireAuth` reads the `Authorization` header and nothing else. The Supabase
 * browser client persists its session to `localStorage`, not to a cookie, so
 * `credentials: 'include'` contributes nothing a route can authenticate — it is
 * easy to write that and believe the call is authenticated, because the page is
 * visibly signed in. The result is a 401 whose message ("Please sign in to
 * continue.") is wrong in exactly the situation where the user can least believe
 * it.
 *
 * Both callers here got that wrong independently before this module existed, and
 * both failed silently: the bookings list showed an error, and the checkout
 * address picker showed no saved addresses. So the decision lives in one place,
 * and a new client inherits it by importing rather than by remembering.
 *
 * ## Why a missing token is not an error
 *
 * A signed-out visitor is a normal state on a public page, and each caller
 * already has a correct response for it (the route's own 401, or rendering
 * nothing). Returning no header keeps that handling where it belongs; throwing
 * here would replace a considered response with an exception no page expects.
 *
 * ## Cost
 *
 * `getSession()` is one localStorage read on the happy path, and it refreshes an
 * expired token in place, so the header is never a stale one.
 */
export async function authorizationHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { authorization: `Bearer ${token}` } : {};
}