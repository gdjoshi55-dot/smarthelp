import { ApiHttpError } from './api';
import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Favourite, FavouriteTargetType } from './supabase';

/**
 * The customer's favourites, server half (§24.10, §25.4).
 *
 * A favourite is polymorphic — a service or a professional — so a list read
 * resolves each `target_id` against the right table and returns a row that
 * already knows its own name. The two audiences of a favourite are a catalogue
 * page (which links to `/services/:slug`) and the customer shell (which links to
 * the service or the professional), so the projection carries what both need and
 * nothing more.
 *
 * Ownership is `customer_id = the caller`, applied here. The 0042 policies admit
 * the same, but the handler reaches Postgres as the service role, so the filter
 * is the gate, not the backstop.
 */

type ServerClient = SupabaseClient<Database>;

export interface FavouriteItem {
  id: string;
  targetType: FavouriteTargetType;
  targetId: string;
  createdAt: string;
  /** Present when `targetType === 'service'`. */
  service?: {
    id: string;
    name: string;
    slug: string;
    shortDescription: string | null;
    basePrice: number;
    imageUrl: string | null;
    isActive: boolean;
  };
  /** Present when `targetType === 'professional'`. */
  professional?: {
    id: string;
    name: string | null;
    rating: number | null;
    ratingCount: number;
    verificationStatus: string;
  };
}

export async function listFavourites(
  customerId: string,
  supabase: ServerClient = createServerClient()
): Promise<{ favourites: FavouriteItem[] }> {
  const { data, error } = await supabase
    .from('favourites')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as Favourite[];
  if (rows.length === 0) return { favourites: [] };

  const serviceIds = rows.filter((r) => r.target_type === 'service').map((r) => r.target_id);
  const professionalIds = rows
    .filter((r) => r.target_type === 'professional')
    .map((r) => r.target_id);

  const [services, professionals] = await Promise.all([
    fetchServices(supabase, serviceIds),
    fetchProfessionals(supabase, professionalIds),
  ]);

  return {
    favourites: rows.map((row) => {
      const base: FavouriteItem = {
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        createdAt: row.created_at,
      };
      if (row.target_type === 'service') base.service = services[row.target_id];
      if (row.target_type === 'professional') base.professional = professionals[row.target_id];
      return base;
    }),
  };
}

/**
 * Add a favourite, idempotently. Re-saving is a no-op, not a duplicate: the
 * unique index makes the second write a conflict, and a conflict here is the
 * desired state already being true.
 */
export async function addFavourite(
  customerId: string,
  targetType: FavouriteTargetType,
  targetId: string,
  supabase: ServerClient = createServerClient()
): Promise<{ favourite: Favourite; alreadySaved: boolean }> {
  await assertTargetExists(supabase, targetType, targetId);

  const { data: existing, error: existingError } = await supabase
    .from('favourites')
    .select('*')
    .eq('customer_id', customerId)
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { favourite: existing as Favourite, alreadySaved: true };

  const { data, error } = await supabase
    .from('favourites')
    .insert({ customer_id: customerId, target_type: targetType, target_id: targetId })
    .select('*')
    .single();
  if (error) throw error;
  return { favourite: data as Favourite, alreadySaved: false };
}

/** Remove a favourite. Removing one that is not there is not an error. */
export async function removeFavourite(
  customerId: string,
  targetType: FavouriteTargetType,
  targetId: string,
  supabase: ServerClient = createServerClient()
): Promise<{ removed: number }> {
  const { error, count } = await supabase
    .from('favourites')
    .delete({ count: 'exact' })
    .eq('customer_id', customerId)
    .eq('target_type', targetType)
    .eq('target_id', targetId);
  if (error) throw error;
  return { removed: count ?? 0 };
}

async function assertTargetExists(
  supabase: ServerClient,
  targetType: FavouriteTargetType,
  targetId: string
): Promise<void> {
  if (targetType === 'service') {
    const { data, error } = await supabase
      .from('services')
      .select('id, is_active')
      .eq('id', targetId)
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.is_active) {
      throw new ApiHttpError('NOT_FOUND', 'That service is not available.', 404, { targetId });
    }
    return;
  }

  const { data, error } = await supabase
    .from('professionals')
    .select('id')
    .eq('id', targetId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('NOT_FOUND', 'That professional was not found.', 404, { targetId });
  }
}

async function fetchServices(
  supabase: ServerClient,
  ids: string[]
): Promise<Record<string, FavouriteItem['service']>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const { data, error } = await supabase
    .from('services')
    .select('id, name, slug, short_description, base_price, image_url, is_active')
    .in('id', unique);
  if (error) throw error;
  return Object.fromEntries(
    (data ?? []).map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        slug: s.slug,
        shortDescription: s.short_description,
        basePrice: Number(s.base_price),
        imageUrl: s.image_url,
        isActive: s.is_active,
      },
    ])
  );
}

async function fetchProfessionals(
  supabase: ServerClient,
  ids: string[]
): Promise<Record<string, FavouriteItem['professional']>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const { data, error } = await supabase
    .from('professionals')
    .select('id, profile_id, rating, rating_count, verification_status')
    .in('id', unique);
  if (error) throw error;

  const profileIds = (data ?? []).map((p) => p.profile_id);
  const names: Record<string, string> = {};
  if (profileIds.length > 0) {
    const { data: profiles, error: namesError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', profileIds);
    if (namesError) throw namesError;
    for (const p of profiles ?? []) names[p.id] = p.full_name;
  }

  return Object.fromEntries(
    (data ?? []).map((p) => [
      p.id,
      {
        id: p.id,
        name: names[p.profile_id] ?? null,
        rating: p.rating,
        ratingCount: p.rating_count,
        verificationStatus: p.verification_status,
      },
    ])
  );
}
