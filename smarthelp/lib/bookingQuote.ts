/**
 * Server-side quote construction for the booking routes.
 *
 * `POST /api/bookings/quote` used to accept `basePrice`, `pricingType` and
 * `durationPrice` straight off the request body and feed them to the pricing
 * engine. That made the quote decorative: a client could quote itself ₹1, show
 * a customer ₹1, and `create` — which re-prices — would either disagree with the
 * screen or, worse, agree by accident. §7.2 is explicit that the *server* is the
 * authority and a client-sent amount is never read.
 *
 * So the wire format carries intent, not money:
 *
 *   items:   [{ serviceId, durationMinutes?, quantity? }]
 *   coupon:  a code, not a discount value
 *
 * Everything priced comes out of `services` / `service_durations` / `coupons`
 * here, so the quote the customer saw and the quote that becomes the booking are
 * produced by the same code path from the same rows.
 */

import { ApiHttpError } from './api';
import { DEFAULT_DURATION_LADDER, PLATFORM_DEFAULTS } from './constants';
import { parseNumeric } from './money';
import {
  priceQuote,
  toBookingMoneyColumns,
  type CouponInput,
  type PriceLineInput,
  type PricingBreakdown,
  type PricingSettings,
} from './pricing';
import { createServerClient } from './supabaseServer';
import type { BookingType, Coupon, PricingType, Service } from './supabase';
import { isUuid } from './validation';

export interface QuoteItemInput {
  serviceId: string;
  durationMinutes?: number;
  quantity?: number;
}

export interface BookingQuoteRequest {
  items: readonly QuoteItemInput[];
  /** Uppercased and trimmed by the route before it gets here. */
  couponCode?: string | null;
  bookingType: BookingType;
}

export interface BookingQuote {
  breakdown: PricingBreakdown;
  /** The `money` columns for `bookings`, already as `numeric` literals. */
  money: Record<string, string>;
  /**
   * Rows for `booking_items`, already in the column names the table uses. The
   * rename lives here rather than in the route so the two writers — create and
   * reschedule — cannot disagree about it.
   */
  itemRows: Array<{
    service_id: string;
    service_name: string;
    duration_minutes: number;
    unit_price: string;
    quantity: number;
    line_total: string;
    scope_snapshot: unknown[];
  }>;
  /** Sum of the per-item durations, for `bookings.duration_minutes`. */
  durationMinutes: number;
  settings: PricingSettings;
}

/** What a quote needs from the caller so it can be compared on create. */
export interface QuoteExpectation {
  total: number;
  quoteToken?: string | null;
}

function settingsFrom(commissionPct?: number | null): PricingSettings {
  return {
    taxRate: PLATFORM_DEFAULTS.taxRate,
    platformFeePct: PLATFORM_DEFAULTS.platformFeePct,
    platformFeeMin: PLATFORM_DEFAULTS.platformFeeMin,
    currency: PLATFORM_DEFAULTS.currency,
  };
}

/** Read an enum column without widening it to `string`. */
function oneOfTwo<T extends string>(value: string | null | undefined, fallback: T): T {
  return typeof value === 'string' ? (value as T) : fallback;
}

/**
 * A pricing type the database did not recognise falls back to hourly rather than
 * being refused: `per_unit_needs_unit` in 0003 means the two `per_unit` columns
 * cannot be inconsistent, so a new type is a schema question rather than a
 * customer-facing one.
 */
function oneOfThree<T extends string>(value: string | null | undefined, fallback: T): T {
  return value === 'flat' || value === 'per_unit' || value === 'hourly' ? (value as T) : fallback;
}

/**
 * Load a coupon and reduce it to what the engine takes.
 *
 * Every constraint here is a database read rather than a trust of the request:
 * `is_active`, the validity window, and `usage_limit` against `usage_count`.
 * A code that exists but has expired is a `VALIDATION_ERROR` the customer can
 * act on, not a silently-zero discount.
 */
async function loadCoupon(code: string, serviceIds: readonly string[]): Promise<CouponInput | null> {
  if (!code) return null;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .ilike('code', code)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('VALIDATION_ERROR', `Coupon ${code} does not exist.`, 400, {
      fields: { couponCode: 'Unknown coupon code' },
    });
  }

  const coupon = data as Coupon;
  const now = new Date();

  if (!coupon.is_active) {
    throw new ApiHttpError('VALIDATION_ERROR', `Coupon ${code} is no longer active.`, 400, {
      fields: { couponCode: 'This coupon is not active' },
    });
  }
  if (new Date(coupon.valid_from) > now) {
    throw new ApiHttpError('VALIDATION_ERROR', `Coupon ${code} is not valid yet.`, 400, {
      fields: { couponCode: 'This coupon is not valid yet' },
    });
  }
  if (coupon.valid_to && new Date(coupon.valid_to) < now) {
    throw new ApiHttpError('VALIDATION_ERROR', `Coupon ${code} has expired.`, 400, {
      fields: { couponCode: 'This coupon has expired' },
    });
  }
  if (coupon.usage_limit != null && coupon.usage_count >= coupon.usage_limit) {
    throw new ApiHttpError('VALIDATION_ERROR', `Coupon ${code} has been fully redeemed.`, 400, {
      fields: { couponCode: 'This coupon has been fully used' },
    });
  }

  // An empty array means "every service". Postgres stores `{}` for that, which
  // the client sends back as `[]`, so the empty case is the wildcard.
  const appliesToAll = !coupon.applicable_services || coupon.applicable_services.length === 0;
  if (!appliesToAll && !serviceIds.some((id) => coupon.applicable_services.includes(id))) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      `Coupon ${code} does not apply to any service in this booking.`,
      400,
      { fields: { couponCode: 'Not valid for these services' } }
    );
  }

  return {
    code: coupon.code,
    discountType: oneOfTwo<'percentage' | 'fixed'>(coupon.discount_type, 'fixed'),
    discountValue: parseNumeric(coupon.discount_value),
    maxDiscount: coupon.max_discount == null ? null : parseNumeric(coupon.max_discount),
    minBookingAmount: parseNumeric(coupon.min_booking_amount ?? 0),
    maxDiscountPctOfTotal: parseNumeric(coupon.max_discount_pct_of_total ?? 100),
  };
}

/**
 * Build a full quote from the database.
 *
 * This is the single place a booking's money is decided, and both `quote` and
 * `create` call it — which is what makes `PRICE_CHANGED` rare rather than
 * routine. Duration and quantity come from the request because they are the
 * customer's choice; the *price* of each choice never does.
 */
export async function buildQuote(request: BookingQuoteRequest): Promise<BookingQuote> {
  if (request.items.length === 0) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Choose at least one service.', 400, {
      fields: { items: 'At least one service is required' },
    });
  }

  for (const item of request.items) {
    if (!isUuid(item.serviceId)) {
      throw new ApiHttpError('VALIDATION_ERROR', 'One of these services is not a valid service.', 400, {
        fields: { items: 'Unknown service' },
      });
    }
    if (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity < 1)) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Quantity must be a whole number of 1 or more.', 400, {
        fields: { items: 'Enter a whole number' },
      });
    }
  }

  const serviceIds = [...new Set(request.items.map((i) => i.serviceId))];

  const supabase = createServerClient();
  const { data: services, error: servicesError } = await supabase
    .from('services')
    .select('*')
    .in('id', serviceIds);

  if (servicesError) throw servicesError;

  const byId = new Map<string, Service>();
  for (const row of (services ?? []) as Service[]) byId.set(row.id, row);

  const missing = serviceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ApiHttpError('VALIDATION_ERROR', 'One of these services is no longer available.', 400, {
      fields: { items: 'Unknown service' },
    });
  }

  const inactive = serviceIds.filter((id) => !byId.get(id)!.is_active);
  if (inactive.length > 0) {
    throw new ApiHttpError('VALIDATION_ERROR', 'One of these services is no longer available.', 400, {
      fields: { items: 'Service is not active' },
    });
  }

  // Duration overrides, for the chosen service/duration pairs only.
  const durationsByService = new Map<string, Array<{ minutes: number; price: number | null; price_multiplier: number | null }>>();
  for (const item of request.items) {
    if (durationsByService.has(item.serviceId)) continue;
    const { data: durations, error } = await supabase
      .from('service_durations')
      .select('minutes, price, price_multiplier')
      .eq('service_id', item.serviceId)
      .eq('is_active', true);
    if (error) throw error;
    durationsByService.set(item.serviceId, durations ?? []);
  }

  const lines: PriceLineInput[] = [];
  const resolved: Array<{
    serviceId: string;
    serviceName: string;
    durationMinutes: number;
    quantity: number;
    basePrice: number;
    unitPrice: number;
  }> = [];

  for (const item of request.items) {
    const service = byId.get(item.serviceId)!;
    const pricingType = oneOfThree<PricingType>(service.pricing_type, 'hourly');

    // A per-unit service has no duration to speak of; an hourly or flat one
    // defaults to its minimum so a client that omits the field still gets a
    // sensible, in-range quote instead of a validation error.
    const durationMinutes =
      pricingType === 'per_unit'
        ? 0
        : clampDuration(item.durationMinutes ?? service.min_duration_min, service);

    const quantity = pricingType === 'per_unit' ? Math.max(1, item.quantity ?? 1) : 1;

    if (request.bookingType !== 'instant' && durationMinutes > PLATFORM_DEFAULTS.maxBookingMinutes) {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        `A booking cannot be longer than ${PLATFORM_DEFAULTS.maxBookingMinutes} minutes.`,
        400,
        { fields: { durationMinutes: 'Too long for one booking' } }
      );
    }

    const override = durationMinutes
      ? durationsByService
          .get(item.serviceId)
          ?.find((d) => d.minutes === durationMinutes)
      : undefined;

    const basePrice =
      pricingType === 'per_unit'
        ? parseNumeric(service.unit_price ?? service.base_price)
        : parseNumeric(service.base_price);

    lines.push({
      serviceId: service.id,
      label: service.name,
      pricingType,
      basePrice,
      durationMinutes: durationMinutes || 1,
      quantity,
      durationPrice: override?.price == null ? null : parseNumeric(override.price),
      priceMultiplier: override?.price_multiplier == null ? null : parseNumeric(override.price_multiplier),
    });

    resolved.push({
      serviceId: service.id,
      serviceName: service.name,
      durationMinutes,
      quantity,
      basePrice,
      unitPrice: basePrice,
    });
  }

  const coupon = await loadCoupon(request.couponCode ?? '', serviceIds);
  const breakdown = priceQuote({ lines, settings: settingsFrom(), coupon });

  return {
    breakdown,
    money: toBookingMoneyColumns(breakdown),
    itemRows: breakdown.lines.map((line, i) => {
      const source = resolved[i];
      return {
        service_id: source.serviceId,
        service_name: source.serviceName,
        duration_minutes: source.durationMinutes,
        unit_price: source.unitPrice.toFixed(2),
        quantity: source.quantity,
        line_total: line.lineTotal.toFixed(2),
        scope_snapshot: [],
      };
    }),
    durationMinutes:
      resolved.reduce((sum, r) => sum + r.durationMinutes, 0) || DEFAULT_DURATION_LADDER[2],
    settings: settingsFrom(),
  };
}

/** Keep a requested duration inside the service's own ladder. */
function clampDuration(minutes: number, service: Service): number {
  const min = service.min_duration_min || 30;
  const max = service.max_duration_min || PLATFORM_DEFAULTS.maxBookingMinutes;
  return Math.min(Math.max(minutes, min), max);
}

/**
 * §7.2's gate: the server re-prices on every create and compares.
 *
 * A client-sent total is never stored. It is only ever used as the thing we
 * disagree with, and a disagreement returns the fresh breakdown attached so the
 * screen can re-render instead of asking the customer to accept a price that
 * moved underneath them.
 */
export function assertPriceUnchanged(expected: QuoteExpectation | null, breakdown: PricingBreakdown): void {
  if (!expected) return;
  if (expected.total === breakdown.total) return;
  throw new ApiHttpError(
    'PRICE_CHANGED',
    'The price changed while you were deciding. Please review the new total.',
    409,
    { previousTotal: expected.total, currentTotal: breakdown.total, breakdown }
  );
}