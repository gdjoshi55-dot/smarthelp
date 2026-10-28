'use client';

import { useEffect, useRef, useState } from 'react';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { postLocation } from '@/lib/professionalClient';

interface LocationSharingState {
  sharing: boolean;
  lastSentAt: number | null;
  problem: string | null;
  /** The device's latest fix, so a map can draw it without a server round trip. */
  position: { lat: number; lng: number } | null;
}

/**
 * Streams the professional's position to `/api/professionals/me/location` while
 * they are travelling, so the customer's track poll has something fresh to show.
 *
 * The browser's `watchPosition` is throttled to the platform's ping window: the
 * route drops anything inside it anyway, and a fix per second would spend the
 * device's battery to write the same row once. Failures are reported once in the
 * sentence the screen shows — a missed ping is not worth ending the journey.
 */
export function useLocationSharing(enabled: boolean): LocationSharingState {
  const [sharing, setSharing] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const lastSentRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setSharing(false);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setProblem('This device cannot share its location. Call the customer if you are delayed.');
      return;
    }

    const throttleMs = Math.max(5, PLATFORM_DEFAULTS.proLocationThrottleSeconds) * 1000;
    let cancelled = false;
    lastSentRef.current = 0;
    setSharing(true);
    setProblem(null);

    const send = (fix: GeolocationPosition) => {
      setPosition({ lat: fix.coords.latitude, lng: fix.coords.longitude });
      const now = Date.now();
      if (inFlightRef.current || now - lastSentRef.current < throttleMs) return;
      inFlightRef.current = true;
      lastSentRef.current = now;
      void postLocation({
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
      })
        .then((result) => {
          if (!cancelled && result.updated) setLastSentAt(Date.now());
        })
        .catch(() => {
          if (!cancelled) {
            setProblem(
              'We could not update your location. The customer may see it a little late.'
            );
          }
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    const watchId = navigator.geolocation.watchPosition(send, () => {
      if (!cancelled) {
        setProblem(
          'Turn on location access so the customer can follow your arrival.'
        );
      }
    }, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 10000,
    });

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watchId);
      setSharing(false);
    };
  }, [enabled]);

  return { sharing, lastSentAt, problem, position };
}
