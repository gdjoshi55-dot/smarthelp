import type { PricingType } from './supabase';

/**
 * Catalogue shapes and money maths (Phase 1).
 *
 * The response contracts for `/api/landing`, `/api/services` and
 * `/api/services/[slug]`, plus the price arithmetic the service detail screen
 * previews. Both halves of the app need these types — the Route Handler builds
 * them, the client component renders them — so they live in a module that
 * imports nothing and is safe in either bundle.
 *
 * The price here is the *line* price for a duration, from §7.1:
 *
 *     hourly    base_price × (minutes / 60), or the duration row's flat `price`,
 *               or `base_price × price_multiplier`
 *     flat      base_price, whatever the duration
 *     per_unit  unit_price × units — units are agreed at booking, so the
 *               screen previews the rate and says so
 *
 * Tax, platform fee, surge, coupons and the commission split are Phase 2 and
 * Phase 3, and they belong to `POST /api/bookings/quote`. Nothing here is a
 * quote: the customer sees an estimate and the server re-derives it at booking.
 */

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
  iconKey: string;
  imageUrl: string | null;
  sortOrder: number;
  serviceCount: number;
}

export interface ServiceSummary {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  imageUrl: string | null;
  category: { id: string; name: string; slug: string; iconKey: string };
  pricingType: PricingType;
  basePrice: number;
  unitLabel: string | null;
  unitPrice: number | null;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  prepMinutes: number;
  sortOrder: number;
  /** Duration options that are active for this service. Never empty. */
  durations: number[];
  /** Verified professionals with the skill, and how many are online right now. */
  professionals: { total: number; online: number };
  /** `null` until `ratings` rows exist (Phase 2). Rendered as "New". */
  rating: number | null;
  ratingCount: number;
  /** `null` when no location was supplied, or the locality is not covered. */
  serviceable: Serviceability | null;
}

export interface ServiceTaskView {
  kind: 'included' | 'excluded';
  label: string;
  sortOrder: number;
}

export interface DurationOption {
  minutes: number;
  price: number | null;
  priceMultiplier: number | null;
}

export interface ServiceDetail extends ServiceSummary {
  description: string | null;
  materialsIncluded: boolean;
  materialsNote: string | null;
  requiresPhotoProof: boolean;
  maxActiveJobs: number;
  images: { url: string; altText: string | null }[];
  tasks: ServiceTaskView[];
  durationOptions: DurationOption[];
  keywords: string[];
}

export type ServiceabilityReason =
  | 'no_location'
  | 'outside_coverage'
  | 'service_not_offered';

export interface Serviceability {
  ok: boolean;
  localityId: string;
  localityName: string;
  cityName: string | null;
  timeZone: string;
  /** `service_areas.lead_minutes`, already the max of the area's and the service's. */
  leadMinutes: number;
  slotCapacity: number;
  reason: ServiceabilityReason | null;
  /** How the locality was resolved, so the UI can be honest about it. */
  matchedBy: 'area' | 'coordinates' | 'saved_address' | null;
}

export interface LocationSummary {
  localityId: string | null;
  localityName: string | null;
  cityName: string | null;
  timeZone: string | null;
  matchedBy: 'area' | 'coordinates' | 'saved_address' | null;
  distanceKm: number | null;
  /** Copy for the banner under the location chip. */
  message: string;
  addressId: string | null;
}

export interface LandingData {
  categories: CategorySummary[];
  featured: ServiceSummary[];
  coverage: { city: string; state: string; localities: string[] };
  verifiedProfessionals: number;
  /** Where a visitor should be pointed when they ask "do you come to me?". */
  servedLocalities: number;
}

/** Two decimal places, as a number. Prices are never strings in transit. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The price of a duration, from the rule above.
 *
 * A duration row may override the base either with a flat `price` or with a
 * `price_multiplier`, never both — the table has a check constraint that says
 * so, and this prefers the flat one when a future migration relaxes it.
 */
export function priceForDuration(
  service: Pick<ServiceSummary, 'pricingType' | 'basePrice' | 'unitPrice'>,
  minutes: number,
  option?: Pick<DurationOption, 'price' | 'priceMultiplier'> | null
): number {
  if (service.pricingType === 'flat') return round2(service.basePrice);
  if (service.pricingType === 'per_unit') return round2(service.unitPrice ?? service.basePrice);

  if (option?.price != null) return round2(option.price);
  const multiplier = option?.priceMultiplier ?? 1;
  return round2(service.basePrice * (minutes / 60) * multiplier);
}

/**
 * What a service costs "from", before a duration is chosen.
 *
 * Hourly services quote the hourly rate, flat and per-unit quote the headline
 * figure, and anything that cannot be priced returns `null` rather than a zero
 * — a "from ₹0" card is worse than no card.
 */
export function fromPrice(service: Pick<ServiceSummary, 'pricingType' | 'basePrice' | 'unitPrice'>): number | null {
  if (!Number.isFinite(service.basePrice) || service.basePrice <= 0) return null;
  if (service.pricingType === 'per_unit') {
    return service.unitPrice != null && service.unitPrice > 0 ? round2(service.unitPrice) : null;
  }
  return round2(service.basePrice);
}

/** The unit a price is quoted in, for "from ₹249 / hour". */
export function priceUnitLabel(service: Pick<ServiceSummary, 'pricingType' | 'unitLabel'>): string {
  if (service.pricingType === 'hourly') return '/ hour';
  if (service.pricingType === 'per_unit') return service.unitLabel ? `/ ${service.unitLabel}` : '';
  return '';
}

/**
 * Indian digit grouping, and the rupee sign.
 *
 * `Intl` gets this right for every locale and is already in the runtime, so it
 * is used rather than a hand-rolled regex that breaks on 1,00,000 the moment
 * someone changes a price.
 */
export function formatPrice(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    minimumFractionDigits: 0,
  }).format(amount)}`;
}

/** `30 min`, `1 hr`, `1 hr 30 min`. */
export function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** The rating line, or "New" when nothing has been rated yet. */
export function ratingLabel(rating: number | null, count: number): string {
  if (rating == null || count <= 0) return 'New';
  return `${rating.toFixed(1)} (${count})`;
}
