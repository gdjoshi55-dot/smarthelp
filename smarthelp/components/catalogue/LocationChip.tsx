'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Crosshair, Loader2, Map as MapIcon, MapPin, X } from 'lucide-react';
import { usePublicLocation } from './PublicLocationContext';
import type { LocationSummary } from '@/lib/catalogue';

// Google Maps touches `window`; load the picker only when somebody asks for it.
const AddressMapPicker = dynamic(() => import('@/components/map/AddressMapPicker'), {
  ssr: false,
  loading: () => (
    <div className="flex h-56 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
      Loading the map…
    </div>
  ),
});

/**
 * The location chip and the banner under it (§5.3, §5.4).
 *
 * Two states, and they answer different questions. The *chip* is a control: it
 * says which locality the results are for, and it is how a person changes their
 * mind. The *banner* is a sentence from the server, and it never disagrees with
 * the data underneath — which is why the copy here is not written here.
 *
 * Nothing prompts on load. A browser that asks for a location the moment
 * somebody arrives is a browser that gets refused, and after that the chip is
 * decoration.
 */

export function LocationChip({ className = '' }: { className?: string }) {
  const { area, summary, resolving, problem, setArea, setPoint, locateMe, clear, hasLocation } =
    usePublicLocation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(area ?? '');
  const [showMap, setShowMap] = useState(false);

  const label = summary?.localityName ?? (area ? area : hasLocation ? 'Your location' : 'Add location');

  if (!editing) {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={() => {
            setDraft(area ?? summary?.localityName ?? '');
            setEditing(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:border-blue-400 hover:text-blue-700"
        >
          <MapPin className="h-4 w-4 text-blue-600" aria-hidden="true" />
          <span className="max-w-[10rem] truncate">{label}</span>
          {hasLocation ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear location"
              onClick={(event) => {
                event.stopPropagation();
                clear();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  clear();
                }
              }}
              className="rounded-full p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          ) : null}
        </button>
        {problem ? (
          <p className="mt-1.5 text-xs text-amber-700" role="status">
            {problem}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        setArea(draft);
        setEditing(false);
      }}
    >
      <label htmlFor="public-location-area" className="sr-only">
        Your area
      </label>
      <div className="flex items-center gap-2">
        <input
          id="public-location-area"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Area or locality, e.g. Indiranagar"
          autoComplete="off"
          className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Set
        </button>
        <button
          type="button"
          onClick={locateMe}
          disabled={resolving}
          title="Use my current location"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-blue-400 disabled:opacity-60"
        >
          {resolving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Crosshair className="h-4 w-4" aria-hidden="true" />
          )}
          Near me
        </button>
        <button
          type="button"
          onClick={() => setShowMap((open) => !open)}
          aria-expanded={showMap}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-blue-400"
        >
          <MapIcon className="h-4 w-4" aria-hidden="true" />
          Map
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMap(false);
            setEditing(false);
          }}
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
      {showMap ? (
        <div className="mt-3 w-[min(84vw,32rem)] rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
          <AddressMapPicker
            title="Pick your area on the map"
            hint="Search or drop a pin near you. We use that point to find professionals who cover your area."
              onSelect={(selection: any) => {
                const pickedArea = selection.area || selection.city || null;
                setPoint({ area: pickedArea, lat: selection.lat, lng: selection.lng });
                setDraft(pickedArea ?? '');
                setShowMap(false);
                setEditing(false);
              }}
          />
        </div>
      ) : null}
    </form>
  );
}

/**
 * The server's sentence about the location. It renders nothing when there is no
 * location at all — silence is the right answer to a question nobody has asked
 * yet, and a nag about it on a first visit is the wrong first impression.
 */
export function LocationBanner({
  summary,
  className = '',
}: {
  summary?: LocationSummary | null;
  className?: string;
}) {
  const { summary: contextSummary, hasLocation } = usePublicLocation();
  const resolved = summary ?? contextSummary;
  if (!resolved || !hasLocation) return null;

  const uncovered = resolved.localityId === null;
  const tone = uncovered
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : 'border-blue-100 bg-blue-50 text-blue-900';

  return (
    <p className={`rounded-lg border px-3 py-2 text-sm ${tone} ${className}`} role="status">
      {resolved.message}
      {resolved.distanceKm != null ? ` (${resolved.distanceKm.toFixed(1)} km away)` : ''}
    </p>
  );
}
