import { createServerClient } from './supabaseServer';
import { parseNumeric, toPaise, numericLiteral } from './money';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  PricingType,
  ServiceArea,
  ServiceDuration,
  TablesUpdate,
} from './supabase';

/**
 * The services console's read/write helpers (Phase 6, wave C; §7, §24, §31.1).
 *
 * Same rules as `lib/adminServer.ts`: service-role, D3 (a bad id resolves to
 * `null` here and the route 404s without writing), money parsed at the boundary.
 * One deliberate convenience: `createService` derives the slug from the name
 * and makes it unique against what is already in the table, so a console user
 * never has to type "computer-repair" by hand.
 */

type ServerClient = SupabaseClient<Database>;

function dec(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Not a finite number: ${value}`);
  return String(value);
}

export interface AdminServiceListItem {
  id: string;
  name: string;
  slug: string;
  categoryId: string;
  categoryName: string;
  pricingType: PricingType;
  basePrice: number;
  durationMin: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminServiceListFilters {
  q?: string;
  categoryId?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export async function listAdminServices(
  filters: AdminServiceListFilters = {},
  supabase: ServerClient = createServerClient()
): Promise<{ services: AdminServiceListItem[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  let query = supabase.from('services').select('*', { count: 'exact' });
  if (filters.q) query = query.ilike('name', `%${filters.q}%`);
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters.isActive !== undefined) query = query.eq('is_active', filters.isActive);
  const { data, error, count } = await query
    .order('sort_order', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = data ?? [];
  const categoryIds = [...new Set(rows.map((r) => r.category_id))];
  const names: Record<string, string> = {};
  if (categoryIds.length > 0) {
    const { data: cats, error: catError } = await supabase
      .from('service_categories')
      .select('id, name')
      .in('id', categoryIds);
    if (catError) throw catError;
    for (const c of cats ?? []) names[c.id] = c.name;
  }

  return {
    services: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      categoryId: r.category_id,
      categoryName: names[r.category_id] ?? 'Uncategorised',
      pricingType: r.pricing_type,
      basePrice: parseNumeric(r.base_price),
      durationMin: r.min_duration_min,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: count ?? rows.length,
  };
}

export interface AdminServiceDetail {
  service: Database['public']['Tables']['services']['Row'];
  categoryName: string;
  durations: ServiceDuration[];
  areas: (ServiceArea & { localityName: string })[];
}

export async function getAdminService(
  serviceId: string,
  supabase: ServerClient = createServerClient()
): Promise<AdminServiceDetail | null> {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('id', serviceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const [catRes, durationsRes, areasRes] = await Promise.all([
    supabase.from('service_categories').select('name').eq('id', data.category_id).maybeSingle(),
    supabase
      .from('service_durations')
      .select('*')
      .eq('service_id', serviceId)
      .order('minutes', { ascending: true }),
    supabase.from('service_areas').select('*').eq('service_id', serviceId),
  ]);
  if (catRes.error) throw catRes.error;
  if (durationsRes.error) throw durationsRes.error;
  if (areasRes.error) throw areasRes.error;

  const areaRows = (areasRes.data ?? []) as ServiceArea[];
  const localityIds = [...new Set(areaRows.map((a) => a.locality_id))];
  const localityNames: Record<string, string> = {};
  if (localityIds.length > 0) {
    const { data: locs, error: locError } = await supabase
      .from('localities')
      .select('id, name')
      .in('id', localityIds);
    if (locError) throw locError;
    for (const l of locs ?? []) localityNames[l.id] = l.name;
  }

  return {
    service: data,
    categoryName: catRes.data?.name ?? 'Uncategorised',
    durations: (durationsRes.data ?? []) as ServiceDuration[],
    areas: areaRows.map((a) => ({ ...a, localityName: localityNames[a.locality_id] ?? 'Unknown locality' })),
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'service';
}

async function uniqueSlug(name: string, supabase: ServerClient, ignoreId?: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    let q = supabase.from('services').select('id').eq('slug', candidate).limit(1);
    if (ignoreId) q = q.neq('id', ignoreId);
    const { data, error } = await q;
    if (error) throw error;
    if ((data ?? []).length === 0) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export interface AdminServiceInput {
  categoryId: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  basePrice: number;
  pricingType: PricingType;
  unitLabel?: string | null;
  unitPrice?: number | null;
  minDurationMin?: number;
  maxDurationMin?: number;
  prepMinutes?: number;
  maxActiveJobs?: number;
  materialsIncluded?: boolean;
  materialsNote?: string | null;
  requiresPhotoProof?: boolean;
  sortOrder?: number;
  isActive?: boolean;
  durations?: { minutes: number; price?: number | null; priceMultiplier?: number | null; isActive?: boolean }[];
}

function serviceRow(input: AdminServiceInput, slug: string) {
  return {
    category_id: input.categoryId,
    name: input.name,
    slug,
    short_description: input.shortDescription ?? null,
    description: input.description ?? null,
    image_url: input.imageUrl ?? null,
    base_price: input.basePrice,
    pricing_type: input.pricingType,
    unit_label: input.unitLabel ?? null,
    unit_price: input.unitPrice ?? null,
    min_duration_min: input.minDurationMin ?? 30,
    max_duration_min: input.maxDurationMin ?? 480,
    prep_minutes: input.prepMinutes ?? 15,
    max_active_jobs: input.maxActiveJobs ?? 3,
    materials_included: input.materialsIncluded ?? false,
    materials_note: input.materialsNote ?? null,
    requires_photo_proof: input.requiresPhotoProof ?? false,
    sort_order: input.sortOrder ?? 0,
    is_active: input.isActive ?? true,
  };
}

export async function createService(
  input: AdminServiceInput,
  supabase: ServerClient = createServerClient()
): Promise<AdminServiceDetail> {
  const slug = await uniqueSlug(input.name, supabase);
  const { data, error } = await supabase
    .from('services')
    .insert(serviceRow(input, slug))
    .select('*')
    .single();
  if (error) throw error;

  if (input.durations && input.durations.length > 0) {
    await supabase.from('service_durations').insert(
      input.durations.map((d) => ({
        service_id: data.id,
        minutes: d.minutes,
        price: d.price === null || d.price === undefined ? null : numericLiteral(toPaise(d.price)),
        price_multiplier: d.priceMultiplier === null || d.priceMultiplier === undefined
          ? null
          : dec(d.priceMultiplier),
        is_active: d.isActive ?? true,
      }))
    );
  }

  const detail = await getAdminService(data.id, supabase);
  return detail as AdminServiceDetail;
}

export async function updateService(
  id: string,
  patch: Partial<AdminServiceInput>,
  supabase: ServerClient = createServerClient()
): Promise<Database['public']['Tables']['services']['Row']> {
  const row: TablesUpdate<'services'> = {};
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
  if (patch.name !== undefined) {
    row.name = patch.name;
    row.slug = await uniqueSlug(patch.name, supabase, id);
  }
  if (patch.shortDescription !== undefined) row.short_description = patch.shortDescription;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.imageUrl !== undefined) row.image_url = patch.imageUrl;
  if (patch.basePrice !== undefined) row.base_price = patch.basePrice;
  if (patch.pricingType !== undefined) row.pricing_type = patch.pricingType;
  if (patch.unitLabel !== undefined) row.unit_label = patch.unitLabel;
  if (patch.unitPrice !== undefined) row.unit_price = patch.unitPrice;
  if (patch.minDurationMin !== undefined) row.min_duration_min = patch.minDurationMin;
  if (patch.maxDurationMin !== undefined) row.max_duration_min = patch.maxDurationMin;
  if (patch.prepMinutes !== undefined) row.prep_minutes = patch.prepMinutes;
  if (patch.maxActiveJobs !== undefined) row.max_active_jobs = patch.maxActiveJobs;
  if (patch.materialsIncluded !== undefined) row.materials_included = patch.materialsIncluded;
  if (patch.materialsNote !== undefined) row.materials_note = patch.materialsNote;
  if (patch.requiresPhotoProof !== undefined) row.requires_photo_proof = patch.requiresPhotoProof;
  if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('services')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export interface ServiceDurationInput {
  minutes: number;
  price?: number | null;
  priceMultiplier?: number | null;
  isActive?: boolean;
}

export async function createServiceDuration(
  serviceId: string,
  input: ServiceDurationInput,
  supabase: ServerClient = createServerClient()
): Promise<ServiceDuration> {
  const { data, error } = await supabase
    .from('service_durations')
    .insert({
      service_id: serviceId,
      minutes: input.minutes,
      price: input.price === null || input.price === undefined ? null : numericLiteral(toPaise(input.price)),
      price_multiplier:
        input.priceMultiplier === null || input.priceMultiplier === undefined ? null : dec(input.priceMultiplier),
      is_active: input.isActive ?? true,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ServiceDuration;
}

export async function updateServiceDuration(
  id: string,
  patch: Partial<ServiceDurationInput>,
  supabase: ServerClient = createServerClient()
): Promise<ServiceDuration> {
  const row: TablesUpdate<'service_durations'> = {};
  if (patch.minutes !== undefined) row.minutes = patch.minutes;
  if (patch.price !== undefined)
    row.price = patch.price === null ? null : numericLiteral(toPaise(patch.price));
  if (patch.priceMultiplier !== undefined)
    row.price_multiplier = patch.priceMultiplier === null ? null : dec(patch.priceMultiplier);
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('service_durations')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as ServiceDuration;
}

export async function deleteServiceDuration(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<void> {
  const { error } = await supabase.from('service_durations').delete().eq('id', id);
  if (error) throw error;
}

export interface ServiceAreaInput {
  localityId: string;
  leadMinutes?: number;
  slotCapacity?: number;
  isActive?: boolean;
}

export async function createServiceArea(
  serviceId: string,
  input: ServiceAreaInput,
  supabase: ServerClient = createServerClient()
): Promise<ServiceArea> {
  const { data, error } = await supabase
    .from('service_areas')
    .insert({
      service_id: serviceId,
      locality_id: input.localityId,
      lead_minutes: input.leadMinutes ?? 0,
      slot_capacity: input.slotCapacity ?? 8,
      is_active: input.isActive ?? true,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ServiceArea;
}

export async function updateServiceArea(
  id: string,
  patch: Partial<ServiceAreaInput>,
  supabase: ServerClient = createServerClient()
): Promise<ServiceArea> {
  const row: TablesUpdate<'service_areas'> = {};
  if (patch.localityId !== undefined) row.locality_id = patch.localityId;
  if (patch.leadMinutes !== undefined) row.lead_minutes = patch.leadMinutes;
  if (patch.slotCapacity !== undefined) row.slot_capacity = patch.slotCapacity;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('service_areas')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as ServiceArea;
}

export async function deleteServiceArea(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<void> {
  const { error } = await supabase.from('service_areas').delete().eq('id', id);
  if (error) throw error;
}

/** The locality picker for service areas: name + city, searchable. */
export async function listLocalities(
  q?: string,
  supabase: ServerClient = createServerClient()
): Promise<{ id: string; name: string; city: string }[]> {
  let query = supabase.from('localities').select('id, name, city_id').eq('is_active', true).limit(100);
  if (q) query = query.ilike('name', `%${q}%`);
  const { data, error } = await query.order('name', { ascending: true });
  if (error) throw error;

  const rows = data ?? [];
  const cityIds = [...new Set(rows.map((r) => r.city_id))];
  const cityNames: Record<string, string> = {};
  if (cityIds.length > 0) {
    const { data: cities, error: cityError } = await supabase
      .from('cities')
      .select('id, name')
      .in('id', cityIds);
    if (cityError) throw cityError;
    for (const c of cities ?? []) cityNames[c.id] = c.name;
  }
  return rows.map((r) => ({ id: r.id, name: r.name, city: cityNames[r.city_id] ?? '' }));
}