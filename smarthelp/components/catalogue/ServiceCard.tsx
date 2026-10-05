'use client';

import Link from 'next/link';
import { Clock, MapPinOff, Star, Users } from 'lucide-react';
import type { ServiceSummary } from '@/lib/catalogue';
import { durationLabel, formatPrice, fromPrice, priceUnitLabel, ratingLabel } from '@/lib/catalogue';

/**
 * One card in the catalogue grid (§20.2).
 *
 * The card is a link, and everything inside it is text. A card that is a `div`
 * with an `onClick` is not focusable, has no link to share, and does not open in
 * a new tab — and "book again" is a link somebody will send to their neighbour.
 *
 * The one judgement call is the "Not in your area" badge. A service that cannot
 * be booked where the visitor is stays in the grid rather than disappearing,
 * because the catalogue route is asked for the full list and the *server* owns
 * the decision about what to hide. Rendering the truth is this component's job.
 */

function priceLine(service: ServiceSummary): string {
  const from = fromPrice(service);
  if (from == null) return 'Price on request';
  return `From ${formatPrice(from)}${priceUnitLabel(service)}`;
}

export function ServiceCard({
  service,
  showAreaBadge = true,
}: {
  service: ServiceSummary;
  showAreaBadge?: boolean;
}) {
  const unavailable = service.serviceable != null && !service.serviceable.ok;
  const online = service.professionals.online;

  return (
    <Link
      href={`/services/${service.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white transition hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-gray-100">
        {service.imageUrl ? (
          // Catalogue images are admin-supplied URLs of unknown size, so the
          // optimiser is told to lay out for a card rather than guess.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={service.imageUrl}
            alt={service.name}
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-gray-300">
            {service.name.slice(0, 1)}
          </div>
        )}

        {showAreaBadge && unavailable ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-gray-900/85 px-2 py-1 text-xs font-medium text-white">
            <MapPinOff className="h-3 w-3" aria-hidden="true" />
            Not in your area
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col p-3.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
          {service.category.name}
        </p>
        <h3 className="mt-1 line-clamp-1 text-sm font-semibold text-gray-900">{service.name}</h3>
        {service.shortDescription ? (
          <p className="mt-1 line-clamp-2 text-xs text-gray-600">{service.shortDescription}</p>
        ) : null}

        <div className="mt-2 flex items-center gap-3 text-xs text-gray-600">
          <span className="inline-flex items-center gap-1">
            <Star className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
            {ratingLabel(service.rating, service.ratingCount)}
          </span>
          {service.professionals.total > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
              {online > 0 ? `${online} online` : `${service.professionals.total} pros`}
            </span>
          ) : null}
          {service.minDurationMinutes ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
              {durationLabel(service.minDurationMinutes)}
              {service.maxDurationMinutes > service.minDurationMinutes
                ? `+`
                : ''}
            </span>
          ) : null}
        </div>

        <p className="mt-auto pt-3 text-sm font-semibold text-gray-900">{priceLine(service)}</p>
      </div>
    </Link>
  );
}
