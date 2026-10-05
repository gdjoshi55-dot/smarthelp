import { roundHalfUp, toPaise, numericLiteral, parseNumeric } from './money';

/**
 * The cancellation ladder (§11.1) as a pure function.
 *
 * §11.1 is a five-row table with the resolution SQL next to it. This is that SQL
 * without the SQL, because the arithmetic is the part worth testing and the
 * part that has to be readable when a customer disputes a fee.
 *
 * ## The bands
 *
 *   ≥ 24 h   free        0%      — the slot can be refilled; the whole point
 *   6–24 h   percentage 10%      — the professional's time is already spoken for
 *   2–6 h    percentage 25%
 *   < 2 h    percentage 50%
 *   arrived  percentage 100%     — the visit is treated as consumed
 *
 * ## How the bands are stored, which is the part that is easy to get wrong
 *
 * `hoursBefore` on a row is the **ceiling** of its band, not the floor. §11.1's
 * SQL matches `$2 <= hours_before` and takes `ORDER BY hours_before ASC LIMIT 1`,
 * so a row is chosen by: *the smallest ceiling that is still at or above the
 * request*. That makes "≥ 24 h" the unbounded row (`hoursBefore: null`), 6–24 h
 * the ceiling-24 row, 2–6 h the ceiling-6 row and `< 2 h` the ceiling-2 row.
 *
 * Storing the floor instead — 24, 6, 2, 0 — is the same table written down
 * wrong, and it fails quietly: a request four hours out matches nothing but the
 * 24 and 6 rows, so it is charged 10% when §11.1 says 25%, and nobody finds out
 * until a customer reads the policy page.
 *
 * ## Where a boundary falls
 *
 * §11.1 writes "≥ 24 h" and "6 – 24 h", which both contain 24. The SQL settles
 * it: `ORDER BY hours_before ASC LIMIT 1` takes the smallest ceiling that still
 * covers the request, so an exact boundary lands in the **tighter** band — 24
 * hours out is 10%, 6 hours out is 25%, 2 hours out is 50%. That is the
 * behaviour implemented below, and `test/cancellation.test.ts` asserts it at all
 * three boundaries, because making them free instead would look like a harmless
 * leniency until an ops analyst reconciles the month.
 *
 * ## The two guards that are easy to lose
 *
 *   `LEAST(fee_value, amount)` for a `fixed` fee — a flat ₹500 fee cannot be
 *   charged against a ₹300 booking, and without the clamp `total_amount - fee`
 *   goes negative and the booking becomes worth money to the customer.
 *
 *   §11.2's waiver — when it is not the customer's fault, the fee is zero. It is
 *   a parameter rather than a branch so that nothing can reach it by accident.
 *
 * ## Where the rows come from
 *
 * `DEFAULT_CANCELLATION_POLICIES` below is §11.1's table with the
 * specification's own values. `cancellation_policies` is an admin-configurable
 * table in §24 but a Phase 6 one, so the row shape is defined here and the rows
 * are constants for now — the same arrangement Phase 1 used for
 * `instant_lead_minutes` and Phase 2 used for `platform_settings`.
 */

export type CancellationFeeType = 'free' | 'percentage' | 'fixed';

export interface CancellationPolicyRow {
  /** NULL is the platform-wide default; a service id is more specific. */
  serviceId?: string | null;
  /** The **ceiling** of the band in hours. `null` = no upper bound ("≥ 24 h"). */
  hoursBefore: number | null;
  feeType: CancellationFeeType;
  /** Percent (0–100) for `percentage`, rupees for `fixed`, ignored for `free`. */
  feeValue: number;
  /** Set on the arrival row, which §11.1 keys on arrival rather than on time. */
  appliesWhenArrived?: boolean;
  /** Shown to the customer and asserted in tests, so a band cannot be misnamed. */
  band?: string;
}

/** §11.1's table, verbatim, with each row's ceiling. */
export const DEFAULT_CANCELLATION_POLICIES: readonly CancellationPolicyRow[] = [
  { serviceId: null, hoursBefore: null, feeType: 'free', feeValue: 0, band: 'over_24h' },
  { serviceId: null, hoursBefore: 24, feeType: 'percentage', feeValue: 10, band: '6_to_24h' },
  { serviceId: null, hoursBefore: 6, feeType: 'percentage', feeValue: 25, band: '2_to_6h' },
  { serviceId: null, hoursBefore: 2, feeType: 'percentage', feeValue: 50, band: 'under_2h' },
  {
    serviceId: null,
    hoursBefore: null,
    feeType: 'percentage',
    feeValue: 100,
    appliesWhenArrived: true,
    band: 'after_arrival',
  },
];

export interface CancellationQuery {
  /** The booking's `total_amount`, in rupees. */
  amount: number;
  /** Hours from now until `scheduled_start_at`. Negative once the start has passed. */
  hoursBefore: number;
  /** True once the professional has reached the address. */
  arrived: boolean;
  /** Who is cancelling. §11.2 waives the fee for anyone but the customer. */
  cancelledBy: 'customer' | 'professional' | 'ops' | 'system';
  serviceId?: string | null;
  /** Defaults to §11.1's table. */
  policies?: readonly CancellationPolicyRow[];
}

export interface CancellationQuote {
  /** Rupees. Always ≤ `amount`, never negative. */
  fee: number;
  /** `amount - fee`, floored at zero. Money back, before the gateway is involved. */
  refund: number;
  feeType: CancellationFeeType;
  feeValue: number;
  /** The band that decided it, so the UI can say why. */
  band: string;
  /** True when §11.2's waiver applied. */
  waived: boolean;
  /** The amount the fee was taken from, for the copy. */
  basis: number;
}

function isServiceSpecific(p: CancellationPolicyRow): number {
  return p.serviceId ? 1 : 0;
}

/**
 * The row that applies, most specific first.
 *
 * Specificity is §11.1's `ORDER BY (service_id IS NOT NULL) DESC, hours_before
 * ASC`: a service-specific row beats the platform-wide one, and within a scope
 * the tightest ceiling that still contains the request wins. `null` sorts last
 * in both, which is what puts the unbounded "free" row behind the others instead
 * of in front of them.
 *
 * Exported because the cancel dialog says "you will be charged X%" and a test
 * needs to assert the band without re-deriving it.
 */
export function resolveCancellationPolicy(query: {
  hoursBefore: number;
  arrived: boolean;
  serviceId?: string | null;
  policies?: readonly CancellationPolicyRow[];
}): CancellationPolicyRow | null {
  const policies = query.policies ?? DEFAULT_CANCELLATION_POLICIES;
  const applicable = policies.filter((p) =>
    query.serviceId ? p.serviceId === query.serviceId || !p.serviceId : !p.serviceId
  );

  const bySpecificityThenTightness = (a: CancellationPolicyRow, b: CancellationPolicyRow) =>
    isServiceSpecific(b) - isServiceSpecific(a) ||
    (a.hoursBefore ?? Number.POSITIVE_INFINITY) - (b.hoursBefore ?? Number.POSITIVE_INFINITY);

  // Arrival is checked first and is not a function of the hours: once the
  // professional is at the door, how long ago the slot was booked is irrelevant,
  // and a booking cancelled 30 hours out that has already been marked arrived is
  // still a consumed visit.
  if (query.arrived) {
    const onArrival = applicable
      .filter((p) => p.appliesWhenArrived)
      .sort(bySpecificityThenTightness)[0];
    if (onArrival) return onArrival;
  }

  const timed = applicable
    .filter((p) => !p.appliesWhenArrived)
    .filter((p) => p.hoursBefore === null || query.hoursBefore <= p.hoursBefore)
    .sort(bySpecificityThenTightness);

  return timed[0] ?? null;
}

/**
 * What cancelling this booking costs, and what is left.
 *
 * Computed in paise and converted once, for the reason the pricing engine does
 * the same: a 10% fee on ₹437.80 is 43.78 in decimal and 4378 in paise, and
 * only one of those is a fact.
 */
export function quoteCancellation(query: CancellationQuery): CancellationQuote {
  const amountPaise = toPaise(query.amount);
  if (amountPaise < 0) {
    throw new RangeError(`amount must not be negative, got ${query.amount}`);
  }
  const amount = amountPaise / 100;

  // §11.2. Not the customer's fault, so there is nothing to collect. Checked
  // before the ladder: the ladder answers "how much", and "nothing" is a
  // different question.
  if (query.cancelledBy !== 'customer') {
    return {
      fee: 0,
      refund: amount,
      feeType: 'free',
      feeValue: 0,
      band: `${query.cancelledBy}_cancelled`,
      waived: true,
      basis: amount,
    };
  }

  const policy = resolveCancellationPolicy({
    hoursBefore: query.hoursBefore,
    arrived: query.arrived,
    serviceId: query.serviceId,
    policies: query.policies,
  });

  // No policy covers it. Zero is the only safe answer: a fee invented from a
  // missing row would be money nobody agreed to charge.
  if (!policy) {
    return { fee: 0, refund: amount, feeType: 'free', feeValue: 0, band: 'no_policy', waived: false, basis: amount };
  }

  let feePaise = 0;
  switch (policy.feeType) {
    case 'free':
      feePaise = 0;
      break;
    case 'percentage': {
      const pct = Math.min(Math.max(policy.feeValue, 0), 100);
      feePaise = roundHalfUp((amountPaise * pct) / 100);
      break;
    }
    case 'fixed':
      // §11.1's `LEAST(fee_value, amount)`.
      feePaise = Math.min(toPaise(policy.feeValue), amountPaise);
      break;
  }

  return {
    fee: feePaise / 100,
    // Floored at zero: a fee and a refund are the same amount only when the fee
    // is the whole amount, and clamping here is what makes that the *most* they
    // can take rather than a case that can go wrong.
    refund: Math.max(amountPaise - feePaise, 0) / 100,
    feeType: policy.feeType,
    feeValue: policy.feeValue,
    band: policy.band ?? `${policy.feeType}:${policy.feeValue}`,
    waived: false,
    basis: amount,
  };
}

/**
 * §11.3: rescheduling costs the same as cancelling, once somebody is assigned.
 *
 * Free before that, because until a professional holds the booking nothing has
 * been taken off a calendar. Deliberately the same function over the same rows
 * as the cancellation ladder — a separate reschedule ladder would be a second
 * set of numbers to keep in step with this one.
 */
export function quoteRescheduleFee(
  query: Omit<CancellationQuery, 'arrived'> & { assigned: boolean }
): CancellationQuote {
  if (!query.assigned) {
    return {
      fee: 0,
      refund: 0,
      feeType: 'free',
      feeValue: 0,
      band: 'free_until_assigned',
      waived: false,
      basis: 0,
    };
  }
  return quoteCancellation({ ...query, arrived: false });
}

/** `₹123.45`, from paise. Used by the cancellation copy. */
export function formatFee(fee: number): string {
  return `₹${numericLiteral(toPaise(parseNumeric(fee)))}`;
}

/**
 * The sentence the cancel dialog shows above the button.
 *
 * In rupees, never as a percentage: §16 #18 asks for the fee to be visible
 * before the customer commits, and "a percentage of the booking" is not
 * something a person can accept.
 */
export function cancellationCopy(quote: CancellationQuote): string {
  if (quote.waived) return 'No cancellation fee — this was not your decision to make.';
  if (quote.fee === 0) return 'No cancellation fee on this booking.';
  if (quote.refund <= 0) return `The full ${formatFee(quote.basis)} is kept as a cancellation fee.`;
  return `A cancellation fee of ${formatFee(quote.fee)} applies. ${formatFee(quote.refund)} is returned to you.`;
}