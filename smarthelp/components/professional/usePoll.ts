'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polling, never Realtime (Interaction Contract 1).
 *
 * One hook, because the offers inbox and the jobs list carry the same four
 * obligations and a second copy would drift: fetch immediately, then every
 * `intervalMs`; never let two requests overlap (a slow response must not stack
 * behind a fast one); skip ticks while `document.hidden` and refresh the moment
 * the tab is visible again; and stop on unmount.
 *
 * The fetcher is held in a ref, so an inline arrow at the call site does not
 * restart the interval on every render — a trap that turns a 5s poll into a
 * request per keystroke.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  { enabled, intervalMs = 5000 }: { enabled: boolean; intervalMs?: number } = { enabled: false }
): { data: T | null; error: boolean; loading: boolean; refresh: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const inFlight = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetcherRef.current();
      if (alive.current) {
        setData(next);
        setError(false);
      }
    } catch {
      if (alive.current) setError(true);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    alive.current = true;
    void load();

    const tick = () => {
      if (!document.hidden) void load();
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive.current = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, load]);

  return { data, error, loading, refresh: load };
}
