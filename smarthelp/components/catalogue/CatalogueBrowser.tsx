'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, SearchX, SlidersHorizontal } from 'lucide-react';
import { fetchCatalogue } from '@/lib/catalogueClient';
import { ApiRequestError } from '@/lib/catalogueClient';
import type { CategorySummary, LocationSummary, ServiceSummary } from '@/lib/catalogue';
import { CategoryPills } from './CategoryPills';
import { LocationBanner, LocationChip } from './LocationChip';
import { ServiceCard } from './ServiceCard';
import { usePublicLocation } from './PublicLocationContext';
import type { LocationQueryInput } from '@/lib/catalogueClient';

/**
 * The catalogue at `/services` (§20.2).
 *
 * Search and the category filter are client state; the *list* comes from the
 * server on every change that could alter it. That split is deliberate: the
 * catalogue is a few dozen rows, so filtering it in the browser is instant, but
 * whether a service is offered where the visitor is can only be answered by the
 * side that can read `service_areas`. So the query goes to `/api/services` and
 * the `q` / `category` narrowing is applied to whatever came back.
 *
 * The `availableOnly` switch is the one control that is *not* cosmetic. With a
 * location it defaults to true, which is why the server hides services it cannot
 * serve there; turning it off brings them back with a badge instead of a
 * 404-looking absence.
 *
 * The URL is kept truthful: `q` and `category` are written to the address bar as
 * they change, so the browser's back button means what it says and a filtered
 * catalogue is a link somebody can send.
 */

export function CatalogueBrowser({
  initialServices,
  initialCategories,
  initialLocation,
  initialAvailableOnly,
}: {
  initialServices: ServiceSummary[];
  initialCategories: CategorySummary[];
  initialLocation: LocationSummary;
  initialAvailableOnly: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const location = usePublicLocation();
  // Destructured because the context object is rebuilt whenever *any* of its
  // values change. Depending on the object itself would make this effect refetch
  // every time a response published a summary — a loop with a network bill.
  const { reportSummary, hasLocation, area, lat, lng } = location;

  const [services, setServices] = useState(initialServices);
  const [summary, setSummary] = useState(initialLocation);
  const [availableOnly, setAvailableOnly] = useState(initialAvailableOnly);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  const [minDuration, setMinDuration] = useState<number | null>(null);

  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [category, setCategory] = useState<string | null>(searchParams.get('category'));

  // The debounce is 200ms: long enough that a six-letter word is one request,
  // short enough that the list feels like it is answering.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  /** The location actually sent, or null when there is none to send. */
  const sentLocation = useMemo<LocationQueryInput | null>(() => {
    if (!hasLocation) return null;
    return { area: area ?? null, lat: lat ?? null, lng: lng ?? null };
  }, [hasLocation, area, lat, lng]);

  // Which request is in flight, so a slow answer to an old question can tell it
  // is stale instead of overwriting the list.
  const requestId = useRef(0);

  const load = useCallback(
    async (next: {
      q: string;
      category: string | null;
      availableOnly: boolean;
      location: LocationQueryInput | null;
    }) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchCatalogue({
          q: next.q || undefined,
          category: next.category ?? undefined,
          availableOnly: next.availableOnly,
          ...(next.location ?? {}),
        });
        if (id !== requestId.current) return;
        setServices(data.services);
        if (next.location) reportSummary(next.location, data.location);
        else setSummary(data.location);
      } catch (caught) {
        if (id !== requestId.current) return;
        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : 'We could not load the catalogue. Please try again.'
        );
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [reportSummary]
  );

  // Refetch when anything that changes the *server's* answer changes. The search
  // text and the category are included because they are part of the query, but
  // they are also filtered locally below, so the fetch is what keeps the badge
  // and the hidden-out-of-area list honest for the current search.
  useEffect(() => {
    void load({
      q: debouncedQuery,
      category,
      availableOnly,
      location: sentLocation,
    });
  }, [debouncedQuery, category, availableOnly, sentLocation, load]);

  // Keep the address bar in step with the controls.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (debouncedQuery) params.set('q', debouncedQuery);
    else params.delete('q');
    if (category) params.set('category', category);
    else params.delete('category');
    if (sentLocation?.area) params.set('area', sentLocation.area);
    else params.delete('area');
    const next = params.toString();
    const here = searchParams.toString();
    if (next !== here) router.replace(next ? `/services?${next}` : '/services', { scroll: false });
  }, [debouncedQuery, category, sentLocation, router, searchParams]);

  /**
   * The narrowed list.
   *
   * The server already applied `q` when it could; doing it again here is what
   * makes typing feel instant rather than waiting on a round trip, and the two
   * agree because both match the same three fields. The price and duration
   * filters only exist here, because nothing in the API contract describes them
   * and a request nobody can cache is not worth adding to it yet.
   */
  const visible = useMemo(() => {
    const needle = debouncedQuery.toLowerCase();
    return services.filter((service) => {
      if (
        needle &&
        ![service.name, service.category.name, service.shortDescription ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }
      if (maxPrice != null && service.basePrice > maxPrice) return false;
      if (minDuration != null && service.minDurationMinutes < minDuration) return false;
      return true;
    });
  }, [services, debouncedQuery, maxPrice, minDuration]);

  const priceCeiling = useMemo(() => {
    const prices = services.map((s) => s.basePrice).filter((p) => Number.isFinite(p) && p > 0);
    return prices.length > 0 ? Math.ceil(Math.max(...prices) / 100) * 100 : 1000;
  }, [services]);

  const filtersActive = maxPrice != null || minDuration != null;

  const hiddenByArea = useMemo(
    () => services.length - services.filter((s) => s.serviceable?.ok !== false).length,
    [services]
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            {category ? `${categoryLabel(initialCategories, category)} services` : 'All services'}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {visible.length} {visible.length === 1 ? 'service' : 'services'} available
            {summary.localityName ? ` near ${summary.localityName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LocationChip />
          <button
            type="button"
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-blue-400"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Filters
          </button>
        </div>
      </div>

      <LocationBanner summary={summary} className="mt-3" />

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <label htmlFor="catalogue-search" className="sr-only">
            Search services
          </label>
          <input
            id="catalogue-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search services, e.g. leak, bathroom, switch"
            className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {loading ? (
            <Loader2
              className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400"
              aria-hidden="true"
            />
          ) : null}
        </div>

        {summary.localityId ? (
          <label className="flex shrink-0 items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={!availableOnly}
              onChange={(event) => {
                const next = !availableOnly;
                setAvailableOnly(next);
              }}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Show services not yet in {summary.localityName}
          </label>
        ) : null}
      </div>

      <CategoryPills
        categories={initialCategories}
        activeSlug={category}
        onSelect={setCategory}
        className="mt-4"
      />

      {showFilters ? (
        <div className="mt-4 grid gap-4 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="filter-max-price"
              className="flex items-center justify-between text-sm font-medium text-gray-800"
            >
              Up to
              <span className="font-normal text-gray-500">
                {maxPrice == null ? `any price` : `₹${maxPrice}`}
              </span>
            </label>
            <input
              id="filter-max-price"
              type="range"
              min={100}
              max={priceCeiling}
              step={100}
              value={maxPrice ?? priceCeiling}
              onChange={(event) => {
                const next = Number(event.target.value);
                setMaxPrice(next >= priceCeiling ? null : next);
              }}
              className="mt-2 w-full"
            />
          </div>

          <div>
            <span className="text-sm font-medium text-gray-800">Job length</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {[
                { label: 'Any', value: null },
                { label: 'Under 1 hr', value: 60 },
                { label: '1 hr or more', value: 90 },
                { label: 'Half day', value: 180 },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => setMinDuration(option.value)}
                  aria-pressed={minDuration === option.value}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                    minDuration === option.value
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-blue-400'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {filtersActive ? (
            <button
              type="button"
              onClick={() => {
                setMaxPrice(null);
                setMinDuration(null);
              }}
              className="text-sm font-medium text-blue-700 hover:text-blue-800 sm:col-span-2 sm:justify-self-start"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      {visible.length === 0 && !loading ? (
        <div className="mt-12 flex flex-col items-center text-center">
          <SearchX className="h-10 w-10 text-gray-300" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium text-gray-900">Nothing matches that search</p>
          <p className="mt-1 max-w-sm text-sm text-gray-600">
            {hiddenByArea > 0
              ? `${hiddenByArea} service${hiddenByArea === 1 ? ' is' : 's are'} hidden because they are not offered in your area yet.`
              : 'Try a different word, or clear the filters.'}
          </p>
          {hiddenByArea > 0 && summary.localityId ? (
            <button
              type="button"
              onClick={() => setAvailableOnly(false)}
              className="mt-3 text-sm font-medium text-blue-700 hover:text-blue-800"
            >
              Show them anyway
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {visible.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </div>
      )}

      {!availableOnly && hiddenByArea > 0 ? (
        <p className="mt-6 text-xs text-gray-500">
          Showing {hiddenByArea} service{hiddenByArea === 1 ? '' : 's'} we do not cover in{' '}
          {summary.localityName} yet.
        </p>
      ) : null}
    </div>
  );
}

function categoryLabel(categories: CategorySummary[], slug: string): string {
  return categories.find((c) => c.slug === slug)?.name ?? slug;
}
