import type { LatLng } from './googleMapsAddress';

export interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  address?: Record<string, string>;
}

const USER_AGENT = 'SmartHelp/1.0 (https://smarthelp.local)';

function buildUrl(base: string, params: Record<string, string | number | boolean>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export async function nominatimSearch(query: string, opts: { limit?: number; country?: string; viewbox?: string } = {}): Promise<NominatimResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const res = await fetch(
    buildUrl('https://nominatim.openstreetmap.org/search', {
      q,
      format: 'jsonv2',
      addressdetails: 1,
      limit: opts.limit ?? 5,
      ...(opts.country ? { countrycodes: opts.country } : {}),
      ...(opts.viewbox ? { viewbox: opts.viewbox, bounded: 1 } : {}),
    }),
    {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    }
  );
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

export async function nominatimReverse(point: LatLng): Promise<NominatimResult | null> {
  const res = await fetch(
    buildUrl('https://nominatim.openstreetmap.org/reverse', {
      lat: point.lat,
      lon: point.lng,
      format: 'jsonv2',
      addressdetails: 1,
    }),
    {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    }
  );
  if (!res.ok) throw new Error('Reverse geocode failed');
  const data = await res.json();
  if (data && data.error) return null;
  return data as NominatimResult;
}

export function nominatimToAddress(result: NominatimResult, fallbackLine: string): {
  line1: string;
  line2: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  formattedAddress: string;
} {
  const addr = result.address ?? {};
  const line1Parts = [addr.house_number, addr.road].filter(Boolean).join(' ').trim();
  const line1 = line1Parts || fallbackLine || result.display_name.split(',')[0]?.trim() || '';
  const line2 = addr.premise || addr.building || '';
  const area = addr.suburb || addr.neighbourhood || addr.locality || addr.quarter || addr.village || addr.town || '';
  const city = addr.city || addr.town || addr.municipality || addr.county || '';
  const state = addr.state || addr.region || '';
  const pincode = addr.postcode || '';
  return {
    line1,
    line2,
    area,
    city,
    state,
    pincode,
    formattedAddress: result.display_name,
  };
}

export function directionsUrlOsm(point: LatLng): string {
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=;${point.lat},${point.lng}`;
}
