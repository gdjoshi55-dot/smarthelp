import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase';

/**
 * Service-role client for Route Handlers only.
 *
 * This key bypasses RLS, so it must never be imported by a client component,
 * and never used before the caller has been authenticated and authorised.
 * The order in every route is always: authenticate -> authorise -> act.
 */
export function createServerClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase server credentials missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
}

/**
 * A request-scoped client that runs as the *caller*, not as the service role.
 * Used where a route needs RLS to keep doing the work for it — for example
 * listing a customer's own bookings without a hand-written ownership filter.
 */
export function createRequestClient(accessToken: string): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase browser credentials missing.');
  }

  return createClient<Database>(url, anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
