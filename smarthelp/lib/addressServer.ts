import { createServerClient } from './supabaseServer';
import { ApiHttpError } from './api';
import { audit, clientIp } from './audit';
import { requireAuth, type AddressInput, type AuthContext } from './validation';
import { resolveLocality, type LocalityResolution } from './geo';
import { getGeography } from './catalogueServer';
import type { Address, AddressType, LocationPrecision } from './supabase';

/**
 * The address write model (Phase 1).
 *
 * An address is the only private row a customer creates in this phase, so the
 * rules live here rather than in each of the five handlers: who may read it,
 * what happens to its locality when the area or the pin changes, what the first
 * address does, and what the audit row records.
 */

/** `12, 4th Cross, Indiranagar, Bengaluru 560038` — for the picker and the pro's screen. */
export function formatAddress(row: {
  line1: string;
  line2?: string | null;
  area: string;
  city: string;
  state?: string | null;
  pincode: string;
}): string {
  return [row.line1, row.line2, row.area, row.city, row.pincode]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(', ');
}

/**
 * The caller, and their `customers` row.
 *
 * `requireAuth` already rejects a suspended account; this rejects the roles that
 * have no customer profile, because `current_customer_id()` is NULL for them and
 * every ownership check below would silently match nothing — which reads as
 * "you have no addresses" rather than "addresses are not a thing your account
 * has".
 */
export async function requireCustomer(req: Request): Promise<{
  auth: AuthContext;
  customer: { id: string };
}> {
  const auth = await requireAuth(req);
  const supabase = createServerClient();

  const { data: customer, error } = await supabase
    .from('customers')
    .select('id')
    .eq('profile_id', auth.userId)
    .maybeSingle();

  if (error) throw error;
  if (!customer) {
    throw new ApiHttpError(
      'FORBIDDEN',
      'Addresses belong to a customer account. This account does not have one.',
      403
    );
  }

  return { auth, customer };
}

/**
 * One address, or a 404 that does not distinguish "not yours" from "not there".
 */
export async function loadOwnedAddress(
  customerId: string,
  addressId: string
): Promise<Address> {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from('addresses')
    .select('*')
    .eq('id', addressId)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('NOT_FOUND', 'That address was not found on your account.', 404);
  }
  return data;
}

export interface ResolvedLocation {
  localityId: string | null;
  lat: number;
  lng: number;
  precision: LocationPrecision;
  resolution: LocalityResolution;
}

/**
 * The locality for an address being saved.
 *
 * When the person supplied coordinates they win, and the result is `exact`. When
 * they typed an area instead — which is what happens if the browser's location
 * prompt is declined — the locality centre is stored and the answer says
 * `locality_centre`, so the form can warn them that the professional will get
 * the centre of the area and asking for a landmark is worth it.
 *
 * No coordinates and no resolvable locality is refused rather than stored:
 * `lat`/`lng` are `not null`, and inventing a point for an address nobody can
 * place is how a professional ends up at the wrong building.
 */
export async function resolveLocationForSave(
  input: Pick<AddressInput, 'area' | 'city' | 'lat' | 'lng'>
): Promise<ResolvedLocation> {
  const geography = await getGeography();

  const resolution = resolveLocality({
    localities: geography.localities,
    cities: geography.cities,
    area: input.area,
    city: input.city,
    point: input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null,
  });

  const locality = resolution.locality;
  if (!locality) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      `We could not match "${input.area}" to a service area. Pick a locality from the list, or share your location.`,
      400,
      { fields: { area: 'Not a locality we recognise' } }
    );
  }

  return {
    localityId: locality.id,
    lat: input.lat ?? Number(locality.lat),
    lng: input.lng ?? Number(locality.lng),
    precision: input.lat != null ? 'exact' : 'locality_centre',
    resolution,
  };
}

export interface AddressView {
  id: string;
  label: string;
  addressType: AddressType;
  line1: string;
  line2: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
  landmark: string | null;
  accessNotes: string | null;
  isDefault: boolean;
  locality: { id: string; name: string } | null;
  /** The "not yet available" badge of §5.4. */
  coverage: 'covered' | 'not_yet_available';
  formatted: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The two reads every address list needs, batched: what the localities are
 * called, and which of them we actually serve.
 *
 * The second one is why `coverage` is not simply "has a locality id". A
 * locality can exist with no active `service_areas` row, and an address in it
 * is a real place where nobody can be booked — the badge is the whole point of
 * resolving the locality up front, so it has to answer the real question.
 */
export interface AddressContext {
  names: Map<string, string>;
  covered: Set<string>;
}

export async function addressContext(rows: Address[]): Promise<AddressContext> {
  const ids = [...new Set(rows.map((r) => r.locality_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  const covered = new Set<string>();
  if (ids.length === 0) return { names, covered };

  const supabase = createServerClient();

  const { data: localities, error: localityError } = await supabase
    .from('localities')
    .select('id, name')
    .in('id', ids);
  if (localityError) throw localityError;
  for (const row of localities ?? []) names.set(row.id, row.name);

  const { data: areas, error: areaError } = await supabase
    .from('service_areas')
    .select('locality_id')
    .in('locality_id', ids)
    .eq('is_active', true);
  if (areaError) throw areaError;
  for (const row of areas ?? []) {
    if (row.locality_id) covered.add(row.locality_id);
  }

  return { names, covered };
}

/** The shape the client renders. Locality names come from one batched read. */
export function toAddressView(
  row: Address,
  localityName: string | null = null,
  isCovered = false
): AddressView {
  return {
    id: row.id,
    label: row.label,
    addressType: row.address_type,
    line1: row.line1,
    line2: row.line2,
    area: row.area,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    lat: Number(row.lat),
    lng: Number(row.lng),
    landmark: row.landmark,
    accessNotes: row.access_notes,
    isDefault: row.is_default,
    locality: row.locality_id ? { id: row.locality_id, name: localityName ?? row.area } : null,
    coverage: row.locality_id && isCovered ? 'covered' : 'not_yet_available',
    formatted: formatAddress(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The fields of an address that the audit trail is allowed to keep. */
export function auditSafeAddress(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  const { lat: _lat, lng: _lng, ...rest } = row as Record<string, unknown>;
  return rest;
}

/** Audit rows for address writes, which are PII changes and worth a trail. */
export async function auditAddress(
  req: Request,
  input: {
    actorProfileId: string;
    requestId: string;
    action: string;
    entityId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  }
) {
  const supabase = createServerClient();
  await audit(supabase, {
    actorProfileId: input.actorProfileId,
    action: input.action,
    entityType: 'addresses',
    entityId: input.entityId ?? null,
    before: auditSafeAddress(input.before),
    after: auditSafeAddress(input.after),
    metadata: { fields: Object.keys(input.after ?? input.before ?? {}) },
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
    requestId: input.requestId,
  });
}
