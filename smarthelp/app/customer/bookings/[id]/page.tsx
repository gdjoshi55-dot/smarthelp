'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowLeft, CalendarClock, Loader2, XCircle } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { BookingStatusBadge } from '@/components/catalogue/PriceBreakdown';
import { BookingTimeline } from '@/components/catalogue/BookingTimeline';
import { CancelBookingDialog } from '@/components/catalogue/CancelBookingDialog';
import { ReschedulePanel } from '@/components/catalogue/ReschedulePanel';
import { InvoiceView } from '@/components/catalogue/InvoiceView';
import { EmptyState } from '@/components/catalogue/EmptyState';
import { formatBookingWhen } from '@/components/catalogue/bookingFormat';
import { OtpDisplay } from '@/components/booking/OtpDisplay';
import { ServiceTimer } from '@/components/booking/ServiceTimer';
import {
  fetchBooking,
  fetchBookingTrack,
  fetchInvoice,
  BookingApiError,
  type BookingDetailResult,
  type BookingTrackResult,
  type InvoiceResult,
  type CancelResult,
} from '@/lib/bookingClient';
import type { BookingStatus } from '@/lib/supabase';
import type { LocationQueryInput } from '@/lib/catalogueClient';
import type { RouteInfo } from '@/components/map/RouteMap';

/**
 * `/customer/bookings/[id]` (§20.6).
 *
 * ## The version is state, not a lookup
 *
 * Every mutating call on this page sends the `version` currently on screen. After
 * a successful reschedule the response carries the new row *and* the new version,
 * and this page adopts both — so a cancel immediately after a reschedule cannot
 * fail on a version it has already spent. Refetching instead would work too, but
 * it puts a round trip between "moved" and "you may now cancel", which is where
 * customers press the button twice.
 *
 * ## What is shown and when
 *
 * The invoice is fetched lazily, one render after the booking resolves. It is the
 * biggest block on the page and most visits — checking whether somebody is on the
 * way — never scroll to it. The attempt is remembered in a ref rather than in
 * `data`, because "no invoice yet" and "the invoice request failed" are the same
 * state to this component and must not be two: deriving the effect's dependency
 * from `data` re-ran it on every `setData`, which turned one failure into a
 * request per render.
 *
 * The reschedule panel only appears when the server said the state machine allows
 * the move. `reschedulable` comes from the same `isReschedulableStatus` list the
 * reschedule route enforces, so the button can never be offered for a move that
 * would 409 — including a booking whose professional is already on the way, which
 * a "is it cancellable" test would have wrongly allowed.
 *
 * ## The live view
 *
 * While a booking is in flight the page polls `/track` every 15 s. The poll owns
 * the status, the timer and the start code, and the initial detail read is the
 * floor it improves on: every status-dependent element reads `liveStatus`, which
 * is the poll's answer when there is one and the detail's otherwise. The timer
 * numbers are the server's — `endsAt` and `serverNow` travel together and never
 * meet `Date.now()` — so a phone with a wrong clock cannot lie to its owner about
 * how long is left. The poll is skipped while the tab is hidden and the moment
 * the tab returns, and a failed tick keeps the last good payload rather than
 * blanking the screen.
 */

// Google Maps touches `window` at import time, so the map is never part of the
// server bundle: it is a client-only dynamic import that loads when a map first
// renders and shows a plain placeholder until then.
const TrackingMap = dynamic(() => import('@/components/map/TrackingMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
      Loading map…
    </div>
  ),
});

interface Loaded {
  detail: BookingDetailResult;
  invoice: InvoiceResult | null;
}

function bookingLocation(booking: BookingDetailResult['booking']): LocationQueryInput | null {
  const snapshot = booking.address_snapshot as {
    lat?: number | null;
    lng?: number | null;
    area?: string | null;
    city?: string | null;
  };
  const lat = typeof snapshot.lat === 'number' ? snapshot.lat : null;
  const lng = typeof snapshot.lng === 'number' ? snapshot.lng : null;
  const area = snapshot.area ?? snapshot.city ?? null;
  if (lat == null || lng == null) {
    return area ? { area } : null;
  }
  return { lat, lng, area };
}

function BookingDetail({ id }: { id: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [track, setTrack] = useState<BookingTrackResult | null>(null);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);

  const load = useCallback(async () => {
    const detail = await fetchBooking(id);
    setData({ detail, invoice: null });
    return detail;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProblem(null);
    setNotFound(false);
    load()
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof BookingApiError && e.code === 'NOT_FOUND') {
          setNotFound(true);
          return;
        }
        setProblem(
          e instanceof BookingApiError ? e.message : 'We could not load this booking right now.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // The invoice is a second request that only some visits need, so it waits for
  // the booking to have resolved and never blocks the status block above it. The
  // ref records that a request has been made for this booking so a failure ends
  // the attempt instead of starting the next one.
  const invoiceRequestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || invoiceRequestedFor.current === id) return;
    invoiceRequestedFor.current = id;
    let cancelled = false;
    fetchInvoice(id)
      .then((invoice) => {
        if (!cancelled) setData((current) => (current ? { ...current, invoice } : current));
      })
      .catch(() => {
        // A missing invoice is not a reason to fail the page; the price is also
        // on the booking row, and the receipt is an extra.
      });
    return () => {
      cancelled = true;
    };
  }, [data, id]);

  // The live view: a 15 s poll of `/track` once the booking has resolved
  // (§10.2, Interaction Contract 2). The dependency is `loaded`, not `data`, so
  // the invoice arriving mid-poll does not tear the interval down and start a
  // fresh one. A tick is skipped while one is still in flight and while the tab
  // is hidden, and the moment the tab returns the poll runs immediately rather
  // than waiting out the interval.
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    const tick = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const next = await fetchBookingTrack(id, { signal: controller.signal });
        if (!cancelled) setTrack(next);
      } catch {
        // Keep the last good payload; a missed poll is not a blanked screen.
      } finally {
        inFlight = false;
        controller = null;
      }
    };

    void tick();
    const interval = window.setInterval(tick, 15_000);
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
    };
  }, [id, loaded]);

  const location = useMemo(
    () => (data ? bookingLocation(data.detail.booking) : null),
    [data]
  );

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-gray-600" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading this booking…
      </p>
    );
  }

  if (notFound) {
    return (
      <EmptyState
        title="We could not find that booking"
        message="It may have been removed, or the link may be for somebody else's booking."
        action={{ href: '/customer/bookings', label: 'Back to your bookings' }}
      />
    );
  }

  if (problem || !data) {
    return (
      <div className="space-y-4">
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {problem ?? 'Something went wrong.'}
        </p>
        <Link href="/customer/bookings" className="text-sm font-medium text-blue-700 hover:underline">
          Back to your bookings
        </Link>
      </div>
    );
  }

  const { booking, status, cancellable, reschedulable, items, history } = data.detail;

  // The poll is the source of truth once it has answered; the detail read is the
  // floor it improves on. The badge, the description and the timeline all read
  // `liveStatus`, so a job that went `on_the_way` a second ago shows it without a
  // reload — and while the tab was hidden and polls paused, it still shows the
  // last state the server named.
  const liveStatus = (track?.status ?? booking.status) as BookingStatus;
  const presentation = track?.presentation ?? status;

  // The map's pins come from two independent sources: the address snapshot on
  // the booking (where the job is) and the track poll's `proLocation` (where the
  // professional is right now, or null when no fresh ping exists). Either pin
  // alone is worth showing; with neither there is nothing to plot.
  const proLocation = track?.proLocation ?? null;
  const destination =
    location && location.lat != null && location.lng != null
      ? { lat: location.lat, lng: location.lng }
      : null;
  const showMap = proLocation != null || destination != null;

  // The map's route duration is the accurate one; the track payload's fallback
  // covers the first seconds before Google has calculated the route.
  const liveEtaMinutes =
    liveStatus === 'on_the_way' && proLocation
      ? routeInfo?.durationMinutes ?? track?.etaMinutes ?? null
      : null;
  const liveDistanceKm =
    liveStatus === 'on_the_way' && proLocation
      ? routeInfo?.distanceKm ?? track?.distanceKm ?? null
      : null;

  const firstServiceId = items[0]?.service_id ?? null;
  const showReschedule = reschedulable && firstServiceId != null;

  return (
    <div>
      <Link
        href="/customer/bookings"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        All bookings
      </Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-gray-500">{booking.booking_number}</span>
              <BookingStatusBadge status={liveStatus} />
            </div>
            <p className="mt-2 text-lg font-semibold text-gray-900">
              {formatBookingWhen(booking.scheduled_start_at)}
            </p>
            <p className="mt-1 text-sm text-gray-600">{presentation.description}</p>
            {liveStatus === 'on_the_way' ? (
              <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
                {proLocation ? (
                  liveEtaMinutes != null ? (
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                          Arriving in
                        </p>
                        <p className="mt-1 text-3xl font-bold leading-none text-blue-900">
                          ~{liveEtaMinutes} min
                        </p>
                      </div>
                      {liveDistanceKm != null ? (
                        <p className="text-sm font-medium text-blue-800">
                          {liveDistanceKm.toFixed(1)} km away
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-blue-900">
                      {destination
                        ? 'Your professional is on the way. Calculating the arrival time…'
                        : 'Your professional is on the way. Arrival time is unavailable for this address.'}
                    </p>
                  )
                ) : (
                  <p className="text-sm font-medium text-blue-900">
                    Your professional is on the way. Waiting for their live location&hellip;
                  </p>
                )}
              </div>
            ) : null}
            {liveStatus === 'payment_pending' ? (
              // A booking is created in `payment_pending` because payment is the
              // next release, not because the customer did something wrong. Landing
              // here from checkout with a silent "payment pending" reads as a
              // failure that nobody is going to fix, so say what the state means.
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span className="font-medium">Awaiting payment. </span>
                Your booking is held and your slot is reserved. Taking payment is
                the next step in this release — nothing further is needed from you
                yet, and you can cancel for free until then.
              </p>
            ) : null}
            {booking.notes ? (
              <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                <span className="font-medium text-gray-900">Your note: </span>
                {booking.notes}
              </p>
            ) : null}
            {/* While the job is running the timer is the most-consulted thing on
                the page, so it sits in the status card rather than below it. Both
                terms come from the track poll; before the first answer it renders
                nothing. */}
            {liveStatus === 'in_progress' ? (
              <ServiceTimer
                endsAt={track?.endsAt ?? null}
                serverNow={track?.serverNow ?? null}
                className="mt-3"
              />
            ) : null}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Progress</h2>
            <BookingTimeline status={liveStatus} history={history} />
          </section>

          {/* The start code appears exactly when it is useful — the professional
              has arrived and is about to verify it — and disappears once they
              have, so the customer is not left staring at a dead code. */}
          {liveStatus === 'arrived' ? (
            <OtpDisplay
              bookingId={booking.id}
              expiresAt={track?.otpExpiresAt ?? null}
              serverNow={track?.serverNow ?? null}
              generationsRemaining={track?.otpGenerationsRemaining ?? null}
            />
          ) : null}

          {showReschedule ? (
            <ReschedulePanel
              bookingId={booking.id}
              version={booking.version}
              serviceId={firstServiceId}
              durationMinutes={booking.duration_minutes}
              location={location}
              onRescheduled={(result) =>
                setData((current) =>
                  current
                    ? {
                        ...current,
                        detail: {
                          ...current.detail,
                          booking: result.booking,
                          // The reschedule response has no status block; the state
                          // did not change, so the one on screen is still true.
                        },
                      }
                    : current
                )
              }
            />
          ) : null}
        </div>

        <div className="space-y-5 lg:col-span-2">
          {showMap ? (
            <section className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-gray-900">
                {proLocation ? 'Live location' : 'Service location'}
              </h2>
              <TrackingMap
                destination={destination}
                pro={proLocation}
                className="h-64 w-full rounded-lg"
                showRoute
                onRoute={setRouteInfo}
              />
              {proLocation ? (
                <p className="mt-2 text-xs text-gray-500">
                  Live &mdash; the professional&rsquo;s position keeps updating while they are on the way.
                </p>
              ) : liveStatus === 'on_the_way' ? (
                <p className="mt-2 text-xs text-gray-500">
                  Waiting for the professional to share their live location.
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Services</h2>
            <ul className="space-y-2">
              {items.map((item, index) => (
                <li key={`${item.service_id}-${index}`} className="text-sm text-gray-800">
                  {item.service_name}
                  <span className="text-gray-500">
                    {item.quantity > 1 ? ` × ${item.quantity}` : ''} ·{' '}
                    {item.duration_minutes >= 60
                      ? `${Math.floor(item.duration_minutes / 60)} h`
                      : `${item.duration_minutes} min`}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {cancellable ? (
            <section className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-gray-900">Need to cancel?</h2>
              <p className="mt-1 text-xs text-gray-600">
                The fee depends on how close the start time is, and it is shown before you confirm.
              </p>
              <button
                type="button"
                onClick={() => setCancelling(true)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                <XCircle className="h-4 w-4" aria-hidden="true" />
                Cancel this booking
              </button>
            </section>
          ) : null}

          {data.invoice ? <InvoiceView data={data.invoice} /> : null}

          {!showReschedule && booking.booking_type === 'scheduled' && !presentation.terminal ? (
            <p className="flex items-center gap-2 rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              This booking can no longer be moved online. Contact support if the time has to change.
            </p>
          ) : null}
        </div>
      </div>

      <CancelBookingDialog
        booking={booking}
        open={cancelling}
        onClose={() => setCancelling(false)}
        onCancelled={(result: CancelResult) => {
          setCancelling(false);
          // The cancel response carries the whole updated row, so the card and
          // the timeline change without a refetch that could show the pre-cancel
          // state for a frame.
          setData((current) =>
            current
              ? {
                  ...current,
                  detail: {
                    ...current.detail,
                    booking: result.booking,
                    cancellable: false,
                  },
                }
              : current
          );
        }}
      />
    </div>
  );
}

export default function CustomerBookingDetailPage({ params }: { params: { id: string } }) {
  return (
    <AuthGuard role="customer" capability="booking.create">
      <RoleShell role="customer" eyebrow="Booking" title="Booking details">
        <BookingDetail id={params.id} />
      </RoleShell>
    </AuthGuard>
  );
}