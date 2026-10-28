'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, MapPinOff } from 'lucide-react';
import {
  DEFAULT_MAP_ZOOM,
  GOOGLE_MAPS_MAP_ID,
  hasGoogleMapsKey,
  importGoogleMapsLibrary,
  loadGoogleMaps,
} from '@/lib/googleMaps';
import type { LatLng } from '@/lib/googleMapsAddress';

export interface RouteInfo {
  durationMinutes: number | null;
  distanceKm: number | null;
}

interface RouteMapProps {
  origin: LatLng;
  destination: LatLng;
  className?: string;
  onRoute?: (info: RouteInfo | null) => void;
}

export default function RouteMap({
  origin,
  destination,
  className,
  onRoute,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);
  const markersRef = useRef<google.maps.Marker[]>([]);

  // The parent may pass an inline callback; keeping it in a ref means a new
  // function identity does not force the route to be recomputed.
  const onRouteRef = useRef(onRoute);
  useEffect(() => {
    onRouteRef.current = onRoute;
  }, [onRoute]);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!hasGoogleMapsKey()) {
      setStatus('error');
      setProblem(
        'Map is not configured. Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env.local.'
      );
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let map: google.maps.Map | null = null;
    let routePolylines: google.maps.Polyline[] = [];
    let markers: google.maps.Marker[] = [];

    const container = containerRef.current;

    if (!container) return;

    setStatus('loading');
    setProblem(null);

    const cleanup = () => {
      routePolylines.forEach((polyline) => polyline.setMap(null));
      markers.forEach((marker) => marker.setMap(null));

      routePolylines = [];
      markers = [];

      if (mapRef.current === map) {
        mapRef.current = null;
      }

      if (container) {
        container.innerHTML = '';
      }
    };

    timeoutId = setTimeout(() => {
      if (cancelled) return;

      setStatus((previous) => {
        if (previous === 'loading') {
          setProblem(
            'Map loading timed out. Check your Google Maps API configuration.'
          );
          return 'error';
        }

        return previous;
      });
    }, 60000);

    const initializeMap = async () => {
      try {
        const maps = await loadGoogleMaps();

        if (cancelled || !containerRef.current) return;

        const mapOptions: google.maps.MapOptions = {
          center: origin,
          zoom: DEFAULT_MAP_ZOOM,
          disableDefaultUI: false,
          zoomControl: true,
          fullscreenControl: true,
          streetViewControl: false,
          mapTypeControl: false,
          clickableIcons: false,
          gestureHandling: 'cooperative',
        };

        if (GOOGLE_MAPS_MAP_ID) {
          mapOptions.mapId = GOOGLE_MAPS_MAP_ID;
        }

        map = new maps.Map(containerRef.current, mapOptions);
        mapRef.current = map;

        // Use the modern JavaScript Routes API.
        const routesLibrary =
          await importGoogleMapsLibrary<any>('routes');

        if (cancelled) return;

        const Route = routesLibrary.Route;

        if (!Route?.computeRoutes) {
          throw new Error(
            'Google Maps Routes API is unavailable. Check that Routes API is enabled.'
          );
        }

        const response = await Route.computeRoutes({
          origin: {
            lat: origin.lat,
            lng: origin.lng,
          },
          destination: {
            lat: destination.lat,
            lng: destination.lng,
          },
          travelMode: 'DRIVING',
          fields: ['path', 'durationMillis', 'distanceMeters'],
        });

        if (cancelled) return;

        const route = response.routes?.[0];

        if (!route) {
          throw new Error(
            'No driving route was found between these locations.'
          );
        }

        // Hand the live driving duration and distance back to the page. This
        // is the same route the map draws, so the customer's ETA needs no
        // second Google request.
        onRouteRef.current?.({
          durationMinutes:
            typeof route.durationMillis === 'number'
              ? Math.max(1, Math.round(route.durationMillis / 60_000))
              : null,
          distanceKm:
            typeof route.distanceMeters === 'number'
              ? Math.round((route.distanceMeters / 1000) * 10) / 10
              : null,
        });

        // Draw the route returned by the JavaScript Routes API.
        routePolylines = route.createPolylines({
          polylineOptions: {
            strokeColor: '#2563eb',
            strokeWeight: 5,
            strokeOpacity: 0.85,
          },
        });

        routePolylines.forEach((polyline) => {
          polyline.setMap(map);
        });

        polylinesRef.current = routePolylines;

        // Keep the professional and service-address markers.
        markers = [
          new google.maps.Marker({
            position: origin,
            map,
            title: 'Professional',
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#2563eb',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            },
          }),
          new google.maps.Marker({
            position: destination,
            map,
            title: 'Service address',
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#dc2626',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            },
          }),
        ];

        markersRef.current = markers;

        // Fit the viewport around the actual route.
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(origin);
        bounds.extend(destination);

        const routePath = route.path ?? [];

        routePath.forEach((point: google.maps.LatLngLiteral) => {
          bounds.extend(point);
        });

        map.fitBounds(bounds, 48);

        if (timeoutId) clearTimeout(timeoutId);

        setStatus('ready');
      } catch (error) {
        if (cancelled) return;

        onRouteRef.current?.(null);

        console.error('[RouteMap] Routes API failed:', error);

        if (timeoutId) clearTimeout(timeoutId);

        setStatus('error');

        setProblem(
          error instanceof Error
            ? error.message
            : 'Could not calculate the route. Check your Google Maps configuration.'
        );
      }
    };

    void initializeMap();

    return () => {
      cancelled = true;

      if (timeoutId) clearTimeout(timeoutId);

      cleanup();

      polylinesRef.current = [];
      markersRef.current = [];
    };
  }, [origin.lat, origin.lng, destination.lat, destination.lng]);

  return (
    <div
      className={`relative isolate overflow-hidden ${
        className ?? 'h-64 w-full rounded-lg'
      }`}
    >
      <div ref={containerRef} className="h-full w-full" />

      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100 text-xs text-gray-500">
          <Loader2
            className="mr-2 h-4 w-4 animate-spin"
            aria-hidden="true"
          />
          Loading route...
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-50 p-4 text-center text-xs text-gray-600">
          <MapPinOff
            className="h-5 w-5 text-gray-400"
            aria-hidden="true"
          />
          <p className="max-w-xs break-words">
            {problem ?? 'The map is unavailable right now.'}
          </p>
        </div>
      )}
    </div>
  );
}