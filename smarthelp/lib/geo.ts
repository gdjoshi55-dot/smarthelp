/**
 * Locality resolution (§5.3, §5.4).
 *
 * A service is bookable where an active `service_areas` row exists, and that
 * row is keyed on locality. So the question "can this person book a cleaner at
 * this address?" reduces to "which locality is this address in?", and the whole
 * product hangs off getting that right — and off *not* guessing when it cannot
 * be known.
 *
 * This module is pure and imports nothing. It runs in a Route Handler, in a
 * Server Component and in a unit test with the same answer, which is the point:
 * the radius rule is business logic with a boundary condition, and a boundary
 * condition belongs where it can be tested rather than inside a SQL string that
 * only runs against a live database.
 *
 * There is no PostGIS here — `0002_geo.sql` indexes `point(lng, lat)` with
 * `btree_gist` and stops there — so distance is Haversine over the handful of
 * locality rows a city has.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** The columns of `localities` this module needs. Nothing more. */
export interface LocalityLike {
  id: string;
  city_id: string;
  name: string;
  lat: number;
  lng: number;
  radius_km: number | string;
  is_active?: boolean;
}

/** The columns of `cities` this module needs. */
export interface CityLike {
  id: string;
  name: string;
  state?: string;
  time_zone?: string;
  is_active?: boolean;
}

export type LocalityMatchBy = 'area' | 'coordinates';

export interface LocalityResolution {
  locality: LocalityLike | null;
  city: CityLike | null;
  matchedBy: LocalityMatchBy | null;
  /** Great-circle distance to the locality centre, when the match was by point. */
  distanceKm: number | null;
}

/** Mean Earth radius, IUGG. Kilometres, to match `localities.radius_km`. */
export const EARTH_RADIUS_KM = 6371.0088;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in kilometres.
 *
 * Haversine, not the law of cosines: the law of cosines loses precision for the
 * short distances this product cares about (a professional's last few hundred
 * metres inside one locality), and Haversine is stable there.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Normalises a typed locality name for comparison.
 *
 * Case, surrounding whitespace, repeated spaces and a trailing comma are all
 * things a person types and none of them make a different place: "hsr  layout",
 * "HSR Layout," and "HSR Layout" are one locality.
 */
function normaliseName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[,]/g, '').trim();
}

function activeOnly(rows: LocalityLike[]): LocalityLike[] {
  return rows.filter((l) => l.is_active !== false);
}

function radiusOf(locality: LocalityLike): number {
  const r = Number(locality.radius_km);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

/**
 * The locality a person named.
 *
 * `cityId` narrows the search when the address also names a city, which is what
 * keeps "Kalyan Nagar" in Bengaluru from colliding with a namesake elsewhere.
 * Case-insensitive, whitespace-tolerant, and an exact match only: there is no
 * fuzzy fall-through, because a wrong locality silently hides services rather
 * than showing a wrong one, and a wrong answer here is much harder to notice.
 */
export function localityByName(
  localities: LocalityLike[],
  area: string | null | undefined,
  cityId?: string | null
): LocalityLike | null {
  if (!area) return null;

  const candidates = activeOnly(localities).filter(
    (l) => !cityId || l.city_id === cityId
  );
  const byName = (name: string) =>
    candidates.find((l) => normaliseName(l.name) === name) ?? null;

  // People type the city as well as the locality — "Indiranagar, Bengaluru" —
  // and sometimes only the leading half of a two-part locality name. The whole
  // string is tried first, so a locality whose own name contains a comma still
  // matches as a whole; then each comma-separated part, in the order it was
  // typed.
  const parts = area
    .split(',')
    .map((part) => normaliseName(part))
    .filter(Boolean);
  const whole = normaliseName(area);
  if (!whole) return null;

  for (const part of [whole, ...parts]) {
    const hit = byName(part);
    if (hit) return hit;
  }

  // A longer locality that begins with what was typed, on a word boundary:
  // "HSR" finds "HSR Layout", "HS" finds nothing.
  return candidates.find((l) => normaliseName(l.name).startsWith(`${whole} `)) ?? null;
}

/**
 * The nearest locality to a point, if it is inside its own radius.
 *
 * `radius_km` is per locality rather than global because coverage is not
 * circular in the real world: an outer locality may legitimately be a wide
 * spread of low-rise blocks. A point outside every radius resolves to `null`
 * and the caller shows "not yet available" — SmartHelp never picks the closest
 * row and hopes.
 */
export function localityForPoint(
  localities: LocalityLike[],
  point: GeoPoint,
  opts: { maxKm?: number } = {}
): { locality: LocalityLike; distanceKm: number } | null {
  let best: { locality: LocalityLike; distanceKm: number } | null = null;

  for (const locality of activeOnly(localities)) {
    const distanceKm = haversineKm(point, { lat: Number(locality.lat), lng: Number(locality.lng) });
    if (best && distanceKm >= best.distanceKm) continue;

    const limit = opts.maxKm ?? radiusOf(locality);
    if (limit <= 0 || distanceKm > limit) continue;

    best = { locality, distanceKm: round2(distanceKm) };
  }

  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ResolveLocalityInput {
  localities: LocalityLike[];
  cities: CityLike[];
  /** The `area` the person typed, if any. */
  area?: string | null;
  /** The `city` the person typed, if any. */
  city?: string | null;
  /** Browser geolocation or a geocoded address. */
  point?: GeoPoint | null;
}

function cityByName(cities: CityLike[], name: string | null | undefined): CityLike | null {
  if (!name) return null;
  const wanted = normaliseName(name);
  const live = cities.filter((c) => c.is_active !== false);
  return (
    live.find((c) => normaliseName(c.name) === wanted) ??
    live.find((c) => (c.state ? normaliseName(c.state) === wanted : false)) ??
    null
  );
}

function cityOf(cities: CityLike[], id: string | null | undefined): CityLike | null {
  if (!id) return null;
  return cities.find((c) => c.id === id && c.is_active !== false) ?? null;
}

/**
 * The one resolution path: a name, a point, or both.
 *
 * A named locality wins over coordinates. A person who typed "HSR Layout" and
 * then allowed the browser to locate them from a tower in Jayanagar meant HSR
 * Layout, and silently preferring the tower would put the service at the wrong
 * address. The coordinates are the fallback for "Use current location", where
 * no name exists at all.
 */
export function resolveLocality(input: ResolveLocalityInput): LocalityResolution {
  const { localities, cities, area, city, point } = input;

  const namedCity = cityByName(cities, city);

  if (area) {
    const byName = localityByName(localities, area, namedCity?.id ?? null);
    if (byName) {
      return {
        locality: byName,
        city: cityOf(cities, byName.city_id),
        matchedBy: 'area',
        distanceKm: null,
      };
    }
  }

  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    const candidates = namedCity
      ? localities.filter((l) => l.city_id === namedCity.id)
      : localities;
    const byPoint = localityForPoint(candidates, point);
    if (byPoint) {
      return {
        locality: byPoint.locality,
        city: cityOf(cities, byPoint.locality.city_id),
        matchedBy: 'coordinates',
        distanceKm: byPoint.distanceKm,
      };
    }
  }

  return { locality: null, city: namedCity, matchedBy: null, distanceKm: null };
}

/**
 * The sentence the address form shows under the resolved locality.
 *
 * A resolution that cannot be explained is not a resolution, so this is part of
 * the return path rather than a debug aid.
 */
export function describeResolution(resolution: LocalityResolution): string {
  if (!resolution.locality) {
    return 'We do not serve this location yet. Your address is saved and will work as soon as we do.';
  }
  const name = resolution.locality.name;
  if (resolution.matchedBy === 'coordinates' && resolution.distanceKm != null) {
    return `${name} — ${resolution.distanceKm} km from the centre of ${name}.`;
  }
  return `${name} — services here are bookable.`;
}
