import type { BookingStatus } from './supabase';

/**
 * What a booking's status looks and says (Phase 2).
 *
 * Two things live here, and both of them are things that must not be written
 * twice:
 *
 *   1. The transition table, as data. `enforce_booking_transition()` in 0011 is
 *      the enforcement; this is the same table in TypeScript, so a Route
 *      Handler can say "you cannot cancel a completed booking" in a sentence
 *      instead of letting Postgres raise and reporting the constraint name. The
 *      `status.test.ts` suite checks the two agree by hitting the real trigger.
 *
 *   2. The presentation: label, badge variant, and where the status sits on the
 *      customer's stepper.
 *
 * ## Colour is never the only signal
 *
 * §23 requires it, and it is also the accessibility rule. Every badge pairs its
 * colour with a word — "Cancelled", "Payment pending" — and the stepper pairs it
 * with a shape (filled / ring / empty) and a label. Two people who cannot
 * distinguish the colours read the same information.
 */

/**
 * §8.2's table, as legal *successors*. The trigger stores predecessors of the
 * new state; this is the same set inverted, because a caller asks "from where I
 * am standing, where can I go".
 *
 * `test/status.test.ts` walks every pair here against `enforce_booking_transition()`
 * on a live database, so the two cannot drift without a test failing.
 */
export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  draft: ['payment_pending', 'cancelled'],
  payment_pending: ['paid', 'cancelled'],
  // `paid -> cancelled` is legal and is the fee-bearing path: the money is in but
  // no professional has been matched yet, so §16's cancellation fee is exactly what
  // it exists for. Omitting it here meant the Route Handler refused a cancellation
  // the database would have allowed.
  paid: ['searching', 'cancelled', 'refund_pending'],
  searching: ['assigned', 'cancelled'],
  // Deliberately no `refund_pending`: §8.2 reaches `refund_pending` from
  // cancelled, paid, accepted, on_the_way, arrived and disputed — an *offer* is
  // not one of them. From `assigned` the professional has to decline (or accept,
  // and then something goes wrong later in the job), so the offer route is
  // `assigned -> cancelled -> refund_pending`, which is also the route the
  // cancellation fee is calculated on.
  assigned: ['accepted', 'cancelled'],
  accepted: ['on_the_way', 'cancelled', 'refund_pending', 'disputed', 'no_show'],
  on_the_way: ['arrived', 'cancelled', 'refund_pending', 'disputed', 'no_show'],
  arrived: ['otp_verified', 'cancelled', 'refund_pending', 'disputed', 'no_show'],
  otp_verified: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['extension_requested', 'completed', 'cancelled', 'disputed', 'no_show'],
  extension_requested: ['in_progress', 'cancelled'],
  completed: ['closed', 'disputed'],
  cancelled: ['refund_pending'],
  refund_pending: ['refunded'],
  refunded: ['closed'],
  disputed: ['refund_pending'],
  no_show: ['closed'],
  closed: [],
};

/** The application half of the guard. The trigger is what actually enforces it. */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The states a booking can still be *moved* from.
 *
 * A reschedule is not a transition — `§8.2` has no reschedule edge because the
 * booking stays in the same state and only its window changes — so there is
 * nothing in the table above to derive this from. It has to be stated, and it has
 * to be stated once, because two copies drift: the detail route decides whether to
 * offer the panel and the reschedule route decides whether to honour it, and a
 * customer who is offered a move the route then refuses has been told a lie by
 * one of them.
 *
 * The line is drawn at "the professional has not set off". Everything before it is
 * a promise about time; from `on_the_way` onwards the professional is on the road
 * or standing at the door, and moving the time no longer describes anything real.
 * `draft` is included because a booking nobody submitted is the most movable thing
 * of all.
 */
export const RESCHEDULABLE_STATUSES: readonly BookingStatus[] = [
  'draft',
  'payment_pending',
  'paid',
  'searching',
  'assigned',
  'accepted',
];

/**
 * Whether a reschedule is allowed from here, ignoring the booking's type.
 *
 * `booking_type` is checked separately and belongs to the route: an instant
 * booking has no window to move even when the status would allow it.
 */
export function isReschedulableStatus(status: BookingStatus): boolean {
  return RESCHEDULABLE_STATUSES.includes(status);
}

/**
 * The customer's progress ladder, in order.
 *
 * `searching` is absent because it is a Phase 5 state a customer should never
 * see the inside of, and `otp_verified` is absent because it lasts milliseconds
 * — both map onto a neighbouring step instead of appearing as steps of their own.
 * Anything not on this ladder and not aliased onto it (cancelled, refunded,
 * disputed, no_show) is a dead end the UI renders as a message, not a stepper.
 *
 * Note that consecutive entries are not single legal moves: `paid -> assigned`
 * goes through `searching`, and `arrived -> in_progress` goes through
 * `otp_verified`. The ladder is a presentation order, and the invariant it owes
 * the caller is reachability through the table, not adjacency in it.
 */
export const CUSTOMER_LADDER: readonly BookingStatus[] = [
  'draft',
  'payment_pending',
  'paid',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'in_progress',
  'completed',
  'closed',
];

/**
 * States that are not steps of their own but sit on a neighbour's step.
 *
 * Derived rather than written as a number, because a hand-written `step` is a
 * second copy of the ladder: the first version of this file carried
 * `searching: 2` and `otp_verified: 7` as literals, `extension_requested: 7`
 * slipped in beside them, and nothing checked that an off-ladder state had a
 * null step until a test asked. Step numbers now come from `CUSTOMER_LADDER`
 * and this table alone, so `step !== null` is a *property* of being on the
 * ladder or aliased onto it.
 */
export const STEP_ALIASES: Partial<Record<BookingStatus, BookingStatus>> = {
  /** The dispatch window between `paid` and `assigned`; the customer sees "Paid". */
  searching: 'paid',
  /** Milliseconds long; the customer sees the `in_progress` step instead. */
  otp_verified: 'in_progress',
  /** A branch off `in_progress`, not a step of its own. */
  extension_requested: 'in_progress',
};

/**
 * Where a status sits on the ladder: its own index, the index of the step it
 * aliases, or null for a state the stepper does not render at all.
 */
export function customerStep(status: BookingStatus): number | null {
  const own = CUSTOMER_LADDER.indexOf(status);
  if (own !== -1) return own;
  const aliased = STEP_ALIASES[status];
  return aliased === undefined ? null : CUSTOMER_LADDER.indexOf(aliased);
}

export type StatusTone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusPresentation {
  /** What the badge says. Never an empty string, never a colour name. */
  label: string;
  /** One line a customer can read and act on. */
  description: string;
  tone: StatusTone;
  /**
   * Tailwind classes for the badge. `tone` is what a caller switches on; this
   * is the pre-built class string so no component invents its own palette.
   */
  badgeClass: string;
  /** No successor exists: nothing further will happen to this booking. */
  terminal: boolean;
  /** §8.2 allows a customer cancellation from here. */
  customerCancellable: boolean;
  /** Position on `CUSTOMER_LADDER`, or null for a state that is not on it. */
  step: number | null;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-transparent',
  info: 'bg-sky-100 text-sky-900 border-transparent',
  progress: 'bg-amber-100 text-amber-900 border-transparent',
  success: 'bg-emerald-100 text-emerald-900 border-transparent',
  warning: 'bg-orange-100 text-orange-900 border-transparent',
  danger: 'bg-red-100 text-red-900 border-transparent',
};

function present(
  status: BookingStatus,
  label: string,
  description: string,
  tone: StatusTone
): StatusPresentation {
  // `statusPresentation` falls back for a value that is not in the enum, and the
  // fallback must not throw: `TRANSITIONS[status]` was indexed unconditionally
  // here, so an unrecognised status — exactly the raw-cast-from-JSON case the
  // fallback exists for — crashed instead of degrading. Unknown means unknown:
  // it is neither terminal (we do not know that nothing follows) nor
  // cancellable, which is the only safe answer to give a UI.
  const successors = TRANSITIONS[status];
  return {
    label,
    description,
    tone,
    badgeClass: TONE_CLASSES[tone],
    terminal: successors !== undefined && successors.length === 0,
    customerCancellable: successors?.includes('cancelled') ?? false,
    step: customerStep(status),
  };
}

/**
 * Every one of the 18 states, including the eleven the code does not reach
 * yet. The enum ships in full for a reason (see 0009), and a status with no
 * presentation would be a status the UI renders as a blank, so every label is
 * here even for states only a later phase can produce.
 */
export const BOOKING_STATUS: Record<BookingStatus, StatusPresentation> = {
  draft: present('draft', 'Not submitted', 'This booking has not been sent yet.', 'neutral'),
  payment_pending: present(
    'payment_pending',
    'Payment pending',
    'We are waiting for the payment to be confirmed.',
    'progress'
  ),
  paid: present('paid', 'Paid', 'Payment received. We are finding you a professional.', 'info'),
  searching: present(
    'searching',
    'Finding a professional',
    'We are sending your job to professionals nearby.',
    'info'
  ),
  assigned: present(
    'assigned',
    'Professional assigned',
    'A professional has been offered the job.',
    'info'
  ),
  accepted: present(
    'accepted',
    'Confirmed',
    'The professional has accepted and will be with you at the booked time.',
    'info'
  ),
  on_the_way: present(
    'on_the_way',
    'On the way',
    'The professional is travelling to your address.',
    'progress'
  ),
  arrived: present(
    'arrived',
    'Arrived',
    'The professional is at your address and waiting for you to start the job.',
    'progress'
  ),
  otp_verified: present(
    'otp_verified',
    'Starting',
    'The start code was accepted and the timer is running.',
    'progress'
  ),
  in_progress: present('in_progress', 'In progress', 'The service is under way.', 'progress'),
  extension_requested: present(
    'extension_requested',
    'Extension requested',
    'You have asked for more time. The professional will accept or decline.',
    'progress'
  ),
  completed: present(
    'completed',
    'Completed',
    'The service is finished. Rate the professional to close this booking.',
    'success'
  ),
  cancelled: present(
    'cancelled',
    'Cancelled',
    'This booking was cancelled. See the cancellation fee above.',
    'danger'
  ),
  refund_pending: present(
    'refund_pending',
    'Refund pending',
    'The refund has been requested and is with our payments team.',
    'warning'
  ),
  refunded: present(
    'refunded',
    'Refunded',
    'The amount has been returned to your original payment method.',
    'success'
  ),
  disputed: present(
    'disputed',
    'Under review',
    'Support is looking into this booking. We will be in touch.',
    'warning'
  ),
  no_show: present(
    'no_show',
    'No show',
    'Nobody attended the booking. Contact support if that is wrong.',
    'danger'
  ),
  closed: present(
    'closed',
    'Closed',
    'This booking is closed. The records are kept for your history.',
    'neutral'
  ),
};
export function statusPresentation(status: BookingStatus): StatusPresentation {
  // The enum is closed, so a missing key is a code bug rather than bad data;
  // falling back to the raw label is still better than rendering undefined.
  return (
    BOOKING_STATUS[status] ?? present(status, status.replace(/_/g, ' '), '', 'neutral')
  );
}

/** The §16 cancellation reasons a customer may pick from. */
export const CANCELLATION_REASONS = [
  { code: 'changed_mind', label: 'Changed my mind' },
  { code: 'booked_by_mistake', label: 'Booked by mistake' },
  { code: 'pro_unavailable', label: 'Professional is not available' },
  { code: 'price_changed', label: 'Price changed' },
  { code: 'no_longer_needed', label: 'No longer needed' },
  { code: 'other', label: 'Something else' },
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASONS)[number]['code'];

export function isCancellationReason(value: unknown): value is CancellationReasonCode {
  return CANCELLATION_REASONS.some((r) => r.code === value);
}