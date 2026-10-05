'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LocationSummary } from '@/lib/catalogue';
import type { LocationQueryInput } from '@/lib/catalogueClient';

/**
 * "Where are you?", remembered for the whole public session (§5.2, §5.3).
 *
 * The answer is a locality, but the person gives it in one of three ways — a
 * saved address, a typed area, or a browser fix — and the screens need the
 * query string of whichever they used, not a resolved locality of their own.
 * Resolving is the server's job: it is the only side that can read the geography
 * table and the service areas, and a client that resolved its own locality would
 * be answering a question it cannot keep in step with.
 *
 * So this holds the *input* (`area`, `lat`, `lng`) and the *answer* the API
 * handed back, and shares both. The answer is deliberately not persisted: it is a
 * cache of a server decision, and a stale one is worse than a re-fetch.
 *
 * It lives in `localStorage` because a person who types their area once and then
 * clicks through to a service should not have to type it again, and because the
 * browser fix is the only cheap way to get a location at all. Nothing here is
 * required: a first visit with no location is a valid state that the UI has to
 * handle, not an error.
 */

const STORAGE_KEY = 'smarthelp.publicLocation.v1';

/** Two queries are the same question when every part of the answer is equal. */
function sameLocation(a: LocationQueryInput, b: LocationQueryInput): boolean {
  return (
    (a.addressId ?? null) === (b.addressId ?? null) &&
    (a.area ?? null) === (b.area ?? null) &&
    (a.lat ?? null) === (b.lat ?? null) &&
    (a.lng ?? null) === (b.lng ?? null)
  );
}

export interface PublicLocation extends LocationQueryInput {
  /** Resolved locality, once the API has said. `null` before that, and when unresolved. */
  summary: LocationSummary | null;
  /** True while a request for a new location is in flight. */
  resolving: boolean;
  /** Why the last attempt produced no locality, if it did. */
  problem: string | null;
  hasLocation: boolean;
  setArea: (area: string) => void;
  /**
   * Switch to a saved address.
   *
   * The id alone is sent. The address already knows its own area and point, and
   * the server resolves and ownership-checks it from the row — sending the area
   * too would only risk answering with a copy of it that has since changed.
   *
   * Named without the `use` prefix on purpose. These three are event handlers
   * that change context state, not hooks that read it, and calling one from an
   * `onChange` callback is exactly what `rules-of-hooks` refuses to allow when it
   * believes it is looking at a hook. The earlier `useAddress(name)` was called
   * from inside `SavedAddressPicker`'s select handler and failed lint for
   * precisely that reason — the name was doing the harm, not the call.
   */
  selectAddress: (addressId: string) => void;
  locateMe: () => void;
  clear: () => void;
  /**
   * Publishes the summary an API response carried, along with the query it was
   * answering. Only a response for the *current* query counts.
   */
  reportSummary: (query: LocationQueryInput, summary: LocationSummary) => void;
}

const LocationContext = createContext<PublicLocation | null>(null);

/** Reads the stored query, ignoring anything that is not a usable one. */
function readStoredLocation(): LocationQueryInput | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocationQueryInput;
    if (typeof parsed.addressId === 'string' && parsed.addressId.trim().length > 0) {
      return { addressId: parsed.addressId.trim() };
    }
    const hasArea = typeof parsed.area === 'string' && parsed.area.trim().length > 0;
    const hasPoint = Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng);
    if (!hasArea && !hasPoint) return null;
    return {
      area: hasArea ? parsed.area!.trim() : null,
      lat: hasPoint ? Number(parsed.lat) : null,
      lng: hasPoint ? Number(parsed.lng) : null,
    };
  } catch {
    // A corrupt or unreadable store is not worth an error boundary: the worst
    // case is that the person is asked for their area again.
    return null;
  }
}

function writeStoredLocation(location: LocationQueryInput | null) {
  if (typeof window === 'undefined') return;
  try {
    if (location) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing refuses to write. The location still works for this page.
  }
}

export function PublicLocationProvider({
  children,
  initialSummary = null,
}: {
  children: ReactNode;
  /** The server-rendered page already knows the answer; hand it down. */
  initialSummary?: LocationSummary | null;
}) {
  const [location, setLocation] = useState<LocationQueryInput | null>(null);
  const [summary, setSummary] = useState<LocationSummary | null>(initialSummary);
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const locationRef = useRef<LocationQueryInput | null>(null);

  useEffect(() => {
    const stored = readStoredLocation();
    locationRef.current = stored;
    setLocation(stored);
  }, []);

  /** Every mutation goes through here so the ref and the state cannot disagree. */
  const applyLocation = useCallback((next: LocationQueryInput | null) => {
    locationRef.current = next;
    setLocation(next);
  }, []);

  const setArea = useCallback(
    (area: string) => {
      const trimmed = area.trim();
      // A fresh area drops the old pin: a fix from one neighbourhood used to
      // vouch for a locality in another is the kind of thing that sends somebody
      // to the wrong building. It drops the saved address too, for the same
      // reason — a typed area is a different answer to the question.
      const next: LocationQueryInput = {
        addressId: null,
        area: trimmed,
        lat: null,
        lng: null,
      };
      applyLocation(next);
      writeStoredLocation(next);
    },
    [applyLocation]
  );

  const selectAddress = useCallback(
    (addressId: string) => {
      const trimmed = addressId.trim();
      if (!trimmed) return;
      const next: LocationQueryInput = { addressId: trimmed };
      applyLocation(next);
      writeStoredLocation(next);
    },
    [applyLocation]
  );

  const locateMe = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setProblem('This browser will not share your location. Type your area instead.');
      return;
    }
    setResolving(true);
    setProblem(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next: LocationQueryInput = {
          addressId: null,
          area: null,
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        };
        applyLocation(next);
        writeStoredLocation(next);
        setResolving(false);
      },
      () => {
        // §5.2: a declined prompt is not a failure, it is a choice. The typed
        // area is the fallback and the copy has to point at it.
        setProblem('We could not use your location. Type your area instead.');
        setResolving(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }, [applyLocation]);

  const clear = useCallback(() => {
    applyLocation(null);
    setSummary(null);
    setProblem(null);
    writeStoredLocation(null);
  }, [applyLocation]);

  const reportSummary = useCallback((query: LocationQueryInput, next: LocationSummary) => {
    const current = locationRef.current;
    // A response answers the question that was asked, not the one being asked
    // now. Someone who typed a new area while the old request was in flight
    // would otherwise be told about a locality they have moved away from.
    if (current && !sameLocation(current, query)) return;
    setSummary(next);
    setProblem(next.localityId ? null : next.message);
  }, []);

  const value = useMemo<PublicLocation>(
    () => ({
      ...(location ?? {}),
      summary,
      resolving,
      problem,
      hasLocation:
        !!location?.addressId ||
        !!location?.area ||
        (location?.lat != null && location.lng != null),
      setArea,
      selectAddress,
      locateMe,
      clear,
      reportSummary,
    }),
    [
      location,
      summary,
      resolving,
      problem,
      setArea,
      selectAddress,
      locateMe,
      clear,
      reportSummary,
    ]
  );

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function usePublicLocation(): PublicLocation {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error('usePublicLocation must be used inside a PublicLocationProvider');
  }
  return context;
}

/**
 * The context, or `null` when there is no provider above.
 *
 * For the components that can work *without* a session location. `SlotPicker` is
 * one: on a reschedule the address is the one frozen on the booking, supplied as
 * a prop, and a picker that insisted on a public session would have demanded a
 * provider — and with it a "where are you?" screen — on a page that already knows
 * exactly where the job is. Callers that genuinely need the session use
 * `usePublicLocation`, which still throws.
 */
export function useOptionalPublicLocation(): PublicLocation | null {
  return useContext(LocationContext);
}
