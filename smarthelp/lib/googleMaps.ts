/**
 * The single Google Maps JavaScript API loader.
 *
 * Google's script must be injected exactly once per page. A component that
 * appended its own `<script>` on every mount would load the API twice and
 * Google would answer the second load with a warning and a second set of
 * globals. This module keeps one promise for the whole tab.
 *
 * The loader is only imported by client components (`GoogleMap` and
 * `AddressMapPicker`), both of which are dynamically imported with
 * `ssr: false`, because the API touches `window` at evaluation time.
 */

import type { LatLng } from './googleMapsAddress';

export const GOOGLE_MAPS_API_KEY = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '').trim();
export const GOOGLE_MAPS_MAP_ID =
  (process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? '').trim() || 'DEMO_MAP_ID';
export const GOOGLE_MAPS_REGION = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_REGION ?? 'IN').trim() || 'IN';
export const GOOGLE_MAPS_LANGUAGE =
  (process.env.NEXT_PUBLIC_GOOGLE_MAPS_LANGUAGE ?? 'en').trim() || 'en';

/** Bengaluru, the city the catalogue is seeded for. */
export const DEFAULT_MAP_CENTER: LatLng = { lat: 12.9716, lng: 77.5946 };
export const DEFAULT_MAP_ZOOM = 12;

export function hasGoogleMapsKey(): boolean {
  return GOOGLE_MAPS_API_KEY.length > 0;
}

type GoogleMapsNamespace = typeof google.maps;

declare global {
  interface Window {
    __smarthelpGoogleMapsReady?: () => void;
  }
}

const SCRIPT_ID = 'smarthelp-google-maps-script';
const CALLBACK_NAME = '__smarthelpGoogleMapsReady';

let loader: Promise<GoogleMapsNamespace> | null = null;

/**
 * Resolves with the `google.maps` namespace, injecting the script on first use.
 *
 * `loading=async` plus the callback is the documented modern loading pattern:
 * the callback fires once the core namespace exists, and individual libraries
 * are then pulled in with `importLibrary`. That keeps Places and the marker
 * library out of the initial payload on pages that only show a pin.
 */
export function loadGoogleMaps(): Promise<GoogleMapsNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps can only load in a browser.'));
  }
  if (!hasGoogleMapsKey()) {
    console.error('[GoogleMaps] No API key found');
    return Promise.reject(
      new Error(
        'Google Maps is not configured. Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env.local.'
      )
    );
  }
  if (window.google?.maps) {
    console.log('[GoogleMaps] Already loaded');
    return Promise.resolve(window.google.maps);
  }
  if (loader) {
    console.log('[GoogleMaps] Returning existing loader');
    return loader;
  }

  console.log('[GoogleMaps] Starting to load script');
  loader = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      console.error('[GoogleMaps] Timeout waiting for Google Maps');
      loader = null;
      reject(new Error('Google Maps load timed out. Check API key restrictions and network.'));
    }, 60000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      try {
        delete (window as any)[CALLBACK_NAME];
      } catch (e) {}
    };

    const checkAndResolve = () => {
      if (resolved) return;
      if (window.google && window.google.maps) {
        resolved = true;
        cleanup();
        clearInterval(intervalId);
        resolve(window.google.maps);
        return true;
      }
      return false;
    };

    // Remove any existing script to start fresh
    const existingScript = document.getElementById(SCRIPT_ID);
    if (existingScript) {
      existingScript.parentNode?.removeChild(existingScript);
    }

    // Set callback
    (window as any)[CALLBACK_NAME] = () => {
      console.log('[GoogleMaps] Callback fired');
      checkAndResolve();
    };

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}` +
      '&v=weekly' +
      `&language=${encodeURIComponent(GOOGLE_MAPS_LANGUAGE)}` +
      `&region=${encodeURIComponent(GOOGLE_MAPS_REGION)}` +
      '&libraries=places,marker,geometry,routes' +
      `&callback=${CALLBACK_NAME}`;
    script.onerror = (e) => {
      console.error('[GoogleMaps] Script load error', e);
      if (resolved) return;
      resolved = true;
      cleanup();
      clearInterval(intervalId);
      loader = null;
      reject(
        new Error(
          'Google Maps could not load. Check the API key, enabled APIs (Maps JavaScript API, Places API (New)), and key restrictions (HTTP referrers).'
        )
      );
    };
    document.head.appendChild(script);
    console.log('[GoogleMaps] Script appended with callback');

    const intervalId = setInterval(checkAndResolve, 50);
    checkAndResolve();
  });

  return loader;
}

/**
 * Loads one optional library from the same script.
 *
 * `maps` is the core namespace; `places` is Autocomplete and Place Details;
 * `marker` is AdvancedMarkerElement. Library names that the loaded version does
 * not know reject, and the UI treats that as "this control is unavailable"
 * rather than failing the whole page.
 */
export async function importGoogleMapsLibrary<T = unknown>(name: string): Promise<T> {
  const maps = await loadGoogleMaps();
  const namespace = maps as unknown as {
    importLibrary?: (library: string) => Promise<T>;
  };
  if (!namespace.importLibrary) {
    throw new Error('This Google Maps version does not support lazy library loading.');
  }
  return namespace.importLibrary(name);
}

/** Reads coordinates from a Google `LatLng`, `LatLngLiteral`, or plain pair. */
export function toLatLng(value: unknown): LatLng | null {
  if (!value) return null;
  if (typeof value === 'object' && 'lat' in value && 'lng' in value) {
    const raw = value as { lat: number | (() => number); lng: number | (() => number) };
    const lat = typeof raw.lat === 'function' ? raw.lat() : Number(raw.lat);
    const lng = typeof raw.lng === 'function' ? raw.lng() : Number(raw.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  return null;
}

/**
 * Travel time/distance between two points using Google Distance Matrix API.
 * Works server-side via fetch with the API key.
 */
export interface TravelTimeResult {
  durationMinutes: number | null;
  durationText: string | null;
  distanceKm: number | null;
  distanceText: string | null;
  status: string;
}

export async function getTravelTime(
  origin: LatLng,
  destination: LatLng,
  mode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving'
): Promise<TravelTimeResult> {
  const key = GOOGLE_MAPS_API_KEY;
  if (!key) {
    return { durationMinutes: null, durationText: null, distanceKm: null, distanceText: null, status: 'NO_KEY' };
  }
  const originStr = `${origin.lat},${origin.lng}`;
  const destStr = `${destination.lat},${destination.lng}`;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(originStr)}&destinations=${encodeURIComponent(destStr)}&mode=${mode}&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { durationMinutes: null, durationText: null, distanceKm: null, distanceText: null, status: `HTTP_${res.status}` };
    }
    const data = await res.json();
    if (data.status !== 'OK') {
      return { durationMinutes: null, durationText: null, distanceKm: null, distanceText: null, status: data.status };
    }
    const row = data.rows?.[0];
    const element = row?.elements?.[0];
    if (!element || element.status !== 'OK') {
      return { durationMinutes: null, durationText: null, distanceKm: null, distanceText: null, status: element?.status || 'NO_ELEMENT' };
    }
    const durationSec = element.duration?.value;
    const durationText = element.duration?.text || null;
    const distanceMeters = element.distance?.value;
    const distanceText = element.distance?.text || null;
    return {
      durationMinutes: typeof durationSec === 'number' ? Math.round(durationSec / 60) : null,
      durationText,
      distanceKm: typeof distanceMeters === 'number' ? Math.round((distanceMeters / 1000) * 10) / 10 : null,
      distanceText,
      status: 'OK',
    };
  } catch (e) {
    return { durationMinutes: null, durationText: null, distanceKm: null, distanceText: null, status: 'ERROR' };
  }
}
