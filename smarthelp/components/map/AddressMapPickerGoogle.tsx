'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Crosshair, Loader2, MapPin, Search, X } from 'lucide-react';
import { DEFAULT_MAP_CENTER } from '@/lib/mapConfig';
import { GOOGLE_MAPS_REGION, loadGoogleMaps } from '@/lib/googleMaps';
import {
  parseAddressComponents,
  placeUrl,
  type AddressSelection,
  type LatLng,
} from '@/lib/googleMapsAddress';

const GoogleMap = dynamic(() => import('./GoogleMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-56 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
      Loading the map…
    </div>
  ),
});

interface AddressMapPickerGoogleProps {
  value?: LatLng | null;
  onSelect: (selection: AddressSelection) => void;
  className?: string;
  title?: string;
  hint?: string;
}

interface Suggestion {
  id: string;
  primary: string;
  secondary: string;
  result: google.maps.GeocoderResult;
}

const SEARCH_DEBOUNCE_MS = 400;
const MIN_SEARCH_LENGTH = 3;

function roundKey(point: LatLng): string {
  return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

function readPoint(
  location: google.maps.LatLng | google.maps.LatLngLiteral | null | undefined
): LatLng | null {
  if (!location) return null;
  const lat = typeof location.lat === 'function' ? location.lat() : Number(location.lat);
  const lng = typeof location.lng === 'function' ? location.lng() : Number(location.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function primaryLine(result: google.maps.GeocoderResult): string {
  const first = result.formatted_address.split(',')[0]?.trim();
  return first || result.formatted_address;
}

export default function AddressMapPickerGoogle({
  value = null,
  onSelect,
  className = '',
  title = 'Find your address on the map',
  hint = 'Search for the building or area, then drag the pin to the exact door. The address fields below fill themselves in, and you can still edit them.',
}: AddressMapPickerGoogleProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<AddressSelection | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [view, setView] = useState<{ center: LatLng; zoom: number }>({
    center: value ?? DEFAULT_MAP_CENTER,
    zoom: value ? 16 : 12,
  });

  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const geocodeCache = useRef(new Map<string, AddressSelection>());
  const requestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then((maps) => {
        if (cancelled) return;
        geocoderRef.current = new maps.Geocoder();
        setMapReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setProblem(
          error instanceof Error ? error.message : 'We could not load Google Maps right now.'
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback((selection: AddressSelection) => {
    setSelected(selection);
    setQuery(selection.formattedAddress);
    setSuggestions([]);
    setProblem(null);
    setView({ center: { lat: selection.lat, lng: selection.lng }, zoom: 17 });
    onSelectRef.current(selection);
  }, []);

  const toSelection = useCallback(
    (result: google.maps.GeocoderResult, point: LatLng): AddressSelection => {
      const parsed = parseAddressComponents(
        result.address_components ?? [],
        result.formatted_address,
        primaryLine(result)
      );
      return {
        ...parsed,
        lat: point.lat,
        lng: point.lng,
        formattedAddress: result.formatted_address,
        placeId: result.place_id,
      };
    },
    []
  );

  const resolvePoint = useCallback(
    async (point: LatLng) => {
      const key = roundKey(point);
      const cached = geocodeCache.current.get(key);
      if (cached) {
        choose(cached);
        return;
      }
      const geocoder = geocoderRef.current;
      if (!geocoder) {
        setProblem('The map is still loading. Try again in a moment.');
        return;
      }
      try {
        const { results } = await geocoder.geocode({ location: point });
        const result = results[0];
        if (!result) {
          setProblem('We could not turn that pin into an address. Move it a little and try again.');
          return;
        }
        const selection = toSelection(result, point);
        geocodeCache.current.set(key, selection);
        choose(selection);
      } catch (error) {
        setProblem(
          error instanceof Error ? error.message : 'We could not look up that point.'
        );
      }
    },
    [choose, toSelection]
  );

  useEffect(() => {
    const text = query.trim();
    if (
      !mapReady ||
      text.length < MIN_SEARCH_LENGTH ||
      text === selected?.formattedAddress
    ) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const id = ++requestId.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      (async () => {
        const geocoder = geocoderRef.current;
        if (!geocoder) return;
        try {
          const { results } = await geocoder.geocode({
            address: text,
            region: GOOGLE_MAPS_REGION,
          });
          if (id !== requestId.current) return;
          setSuggestions(
            results.slice(0, 6).map((result, index) => ({
              id: `${result.place_id ?? 'result'}-${index}`,
              primary: primaryLine(result),
              secondary: result.formatted_address,
              result,
            }))
          );
          setProblem(null);
        } catch (error) {
          if (id !== requestId.current) return;
          setSuggestions([]);
          setProblem(error instanceof Error ? error.message : 'Address search is unavailable.');
        } finally {
          if (id === requestId.current) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, selected?.formattedAddress, mapReady]);

  const pickSuggestion = useCallback(
    (suggestion: Suggestion) => {
      const point = readPoint(suggestion.result.geometry?.location);
      if (!point) {
        setProblem('That result has no map position. Try another search.');
        return;
      }
      const selection = toSelection(suggestion.result, point);
      geocodeCache.current.set(roundKey(point), selection);
      choose(selection);
    },
    [choose, toSelection]
  );

  const locateMe = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setProblem('This browser will not share your location. Search for the address instead.');
      return;
    }
    setLocating(true);
    setProblem(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        };
        setLocating(false);
        void resolvePoint(point);
      },
      () => {
        setLocating(false);
        setProblem('We could not get your location. Search for the address instead.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, [resolvePoint]);

  const markers = useMemo(
    () =>
      selected
        ? [
            {
              id: 'picked',
              lat: selected.lat,
              lng: selected.lng,
              title: 'Your address',
              draggable: true,
            },
          ]
        : [],
    [selected]
  );

  return (
    <div className={className}>
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <MapPin className="h-4 w-4 text-gray-400" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-xs text-gray-600">{hint}</p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && suggestions[0]) {
                event.preventDefault();
                pickSuggestion(suggestions[0]);
              }
            }}
            placeholder="Search a building, street or area in India"
            autoComplete="off"
            aria-label="Search for an address"
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-9 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSuggestions([]);
                setProblem(null);
              }}
              aria-label="Clear address search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}

          {suggestions.length > 0 ? (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-full z-[1000] mt-1 max-h-64 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
            >
              {suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickSuggestion(suggestion)}
                    className="block w-full px-3 py-2 text-left hover:bg-blue-50"
                  >
                    <span className="block text-sm font-medium text-gray-900">
                      {suggestion.primary}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {suggestion.secondary}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <button
          type="button"
          onClick={locateMe}
          disabled={locating}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:border-blue-400 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {locating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Crosshair className="h-4 w-4" aria-hidden="true" />
          )}
          Use my location
        </button>
      </div>

      <div className="mt-3">
        <GoogleMap
          center={view.center}
          zoom={view.zoom}
          markers={markers}
          fitMarkers={false}
          onMapClick={(point) => void resolvePoint(point)}
          onMarkerDragEnd={(_id, point) => void resolvePoint(point)}
          className="h-56 w-full rounded-lg border border-gray-200"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {searching
            ? 'Searching…'
            : selected
              ? 'Pin placed. Drag it if the door is not quite right.'
              : 'Tap the map to place the pin.'}
        </p>
        {selected ? (
          <a
            href={placeUrl(
              { lat: selected.lat, lng: selected.lng },
              selected.formattedAddress
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-blue-700 hover:underline"
          >
            Check on Google Maps
          </a>
        ) : null}
      </div>

      {selected ? (
        <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
          <p className="text-xs font-medium text-blue-900">{selected.formattedAddress}</p>
          <p className="mt-0.5 text-[11px] text-blue-800">
            Area: {selected.area || '—'} · City: {selected.city || '—'} · Pincode:{' '}
            {selected.pincode || '—'}
          </p>
        </div>
      ) : null}

      {problem ? (
        <p role="alert" className="mt-2 text-xs text-amber-700">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
