import { describe, expect, it } from 'vitest';
import { priceForDuration } from '@/lib/catalogue';
import { toPaise } from '@/lib/money';
import {
  couponDiscountPaise,
  priceQuote,
  toBookingMoneyColumns,
  PRICING_ENGINE_VERSION,
  type CouponInput,
  type PriceLineInput,
  type PricingSettings,
} from '@/lib/pricing';

/**
 * The pricing engine (§7.1).
 *
 * Two things are being defended here. The first is the arithmetic, which is
 * checked against the specification's own formula. The second is the invariant
 * that the professional's share plus the platform's share equals what the
 * customer paid — which the specification's own formula violates, for the
 * reason set out at the top of `lib/pricing.ts`.
 */

const SETTINGS: PricingSettings = {
  taxRate: 0.18,
  platformFeePct: 0.02,
  platformFeeMin: 20,
  currency: 'INR',
};

function hourly(basePrice: number, durationMinutes = 60, extra: Partial<PriceLineInput> = {}): PriceLineInput {
  return {
    serviceId: 'svc',
    label: 'Service',
    pricingType: 'hourly',
    basePrice,
    durationMinutes,
    ...extra,
  };
}

function coupon(overrides: Partial<CouponInput> = {}): CouponInput {
  return {
    code: 'SAVE50',
    discountType: 'percentage',
    discountValue: 50,
    maxDiscount: null,
    minBookingAmount: 0,
    maxDiscountPctOfTotal: 100,
    ...overrides,
  };
}

/**
 * Does the professional's share plus the platform's share equal the total?
 *
 * Compared in paise, never in rupees. The shares balance exactly as integers,
 * but adding two 2dp floats does not reliably give a 2dp float — 103.95 comes
 * out of the addition as 103.94999999999999 — so a float comparison here would
 * report a real, exact balance as broken. Asserting it the way the money is
 * actually stored is also the assertion that matters.
 */
function balances(quote: ReturnType<typeof priceQuote>): boolean {
  return toPaise(quote.professionalGross) + toPaise(quote.platformRevenue) === toPaise(quote.total);
}

/** Everything the engine emits must land on a whole paisa. */
function expectTwoDecimals(quote: ReturnType<typeof priceQuote>): void {
  const figures: Record<string, number> = {
    subtotal: quote.subtotal,
    platformFee: quote.platformFee,
    discount: quote.discount,
    tax: quote.tax,
    total: quote.total,
    commission: quote.commission,
    professionalGross: quote.professionalGross,
    platformRevenue: quote.platformRevenue,
  };
  // "No third decimal place." Stated as a tolerance because a 2dp figure held
  // in a double is not exactly n/100 — the question is whether it is within a
  // rounding error of it, not whether it is bit-exact.
  const assertWholePaise = (name: string, value: number) => {
    const scaled = value * 100;
    expect(Math.abs(scaled - Math.round(scaled)), name).toBeLessThan(1e-6);
  };
  for (const [name, value] of Object.entries(figures)) assertWholePaise(name, value);
  for (const line of quote.lines) {
    assertWholePaise('lineTotal', line.lineTotal);
    assertWholePaise('line discount', line.discount);
    assertWholePaise('line net', line.net);
  }
}

describe('priceQuote — the formula', () => {
  it('computes the §7.1 worked example', () => {
    // ₹1000 of service, ₹20 fee, ₹100 coupon, 18% GST, 20% commission.
    const quote = priceQuote({
      lines: [hourly(1000)],
      settings: { ...SETTINGS, platformFeePct: 0.02 },
      commissionPct: 0.2,
      coupon: coupon({ discountValue: 10, maxDiscountPctOfTotal: 100 }),
    });

    expect(quote.subtotal).toBe(1000);
    expect(quote.platformFee).toBe(20); // max(20 min, 2% of 1000 = 20)
    expect(quote.discount).toBe(100);
    expect(quote.tax).toBe(165.6); // 18% of 920
    expect(quote.total).toBe(1085.6);
    expect(quote.commission).toBe(184); // 20% of 920
  });

  it('takes the larger of the percentage fee and the minimum fee', () => {
    const small = priceQuote({ lines: [hourly(100)], settings: SETTINGS });
    expect(small.platformFee).toBe(20); // 2% = ₹2, floor wins

    const big = priceQuote({ lines: [hourly(5000)], settings: SETTINGS });
    expect(big.platformFee).toBe(100); // 2% = ₹100, percentage wins
  });

  it('scales an hourly line by duration', () => {
    const one = priceQuote({ lines: [hourly(249)], settings: SETTINGS });
    const three = priceQuote({ lines: [hourly(249, 180)], settings: SETTINGS });
    expect(three.subtotal).toBe(747);
    expect(three.subtotal).toBe(one.subtotal * 3);
  });

  it('honours a duration row that overrides the base', () => {
    const quote = priceQuote({
      lines: [hourly(249, 120, { durationPrice: 450 })],
      settings: SETTINGS,
    });
    expect(quote.subtotal).toBe(450);
  });

  it('honours a duration row multiplier', () => {
    const quote = priceQuote({
      lines: [hourly(200, 60, { priceMultiplier: 1.5 })],
      settings: SETTINGS,
    });
    expect(quote.subtotal).toBe(300);
  });

  it('ignores the duration for a flat price', () => {
    const one = priceQuote({ lines: [{ ...hourly(0, 60), pricingType: 'flat', basePrice: 499 }], settings: SETTINGS });
    const six = priceQuote({ lines: [{ ...hourly(0, 360), pricingType: 'flat', basePrice: 499 }], settings: SETTINGS });
    expect(one.subtotal).toBe(499);
    expect(six.subtotal).toBe(499);
  });

  it('multiplies a per-unit line by the agreed quantity', () => {
    const quote = priceQuote({
      lines: [{ ...hourly(0, 0), pricingType: 'per_unit', basePrice: 25, quantity: 4 }],
      settings: SETTINGS,
    });
    expect(quote.subtotal).toBe(100);
  });

  it('refuses a per-unit line with no quantity rather than assuming one', () => {
    expect(() =>
      priceQuote({
        lines: [{ ...hourly(0, 0), pricingType: 'per_unit', basePrice: 25, quantity: 0 }],
        settings: SETTINGS,
      })
    ).toThrow(/positive integer/);
  });

  it('refuses an empty quote', () => {
    expect(() => priceQuote({ lines: [], settings: SETTINGS })).toThrow(/at least one line/);
  });

  it('refuses a negative fee rate', () => {
    expect(() => priceQuote({ lines: [hourly(100)], settings: { ...SETTINGS, platformFeePct: -1 } })).toThrow();
  });

  it('sums several lines', () => {
    const quote = priceQuote({
      lines: [hourly(100), hourly(200, 30), { ...hourly(0, 0), pricingType: 'per_unit', basePrice: 10, quantity: 3 }],
      settings: SETTINGS,
    });
    // 100 (1h at 100) + 100 (30 min at 200/h) + 30 (10 x 3)
    expect(quote.subtotal).toBe(230);
  });
});

describe('priceQuote — the split balances', () => {
  it('splits the §7.1 example without inventing money', () => {
    const quote = priceQuote({
      lines: [hourly(1000)],
      settings: SETTINGS,
      commissionPct: 0.2,
      coupon: coupon({ discountValue: 10, maxDiscountPctOfTotal: 100 }),
    });
    // The specification's own lines give 736 + 369.60 = 1105.60 against a total
    // of 1085.60, because the ₹20 fee is booked twice.
    expect(quote.professionalGross).toBe(716);
    expect(quote.platformRevenue).toBe(369.6);
    expect(balances(quote)).toBe(true);
  });

  it('balances across every combination of settings and coupons', () => {
    const subtotals = [99, 100, 499, 999.99, 1000, 1234.56, 50_000];
    const fees = [0, 0.02, 0.05, 0.2];
    const mins = [0, 20];
    const commissions = [0, 0.1, 0.2, 0.35];
    const coupons = [
      null,
      coupon(),
      coupon({ discountType: 'fixed', discountValue: 5000 }),
      coupon({ discountValue: 100, maxDiscount: 150 }),
      coupon({ maxDiscountPctOfTotal: 40 }),
      coupon({ maxDiscountPctOfTotal: 0 }),
    ];

    let cases = 0;
    for (const subtotal of subtotals) {
      for (const platformFeePct of fees) {
        for (const platformFeeMin of mins) {
          for (const commissionPct of commissions) {
            for (const c of coupons) {
              for (const taxRate of [0, 0.05, 0.18, 0.28]) {
                const settings: PricingSettings = { taxRate, platformFeePct, platformFeeMin, currency: 'INR' };
                let quote;
                try {
                  quote = priceQuote({
                    lines: [hourly(subtotal)],
                    settings,
                    commissionPct,
                    coupon: c,
                  });
                } catch {
                  continue; // e.g. a coupon below its minimum
                }
                const label = `subtotal=${subtotal} fee=${platformFeePct} min=${platformFeeMin} commission=${commissionPct} tax=${taxRate} coupon=${c?.code ?? 'none'}/${c?.discountValue}`;

                expect(balances(quote), label).toBe(true);
                expect(quote.total, label).toBeGreaterThanOrEqual(0);
                expect(quote.discount, label).toBeGreaterThanOrEqual(0);
                expectTwoDecimals(quote);
                cases++;
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(500);
  });

  it('never pays the professional more than the customer paid', () => {
    for (const subtotal of [50, 99, 100, 500, 10_000]) {
      for (const c of [null, coupon(), coupon({ maxDiscountPctOfTotal: 40 })]) {
        const quote = priceQuote({ lines: [hourly(subtotal)], settings: SETTINGS, coupon: c });
        expect(quote.professionalGross).toBeLessThanOrEqual(quote.total);
        expect(quote.platformRevenue).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('pays the professional on the discounted service value, not the fee or the tax', () => {
    const quote = priceQuote({ lines: [hourly(1000)], settings: SETTINGS, commissionPct: 0.2 });
    // 1000 subtotal, 20 fee, 18% of 1020 = 183.60 tax, total 1203.60,
    // commission 20% of 1020 = 204. Professional: 1020 - 20 - 204 = 796.
    expect(quote.tax).toBe(183.6);
    expect(quote.commission).toBe(204);
    expect(quote.professionalGross).toBe(796);
    expect(quote.platformRevenue).toBe(20 + 183.6 + 204);
  });
});

describe('couponDiscountPaise — the four ceilings', () => {
  const subtotal = 10_000; // ₹100
  const fee = 2000; // ₹20

  it('applies a percentage of the subtotal', () => {
    expect(couponDiscountPaise(coupon({ discountValue: 10 }), subtotal, fee)).toBe(1000);
  });

  it('applies a fixed amount', () => {
    expect(
      couponDiscountPaise(coupon({ discountType: 'fixed', discountValue: 40 }), subtotal, fee)
    ).toBe(4000);
  });

  it('caps a percentage at max_discount', () => {
    expect(
      couponDiscountPaise(coupon({ discountValue: 50, maxDiscount: 30 }), subtotal, fee)
    ).toBe(3000);
  });

  it('ignores max_discount for a fixed coupon', () => {
    // A fixed amount is not a rate, so a cap expressed as one has nothing to
    // scale against; the percentage ceiling below still applies.
    expect(
      couponDiscountPaise(coupon({ discountType: 'fixed', discountValue: 40, maxDiscount: 5 }), subtotal, fee)
    ).toBe(4000);
  });

  it('caps at max_discount_pct_of_total even when max_discount is higher', () => {
    // The belt-and-braces ceiling: a marketing mistake in max_discount must not
    // be able to produce a negative payable.
    expect(
      couponDiscountPaise(
        coupon({ discountValue: 50, maxDiscount: 900, maxDiscountPctOfTotal: 40 }),
        subtotal,
        fee
      )
    ).toBe(4000);
  });

  it('is bounded by the percentage ceiling before the floor guard can bind', () => {
    // §7.1's floor guard allows a discount up to subtotal + platformFee, but
    // max_discount_pct_of_total is clamped to 100% of the subtotal, which is
    // strictly less. So on today's rules the floor guard is unreachable — it is
    // defence in depth, and the thing that would stop `taxable` going negative
    // if the ceiling were ever allowed above 100.
    expect(couponDiscountPaise(coupon({ discountValue: 500 }), subtotal, fee)).toBe(10_000);
    expect(couponDiscountPaise(coupon({ discountType: 'fixed', discountValue: 500 }), subtotal, fee)).toBe(
      10_000
    );
    expect(couponDiscountPaise(coupon({ discountValue: 100, maxDiscountPctOfTotal: 100 }), subtotal, fee)).toBe(
      subtotal
    );
  });

  it('clamps a nonsense ceiling instead of trusting it', () => {
    // A ceiling above 100% is clamped to 100%, which is what stops an
    // "impossible" coupon from discounting more than the subtotal.
    expect(couponDiscountPaise(coupon({ discountValue: 500, maxDiscountPctOfTotal: 500 }), subtotal, fee)).toBe(
      10_000
    );
    // And a ceiling of 100% does not bind a 50% coupon.
    expect(couponDiscountPaise(coupon({ discountValue: 50, maxDiscountPctOfTotal: 500 }), subtotal, fee)).toBe(
      5000
    );
  });

  it('never goes below zero', () => {
    expect(couponDiscountPaise(coupon({ discountValue: 500, maxDiscountPctOfTotal: -1 }), subtotal, fee)).toBe(0);
  });

  it('rejects a coupon below its minimum booking amount', () => {
    expect(() =>
      priceQuote({ lines: [hourly(100)], settings: SETTINGS, coupon: coupon({ minBookingAmount: 500 }) })
    ).toThrow(/at least 500/);
  });
});

describe('priceQuote — per-line discount', () => {
  it('apportions the coupon so the lines sum to the invoice', () => {
    const quote = priceQuote({
      lines: [hourly(500), hourly(333), hourly(167)],
      settings: SETTINGS,
      coupon: coupon({ discountValue: 10, maxDiscountPctOfTotal: 100 }),
    });

    const lineDiscounts = quote.lines.map((l) => l.discount);
    expect(lineDiscounts.reduce((a, b) => a + b, 0)).toBe(quote.discount);
    expect(toPaise(quote.discount)).toBe(100_00);
  });

  it('keeps a single line whole', () => {
    const quote = priceQuote({
      lines: [hourly(1000)],
      settings: SETTINGS,
      coupon: coupon({ discountValue: 25, maxDiscountPctOfTotal: 100 }),
    });
    expect(quote.lines[0].discount).toBe(250);
    expect(quote.lines[0].net).toBe(750);
  });

  it('apportions an awkward discount over three lines without losing a paisa', () => {
    const quote = priceQuote({
      lines: [hourly(33.33), hourly(33.33), hourly(33.33)],
      settings: SETTINGS,
      coupon: coupon({ discountValue: 10, maxDiscountPctOfTotal: 100 }),
    });
    const total = quote.lines.reduce((a, l) => a + toPaise(l.discount), 0);
    expect(total).toBe(toPaise(quote.discount));
  });

  it('makes the lines net add up to subtotal minus discount', () => {
    const quote = priceQuote({
      lines: [hourly(500), hourly(333), hourly(167)],
      settings: SETTINGS,
      coupon: coupon({ discountValue: 10, maxDiscountPctOfTotal: 100 }),
    });
    const net = quote.lines.reduce((a, l) => a + l.net, 0);
    expect(toPaise(net)).toBe(toPaise(quote.subtotal - quote.discount));
  });

  it('leaves lines untouched when there is no coupon', () => {
    const quote = priceQuote({ lines: [hourly(500), hourly(300)], settings: SETTINGS });
    expect(quote.discount).toBe(0);
    expect(quote.discountCode).toBeNull();
    expect(quote.lines.every((l) => l.discount === 0 && l.net === l.lineTotal)).toBe(true);
  });
});

describe('priceQuote — agreement with the catalogue', () => {
  it('agrees with priceForDuration, so the two cannot drift apart', () => {
    // Phase 1 shipped a bug where the client and the server each had their own
    // idea of a duration's price. The catalogue prices for display; the engine
    // prices for the invoice. They must be the same function.
    const cases: Array<[Parameters<typeof priceForDuration>[0], number, Parameters<typeof priceForDuration>[2]]> = [
      [{ pricingType: 'hourly', basePrice: 249, unitPrice: null }, 30, null],
      [{ pricingType: 'hourly', basePrice: 249, unitPrice: null }, 60, null],
      [{ pricingType: 'hourly', basePrice: 249, unitPrice: null }, 90, null],
      [{ pricingType: 'hourly', basePrice: 249, unitPrice: null }, 120, null],
      [{ pricingType: 'hourly', basePrice: 249, unitPrice: null }, 180, { price: 650, priceMultiplier: null }],
      [{ pricingType: 'hourly', basePrice: 199, unitPrice: null }, 90, { price: null, priceMultiplier: 1.25 }],
      [{ pricingType: 'flat', basePrice: 499, unitPrice: null }, 60, null],
      [{ pricingType: 'flat', basePrice: 499, unitPrice: null }, 240, null],
      [{ pricingType: 'per_unit', basePrice: 25, unitPrice: 25 }, 0, null],
    ];

    for (const [service, minutes, option] of cases) {
      const expected = priceForDuration(service, minutes, option);
      const line = hourly(service.basePrice, minutes || 1, {
        pricingType: service.pricingType,
        ...(option?.price != null ? { durationPrice: option.price } : {}),
        ...(option?.priceMultiplier != null ? { priceMultiplier: option.priceMultiplier } : {}),
      });
      const quote = priceQuote({ lines: [line], settings: SETTINGS });
      const label = `${service.pricingType} base=${service.basePrice} min=${minutes} opt=${JSON.stringify(option)}`;
      expect(quote.subtotal, label).toBe(expected);
    }
  });
});

describe('the snapshot', () => {
  it('records every rule, in order, with its parameters', () => {
    const quote = priceQuote({
      lines: [hourly(1000)],
      settings: SETTINGS,
      commissionPct: 0.2,
      coupon: coupon({ discountValue: 10, maxDiscountPctOfTotal: 100 }),
    });

    const snapshot = quote.snapshot as { rules: Array<{ rule: string }>; engineVersion: number };
    expect(snapshot.engineVersion).toBe(PRICING_ENGINE_VERSION);
    expect(snapshot.rules.map((r) => r.rule)).toEqual([
      'line_total',
      'platform_fee',
      'coupon_discount',
      'tax',
      'total',
      'commission_split',
    ]);
  });

  it('records the totals as the literal strings the columns hold', () => {
    const quote = priceQuote({ lines: [hourly(1000)], settings: SETTINGS });
    const totals = (quote.snapshot as { totals: Record<string, string> }).totals;
    expect(totals.subtotal).toBe('1000.00');
    expect(totals.tax).toBe('183.60');
    expect(totals.total).toBe('1203.60');
  });

  it('notes the corrected commission formula', () => {
    const quote = priceQuote({ lines: [hourly(1000)], settings: SETTINGS });
    expect((quote.snapshot as { commissionGrossFormula: string }).commissionGrossFormula).toBe(
      'taxable - platformFee - commission'
    );
  });
});

describe('toBookingMoneyColumns', () => {
  it('emits strings, because the columns are numeric', () => {
    const quote = priceQuote({
      lines: [hourly(1000)],
      settings: SETTINGS,
      commissionPct: 0.2,
    });
    const columns = toBookingMoneyColumns(quote);
    expect(columns).toEqual({
      subtotal: '1000.00',
      platform_fee: '20.00',
      discount: '0.00',
      tax: '183.60',
      total_amount: '1203.60',
      professional_gross: '796.00',
    });
    for (const value of Object.values(columns)) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+\.\d{2}$/);
    }
  });
});