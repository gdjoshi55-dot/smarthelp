import { describe, expect, it } from 'vitest';
import {
  describeResolution,
  haversineKm,
  localityByName,
  localityForPoint,
  resolveLocality,
  type CityLike,
  type LocalityLike,
} from '@/lib/geo';

/**
 * Locality resolution (§5.3), which decides whether a service can be booked at
 * an address at all.
 *
 * The two failure modes being guarded here are opposites and both are bad: a
 * locality resolved when it should not have been (a stranger's neighbourhood,
 * or a service offered where it is not) and a locality that failed to resolve
 * when it should have (a service that exists, at a real address, hidden behind
 * "not yet available"). The radius boundary is therefore asserted from both
 * sides.
 */

const BENGALURU: CityLike = {
  id: 'city-blr',
  name: 'Bengaluru',
  state: 'Karnataka',
  time_zone: 'Asia/Kolkata',
  is_active: true,
};

const MYSORE: CityLike = {
  id: 'city-mys',
  name: 'Mysuru',
  state: 'Karnataka',
  time_zone: 'Asia/Kolkata',
  is_active: true,
};

function locality(overrides: Partial<LocalityLike> & { id: string; name: string }): LocalityLike {
  return {
    city_id: BENGALURU.id,
    lat: 12.9716,
    lng: 77.5946,
    radius_km: 5,
    is_active: true,
    ...overrides,
  };
}

const INDIRANAGAR = locality({ id: 'loc-indiranagar', name: 'Indiranagar' });
const HSR = locality({ id: 'loc-hsr', name: 'HSR Layout', lat: 12.9116, lng: 77.6389, radius_km: 4 });
const KALYAN_NAGAR_BLR = locality({ id: 'loc-kalyan-blr', name: 'Kalyan Nagar', lat: 13.0358, lng: 77.597 });
const KALYAN_NAGAR_MYS = locality({
  id: 'loc-kalyan-mys',
  name: 'Kalyan Nagar',
  city_id: MYSORE.id,
  lat: 12.3052,
  lng: 76.6551,
});
const RETIRED = locality({ id: 'loc-retired', name: 'Old Town', is_active: false });

const LOCALITIES = [
  INDIRANAGAR,
  HSR,
  KALYAN_NAGAR_BLR,
  KALYAN_NAGAR_MYS,
  RETIRED,
];
const CITIES = [BENGALURU, MYSORE];

describe('haversineKm', () => {
  it('is zero for the same point and symmetric otherwise', () => {
    const a = { lat: 12.9716, lng: 77.5946 };
    const b = { lat: 12.9116, lng: 77.6389 };
    expect(haversineKm(a, a)).toBe(0);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });

  it('measures a real distance, not degrees', () => {
    // Indiranagar to HSR Layout is a shade over 8 km apart on the ground; a
    // degrees-to-km mistake would land an order of magnitude away.
    const km = haversineKm(
      { lat: 12.9716, lng: 77.5946 },
      { lat: 12.9116, lng: 77.6389 }
    );
    expect(km).toBeGreaterThan(8);
    expect(km).toBeLessThan(8.5);
  });
});

describe('localityByName', () => {
  it('ignores case, repeated spaces and a trailing comma', () => {
    for (const typed of ['Indiranagar', 'indiranagar', '  INDIRANAGAR  ', 'Indiranagar,']) {
      expect(localityByName(LOCALITIES, typed)?.id).toBe('loc-indiranagar');
    }
  });

  it('ignores a locality that has been retired', () => {
    expect(localityByName(LOCALITIES, 'Old Town')).toBeNull();
  });

  it('does not fall through to a fuzzy match', () => {
    // Close is not close enough: "Indira" is a different place or a typo, and
    // guessing hides services rather than showing a wrong one.
    expect(localityByName(LOCALITIES, 'Indira')).toBeNull();
    expect(localityByName(LOCALITIES, 'Indiranagar Extension')).toBeNull();
  });

  it('takes the city into account when one is named', () => {
    // Two "Kalyan Nagar"s exist in the data; the city is what separates them.
    expect(localityByName(LOCALITIES, 'Kalyan Nagar', BENGALURU.id)?.id).toBe('loc-kalyan-blr');
    expect(localityByName(LOCALITIES, 'Kalyan Nagar', MYSORE.id)?.id).toBe('loc-kalyan-mys');
    expect(localityByName(LOCALITIES, 'Kalyan Nagar')?.id).toBe('loc-kalyan-blr');
  });

  it('accepts "Indiranagar, Bengaluru" for people who type both', () => {
    expect(localityByName(LOCALITIES, 'Indiranagar, Bengaluru')?.id).toBe('loc-indiranagar');
  });

  it('finds a longer locality on a word boundary, and only on one', () => {
    // "HSR" is a prefix of "HSR Layout"; "HS" is not a prefix of any word in it.
    expect(localityByName(LOCALITIES, 'HSR')?.id).toBe('loc-hsr');
    expect(localityByName(LOCALITIES, 'HS')).toBeNull();
  });
});

describe('localityForPoint', () => {
  it('takes the nearest locality the point is inside', () => {
    // Just north of the Indiranagar centre, well inside its 5 km radius.
    const hit = localityForPoint([INDIRANAGAR, HSR], { lat: 12.978, lng: 77.601 });
    expect(hit?.locality.id).toBe('loc-indiranagar');
    expect(hit?.distanceKm).toBeGreaterThan(0);
  });

  it('refuses a point outside every radius rather than taking the closest', () => {
    // 40 km away: nearer than nothing, and much nearer to nobody.
    expect(localityForPoint([INDIRANAGAR, HSR], { lat: 13.35, lng: 77.59 })).toBeNull();
  });

  it('treats the radius as inclusive, to the metre', () => {
    // 0.1 degrees of latitude is about 11.1 km — outside Indiranagar's 5 km but
    // inside HSR's generous override.
    expect(localityForPoint([INDIRANAGAR], { lat: 13.0616, lng: 77.5946 })).toBeNull();
    const wide = locality({ id: 'loc-wide', name: 'Wide', radius_km: 20 });
    expect(localityForPoint([wide], { lat: 13.0616, lng: 77.5946 })?.locality.id).toBe('loc-wide');
  });

  it('ignores a retired locality even when the point is inside it', () => {
    const centre = { lat: Number(RETIRED.lat), lng: Number(RETIRED.lng) };
    expect(localityForPoint([RETIRED], centre)).toBeNull();
  });
});

describe('resolveLocality', () => {
  it('resolves a typed area and reports how it matched', () => {
    const r = resolveLocality({ localities: LOCALITIES, cities: CITIES, area: 'hsr layout' });
    expect(r.locality?.id).toBe('loc-hsr');
    expect(r.matchedBy).toBe('area');
    expect(r.city?.name).toBe('Bengaluru');
    expect(r.distanceKm).toBeNull();
  });

  it('resolves a point and reports the distance it had to travel', () => {
    const r = resolveLocality({
      localities: LOCALITIES,
      cities: CITIES,
      point: { lat: 12.978, lng: 77.601 },
    });
    expect(r.locality?.id).toBe('loc-indiranagar');
    expect(r.matchedBy).toBe('coordinates');
    expect(r.distanceKm).toBeGreaterThan(0);
  });

  it('lets a typed area beat a tower fix', () => {
    // Somebody who typed "HSR Layout" and then allowed the browser to locate
    // them from a tower in Jayanagar meant HSR Layout. Preferring the tower
    // would send the professional to the wrong address.
    const r = resolveLocality({
      localities: LOCALITIES,
      cities: CITIES,
      area: 'HSR Layout',
      point: { lat: 12.925, lng: 77.5938 },
    });
    expect(r.locality?.id).toBe('loc-hsr');
    expect(r.matchedBy).toBe('area');
  });

  it('restricts a point to the named city when a city was named', () => {
    // Coordinates in Mysuru must not resolve to a Bengaluru locality just
    // because one happens to be marginally closer.
    const r = resolveLocality({
      localities: LOCALITIES,
      cities: CITIES,
      city: 'Mysuru',
      point: { lat: 12.3052, lng: 76.6551 },
    });
    expect(r.locality?.id).toBe('loc-kalyan-mys');
  });

  it('returns nothing, rather than a guess, when it cannot know', () => {
    const r = resolveLocality({
      localities: LOCALITIES,
      cities: CITIES,
      area: 'Nowhere In Particular',
    });
    expect(r.locality).toBeNull();
    expect(r.matchedBy).toBeNull();
    expect(r.city).toBeNull();
  });

  it('keeps the city even when the locality is unknown', () => {
    // "Bengaluru" alone is enough to say which city, which is what the coverage
    // badge needs even when the area is not recognised.
    const r = resolveLocality({ localities: LOCALITIES, cities: CITIES, city: 'bengaluru' });
    expect(r.city?.id).toBe('city-blr');
    expect(r.locality).toBeNull();
  });

  it('finds a city by its state when the name is the state', () => {
    expect(resolveLocality({ localities: LOCALITIES, cities: CITIES, city: 'Karnataka' }).city?.id).toBe(
      'city-blr'
    );
  });
});

describe('describeResolution', () => {
  it('says the address is saved when nothing matched', () => {
    const r = resolveLocality({ localities: LOCALITIES, cities: CITIES, area: 'Nowhere' });
    expect(describeResolution(r)).toMatch(/saved/i);
  });

  it('quotes the distance when the match came from coordinates', () => {
    const r = resolveLocality({
      localities: LOCALITIES,
      cities: CITIES,
      point: { lat: 12.978, lng: 77.601 },
    });
    expect(describeResolution(r)).toMatch(/km from the centre of Indiranagar/);
  });
});
