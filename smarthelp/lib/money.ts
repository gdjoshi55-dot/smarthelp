/**
 * Exact money arithmetic (§7.1).
 *
 * Everything here counts paise, never rupees. `bookings.total_amount` is
 * `numeric(12,2)` — an exact decimal — so the only way to stay exact on the way
 * into that column is to keep a fractional rupee out of every intermediate
 * value. 0.1 + 0.2 is 0.30000000000000004 in binary floating point, and a
 * booking total is the sum of a subtotal, a fee, a discount and a tax, each of
 * which is rounded on its own. Add those in floats and round once at the end
 * and the booking lands a paisa away from its own invoice, which is the kind of
 * discrepancy nobody believes until a customer's receipt disagrees with it.
 *
 * `round2()` in `lib/catalogue.ts` stays float-based on purpose: it formats one
 * already-trusted figure for display. This file is what the pricing engine uses
 * to arrive at that figure.
 *
 * Note that PostgREST returns `numeric` as a JSON *string*, to avoid handing a
 * 64-bit decimal to a float. `parseNumeric` is the boundary for that, and it
 * refuses to guess.
 */

/**
 * Round half away from zero, nudged by a relative epsilon.
 *
 * Math.round alone breaks on exactly the values that matter most here: a tax
 * that should land on half a paiso reads 1799.4999999999998 and rounds to 1799
 * instead of 1800. The epsilon is scaled by magnitude so it is far too small to
 * move a genuine fraction (at ₹10 crore in paise it is ~2e-7, against a
 * half-paiso boundary of 0.5) and only lifts a value that is a hair below the
 * line because of binary representation.
 */
export function roundHalfUp(n: number): number {
  const nudge = Number.EPSILON * Math.abs(n);
  return n < 0 ? -Math.round(-n + nudge) : Math.round(n + nudge);
}

/**
 * Read a `numeric` off a row.
 *
 * Strict on purpose. Every money column on `bookings` is `not null`, so a null
 * here is a broken query or a wrong column name, not an absent value — and
 * returning 0 for it would let a booking be created at a total of nothing. Call
 * sites that genuinely have an optional amount pass `?? 0` themselves, where
 * the decision is visible.
 */
export function parseNumeric(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Not a finite number: ${value}`);
    return value;
  }
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(n)) {
    throw new TypeError(`Not a number: ${JSON.stringify(value)}`);
  }
  return n;
}

/** Rupees (any precision) to paise. `12.34` -> `1234`, `12.345` -> `1235`. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) throw new TypeError(`Not a finite number: ${rupees}`);
  return roundHalfUp(rupees * 100);
}

/** Paise to a rupee number, for JSON responses. `-0` is normalised to `0`. */
export function rupees(paise: number): number {
  const n = paise / 100;
  return n === 0 ? 0 : n;
}

/**
 * Paise to the string PostgREST wants for a `numeric` column.
 *
 * A string, not a number: handing PostgREST the JSON float 1234.55 for a
 * `numeric(12,2)` asks it to trust a double to mean the same thing, and it does
 * not have to.
 */
export function numericLiteral(paise: number): string {
  const v = paise === 0 ? 0 : paise;
  return (v / 100).toFixed(2);
}

/** Exact sum. Keeps paise integers in integers. */
export function sumPaise(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) throw new TypeError(`Not a finite number: ${v}`);
    total += Math.round(v);
  }
  return total;
}

/**
 * A fraction of an amount, as paise. `rate` is a rate (0.18), not a percentage.
 *
 * The product is not an integer, so this rounds — and it rounds half up, which
 * is what GST is invoiced at and what a customer expects when a figure lands on
 * half a paiso.
 */
export function percentOfPaise(amountPaise: number, rate: number): number {
  return roundHalfUp(Math.round(amountPaise) * rate);
}

/**
 * Split an amount across parts by weight, with the parts summing to *exactly*
 * the whole.
 *
 * Largest-remainder allocation. Flooring each share independently loses paise:
 * a ₹10 discount over three equal items floors to 3+3+3 = 9 paise, and the
 * missing one has to go somewhere or the discount stops being the discount.
 * Rounding each share half-up instead breaks the other way — three half-paise
 * shares each round up and overpay by two paise.
 *
 * So: floor everything, then hand the leftover paise out one at a time to the
 * largest fractional remainder, breaking ties by index. The tie-break matters
 * because this result is frozen into `pricing_snapshot`; an engine that broke
 * ties differently on a replay would produce a different invoice from the same
 * input.
 *
 * A zero total weight means there is nothing to apportion by, so the whole
 * amount lands on the first part. That keeps the sum exact in the degenerate
 * case instead of quietly returning zeros.
 */
export function allocate(totalPaise: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sign = totalPaise < 0 ? -1 : 1;
  const target = Math.abs(Math.round(totalPaise));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  if (totalWeight <= 0) {
    return weights.map((_, i) => (i === 0 ? target * sign : 0));
  }

  const exact = weights.map((w) => (target * w) / totalWeight);
  const out = exact.map((e) => Math.floor(e));
  let leftover = target - out.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; leftover > 0; k++, leftover--) {
    out[order[k % order.length].i] += 1;
  }
  return out.map((v) => v * sign);
}