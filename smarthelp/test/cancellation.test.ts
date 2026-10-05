import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CANCELLATION_POLICIES,
  cancellationCopy,
  formatFee,
  quoteCancellation,
  quoteRescheduleFee,
  resolveCancellationPolicy,
  type CancellationPolicyRow,
} from '@/lib/cancellation';

/**
 * Every band of §11.1 is a branch, and the branches are the whole product
 * decision. A regression here does not throw — it charges somebody the wrong
 * amount and tells them so confidently.
 *
 * The amounts are chosen to land on exact paisa so a mistake is unambiguous:
 * ₹1,000 gives 10% = ₹100.00 and 25% = ₹250.00.
 */

const AMOUNT = 1000;

function quote(over: Partial<Parameters<typeof quoteCancellation>[0]> = {}) {
  return quoteCancellation({
    amount: AMOUNT,
    hoursBefore: 48,
    arrived: false,
    cancelledBy: 'customer',
    ...over,
  });
}

describe('the §11.1 ladder', () => {
  it('charges nothing beyond 24 hours out', () => {
    for (const hours of [25, 48, 200]) {
      const result = quote({ hoursBefore: hours });
      expect(result.fee, `${hours}h`).toBe(0);
      expect(result.refund, `${hours}h`).toBe(AMOUNT);
      expect(result.band, `${hours}h`).toBe('over_24h');
    }
  });

  it('charges 10% between 6 and 24 hours, and at exactly 24', () => {
    // Exactly 24 is in both "≥ 24 h" and "6–24 h", and §11.1's SQL breaks the tie
    // by taking the smaller ceiling — which is the tighter band. The rule is
    // `$2 <= hours_before ORDER BY hours_before ASC LIMIT 1`, so the boundary
    // belongs to the band above it. Asserted explicitly because a "fix" that
    // made 24 hours free would be indistinguishable from a boundary bug.
    for (const hours of [24, 23.9, 12, 6.1]) {
      const result = quote({ hoursBefore: hours });
      expect(result.fee, `${hours}h`).toBe(100);
      expect(result.refund, `${hours}h`).toBe(900);
      expect(result.band, `${hours}h`).toBe('6_to_24h');
    }
  });

  it('charges 25% between 2 and 6 hours, and at exactly 6', () => {
    for (const hours of [6, 5.9, 3, 2.1]) {
      const result = quote({ hoursBefore: hours });
      expect(result.fee, `${hours}h`).toBe(250);
      expect(result.band, `${hours}h`).toBe('2_to_6h');
    }
  });

  it('charges 50% inside two hours, at exactly 2, and after the start time', () => {
    // A negative `hoursBefore` means the slot is in the past — a late
    // cancellation, not an impossible one. §11.1's `< 2 h` band is unbounded
    // below, so it is still 50% and not "no policy matched".
    for (const hours of [2, 1.9, 0.5, 0, -3]) {
      const result = quote({ hoursBefore: hours });
      expect(result.fee, `${hours}h`).toBe(500);
      expect(result.band, `${hours}h`).toBe('under_2h');
    }
  });

  it('charges the full amount once the professional has arrived', () => {
    // §11.1: "After arrived — percentage 100%. The visit is treated as
    // consumed." Arrival wins over the hours, so a booking 30 hours out that has
    // somehow been marked arrived is still 100%.
    const result = quote({ hoursBefore: 30, arrived: true });
    expect(result.fee).toBe(AMOUNT);
    expect(result.refund).toBe(0);
    expect(result.band).toBe('after_arrival');
  });

  it('is zero rather than negative when the fee is the whole amount', () => {
    const result = quote({ hoursBefore: 30, arrived: true });
    expect(result.refund).toBe(0);
    expect(result.refund).toBeGreaterThanOrEqual(0);
  });
});

describe('the stored ceilings', () => {
  it('are the ceilings of the bands, not their floors', () => {
    // The whole table, misread by one column, still looks plausible. This
    // asserts the column is a ceiling: "≥ 24 h" is unbounded, "6–24 h" is 24,
    // "2–6 h" is 6, "< 2 h" is 2.
    expect(DEFAULT_CANCELLATION_POLICIES.map((p) => p.hoursBefore)).toEqual([
      null, 24, 6, 2, null,
    ]);
    expect(DEFAULT_CANCELLATION_POLICIES[0].feeType).toBe('free');
  });

  it('reach every band for a request in each of them', () => {
    // One representative request per row, which is the only way to catch a
    // boundary that has moved without any single band looking wrong.
    for (const [hoursBefore, expected] of [
      [100, 'over_24h'],
      [25, 'over_24h'],
      [24, '6_to_24h'],
      [23.9, '6_to_24h'],
      [6, '2_to_6h'],
      [5.9, '2_to_6h'],
      [2, 'under_2h'],
      [1.9, 'under_2h'],
      [0, 'under_2h'],
    ] as const) {
      expect(quote({ hoursBefore }).band, `${hoursBefore}h`).toBe(expected);
    }
  });
});

describe('a fixed fee larger than the booking', () => {
  const policies: CancellationPolicyRow[] = [
    { serviceId: null, hoursBefore: null, feeType: 'fixed', feeValue: 500, band: 'flat' },
  ];

  it('clamps to the amount, so the refund cannot go negative', () => {
    const result = quoteCancellation({
      amount: 300,
      hoursBefore: 0.5,
      arrived: false,
      cancelledBy: 'customer',
      policies,
    });
    expect(result.fee).toBe(300);
    expect(result.refund).toBe(0);
  });

  it('charges the flat amount when it fits', () => {
    const result = quoteCancellation({
      amount: 900,
      hoursBefore: 0.5,
      arrived: false,
      cancelledBy: 'customer',
      policies,
    });
    expect(result.fee).toBe(500);
    expect(result.refund).toBe(400);
  });
});

describe('§11.2 professional cancellation', () => {
  it('waives the fee entirely, even inside the two-hour band', () => {
    for (const by of ['professional', 'ops', 'system'] as const) {
      const result = quote({ hoursBefore: 0.5, arrived: true, cancelledBy: by });
      expect(result.fee, by).toBe(0);
      expect(result.refund, by).toBe(AMOUNT);
      expect(result.waived, by).toBe(true);
    }
  });

  it('is the only way to reach the waiver for a `professional` cancel', () => {
    // The waiver is a parameter, not a branch anyone can reach by accident.
    const waived = quote({ hoursBefore: 0.5, cancelledBy: 'professional' });
    const notWaived = quote({ hoursBefore: 0.5, cancelledBy: 'customer' });
    expect(waived.fee).toBe(0);
    expect(notWaived.fee).toBe(500);
  });
});

describe('resolveCancellationPolicy', () => {
  it('prefers a service-specific row over the platform-wide one', () => {
    const policies: CancellationPolicyRow[] = [
      { serviceId: null, hoursBefore: 24, feeType: 'free', feeValue: 0 },
      { serviceId: 'svc-ac', hoursBefore: 24, feeType: 'percentage', feeValue: 15 },
    ];
    const row = resolveCancellationPolicy({ hoursBefore: 10, arrived: false, serviceId: 'svc-ac', policies });
    expect(row?.feeType).toBe('percentage');
    expect(row?.feeValue).toBe(15);
  });

  it('falls back to the global rows for a service with none of its own', () => {
    const policies: CancellationPolicyRow[] = [
      { serviceId: null, hoursBefore: 24, feeType: 'free', feeValue: 0 },
      { serviceId: 'svc-ac', hoursBefore: 24, feeType: 'percentage', feeValue: 15 },
    ];
    const row = resolveCancellationPolicy({ hoursBefore: 10, arrived: false, serviceId: 'svc-b', policies });
    expect(row?.feeType).toBe('free');
  });

  it('picks the tightest band that still contains the request', () => {
    // This is the ORDER BY. With the rows in the default order and no sort, the
    // six-to-twenty-four-hour request would match the free row and be free.
    expect(resolveCancellationPolicy({ hoursBefore: 12, arrived: false })?.feeValue).toBe(10);
    expect(resolveCancellationPolicy({ hoursBefore: 4, arrived: false })?.feeValue).toBe(25);
    expect(resolveCancellationPolicy({ hoursBefore: 1, arrived: false })?.feeValue).toBe(50);
  });

  it('returns null rather than guessing when no row covers the request', () => {
    expect(resolveCancellationPolicy({ hoursBefore: 1, arrived: false, policies: [] })).toBeNull();
    const result = quote({ hoursBefore: 1, policies: [] });
    expect(result.fee).toBe(0);
    expect(result.band).toBe('no_policy');
  });

  it('ships the §11.1 table with the values the specification gives', () => {
    expect(DEFAULT_CANCELLATION_POLICIES.map((p) => p.feeValue)).toEqual([0, 10, 25, 50, 100]);
    expect(DEFAULT_CANCELLATION_POLICIES.map((p) => p.feeType)).toEqual([
      'free',
      'percentage',
      'percentage',
      'percentage',
      'percentage',
    ]);
  });
});

describe('§11.3 reschedule fee', () => {
  it('is free until a professional is assigned', () => {
    const result = quoteRescheduleFee({
      amount: AMOUNT,
      hoursBefore: 1,
      cancelledBy: 'customer',
      assigned: false,
    });
    expect(result.fee).toBe(0);
    expect(result.band).toBe('free_until_assigned');
  });

  it('uses the same ladder as cancellation once the calendar is committed', () => {
    const assigned = quoteRescheduleFee({
      amount: AMOUNT,
      hoursBefore: 1,
      cancelledBy: 'customer',
      assigned: true,
    });
    expect(assigned.fee).toBe(quote({ hoursBefore: 1 }).fee);
    expect(assigned.fee).toBe(500);
  });
});

describe('copy', () => {
  it('states the amount in rupees rather than a percentage', () => {
    // §16 #18: the fee has to be visible before the customer commits, and a
    // percentage is not something a person can accept.
    const copy = cancellationCopy(quote({ hoursBefore: 4 }));
    expect(copy).toContain('₹250.00');
    expect(copy).toContain('₹750.00');
    expect(copy).not.toContain('%');
  });

  it('says so plainly when there is no fee, and when it was waived', () => {
    expect(cancellationCopy(quote({ hoursBefore: 48 }))).toMatch(/no cancellation fee/i);
    expect(cancellationCopy(quote({ hoursBefore: 1, cancelledBy: 'professional' }))).toMatch(
      /not your decision/i
    );
  });

  it('formats every fee to two places', () => {
    expect(formatFee(96.3)).toBe('₹96.30');
    expect(formatFee(0)).toBe('₹0.00');
    // A third of a rupee has to read as the paisa it rounds to, not as 3.33…
    expect(formatFee(9.999)).toBe('₹10.00');
  });
});

describe('paise, not floats', () => {
  it('rounds a percentage fee half-up on a subtotal that would drift in binary', () => {
    // 10% of ₹437.80 is 43.78. In floating point 4378 * 0.1 is 437.79999999999995,
    // which would floor to ₹43.79 -> ₹43.78 is the answer only if the rounding
    // is done on paise.
    const result = quote({ amount: 437.8, hoursBefore: 12 });
    expect(result.fee).toBe(43.78);
    expect(result.refund).toBe(394.02);
  });

  it('refuses a negative amount rather than returning a negative refund', () => {
    expect(() => quote({ amount: -1 })).toThrow();
  });
});