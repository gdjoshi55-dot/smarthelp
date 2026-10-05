import { describe, expect, it } from 'vitest';
import {
  allocate,
  numericLiteral,
  parseNumeric,
  percentOfPaise,
  roundHalfUp,
  rupees,
  sumPaise,
  toPaise,
} from '@/lib/money';

/**
 * `lib/money.ts`. The tests here are about the cases where floating point and
 * half-up rounding disagree, because those are the only cases that matter.
 */
describe('roundHalfUp', () => {
  it('rounds a half away from zero', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
  });

  it('rounds a negative half away from zero, not toward +infinity', () => {
    // Math.round(-0.5) is -0 in JavaScript, which is half up, not half away.
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-1.5)).toBe(-2);
  });

  it('lifts a value that binary representation put a hair below the line', () => {
    // 0.145 is stored as 0.14499999999999999. Math.round gives 0; this gives 1.
    expect(0.145 * 100).toBeLessThan(14.5);
    expect(roundHalfUp(0.145 * 100)).toBe(15);
  });

  it('does not move a value whose fraction is genuinely below the line', () => {
    expect(roundHalfUp(14.49999)).toBe(14);
    expect(roundHalfUp(14.50001)).toBe(15);
  });
});

describe('toPaise / rupees / numericLiteral', () => {
  it('converts round-trip exactly', () => {
    for (const r of [0, 1, 12.34, 249.5, 1234.56, 99999.99]) {
      expect(rupees(toPaise(r))).toBe(r);
    }
  });

  it('rounds a third decimal place half-up', () => {
    expect(toPaise(12.345)).toBe(1235);
    expect(toPaise(12.344)).toBe(1234);
  });

  it('formats two places for a numeric column', () => {
    expect(numericLiteral(1234)).toBe('12.34');
    expect(numericLiteral(0)).toBe('0.00');
    expect(numericLiteral(5)).toBe('0.05');
  });

  it('never writes a negative zero into a money column', () => {
    // "-0.00" is a legal numeric literal and an unwelcome line on a receipt.
    expect(numericLiteral(-0)).toBe('0.00');
    expect(rupees(-0)).toBe(0);
  });

  it('rejects values that are not finite', () => {
    expect(() => toPaise(Number.NaN)).toThrow();
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('parseNumeric', () => {
  it('reads the strings PostgREST returns for numeric', () => {
    expect(parseNumeric('1234.56')).toBe(1234.56);
    expect(parseNumeric('1234.5600')).toBe(1234.56);
    expect(parseNumeric('0.00')).toBe(0);
    expect(parseNumeric(42)).toBe(42);
  });

  it('throws rather than defaulting a broken value to zero', () => {
    // Every money column on bookings is not null, so a zero here would quietly
    // create a booking worth nothing.
    expect(() => parseNumeric('abc')).toThrow();
    expect(() => parseNumeric('')).toThrow();
    expect(() => parseNumeric(Number.NaN)).toThrow();
  });
});

describe('percentOfPaise', () => {
  it('computes GST on an exact base', () => {
    expect(percentOfPaise(10000, 0.18)).toBe(1800);
    expect(percentOfPaise(92000, 0.18)).toBe(16560);
  });

  it('rounds a half paiso up', () => {
    // ₹0.005 at 18% lands on half a paiso.
    expect(percentOfPaise(3, 0.18)).toBe(1);
  });

  it('treats the rate as a rate, not a percentage', () => {
    expect(percentOfPaise(10000, 18)).toBe(180000);
  });
});

describe('sumPaise', () => {
  it('does not drift where float addition would', () => {
    expect(sumPaise([100, 200, 300])).toBe(600);
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumPaise([10, 20, 30])).toBe(60);
  });

  it('refuses a non-finite part', () => {
    expect(() => sumPaise([100, Number.NaN])).toThrow();
  });
});

describe('allocate', () => {
  it('sums to exactly the whole amount', () => {
    // The reason this function exists: 1000 paise over three equal weights
    // floors to 333+333+333 = 999, and the missing paisa has to land somewhere.
    const shares = allocate(1000, [500, 500, 500]);
    expect(shares).toEqual([334, 333, 333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('would lose a paisa if each share were rounded independently', () => {
    const naive = [333, 333, 333];
    expect(naive.reduce((a, b) => a + b, 0)).toBe(999);
  });

  it('never overpays where rounding each share up would', () => {
    // Three shares each landing on exactly half a paiso would round to
    // 2+2+2 = 6 for a 5-paise total.
    const shares = allocate(5, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('gives leftover paise to the largest remainder', () => {
    const shares = allocate(10, [3, 1]);
    // 7.5 and 2.5: both half, so the tie breaks on index.
    expect(shares).toEqual([8, 2]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('is deterministic, because the result is frozen into pricing_snapshot', () => {
    const weights = [7, 11, 13, 17];
    const first = allocate(1000, weights);
    for (let i = 0; i < 20; i++) expect(allocate(1000, weights)).toEqual(first);
  });

  it('weights the split by the weights', () => {
    const shares = allocate(1000, [750, 250]);
    expect(shares).toEqual([750, 250]);
  });

  it('puts everything on the first part when there is nothing to weigh by', () => {
    const shares = allocate(1000, [0, 0, 0]);
    expect(shares).toEqual([1000, 0, 0]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('handles zero and empty', () => {
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    expect(allocate(1000, [])).toEqual([]);
  });

  it('splits a negative amount symmetrically', () => {
    const shares = allocate(-1000, [500, 500, 500]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(-1000);
  });
});