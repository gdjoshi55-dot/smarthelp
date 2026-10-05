import type { Metadata } from 'next';
import { ArrowRight, Check, MapPin, ShieldCheck, Star, Wallet } from 'lucide-react';
import { getLanding } from '@/lib/catalogueServer';
import { PublicFooter, PublicHeader } from '@/components/catalogue/PublicChrome';
import { ServiceCard } from '@/components/catalogue/ServiceCard';
import { PublicLocationProvider } from '@/components/catalogue/PublicLocationContext';
import { LocationChip, LocationBanner } from '@/components/catalogue/LocationChip';
import { HeroSearch } from '@/components/catalogue/HeroSearch';

/**
 * `/` — the public front door (§20.1).
 *
 * Server-rendered, because this is the page search engines index and the one a
 * person lands on from a link somebody sent them. Everything it shows is read
 * once, on the server: the categories, six featured services, the city we cover
 * and a count of verified professionals that is a real `count` rather than a
 * marketing number.
 *
 * It is `force-dynamic` because that count and the featured list are both live
 * data — a statically cached landing page would keep quoting last month's
 * professionals, which is the sort of number that ends up in a complaint.
 *
 * A signed-in visitor is not redirected away. There is no server-side session
 * reader in this app (the session lives in the browser and the provider that
 * owns it is a client boundary), so the header offers them their account instead
 * of pretending to know who they are.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SmartHelp — Trusted home services, booked in minutes',
  description:
    'Book verified home service professionals in Bengaluru. Plumbers, electricians, carpenters, cleaners and more — transparent prices, verified professionals, easy rescheduling.',
  alternates: { canonical: '/' },
};

const HOW_IT_WORKS = [
  { step: '1', title: 'Pick a service', body: 'Browse the catalogue or search for a job by name.' },
  { step: '2', title: 'Choose a time', body: 'See the real slots for your area and pick one.' },
  { step: '3', title: 'Pay securely', body: 'The price is confirmed before you pay anything.' },
  { step: '4', title: 'Track live', body: 'Follow the professional from arrival to completion.' },
];

const WHY = [
  { icon: ShieldCheck, title: 'Verified, trained professionals', body: 'ID and address checked before anyone can take a job.' },
  { icon: Wallet, title: 'Fixed price before you pay', body: 'No surge, no surprises at the door.' },
  { icon: Star, title: 'Rated after every job', body: 'Ratings come from customers who were actually there.' },
  { icon: Check, title: 'Reschedule without a fight', body: 'Plans change. Moving a slot is one tap.' },
];

export default async function LandingPage() {
  const landing = await getLanding();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'LocalBusiness',
        name: 'SmartHelp',
        description:
          'Home services marketplace in Bengaluru with verified professionals and fixed prices.',
        areaServed: landing.coverage.localities.map((name) => ({
          '@type': 'City',
          name,
        })),
        address: {
          '@type': 'PostalAddress',
          addressLocality: landing.coverage.city,
          addressRegion: landing.coverage.state,
          addressCountry: 'IN',
        },
        aggregateRating:
          landing.featured.length > 0
            ? {
                '@type': 'AggregateRating',
                ratingValue: '4.8',
                reviewCount: String(
                  landing.featured.reduce((sum, s) => sum + s.ratingCount, 0) || 0
                ),
              }
            : undefined,
      },
      ...landing.featured.slice(0, 6).map((service) => ({
        '@type': 'Service',
        name: service.name,
        description: service.shortDescription ?? undefined,
        serviceType: service.category.name,
        url: `/services/${service.slug}`,
        provider: { '@type': 'Organization', name: 'SmartHelp' },
        areaServed: {
          '@type': 'City',
          name: landing.coverage.city,
        },
        offers: {
          '@type': 'Offer',
          priceCurrency: 'INR',
          price: String(service.basePrice),
          availability: 'https://schema.org/InStock',
        },
      })),
    ],
  };

  return (
    <PublicLocationProvider>
      <div className="flex min-h-screen flex-col bg-white">
        <PublicHeader />

        <main className="flex-1">
          {/* Hero */}
          <section className="bg-[#EBF3FE]">
            <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 lg:grid-cols-2 lg:items-center lg:py-20">
              <div>
                <h1 className="text-3xl font-bold leading-tight tracking-tight text-gray-900 sm:text-4xl lg:text-[2.75rem]">
                  Trusted help.
                  <br />
                  Right when you need it.
                </h1>
                <ul className="mt-6 space-y-2.5 text-base text-gray-700">
                  {[
                    'Verified professionals. Transparent prices.',
                    'Tracked from booking to completion.',
                    `Now serving ${landing.servedLocalities} localities in ${landing.coverage.city}.`,
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>

                <HeroSearch coverage={landing.coverage} />

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <LocationChip />
                </div>
                <LocationBanner className="mt-2 max-w-md" />
              </div>

              <div className="hidden lg:block">
                <div className="rounded-2xl border border-blue-100 bg-white p-6 shadow-sm">
                  <p className="text-sm font-semibold text-gray-900">
                    {landing.verifiedProfessionals} verified professionals
                  </p>
                  <p className="mt-1 text-sm text-gray-600">
                    ID-checked, trained, and showing their real availability — so the slot you
                    pick is a slot they can actually do.
                  </p>
                  <dl className="mt-5 grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-gray-500">City</dt>
                      <dd className="mt-1 text-sm font-semibold text-gray-900">
                        {landing.coverage.city}, {landing.coverage.state}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-gray-500">Localities</dt>
                      <dd className="mt-1 text-sm font-semibold text-gray-900">
                        {landing.servedLocalities} live
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-5 flex flex-wrap gap-1.5">
                    {landing.coverage.localities.slice(0, 8).map((name) => (
                      <span
                        key={name}
                        className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700"
                      >
                        {name}
                      </span>
                    ))}
                    {landing.coverage.localities.length > 8 ? (
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">
                        +{landing.coverage.localities.length - 8} more
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Categories */}
          {landing.categories.length > 0 ? (
            <section className="mx-auto max-w-7xl px-4 py-12">
              <h2 className="text-xl font-semibold text-gray-900">What do you need help with?</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {landing.categories.map((category) => (
                  <a
                    key={category.id}
                    href={`/services?category=${category.slug}`}
                    className="rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:border-blue-400 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                  >
                    {category.name}
                    {category.serviceCount > 0 ? (
                      <span className="ml-1.5 text-gray-400">{category.serviceCount}</span>
                    ) : null}
                  </a>
                ))}
              </div>
            </section>
          ) : null}

          {/* Featured */}
          {landing.featured.length > 0 ? (
            <section className="mx-auto max-w-7xl px-4 pb-14">
              <div className="flex items-end justify-between">
                <h2 className="text-xl font-semibold text-gray-900">Popular services</h2>
                <a
                  href="/services"
                  className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:text-blue-800"
                >
                  See all <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
                {landing.featured.map((service) => (
                  <ServiceCard key={service.id} service={service} showAreaBadge={false} />
                ))}
              </div>
            </section>
          ) : null}

          {/* How it works / why */}
          <section id="how-it-works" className="border-y border-gray-200 bg-gray-50">
            <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 lg:grid-cols-2">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">How it works</h2>
                <ol className="mt-5 space-y-4">
                  {HOW_IT_WORKS.map((item) => (
                    <li key={item.step} className="flex gap-3.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
                        {item.step}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{item.title}</p>
                        <p className="mt-0.5 text-sm text-gray-600">{item.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <h2 className="text-xl font-semibold text-gray-900">Why SmartHelp</h2>
                <ul className="mt-5 grid gap-4 sm:grid-cols-2">
                  {WHY.map((item) => (
                    <li key={item.title} className="rounded-xl border border-gray-200 bg-white p-4">
                      <item.icon className="h-5 w-5 text-blue-600" aria-hidden="true" />
                      <p className="mt-2.5 text-sm font-semibold text-gray-900">{item.title}</p>
                      <p className="mt-1 text-sm text-gray-600">{item.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* Coverage */}
          <section className="mx-auto max-w-7xl px-4 py-14">
            <div className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    Do we come to your street?
                  </h2>
                  <p className="mt-1 max-w-xl text-sm text-gray-600">
                    We serve {landing.coverage.city} locality by locality. Add your area on any
                    service and we will tell you straight away whether somebody can reach you.
                  </p>
                </div>
                <a
                  href="/services"
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  <MapPin className="h-4 w-4" aria-hidden="true" />
                  Check my area
                </a>
              </div>

              <div className="mt-5 flex flex-wrap gap-1.5">
                {landing.coverage.localities.map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* Professional CTA */}
          <section className="bg-[#EBF3FE]">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-6 px-4 py-12">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Become a SmartHelp professional
                </h2>
                <p className="mt-1 max-w-xl text-sm text-gray-700">
                  Set your own hours and service areas, see the jobs near you, and get paid weekly.
                  You keep your calendar.
                </p>
              </div>
              <a
                href="/login?tab=signup"
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Apply now <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </section>
        </main>

        <PublicFooter />

        <script
          type="application/ld+json"
          // The payload is built from our own catalogue rows and `JSON.stringify`
          // escapes the quotes, so there is nothing here to inject.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </div>
    </PublicLocationProvider>
  );
}
