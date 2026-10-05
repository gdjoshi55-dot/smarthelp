/**
 * The pricing engine (§7.1).
 *
 * Server-side only. The client receives a breakdown and never computes a total
 * — a total that a browser can produce is a total that can be edited in a
 * console, so `POST /api/bookings` re-runs this against the database and stores
 * the result in `pricing_snapshot`.
 *
 * Everything is done in paise (see `lib/money.ts`) and converted to rupees at
 * the very end, so the figures written to `numeric(12,2)` columns are the same
 * figures the customer was shown.
 *
 * ## One deviation from the specification, and why
 *
 * §7.1 defines
 *
 *     taxable           = subtotal + platform_fee - discount
 *     professional_gross = taxable - commission_pct x taxable
 *     platform_revenue   = platform_fee + tax + (taxable x commission_pct)
 *
 * Those three lines do not balance. `taxable` already contains the platform fee,
 * so `professional_gross` pays the professional out of money that includes the
 * fee, and `platform_revenue` then books the fee a second time. On a ₹1000
 * booking with a ₹20 fee, a ₹100 discount, 18% tax and 20% commission:
 *
 *     gross 736 + revenue 370 = 1106, but total = 1086
 *
 * The books are ₹20 out, which is the platform fee counted twice — and it grows
 * with the fee, so the error is not a rounding artefact. It is only visible if
 * somebody adds the two numbers up, which is precisely what a payout run does.
 *
 * The fix is to charge the fee to the platform rather than to the professional:
 *
 *     professional_gross = taxable - platform_fee - commission
 *
 * which reads as "the professional earns on the discounted service value, less
 * commission" — and never touches the fee or the tax, both of which the
 * platform remits. The two shares then sum to `total` exactly, and
 * `assertBalanced()` below throws if they ever stop doing so.
 */

import {
  allocate,
  numericLiteral,
  parseNumeric,
  percentOfPaise,
  roundHalfUp,
  rupees,
  sumPaise,
  toPaise,
} from './money';

/** Bumped when a rule changes, so a snapshot says which engine produced it. */
export const PRICING_ENGINE_VERSION = 2;

export type PricingType = 'hourly' | 'flat' | 'per_unit';

export interface PricingSettings {
  /** GST, as a rate. 0.18, not 18. */
  taxRate: number;
  /** Platform commission on the service value, as a rate. 0.2, not 20. */
  platformFeePct: number;
  /** The floor the platform fee never falls below, in rupees. */
  platformFeeMin: number;
  currency: string;
}

/** One priced line, as the request sent it. */
export interface PriceLineInput {
  serviceId: string;
  label: string;
  pricingType: PricingType;
  /** `base_price` for hourly/flat, `unit_price` for per_unit. */
  basePrice: number;
  /** Optional flat override for this duration (`service_durations.price`). */
  durationPrice?: number | null;
  /** Optional multiplier for this duration (`service_durations.price_multiplier`). */
  priceMultiplier?: number | null;
  durationMinutes: number;
  /** Only meaningful for `per_unit`; 1 otherwise. */
  quantity?: number;
}

export interface PricedLine {
  serviceId: string;
  label: string;
  pricingType: PricingType;
  durationMinutes: number;
  quantity: number;
  /** Before discount. */
  lineTotal: number;
  /** This line's share of the coupon, apportioned so the shares sum exactly. */
  discount: number;
  /** `lineTotal - discount`. */
  net: number;
}

export interface CouponInput {
  code: string;
  discountType: 'percentage' | 'fixed';
  /** Rupees for `fixed`, percent (0–100) for `percentage`. */
  discountValue: number;
  /** Ceiling in rupees, `percentage` only. */
  maxDiscount: number | null;
  minBookingAmount: number;
  /** Ceiling as a percent of the subtotal, 0–100. Never exceeds 100. */
  maxDiscountPctOfTotal: number;
}

/** A rule as it was applied, for `pricing_snapshot`. */
interface SnapshotRule {
  rule: string;
  params: Record<string, unknown>;
  effect: number;
}

export interface PricingBreakdown {
  lines: PricedLine[];
  subtotal: number;
  platformFee: number;
  discount: number;
  discountCode: string | null;
  taxRate: number;
  tax: number;
  total: number;
  commissionPct: number;
  commission: number;
  professionalGross: number;
  platformRevenue: number;
  currency: string;
  snapshot: Record<string, unknown>;
}

export interface PriceQuoteInput {
  lines: readonly PriceLineInput[];
  settings: PricingSettings;
  /** The professional's own commission rate. Defaults to the platform setting. */
  commissionPct?: number;
  coupon?: CouponInput | null;
}

/**
 * Price a line, in paise.
 *
 * Hourly scales the base by duration and honours a duration row's multiplier;
 * `flat` ignores the duration entirely, because a flat price is flat; and
 * `per_unit` multiplies by the quantity agreed at booking. The duration row's
 * flat `price` overrides an hourly base, which is what a "2 hours = ₹450"
 * offer is.
 */
function lineTotalPaise(line: PriceLineInput): number {
  const base = toPaise(line.basePrice);
  if (line.pricingType === 'flat') return base;
  if (line.pricingType === 'per_unit') {
    const quantity = line.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError(`quantity must be a positive integer, got ${quantity}`);
    }
    return base * quantity;
  }
  if (!Number.isInteger(line.durationMinutes) || line.durationMinutes <= 0) {
    throw new RangeError(`durationMinutes must be a positive integer, got ${line.durationMinutes}`);
  }
  if (line.durationPrice != null) return toPaise(line.durationPrice);
  return roundHalfUp((base * line.durationMinutes * (line.priceMultiplier ?? 1)) / 60);
}

/**
 * What a coupon is worth against a subtotal, in paise.
 *
 * Four ceilings, applied in order, each of which exists because a coupon row is
 * editable by marketing:
 *
 * 1. `max_discount` — a 50% coupon is capped at ₹200 on a large booking.
 * 2. `max_discount_pct_of_total` — the belt-and-braces one, so a mistake in
 *    `max_discount` still cannot produce a negative payable.
 * 3. `subtotal + platformFee` — §7.1's floor guard. The discount is taken out
 *    of the pre-tax amount, so it can never exceed that amount; without this a
 *    coupon larger than the booking would drive `taxable` negative and the
 *    `money_non_negative` constraint would reject the insert.
 * 4. Zero, for the same reason.
 */
export function couponDiscountPaise(
  coupon: CouponInput,
  subtotalPaise: number,
  platformFeePaise: number
): number {
  const value = toPaise(coupon.discountValue);
  let discount =
    coupon.discountType === 'percentage'
      ? // `discount_value` is a percent on a 0–100 scale here, unlike
        // `tax_rate`, which is a rate. The scale difference between the two
        // columns is the single easiest thing to get wrong in this file.
        percentOfPaise(subtotalPaise, coupon.discountValue / 100)
      : value;

  if (coupon.discountType === 'percentage' && coupon.maxDiscount != null) {
    discount = Math.min(discount, toPaise(coupon.maxDiscount));
  }

  const ceilingPct = Math.min(Math.max(coupon.maxDiscountPctOfTotal, 0), 100);
  discount = Math.min(discount, percentOfPaise(subtotalPaise, ceilingPct / 100));
  discount = Math.min(discount, subtotalPaise + platformFeePaise);

  return Math.max(discount, 0);
}

/**
 * Throw if the shares do not sum to what the customer pays.
 *
 * A discount rule added later that forgets to update a share would otherwise
 * quietly pay a professional more than the customer paid, and the loss would
 * surface as a payout run that does not reconcile.
 */
function assertBalanced(
  totalPaise: number,
  professionalGrossPaise: number,
  platformRevenuePaise: number
): void {
  if (professionalGrossPaise + platformRevenuePaise !== totalPaise) {
    throw new Error(
      `Pricing does not balance: gross ${professionalGrossPaise} + revenue ${platformRevenuePaise} ` +
        `!= total ${totalPaise}. A share is being counted twice or dropped.`
    );
  }
}

/**
 * The whole engine. `§7.1`, with the fee correction described at the top.
 *
 * Order matters and follows the spec exactly. Each monetary step rounds to a
 * paisa as it is taken, because that is what appears on the invoice; rounding
 * once at the end would produce a different total from the same rules, which
 * is the sort of thing that is only noticed by a customer.
 */
export function priceQuote(input: PriceQuoteInput): PricingBreakdown {
  const { settings, coupon } = input;
  if (input.lines.length === 0) throw new RangeError('A quote needs at least one line');

  const rules: SnapshotRule[] = [];

  // --- subtotal -------------------------------------------------------------
  const linePaise = input.lines.map(lineTotalPaise);
  const subtotalPaise = sumPaise(linePaise);
  rules.push({
    rule: 'line_total',
    params: {
      lines: input.lines.map((l, i) => ({
        serviceId: l.serviceId,
        pricingType: l.pricingType,
        basePrice: l.basePrice,
        durationMinutes: l.durationMinutes,
        quantity: l.quantity ?? 1,
        durationPrice: l.durationPrice ?? null,
        priceMultiplier: l.priceMultiplier ?? null,
      })),
    },
    effect: subtotalPaise,
  });

  // --- platform fee ---------------------------------------------------------
  if (!Number.isFinite(settings.platformFeePct) || settings.platformFeePct < 0) {
    throw new RangeError(`platformFeePct must be a non-negative rate, got ${settings.platformFeePct}`);
  }
  const feeMinPaise = toPaise(settings.platformFeeMin);
  const feeFromPct = percentOfPaise(subtotalPaise, settings.platformFeePct);
  const platformFeePaise = Math.max(feeMinPaise, feeFromPct);
  rules.push({
    rule: 'platform_fee',
    params: { platformFeePct: settings.platformFeePct, platformFeeMin: settings.platformFeeMin },
    effect: platformFeePaise,
  });

  // --- discount -------------------------------------------------------------
  const commissionPct = input.commissionPct ?? settings.platformFeePct;
  let discountPaise = 0;
  let discountCode: string | null = null;
  if (coupon) {
    if (subtotalPaise < toPaise(coupon.minBookingAmount)) {
      throw new RangeError(
        `Coupon ${coupon.code} needs a subtotal of at least ${coupon.minBookingAmount}`
      );
    }
    discountPaise = couponDiscountPaise(coupon, subtotalPaise, platformFeePaise);
    discountCode = coupon.code;
    rules.push({
      rule: 'coupon_discount',
      params: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscount: coupon.maxDiscount,
        minBookingAmount: coupon.minBookingAmount,
        maxDiscountPctOfTotal: coupon.maxDiscountPctOfTotal,
      },
      effect: discountPaise,
    });
  }

  // --- taxable, tax, total --------------------------------------------------
  const taxablePaise = subtotalPaise + platformFeePaise - discountPaise;
  const taxPaise = percentOfPaise(taxablePaise, settings.taxRate);
  const totalPaise = taxablePaise + taxPaise;
  rules.push({ rule: 'tax', params: { taxRate: settings.taxRate, taxablePaise }, effect: taxPaise });
  rules.push({
    rule: 'total',
    params: { subtotalPaise, platformFeePaise, discountPaise, taxPaise },
    effect: totalPaise,
  });

  // --- the split ------------------------------------------------------------
  const commissionPaise = percentOfPaise(taxablePaise, commissionPct);
  // See the header: the fee is charged to the platform, not to the professional,
  // otherwise it is counted in `taxable` here and again in `platform_revenue`.
  const professionalGrossPaise = taxablePaise - platformFeePaise - commissionPaise;
  const platformRevenuePaise = platformFeePaise + taxPaise + commissionPaise;
  rules.push({
    rule: 'commission_split',
    params: { commissionPct, taxablePaise, platformFeePaise },
    effect: commissionPaise,
  });
  assertBalanced(totalPaise, professionalGrossPaise, platformRevenuePaise);

  // --- lines ---------------------------------------------------------------
  // The discount is apportioned across lines so a per-line receipt adds up to
  // the invoice. Weighting by line total means the coupon takes proportionally
  // from everything rather than emptying the first line.
  const discountShares = allocate(discountPaise, linePaise);
  const lines: PricedLine[] = input.lines.map((l, i) => ({
    serviceId: l.serviceId,
    label: l.label,
    pricingType: l.pricingType,
    durationMinutes: l.durationMinutes,
    quantity: l.quantity ?? 1,
    lineTotal: rupees(linePaise[i]),
    discount: rupees(discountShares[i]),
    net: rupees(linePaise[i] - discountShares[i]),
  }));

  return {
    lines,
    subtotal: rupees(subtotalPaise),
    platformFee: rupees(platformFeePaise),
    discount: rupees(discountPaise),
    discountCode,
    taxRate: settings.taxRate,
    tax: rupees(taxPaise),
    total: rupees(totalPaise),
    commissionPct,
    commission: rupees(commissionPaise),
    professionalGross: rupees(professionalGrossPaise),
    platformRevenue: rupees(platformRevenuePaise),
    currency: settings.currency,
    snapshot: {
      engineVersion: PRICING_ENGINE_VERSION,
      currency: settings.currency,
      rules,
      totals: {
        subtotal: numericLiteral(subtotalPaise),
        platformFee: numericLiteral(platformFeePaise),
        discount: numericLiteral(discountPaise),
        taxable: numericLiteral(taxablePaise),
        tax: numericLiteral(taxPaise),
        total: numericLiteral(totalPaise),
        commission: numericLiteral(commissionPaise),
        professionalGross: numericLiteral(professionalGrossPaise),
        platformRevenue: numericLiteral(platformRevenuePaise),
      },
      commissionGrossFormula: 'taxable - platformFee - commission',
    },
  };
}

/**
 * The `bookings` row's money columns, ready to insert.
 *
 * Strings, because the columns are `numeric` and PostgREST should not be asked
 * to read a double as a decimal. This is the only place that conversion happens,
 * so nothing else in the codebase can quietly format a float into a money
 * column.
 */
export function toBookingMoneyColumns(quote: PricingBreakdown): Record<string, string> {
  const paise = (rupees: number) => numericLiteral(toPaise(rupees));
  return {
    subtotal: paise(quote.subtotal),
    platform_fee: paise(quote.platformFee),
    discount: paise(quote.discount),
    tax: paise(quote.tax),
    total_amount: paise(quote.total),
    professional_gross: paise(quote.professionalGross),
  };
}

export { parseNumeric };