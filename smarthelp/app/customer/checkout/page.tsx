'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { PublicLocationProvider } from '@/components/catalogue/PublicLocationContext';
import { CheckoutForm } from '@/components/catalogue/CheckoutForm';
import { fetchService } from '@/lib/catalogueClient';
import type { ServiceSummary } from '@/lib/catalogue';

/**
 * `/customer/checkout` (§20.5).
 *
 * The service arrives as a slug in the query string from `BookingPanel` and is
 * re-read from `/api/services/[slug]` here. Re-reading rather than passing the
 * card's summary forward is deliberate: the catalogue page can be open for an
 * hour before somebody clicks through, and the duration and price that mattered
 * were the ones shown *at that moment*. The server re-prices everything anyway, so
 * the only thing carried forward in the query string is the customer's intent.
 *
 * Nothing here renders without a service. A checkout for a slug that no longer
 * exists says so and offers the catalogue, rather than rendering a form that
 * will fail at submit.
 */

function CheckoutInner() {
  const params = useSearchParams();
  const slug = params.get('service');
  const durationParam = Number(params.get('duration'));
  const bookingType = params.get('bookingType') as 'instant' | 'scheduled' | null;
  const slot = params.get('slot');
  // The slot came from a picker that was showing this length. Kept apart from the
  // length the form starts on so the form can say when the customer has changed it
  // to something the slot may not hold.
  const slotForDuration =
    Number.isFinite(durationParam) && durationParam > 0 ? durationParam : null;

  const [service, setService] = useState<ServiceSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) {
      setProblem('Pick a service first.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchService(slug)
      .then((result) => {
        if (!cancelled) setService(result.service);
      })
      .catch(() => {
        if (!cancelled) setProblem('That service is no longer available.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const duration =
    Number.isFinite(durationParam) && durationParam > 0
      ? durationParam
      : (service?.durations[0] ?? service?.minDurationMinutes ?? 60);

  return (
    <RoleShell role="customer" eyebrow="Checkout" title="Confirm your booking">
      {loading ? (
        <p className="text-sm text-gray-600">Loading…</p>
      ) : problem ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-700">{problem}</p>
          <Link
            href="/services"
            className="mt-4 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Browse services
          </Link>
        </div>
      ) : service ? (
        <PublicLocationProvider>
          <CheckoutForm
            serviceId={service.id}
            serviceName={service.name}
            durationMinutes={duration}
            durations={service.durations}
            slotStart={slot}
            bookingType={bookingType}
            slotForDurationMinutes={slot ? slotForDuration : null}
          />
        </PublicLocationProvider>
      ) : null}
    </RoleShell>
  );
}

export default function CheckoutPage() {
  return (
    <AuthGuard role="customer">
      <Suspense fallback={<RoleShell role="customer" eyebrow="Checkout" title="Confirm your booking"><p className="text-sm text-gray-600">Loading…</p></RoleShell>}>
        <CheckoutInner />
      </Suspense>
    </AuthGuard>
  );
}