'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2, MapPin } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { BookingStatusBadge } from '@/components/catalogue/PriceBreakdown';
import { EmptyState } from '@/components/catalogue/EmptyState';
import { formatBookingWhen } from '@/components/catalogue/bookingFormat';
import {
  fetchBookings,
  BookingApiError,
  type BookingRow,
  type BookingListResult,
} from '@/lib/bookingClient';
import { parseNumeric } from '@/lib/money';
import { formatPrice } from '@/lib/catalogue';

/**
 * `/customer/bookings` (§20.6).
 *
 * **Filter by status, not by tab.** A customer asking "where is my job?" is
 * asking about the ones in flight, which is `assigned` or `in_progress` — states
 * that are not adjacent and would need two tabs to cover. So the filter is a
 * single select over the whole enum and "All" is the default.
 *
 * Pagination is a "load more" rather than numbered pages. The list is ordered by
 * `scheduled_start_at` through the route's own `created_at DESC`, a customer has
 * a handful of live bookings and a history of finished ones, and a numbered pager
 * would be machinery for a second page nobody reaches.
 *
 * The cards show the *frozen* total, not a re-quote: §16 #19. A list that
 * re-priced four bookings on every render would show four different totals than
 * the ones that were paid.
 */

const FILTERS = [
  { value: '', label: 'All bookings' },
  { value: 'payment_pending', label: 'Payment pending' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

const PAGE_SIZE = 20;

function addressLabel(snapshot: Record<string, unknown>): string | null {
  const typed = snapshot as { formatted?: string; line1?: string; area?: string; city?: string };
  const line = typed.formatted ?? [typed.line1, typed.area ?? typed.city].filter(Boolean).join(', ');
  return line ? line : null;
}

function BookingCard({ booking }: { booking: BookingRow }) {
  const address = addressLabel(booking.address_snapshot);
  return (
    <li>
      <Link
        href={`/customer/bookings/${booking.id}`}
        className="group flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-gray-500">{booking.booking_number}</span>
            <BookingStatusBadge status={booking.status} />
          </div>
          <p className="mt-1.5 text-sm font-semibold text-gray-900">
            {formatBookingWhen(booking.scheduled_start_at)}
          </p>
          {address ? (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {address}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-4 sm:justify-end">
          <p className="text-sm font-semibold tabular-nums text-gray-900">
            {formatPrice(parseNumeric(booking.total_amount))}
          </p>
          <ArrowRight
            className="h-4 w-4 text-gray-400 transition group-hover:translate-x-0.5 group-hover:text-blue-600"
            aria-hidden="true"
          />
        </div>
      </Link>
    </li>
  );
}

function BookingsList() {
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<BookingListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    async (nextStatus: string, offset: number, append: boolean) => {
      const data = await fetchBookings({
        status: nextStatus || null,
        limit: PAGE_SIZE,
        offset,
      });
      setResult((current) =>
        append && current ? { ...data, bookings: [...current.bookings, ...data.bookings] } : data
      );
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProblem(null);
    load(status, 0, false)
      .catch((e: unknown) => {
        if (cancelled) return;
        setProblem(
          e instanceof BookingApiError ? e.message : 'We could not load your bookings right now.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, load]);

  async function loadMore() {
    if (!result) return;
    setLoadingMore(true);
    try {
      await load(status, result.bookings.length, true);
    } catch {
      setProblem('We could not load the rest of your bookings.');
    } finally {
      setLoadingMore(false);
    }
  }

  const bookings = result?.bookings ?? [];
  const hasMore = result ? result.total > result.bookings.length : false;
  const filtering = status !== '';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <span className="sr-only sm:not-sr-only">Show</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
        {result ? (
          <p className="text-xs text-gray-500">
            {result.total} booking{result.total === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>

      <div className="mt-4">
        {loading ? (
          <p className="flex items-center gap-2 py-8 text-sm text-gray-600" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading your bookings…
          </p>
        ) : problem ? (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {problem}
          </p>
        ) : bookings.length === 0 ? (
          // Two different sentences, deliberately: "no bookings" and "no bookings
          // matching this filter" look identical otherwise, and the second one
          // reads as though the customer's bookings have vanished.
          filtering ? (
            <EmptyState
              title="Nothing matches that filter"
              message="Try another status, or clear the filter to see everything."
              action={{ href: '/customer/bookings', label: 'Show all bookings' }}
            />
          ) : (
            <EmptyState
              title="No bookings yet"
              message="Book a service and it will appear here, with its price and every status change."
              action={{ href: '/services', label: 'Browse services' }}
            />
          )
        ) : (
          <ul className="space-y-3">
            {bookings.map((booking) => (
              <BookingCard key={booking.id} booking={booking} />
            ))}
          </ul>
        )}
      </div>

      {hasMore ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-4 w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : `Show more (${result ? result.total - result.bookings.length : 0} older)`}
        </button>
      ) : null}
    </div>
  );
}

export default function CustomerBookingsPage() {
  return (
    <AuthGuard role="customer" capability="booking.create">
      <RoleShell role="customer" eyebrow="Customer" title="Your bookings">
        <BookingsList />
      </RoleShell>
    </AuthGuard>
  );
}