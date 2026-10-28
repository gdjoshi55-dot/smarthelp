import type { LatLng } from './googleMapsAddress';

export const MAP_PROVIDER = (process.env.NEXT_PUBLIC_MAP_PROVIDER ?? 'google').trim().toLowerCase();
export const USE_GOOGLE_MAPS = (MAP_PROVIDER === 'google' || MAP_PROVIDER !== 'osm') && Boolean((process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '').trim());

export const DEFAULT_MAP_CENTER: LatLng = { lat: 12.9716, lng: 77.5946 };
export const DEFAULT_MAP_ZOOM = 12;

export function hasMapKey(): boolean {
  if (USE_GOOGLE_MAPS) return true;
  return true;
}
