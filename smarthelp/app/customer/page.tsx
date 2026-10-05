'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, CreditCard, Headphones, Star, User } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';
import { BookingStatusBadge } from '@/components/catalogue/PriceBreakdown';
import { formatBookingWhen } from '@/components/catalogue/bookingFormat';
import { fetchBookings, type BookingRow } from '@/lib/bookingClient';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900 tabular-nums">{value}</p>
    </div>
  );
}

/**
 * The states a booking can be in and still be worth showing on the home screen.
 *
 * A list of everything would be a wall of finished and cancelled jobs. These are
 * the ones somebody would call "mine right now".
 */
const LIVE_STATUSES = ['payment_pending', 'assigned', 'in_progress'];

function useUpcomingBookings() {
  const [bookings, setBookings] = useState<BookingRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    // The three live statuses are fetched separately rather than filtered on the
    // client: the list route has no "these statuses" filter, and fetching 25
    // bookings to keep three is how a home page gets slow.
    Promise.all(
      LIVE_STATUSES.map((status) =>
        fetchBookings({ status, limit: 5 }).catch(() => ({ bookings: [], total: 0, limit: 0, offset: 0 }))
      )
    ).then((results) => {
      if (cancelled) return;
      setBookings(results.flatMap((result) => result.bookings));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return bookings;
}

export default function CustomerHome() {
  const { customer } = useAuth();
  const upcoming = useUpcomingBookings();

  return (
    <AuthGuard role="customer">
      <RoleShell role="customer" eyebrow="Customer" title="Your home services, in one place">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900">Book a service</h2>
              <p className="mt-1 text-sm text-gray-600">
                Browse verified professionals, see the price before you confirm, and pick a slot that
                suits you.
              </p>
              <Link
                href="/services"
                className="mt-4 inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700"
              >
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
                Browse services
              </Link>
            </section>

            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">Your bookings</h2>
                  <p className="mt-1 text-sm text-gray-600">
                    {upcoming.length > 0
                      ? `${upcoming.length} booking${upcoming.length === 1 ? '' : 's'} in flight.`
                      : 'No bookings yet. Your upcoming and past jobs will appear here.'}
                  </p>
                </div>
                <Link
                  href="/customer/bookings"
                  className="shrink-0 text-sm font-medium text-blue-700 hover:underline"
                >
                  See all
                </Link>
              </div>

              {upcoming.length === 0 ? (
                <p className="mt-4 text-sm text-gray-500">
                  Nothing scheduled right now.
                </p>
              ) : (
                <ul className="mt-4 space-y-2">
                  {upcoming.map((booking) => (
                    <li key={booking.id}>
                      <Link
                        href={`/customer/bookings/${booking.id}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2 hover:border-blue-200 hover:bg-blue-50/40"
                      >
                        <span className="min-w-0">
                          <span className="block font-mono text-xs text-gray-500">
                            {booking.booking_number}
                          </span>
                          <span className="block truncate text-sm text-gray-900">
                            {formatBookingWhen(booking.scheduled_start_at)}
                          </span>
                        </span>
                        <BookingStatusBadge status={booking.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Total bookings" value={customer?.total_bookings ?? 0} />
              <Stat label="Completed" value={customer?.completed_bookings ?? 0} />
            </div>

            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900">Your referral code</h2>
              <p className="mt-2 font-mono text-lg font-semibold text-blue-700">
                {customer?.referral_code ?? '—'}
              </p>
              <p className="mt-2 text-xs text-gray-500">
                Share it with a neighbour. When they complete a booking, you both get ₹100.
              </p>
            </section>

            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900">Quick links</h2>
              <ul className="mt-3 space-y-1">
                {[
                  { href: '#', label: 'Wallet & refunds', icon: CreditCard },
                  { href: '#', label: 'Favourites', icon: Star },
                  { href: '#', label: 'Support', icon: Headphones },
                  { href: '#', label: 'Profile', icon: User },
                ].map(({ href, label, icon: Icon }) => (
                  <li key={label}>
                    <Link
                      href={href}
                      className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Icon className="h-4 w-4 text-gray-400" aria-hidden="true" />
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </RoleShell>
    </AuthGuard>
  );
}
