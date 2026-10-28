'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, MapPinOff } from 'lucide-react';
import {
  DEFAULT_MAP_ZOOM,
  GOOGLE_MAPS_MAP_ID,
  hasGoogleMapsKey,
  importGoogleMapsLibrary,
  loadGoogleMaps,
  toLatLng,
} from '@/lib/googleMaps';
import type { LatLng } from '@/lib/googleMapsAddress';

/**
 * A small, imperative wrapper around the Google Maps JavaScript API.
 *
 * The wrapper exists so every map in the app shares three behaviours:
 *
 * 1. **One loader.** `loadGoogleMaps()` injects the script once; this component
 *    only asks for the libraries it needs.
 * 2. **Markers that move instead of blinking.** A tracking pin is updated in
 *    place. Recreating the marker on every 15-second poll would restart its
 *    animation and drop an open info window.
 * 3. **A camera that fits a shape, not a ping.** The view fits the available
 *    pins when pins appear or disappear, never when one of them moves — a
 *    professional driving down a road must not drag the map away from the
 *    customer's thumb.
 *
 * Leaflet needed `ssr: false`; Google Maps needs the same. Always import this
 * component through `next/dynamic` with that option.
 */

export interface GoogleMapMarker extends LatLng {
  id: string;
  title?: string;
  color?: string;
  draggable?: boolean;
}

interface GoogleMapProps {
  center: LatLng;
  zoom?: number;
  markers?: GoogleMapMarker[];
  className?: string;
  /** Fit the camera to all markers when the *set* of pins changes. Default true. */
  fitMarkers?: boolean;
  onMapClick?: (point: LatLng) => void;
  onMarkerDragEnd?: (id: string, point: LatLng) => void;
}

interface MarkerHandle {
  marker: google.maps.marker.AdvancedMarkerElement;
  color: string;
}

export default function GoogleMap({
  center,
  zoom = DEFAULT_MAP_ZOOM,
  markers = [],
  className,
  fitMarkers = true,
  onMapClick,
  onMarkerDragEnd,
}: GoogleMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerHandles = useRef(new Map<string, MarkerHandle>());
  const markerLibrary = useRef<google.maps.MarkerLibrary | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [problem, setProblem] = useState<string | null>(null);

  const clickRef = useRef(onMapClick);
  const dragRef = useRef(onMarkerDragEnd);
  useEffect(() => {
    clickRef.current = onMapClick;
    dragRef.current = onMarkerDragEnd;
  }, [onMapClick, onMarkerDragEnd]);

    // Create the map once. Libraries load lazily, so the first paint is a plain
    // placeholder rather than an exception when Places or markers are slow.
    useEffect(() => {
      if (!hasGoogleMapsKey()) {
        setStatus('error');
        setProblem(
          'Map is not configured yet. Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env.local to show it.'
        );
        return;
      } else {
        console.log('[GoogleMap] has key:', hasGoogleMapsKey());
      }

      let cancelled = false;
      const container = containerRef.current;
      const handles = markerHandles.current;
      if (!container) return;

      const timeoutId = setTimeout(() => {
        if (cancelled) return;
        setStatus((prev) => {
          if (prev === 'loading') {
            setProblem('Map load timed out. Check API key, network, and browser console.');
            return 'error';
          }
          return prev;
        });
      }, 60000);

      (async () => {
        try {
          console.log('[GoogleMap] Loading Google Maps...');
          const maps = await loadGoogleMaps().catch((e) => {
            console.error('[GoogleMap] loadGoogleMaps error:', e);
            throw e;
          });
          console.log('[GoogleMap] Google Maps loaded');
          let markerLib: google.maps.MarkerLibrary | null = null;
          try {
            markerLib = await importGoogleMapsLibrary<google.maps.MarkerLibrary>('marker');
          } catch (e) {
            console.warn('[GoogleMap] Marker library failed to load:', e);
            markerLib = null;
          }
          console.log('[GoogleMap] Initializing map');
          if (cancelled || !containerRef.current) return;

          markerLibrary.current = markerLib as any;

          try {
            const mapOptions: google.maps.MapOptions = {
              center,
              zoom,
              disableDefaultUI: false,
              zoomControl: true,
              fullscreenControl: true,
              streetViewControl: false,
              mapTypeControl: false,
              clickableIcons: false,
              gestureHandling: 'cooperative',
            };
            try {
              if (GOOGLE_MAPS_MAP_ID && GOOGLE_MAPS_MAP_ID !== 'DEMO_MAP_ID') {
                (mapOptions as any).mapId = GOOGLE_MAPS_MAP_ID;
              }
            } catch (e) {
              console.warn('mapId error', e);
            }
            const map = new maps.Map(containerRef.current, mapOptions);
            map.addListener('click', (event: google.maps.MapMouseEvent) => {
              try {
                const point = toLatLng(event.latLng);
                if (point) clickRef.current?.(point);
              } catch (e) {
                // ignore
              }
            });

            mapRef.current = map;
            clearTimeout(timeoutId);
            setStatus('ready');
            console.log('[GoogleMap] Map initialized successfully');
          } catch (err) {
            clearTimeout(timeoutId);
            if (cancelled) return;
            console.error('[GoogleMap] Map init error:', err);
            setStatus('error');
            setProblem(err instanceof Error ? err.message : 'Failed to initialize Google Map.');
          }
        } catch (error) {
          clearTimeout(timeoutId);
          if (cancelled) return;
          console.error('[GoogleMap] Load error:', error);
          setStatus('error');
          setProblem(
            error instanceof Error
              ? error.message
              : 'The map could not load. Check your connection and the API key.'
          );
        }
      })();

      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
        handles.clear();
        mapRef.current = null;
        if (container) container.innerHTML = '';
      };
      // The map is created once. `center` and `zoom` changes are applied below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

  // Explicit camera moves. Tracking passes a stable center, so a moving pin
  // never lands here; the address picker passes a new one when a result is
  // chosen. The primitives are the dependencies so an equal-but-new object
  // cannot re-centre a map the user is panning.
  const centerLat = center.lat;
  const centerLng = center.lng;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setCenter({ lat: centerLat, lng: centerLng });
    map.setZoom(zoom);
  }, [centerLat, centerLng, zoom]);

  // Diff markers by id. Existing pins get a new position; only genuinely new
  // pins are constructed.
  useEffect(() => {
    const map = mapRef.current;
    const library = markerLibrary.current;
    if (status !== 'ready' || !map || !library) return;

    try {
      const live = new Set(markers.map((marker) => marker.id));

      for (const [id, handle] of markerHandles.current) {
        if (!live.has(id)) {
          try {
            (handle.marker as any).map = null;
          } catch (e) {
            // ignore
          }
          markerHandles.current.delete(id);
        }
      }

      for (const next of markers) {
        const color = next.color ?? '#dc2626';
        const existing = markerHandles.current.get(next.id);
        if (existing && existing.color === color) {
          try {
            (existing.marker as any).position = { lat: next.lat, lng: next.lng };
            if (next.title) (existing.marker as any).title = next.title;
            (existing.marker as any).gmpDraggable = next.draggable === true;
          } catch (e) {
            // ignore
          }
          continue;
        }
        if (existing) {
          try {
            (existing.marker as any).map = null;
          } catch (e) {
            // ignore
          }
          markerHandles.current.delete(next.id);
        }

        try {
          const pin = new library.PinElement({
            background: color,
            borderColor: '#ffffff',
            glyphColor: '#ffffff',
          });
          const marker = new library.AdvancedMarkerElement({
            map,
            position: { lat: next.lat, lng: next.lng },
            title: next.title,
            content: pin.element,
            gmpDraggable: next.draggable === true,
          });
          marker.addListener('dragend', () => {
            try {
              const point = toLatLng(marker.position);
              if (point) dragRef.current?.(next.id, point);
            } catch (e) {
              // ignore
            }
          });
          markerHandles.current.set(next.id, { marker, color });
        } catch (e) {
          console.warn('Failed to create marker:', e);
        }
      }
    } catch (e) {
      console.warn('Marker update error:', e);
    }
  }, [markers, status]);

  // Fit only when the pin *shape* changes — see the component comment.
  const shape = markers.map((marker) => marker.id).sort().join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitMarkers || status !== 'ready' || markers.length === 0) return;

    try {
      if (markers.length === 1) {
        map.setCenter({ lat: markers[0].lat, lng: markers[0].lng });
        map.setZoom(15);
        return;
      }

      const bounds = new google.maps.LatLngBounds();
      for (const marker of markers) bounds.extend({ lat: marker.lat, lng: marker.lng });
      map.fitBounds(bounds, 48);
    } catch (e) {
      console.warn('fitBounds error', e);
    }
    // `shape` is the deliberate dependency: marker movement must not re-fit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, fitMarkers, status]);

  return (
    <div
      className={`relative isolate overflow-hidden ${className ?? 'h-64 w-full rounded-lg'}`}
    >
      <div ref={containerRef} className="h-full w-full" />

      {status === 'loading' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 text-xs text-gray-500 z-10">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          Loading map…
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-50 p-4 text-center text-xs text-gray-600">
          <MapPinOff className="h-5 w-5 text-gray-400" aria-hidden="true" />
          <p className="max-w-xs break-words">{problem ?? 'The map is unavailable right now.'}</p>
          <p className="text-[10px] text-gray-400">Check browser console for Google Maps errors.</p>
        </div>
      ) : null}
    </div>
  );
}
