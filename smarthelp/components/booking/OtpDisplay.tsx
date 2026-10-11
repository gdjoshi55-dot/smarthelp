'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { BookingApiError, regenerateServiceOtp } from '@/lib/bookingClient';

/**
 * The customer's start code (§20.6, §22.3, D3, Interaction Contract 8).
 *
 * The code is hash-only in the database, so this is the only place the plaintext
 * is ever visible: the first mint happens on arrival, the response is cached in
 * `sessionStorage` for the session, and a refresh after expiry asks for a new
 * one — up to three generations. The component never invents a code; if the
 * cache is cold and the cap is not reached it asks the server, and if that fails
 * it says so rather than showing empty slots that look like a code nobody read
 * out.
 *
 * The countdown is `otpExpiresAt − serverNow`, re-anchored from the track poll
 * and decremented locally between polls. `Date.now()` is never the anchor
 * (Interaction Contract 2): a device with a skewed clock must not tell the
 * customer their valid code has expired.
 */

const CACHE_PREFIX = 'smarthelp:otp:';

interface CachedCode {
  code: string;
  expiresAt: string;
}

function cacheKey(bookingId: string): string {
  return `${CACHE_PREFIX}${bookingId}`;
}

function readCached(bookingId: string): CachedCode | null {
  try {
    const raw = window.sessionStorage.getItem(CACHE_PREFIX + bookingId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: unknown; expiresAt?: unknown };
    if (typeof parsed.code === 'string' && typeof parsed.expiresAt === 'string') {
      return { code: parsed.code, expiresAt: parsed.expiresAt };
    }
  } catch {
    // Private browsing can throw on sessionStorage; a missing cache only means
    // "ask again", which is the safe direction.
  }
  return null;
}

function writeCache(bookingId: string, value: CachedCode): void {
  try {
    window.sessionStorage.setItem(`${CACHE_PREFIX}${bookingId}`, JSON.stringify(value));
  } catch {
    // Nothing to do: the code is still on screen for this render.
  }
}

/** The later of two instants, treating a missing one as "not later". */
function pickLater(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function secondsUntil(expires: string | null, serverNow: string | null): number | null {
  if (!expires || !serverNow) return null;
  const ms = new Date(expires).getTime() - new Date(serverNow).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function OtpDisplay({
  bookingId,
  expiresAt,
  serverNow,
  generationsRemaining,
}: {
  bookingId: string;
  /** The server's `otpExpiresAt` from the latest track poll. */
  expiresAt: string | null;
  /** When the server computed the poll — the countdown's anchor. */
  serverNow: string | null;
  /** Nulls until the first poll; 0 means the three-generation cap is reached. */
  generationsRemaining: number | null;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [cachedExpiresAt, setCachedExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atCap, setAtCap] = useState(false);

  const inFlight = useRef(false);
  const autoMinted = useRef(false);

  // Any code minted earlier this session, restored on mount. Read in an effect
  // rather than during render so the server render and the first client render
  // agree (sessionStorage does not exist on the server).
  useEffect(() => {
    const cached = readCached(bookingId);
    setCode(cached?.code ?? null);
    setCachedExpiresAt(cached?.expiresAt ?? null);
  }, [bookingId]);

  const mint = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const fresh = await regenerateServiceOtp(bookingId);
      try {
        window.sessionStorage.setItem(`${CACHE_PREFIX}${bookingId}`, JSON.stringify(fresh));
      } catch {
        // A cache write that fails is not a failure to show the code.
      }
      setCode(fresh.code);
      setCachedExpiresAt(fresh.expiresAt);
      setAtCap(false);
    } catch (e) {
      if (e instanceof BookingApiError && e.code === 'INVALID_STATE') {
        setAtCap(true);
      } else {
        setError('We could not get a new code. Try again in a moment.');
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [bookingId]);

  // Generation 1: minted on arrival, not at booking creation (D3). Once only,
  // and never once the cap is known to be reached.
  useEffect(() => {
    if (code || autoMinted.current) return;
    if (generationsRemaining == null || generationsRemaining <= 0) return;
    autoMinted.current = true;
    void mint();
  }, [code, generationsRemaining, mint]);

  const capped = atCap || generationsRemaining === 0;
  const effectiveExpiresAt = pickLater(cachedExpiresAt, expiresAt ?? null);

  const [remaining, setRemaining] = useState<number | null>(() =>
    secondsUntil(effectiveExpiresAt, serverNow)
  );
  useEffect(() => {
    setRemaining(secondsUntil(effectiveExpiresAt, serverNow));
    const timer = window.setInterval(() => {
      setRemaining((current) => (current == null ? current : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [effectiveExpiresAt, serverNow]);

  const expired = remaining != null && remaining <= 0;
  const showCountdown = code != null && remaining != null && remaining > 0;

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
      <h2 className="text-sm font-semibold text-amber-900">Your start code</h2>
      <p className="mt-1 text-sm text-amber-800">
        Read this code to the professional so they can start your job.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-5">
        {code ? (
          <p
            className="text-2xl font-semibold tabular-nums tracking-[0.4em] text-gray-900"
            aria-label={`Start code ${code.split('').join(' ')}`}
            aria-live="polite"
          >
            {code}
          </p>
        ) : (
          <p className="text-2xl font-semibold tabular-nums tracking-[0.4em] text-amber-300">
            ••••
          </p>
        )}

        <div className="flex flex-col items-start gap-2">
          {showCountdown ? (
            <p className="text-sm text-amber-800" role="timer" aria-label={`Code expires in ${remaining} seconds`}>
              Expires in <span className="tabular-nums">{formatClock(remaining as number)}</span>
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void mint()}
              disabled={busy || capped || (!code && remaining == null)}
              aria-busy={busy}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              {busy ? (
                <>
                  <LoadingSpinner size="sm" />
                  Getting a code…
                </>
              ) : (
                'Get a new code'
              )}
            </button>
          )}

          {capped ? (
            <p className="text-sm text-amber-700">New code limit reached — ask support.</p>
          ) : error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
