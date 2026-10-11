'use client';

import { useEffect, useState } from 'react';
import { Clock, IndianRupee, MapPin } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import type { Offer } from '@/lib/professionalClient';

/**
 * The offer card (UI-SPEC OQ-4).
 *
 * The field set is exactly the inbox contract and nothing more — service name,
 * window, area only, quoted price, the countdown, and the two CTAs. The privacy
 * gate (§14.3 / Interaction Contract 6) is enforced server-side by
 * `stripProBooking`, and this card compounds it by simply not having a field for
 * a phone number, a street address or a full customer name.
 *
 * The Accept CTA is the visual anchor and the only blue; Decline is an outline,
 * deliberately not red (Copywriting Contract) — a decline is a choice, not a
 * destructive act. There is no optimistic transition (Interaction Contract 4):
 * the page owns the busy state and the card only reflects it.
 */
export function OfferCard({
  offer,
  serverNow,
  busy,
  onAccept,
  onDecline,
}: {
  offer: Offer;
  serverNow: string;
  busy: boolean;
  onAccept: (offer: Offer) => void;
  onDecline: (offer: Offer) => void;
}) {
  const remainingMs = useCountdown(offer.expiresAt, serverNow);
  const expired = remainingMs <= 0;

  return (
    <article className="rounded-2xl bg-white p-6 shadow-xl">
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-base font-semibold text-gray-900">{offer.serviceName}</h3>
        <span className="inline-flex shrink-0 items-center gap-1 text-lg font-semibold tabular-nums text-gray-900">
          <IndianRupee className="h-4 w-4 text-gray-400" aria-hidden="true" />
          {formatPrice(offer.quotedPrice)}
        </span>
      </div>

      <dl className="mt-3 space-y-1.5 text-sm text-gray-600">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-400" aria-hidden="true" />
          <dd>{formatWindow(offer.scheduledStartAt, offer.scheduledEndAt)}</dd>
        </div>
        {offer.area ? (
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-gray-400" aria-hidden="true" />
            <dd>{offer.area}</dd>
          </div>
        ) : null}
      </dl>

      <p
        className={`mt-3 text-xs font-semibold ${
          expired ? 'text-red-600' : 'text-gray-500'
        }`}
      >
        {expired ? (
          'This offer has expired.'
        ) : (
          <>
            Expires in <span className="tabular-nums">{formatCountdown(remainingMs)}</span>
          </>
        )}
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => onAccept(offer)}
          disabled={busy || expired}
          aria-busy={busy}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {busy ? (
            <>
              <LoadingSpinner size="sm" />
              <span>Accepting…</span>
            </>
          ) : (
            'Accept offer'
          )}
        </button>
        <button
          type="button"
          onClick={() => onDecline(offer)}
          disabled={busy}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Decline offer
        </button>
      </div>
    </article>
  );
}

/**
 * Remaining time, anchored to server time and re-anchored on every poll
 * (Interaction Contract 2 / §22.3).
 *
 * `serverNow` is the anchor: at mount the remaining time is `expiresAt −
 * serverNow`, a server computation, and it then decrements only by elapsed local
 * time until the next 5s poll replaces the anchor. A long-lived `Date.now()`
 * delta would drift; a per-render recompute against a frozen `serverNow` would
 * not count down at all.
 */
function useCountdown(expiresAt: string, serverNow: string): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Date.parse(expiresAt) - Date.parse(serverNow))
  );

  useEffect(() => {
    const initial = Math.max(0, Date.parse(expiresAt) - Date.parse(serverNow));
    const startedAt = Date.now();
    setRemaining(initial);
    const id = window.setInterval(() => {
      setRemaining(Math.max(0, initial - (Date.now() - startedAt)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, serverNow]);

  return remaining;
}

function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPrice(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start) return 'Time to be confirmed';
  const startDate = new Date(start);
  const date = startDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const startTime = startDate.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (!end) return `${date} · ${startTime}`;
  const endTime = new Date(end).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${date} · ${startTime} – ${endTime}`;
}
