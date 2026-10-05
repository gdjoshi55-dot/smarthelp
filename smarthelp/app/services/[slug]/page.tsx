import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, ChevronRight, Clock, MapPinOff, Star, X } from 'lucide-react';
import { describeLocation, getServiceBySlug } from '@/lib/catalogueServer';
import { resolveLocality } from '@/lib/geo';
import { durationLabel, formatPrice, fromPrice, priceUnitLabel, ratingLabel } from '@/lib/catalogue';
import { PublicFooter, PublicHeader } from '@/components/catalogue/PublicChrome';
import { PublicLocationProvider } from '@/components/catalogue/PublicLocationContext';
import { BookingPanel } from '@/components/catalogue/BookingPanel';
import { ServiceTasks } from '@/components/catalogue/ServiceTasks';

/**
 * `/services/[slug]` — the service detail and the price preview (§20.3).
 *
 * Server-rendered from the same read model as the API, so the page is
 * indexable and works without JavaScript; the booking card is the only client
 * part, because it is the only part that needs a location from the browser.
 *
 * The scope list is the trust centrepiece of this screen, and it comes from
 * `service_tasks` — a green check for what is included, a muted cross for what
 * is not. It is rendered from the rows rather than written here, because the day
 * an admin edits the scope in the database and this page disagrees with them is
 * the day a customer books something they were never offered.
 */

export const dynamic = 'force-dynamic';

interface Params {
  params: { slug: string };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const service = await getServiceBySlug(params.slug);
  if (!service) return { title: 'Service not found' };

  return {
    title: `${service.name}${service.shortDescription ? ` — ${service.shortDescription}` : ''}`,
    description:
      service.shortDescription ??
      `Book ${service.name.toLowerCase()} with a verified professional through SmartHelp.`,
    alternates: { canonical: `/services/${service.slug}` },
    openGraph: {
      title: service.name,
      description: service.shortDescription ?? undefined,
      images: service.imageUrl ? [{ url: service.imageUrl }] : undefined,
    },
  };
}

export default async function ServiceDetailPage({ params }: Params) {
  const service = await getServiceBySlug(params.slug);
  if (!service) notFound();

  const summary = describeLocation(resolveLocality({ localities: [], cities: [] }));
  const from = fromPrice(service);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: service.name,
    description: service.description ?? service.shortDescription ?? undefined,
    serviceType: service.category.name,
    url: `/services/${service.slug}`,
    provider: { '@type': 'Organization', name: 'SmartHelp' },
    offers: {
      '@type': 'Offer',
      priceCurrency: 'INR',
      price: String(from ?? service.basePrice),
      availability: 'https://schema.org/InStock',
    },
    ...(service.rating != null && service.ratingCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: String(service.rating),
            reviewCount: String(service.ratingCount),
          },
        }
      : {}),
  };

  return (
    <PublicLocationProvider initialSummary={summary}>
      <div className="flex min-h-screen flex-col bg-gray-50">
        <PublicHeader />

        <main className="flex-1">
          <div className="mx-auto max-w-7xl px-4 py-5">
            <nav aria-label="Breadcrumb" className="text-sm text-gray-500">
              <ol className="flex flex-wrap items-center gap-1.5">
                <li>
                  <Link href="/services" className="hover:text-blue-700">
                    Services
                  </Link>
                </li>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                <li>
                  <Link
                    href={`/services?category=${service.category.slug}`}
                    className="hover:text-blue-700"
                  >
                    {service.category.name}
                  </Link>
                </li>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                <li className="font-medium text-gray-900" aria-current="page">
                  {service.name}
                </li>
              </ol>
            </nav>
          </div>

          <div className="mx-auto grid max-w-7xl gap-8 px-4 pb-14 lg:grid-cols-[minmax(0,1fr)_380px]">
            {/* Left: media and scope */}
            <div className="min-w-0">
              {service.imageUrl ? (
                <div className="overflow-hidden rounded-2xl bg-gray-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={service.imageUrl}
                    alt={service.images[0]?.altText ?? service.name}
                    className="aspect-video w-full object-cover"
                  />
                </div>
              ) : null}

              <header className="mt-5">
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900 sm:text-3xl">
                  {service.name}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-gray-600">
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-4 w-4 text-amber-500" aria-hidden="true" />
                    {ratingLabel(service.rating, service.ratingCount)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-4 w-4 text-gray-400" aria-hidden="true" />
                    {durationLabel(service.minDurationMinutes)}
                    {service.maxDurationMinutes > service.minDurationMinutes
                      ? ` to ${durationLabel(service.maxDurationMinutes)}`
                      : ''}
                  </span>
                  {service.serviceable?.ok === false ? (
                    <span className="inline-flex items-center gap-1 text-amber-700">
                      <MapPinOff className="h-4 w-4" aria-hidden="true" />
                      Not in your area
                    </span>
                  ) : null}
                </div>
                {service.description ?? service.shortDescription ? (
                  <p className="mt-3 max-w-2xl text-base text-gray-700">
                    {service.shortDescription ?? service.description}
                  </p>
                ) : null}
              </header>

              {service.tasks.length > 0 ? <ServiceTasks tasks={service.tasks} /> : null}

              {service.materialsNote || !service.materialsIncluded ? (
                <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
                  <h2 className="text-sm font-semibold text-gray-900">Materials</h2>
                  <p className="mt-1.5 text-sm text-gray-600">
                    {service.materialsNote ??
                      'Materials are not included. The professional will tell you what is needed before starting.'}
                  </p>
                </section>
              ) : null}
            </div>

            {/* Right: price and slots */}
            <aside className="lg:sticky lg:top-20 lg:self-start">
              <BookingPanel service={service} />
            </aside>
          </div>
        </main>

        <PublicFooter />

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </div>
    </PublicLocationProvider>
  );
}
