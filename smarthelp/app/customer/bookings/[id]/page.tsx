'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
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
import {
  fetchBooking,
  fetchInvoice,
  BookingApiError,
  type BookingDetailResult,
  type InvoiceResult,
  type CancelResult,
} from '@/lib/bookingClient';
import type { LocationQueryInput } from '@/lib/catalogueClient';

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
 */

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
              <BookingStatusBadge status={booking.status} />
            </div>
            <p className="mt-2 text-lg font-semibold text-gray-900">
              {formatBookingWhen(booking.scheduled_start_at)}
            </p>
            <p className="mt-1 text-sm text-gray-600">{status.description}</p>
            {booking.status === 'payment_pending' ? (
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
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Progress</h2>
            <BookingTimeline status={booking.status} history={history} />
          </section>

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

          {!showReschedule && booking.booking_type === 'scheduled' && !status.terminal ? (
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