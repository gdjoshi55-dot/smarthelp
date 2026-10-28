'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Crosshair, Loader2, MapPin, Search, X } from 'lucide-react';
import { DEFAULT_MAP_CENTER } from '@/lib/mapConfig';
import { nominatimReverse, nominatimSearch, nominatimToAddress, type NominatimResult } from '@/lib/osm';
import type { AddressSelection, LatLng } from '@/lib/googleMapsAddress';

const OSMMap = dynamic(() => import('./OSMMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-56 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
      Loading the map…
    </div>
  ),
});

interface AddressMapPickerProps {
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
  result: NominatimResult;
}

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 3;

function roundKey(point: LatLng): string {
  return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

export default function AddressMapPickerOSM({
  value = null,
  onSelect,
  className = '',
  title = 'Find your address on the map',
  hint = 'Search for the building or area, then drag the pin to the exact door. The address fields below fill themselves in, and you can still edit them.',
}: AddressMapPickerProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<AddressSelection | null>(null);
  const [view, setView] = useState<{ center: LatLng; zoom: number }>({
    center: value ?? DEFAULT_MAP_CENTER,
    zoom: value ? 16 : 12,
  });

  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const geocodeCache = useRef(new Map<string, AddressSelection>());
  const requestId = useRef(0);

  const choose = useCallback((selection: AddressSelection) => {
    setSelected(selection);
    setQuery(selection.formattedAddress);
    setSuggestions([]);
    setProblem(null);
    setView({ center: { lat: selection.lat, lng: selection.lng }, zoom: 17 });
    onSelectRef.current(selection);
  }, []);

  const resolvePoint = useCallback(
    async (point: LatLng, opts: { silent?: boolean } = {}) => {
      const key = roundKey(point);
      const cached = geocodeCache.current.get(key);
      if (cached) {
        choose(cached);
        return;
      }
      if (!opts.silent) setProblem(null);
      try {
        const result = await nominatimReverse(point);
        if (!result) {
          setProblem('We could not turn that pin into an address. Move it a little and try again.');
          return;
        }
        const parsed = nominatimToAddress(result, 'Picked location');
        const selection: AddressSelection = {
          ...parsed,
          lat: point.lat,
          lng: point.lng,
          formattedAddress: result.display_name,
        };
        geocodeCache.current.set(key, selection);
        choose(selection);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'We could not look up that point.');
      }
    },
    [choose]
  );

  useEffect(() => {
    const text = query.trim();
    if (text.length < MIN_SEARCH_LENGTH || text === selected?.formattedAddress) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const id = ++requestId.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      (async () => {
        try {
          const results = await nominatimSearch(text, { country: 'in', limit: 6 });
          if (id !== requestId.current) return;
          setSuggestions(
            results.map((r, idx) => ({
              id: `${r.lat},${r.lon},${idx}`,
              primary: r.display_name.split(',')[0]?.trim() || r.display_name,
              secondary: r.display_name,
              result: r,
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
  }, [query, selected?.formattedAddress]);

  const pickSuggestion = useCallback(
    (suggestion: Suggestion) => {
      setSearching(true);
      setSuggestions([]);
      setProblem(null);
      const r = suggestion.result;
      const point = { lat: Number(r.lat), lng: Number(r.lon) };
      const parsed = nominatimToAddress(r, suggestion.primary);
      const selection: AddressSelection = {
        ...parsed,
        lat: point.lat,
        lng: point.lng,
        formattedAddress: r.display_name,
      };
      geocodeCache.current.set(roundKey(point), selection);
      choose(selection);
      setSearching(false);
    },
    [choose]
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
        const point = { lat: Number(position.coords.latitude.toFixed(6)), lng: Number(position.coords.longitude.toFixed(6)) };
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
    () => (selected ? [{ id: 'picked', lat: selected.lat, lng: selected.lng, title: 'Your address', draggable: true }] : []),
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
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
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
            <ul role="listbox" className="absolute left-0 right-0 top-full z-[1000] mt-1 max-h-64 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickSuggestion(suggestion)}
                    className="block w-full px-3 py-2 text-left hover:bg-blue-50"
                  >
                    <span className="block text-sm font-medium text-gray-900">{suggestion.primary}</span>
                    <span className="block truncate text-xs text-gray-500">{suggestion.secondary}</span>
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
          {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Crosshair className="h-4 w-4" aria-hidden="true" />}
          Use my location
        </button>
      </div>

      <div className="mt-3">
        <OSMMap
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
          {searching ? 'Searching…' : selected ? 'Pin placed. Drag it if the door is not quite right.' : 'Tap the map to place the pin.'}
        </p>
        {selected ? (
          <a href={`https://www.openstreetmap.org/?mlat=${selected.lat}&mlon=${selected.lng}#map=17/${selected.lat}/${selected.lng}`} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-700 hover:underline">
            Check on OpenStreetMap
          </a>
        ) : null}
      </div>

      {selected ? (
        <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
          <p className="text-xs font-medium text-blue-900">{selected.formattedAddress}</p>
          <p className="mt-0.5 text-[11px] text-blue-800">
            Area: {selected.area || '—'} · City: {selected.city || '—'} · Pincode: {selected.pincode || '—'}
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
