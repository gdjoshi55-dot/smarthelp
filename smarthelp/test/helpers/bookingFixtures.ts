import { priceQuote, type PricingSettings } from '@/lib/pricing';
import { PLATFORM_DEFAULTS } from '@/lib/constants';

/**
 * Money figures the route tests assert on, computed by the real engine.
 *
 * The point of deriving them rather than writing `613.60` into each test is
 * that a change to a fee default or a rounding rule moves the expectation with
 * it. A hard-coded total would keep passing after the pricing changed, which is
 * exactly the failure a pricing test must not have.
 */

export const PRICE_SETTINGS: PricingSettings = {
  taxRate: PLATFORM_DEFAULTS.taxRate,
  platformFeePct: PLATFORM_DEFAULTS.platformFeePct,
  platformFeeMin: PLATFORM_DEFAULTS.platformFeeMin,
  currency: PLATFORM_DEFAULTS.currency,
};

/** One hour of a ₹500 hourly service, priced by the engine. */
export const PRICE_FEES = priceQuote({
  lines: [
    {
      serviceId: 'ffffffff-1111-4111-8111-ffffffffffff',
      label: 'Deep cleaning',
      pricingType: 'hourly',
      basePrice: 500,
      durationMinutes: 60,
    },
  ],
  settings: PRICE_SETTINGS,
});

/** §7.1's worked example: a ₹500 subtotal takes the ₹20 fee floor, not 4%. */
export const PRICE_SUBTOTAL = PRICE_FEES.subtotal;
export const PRICE_TOTAL = PRICE_FEES.total;