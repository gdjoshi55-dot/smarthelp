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
