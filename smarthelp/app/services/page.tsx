import { Suspense } from 'react';
import type { Metadata } from 'next';
import { categorySummaries, describeLocation, getCatalogue, loadServiceContext } from '@/lib/catalogueServer';
import { resolveLocality } from '@/lib/geo';
import { PublicFooter, PublicHeader } from '@/components/catalogue/PublicChrome';
import { PublicLocationProvider } from '@/components/catalogue/PublicLocationContext';
import { CatalogueBrowser } from '@/components/catalogue/CatalogueBrowser';
import LoadingSpinner from '@/components/ui/LoadingSpinner';

/**
 * `/services` — the catalogue (§20.2).
 *
 * Server-rendered from the same read model the API uses, so the first paint is
 * real data rather than a spinner over a fetch, and the page works for a visitor
 * with JavaScript disabled. The client half (`CatalogueBrowser`) then takes over
 * for search, the category filter and the location.
 *
 * The initial read is deliberately location-free. A location only exists in the
 * visitor's browser — from `localStorage` or a geolocation prompt — and a
 * server-rendered page has not got one. So the first answer is the whole
 * catalogue with `availableOnly: false`, and the browser asks again with a
 * location as soon as it has one. Two requests, in that order, on purpose: a
 * page that waits for a prompt before showing a single service is a page that
 * shows nothing to everyone who declines.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Services — browse and book home help',
  description:
    'Every SmartHelp service with real prices, job lengths and availability in your area. Plumbers, electricians, cleaners, carpenters and appliance repair.',
  alternates: { canonical: '/services' },
};

export default async function ServicesPage() {
  const [services, categories] = await Promise.all([
    getCatalogue({ availableOnly: false }),
    loadServiceContext().then(categorySummaries),
  ]);

  // Resolved against no geography at all, which is the honest description of
  // this render: nobody's area, so the banner says nothing until the browser
  // knows one.
  const summary = describeLocation(resolveLocality({ localities: [], cities: [] }));

  return (
    <PublicLocationProvider initialSummary={summary}>
      <div className="flex min-h-screen flex-col bg-gray-50">
        <PublicHeader />
        <main className="flex-1">
          <Suspense
            fallback={
              <div className="flex min-h-[50vh] items-center justify-center">
                <LoadingSpinner size="lg" />
              </div>
            }
          >
            <CatalogueBrowser
              initialServices={services}
              initialCategories={categories}
              initialLocation={summary}
              initialAvailableOnly={false}
            />
          </Suspense>
        </main>
        <PublicFooter />
      </div>
    </PublicLocationProvider>
  );
}
