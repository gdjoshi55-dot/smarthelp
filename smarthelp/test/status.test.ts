import { afterAll, describe, expect, it } from 'vitest';
import type { BookingStatus } from '../lib/supabase';
import {
  BOOKING_STATUS,
  CANCELLATION_REASONS,
  CUSTOMER_LADDER,
  STEP_ALIASES,
  TRANSITIONS,
  canTransition,
  isCancellationReason,
  statusPresentation,
} from '../lib/status';
import { closeDb, dbUrl, getClient, sql } from './helpers/dbEnv';

/**
 * The §8.2 transition table, and the presentation derived from it.
 *
 * The table is duplicated on purpose: `enforce_booking_transition()` in 0011 is
 * the thing that makes a booking's state safe, and `lib/status.ts` is the thing
 * that lets a Route Handler answer "you cannot cancel this" in a sentence
 * instead of reporting a Postgres constraint name. Duplication is only safe if
 * something checks the two agree, and that is the `describeDb` block at the
 * bottom: it asks the real trigger what it allows for every 18 × 18 pair that is
 * an actual move and compares. Everything above it runs with no database at all,
 * because the presentation rules are worth checking on every `npm test` and a
 * suite that skips itself when credentials are absent is a suite nobody runs.
 *
 *   npm run test:db   # for the parity block
 */

const ALL_STATUSES: readonly BookingStatus[] = [
  'draft',
  'payment_pending',
  'paid',
  'searching',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'otp_verified',
  'in_progress',
  'extension_requested',
  'completed',
  'cancelled',
  'refund_pending',
  'refunded',
  'disputed',
  'no_show',
  'closed',
];

describe('the transition table', () => {
  it('covers every status, so a missing key is a type error rather than undefined', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('sends every status somewhere except closed', () => {
    // `closed` being the only dead end is what lets the UI hide a cancel button
    // without a special case. If a later phase adds a terminal state, this fails
    // and the assertion below makes the decision deliberate.
    for (const status of ALL_STATUSES) {
      if (status === 'closed') expect(TRANSITIONS[status]).toEqual([]);
      else expect(TRANSITIONS[status].length, status).toBeGreaterThan(0);
    }
  });

  it('never lets a booking return to draft, so a cancelled one cannot be revived', () => {
    for (const status of ALL_STATUSES) {
      expect(TRANSITIONS[status], status).not.toContain('draft');
    }
    expect(canTransition('cancelled', 'draft')).toBe(false);
  });

  it('reaches money only through cancellation', () => {
    // §8.2 has no `paid -> refunded` and no `accepted -> refunded`. The one route
    // is `-> cancelled -> refund_pending -> refunded`, which is also the route
    // that puts a cancellation fee in the calculation — a booking refunded by any
    // other path would have returned money no fee was ever subtracted from.
    expect(canTransition('paid', 'refunded')).toBe(false);
    expect(canTransition('accepted', 'refunded')).toBe(false);
    expect(canTransition('completed', 'refunded')).toBe(false);
    expect(canTransition('cancelled', 'refunded')).toBe(false);
    expect(canTransition('cancelled', 'refund_pending')).toBe(true);
  });

  it('will not skip payment to become paid', () => {
    expect(canTransition('draft', 'paid')).toBe(false);
    expect(canTransition('draft', 'payment_pending')).toBe(true);
    expect(canTransition('payment_pending', 'paid')).toBe(true);
  });

  it('will not skip the professional accepting the job', () => {
    expect(canTransition('assigned', 'on_the_way')).toBe(false);
    expect(canTransition('assigned', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'on_the_way')).toBe(true);
  });

  it('will not let a completed booking be cancelled after the fact', () => {
    // §11.1's ladder is meaningless here: the work is done, so there is nothing
    // to refund and nothing to reschedule. `disputed` is the way out, and that
    // is deliberate — it routes to a human rather than a formula.
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('completed', 'disputed')).toBe(true);
    expect(canTransition('refunded', 'cancelled')).toBe(false);
    expect(canTransition('closed', 'cancelled')).toBe(false);
  });

  it('treats a status change to itself as not a transition', () => {
    // The trigger returns early when NEW.status is not distinct from OLD.status,
    // so a reschedule or a fee update does not raise. `canTransition` is the
    // application guard for an actual move and does not claim otherwise.
    for (const status of ALL_STATUSES) {
      expect(TRANSITIONS[status], status).not.toContain(status);
    }
  });

  it('has no duplicate successor anywhere', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(new Set(targets).size, from).toBe(targets.length);
    }
  });
});

describe('the customer ladder', () => {
  /**
   * Reachability through the table, not adjacency in it.
   *
   * The ladder is a *presentation* order, and two of its steps are states the
   * customer never sees: `paid -> assigned` goes through `searching`, and
   * `arrived -> in_progress` goes through `otp_verified`. Asserting a direct
   * `canTransition` on each consecutive pair therefore demanded a move §8.2
   * forbids, and the only way to satisfy it would have been to put a Phase 5
   * dispatch state into the customer's stepper. What the stepper actually owes
   * its caller is that walking it describes a path the booking can take.
   */
  function reachable(from: BookingStatus, to: BookingStatus): boolean {
    const seen = new Set<BookingStatus>([from]);
    const queue: BookingStatus[] = [from];
    while (queue.length > 0) {
      const current = queue.shift() as BookingStatus;
      if (current === to) return true;
      for (const next of TRANSITIONS[current] ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  }

  it('runs in an order the booking can actually reach', () => {
    // Every consecutive pair must be a path the database permits, or the stepper
    // walks a journey the booking cannot take. This is what keeps the progress
    // bar honest.
    for (let i = 1; i < CUSTOMER_LADDER.length; i += 1) {
      expect(reachable(CUSTOMER_LADDER[i - 1], CUSTOMER_LADDER[i]), CUSTOMER_LADDER[i]).toBe(true);
    }
  });

  it('does not walk backwards, so no step is reachable only from a later one', () => {
    // Reachability is checked forwards only above. A ladder that could also be
    // walked backwards would render a bar that moves in both directions.
    for (let i = 1; i < CUSTOMER_LADDER.length; i += 1) {
      expect(reachable(CUSTOMER_LADDER[i], CUSTOMER_LADDER[i - 1]), CUSTOMER_LADDER[i]).toBe(false);
    }
  });

  it('contains only statuses the customer is meant to see', () => {
    // `searching` is a dispatch state and `otp_verified` lasts milliseconds;
    // both map onto neighbouring steps instead of appearing as steps of their own.
    expect(CUSTOMER_LADDER).not.toContain('searching');
    expect(CUSTOMER_LADDER).not.toContain('otp_verified');
  });

  it('grows monotonically, so the bar never goes backwards', () => {
    const steps = CUSTOMER_LADDER.map((s) => statusPresentation(s).step);
    for (const step of steps) expect(step).not.toBeNull();
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i], `${CUSTOMER_LADDER[i]}`).toBeGreaterThan(steps[i - 1] as number);
    }
  });

  it('puts a status on a step exactly when the ladder can render one', () => {
    // The invariant the first version of this file broke. A hand-written `step`
    // number is a second copy of the ladder, so an off-ladder state could carry a
    // step the stepper has nowhere to draw — and `searching`, `otp_verified` and
    // `extension_requested` each did. Step numbers are derived now, so this holds
    // by construction; the loop is what keeps it that way.
    for (const status of ALL_STATUSES) {
      const renderable = CUSTOMER_LADDER.includes(status) || status in STEP_ALIASES;
      expect(statusPresentation(status).step !== null, status).toBe(renderable);
    }
  });

  it('aliases an off-ladder state onto a step that is on the ladder', () => {
    // An alias pointing at something off the ladder would put a status on step
    // -1, which is a stepper that renders a bar one notch to the left of zero.
    for (const [status, target] of Object.entries(STEP_ALIASES)) {
      expect(CUSTOMER_LADDER.includes(target as BookingStatus), status).toBe(true);
    }
  });

  it('leaves a state with no step on it one the stepper can render as a message', () => {
    // cancelled, refunded, disputed, no_show: the dead ends. No step, so the UI
    // shows a sentence instead of a bar that stops three-quarters full.
    for (const status of ['cancelled', 'refunded', 'disputed', 'no_show'] as const) {
      expect(statusPresentation(status).step, status).toBeNull();
    }
  });
});

describe('the presentation', () => {
  it('has a label and a description for all eighteen statuses', () => {
    for (const status of ALL_STATUSES) {
      const p = statusPresentation(status);
      expect(p.label.length, status).toBeGreaterThan(0);
      expect(p.description.length, status).toBeGreaterThan(0);
    }
  });

  it('never renders the raw token as the badge label', () => {
    // §23 / WCAG: colour is never the only signal, and neither is a slug. If a
    // label ever equals its status token, the badge has degenerated into debug
    // output and "on_the_way" is what a customer reads.
    for (const status of ALL_STATUSES) {
      expect(statusPresentation(status).label, status).not.toBe(status);
    }
  });

  it('agrees with the table about terminality and cancellability', () => {
    for (const status of ALL_STATUSES) {
      const p = statusPresentation(status);
      expect(p.terminal, status).toBe(TRANSITIONS[status].length === 0);
      expect(p.customerCancellable, status).toBe(TRANSITIONS[status].includes('cancelled'));
    }
  });

  it('gives every status a badge class, so no component invents its own palette', () => {
    const tones = new Set(Object.values(BOOKING_STATUS).map((p) => p.badgeClass));
    for (const status of ALL_STATUSES) {
      expect(statusPresentation(status).badgeClass.length, status).toBeGreaterThan(0);
    }
    expect(tones.size).toBeGreaterThan(1);
  });

  it('uses one shared tone per badge class, rather than a colour per status', () => {
    // A status that reused another status' class string would be invisible to a
    // caller switching on `tone`, which is the field the API is meant to expose.
    for (const p of Object.values(BOOKING_STATUS)) {
      const owner = BOOKING_STATUS[
        Object.keys(BOOKING_STATUS).find(
          (k) => BOOKING_STATUS[k as BookingStatus].badgeClass === p.badgeClass
        ) as BookingStatus
      ];
      expect(owner.tone, p.label).toBe(p.tone);
    }
  });

  it('calls a cancelled booking cancelled, and a refund a refund', () => {
    // The three states a customer checks first, spelled the way they would.
    expect(statusPresentation('cancelled').label).toBe('Cancelled');
    expect(statusPresentation('refund_pending').label).toBe('Refund pending');
    expect(statusPresentation('refunded').label).toBe('Refunded');
    expect(statusPresentation('no_show').label).toBe('No show');
  });

  it('falls back to a readable label for a status it does not know', () => {
    // The enum is closed, so this is unreachable through types. It is kept
    // because the alternative is `undefined` reaching the badge, and a raw cast
    // from a JSON response is exactly how an untyped value arrives in practice.
    const unknown = 'awaiting_review' as BookingStatus;
    const p = statusPresentation(unknown);
    expect(p.label).toBe('awaiting review');
    expect(p.terminal).toBe(false);
  });
});

describe('cancellation reasons', () => {
  it('offers the §16 set, with `other` last so it is the fallback', () => {
    expect(CANCELLATION_REASONS.map((r) => r.code)).toEqual([
      'changed_mind',
      'booked_by_mistake',
      'pro_unavailable',
      'price_changed',
      'no_longer_needed',
      'other',
    ]);
    expect(CANCELLATION_REASONS.at(-1)?.code).toBe('other');
  });

  it('has a unique lowercase code per reason', () => {
    const codes = CANCELLATION_REASONS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c, c).toMatch(/^[a-z][a-z_]*$/);
  });

  it('recognises exactly the codes it lists', () => {
    for (const r of CANCELLATION_REASONS) expect(isCancellationReason(r.code)).toBe(true);
    expect(isCancellationReason('')).toBe(false);
    expect(isCancellationReason('other ')).toBe(false);
    expect(isCancellationReason(null)).toBe(false);
    expect(isCancellationReason(undefined)).toBe(false);
    expect(isCancellationReason(0)).toBe(false);
  });
});

// ── Live parity with enforce_booking_transition() ──────────

const describeDb = dbUrl ? describe : describe.skip;

/** §8.2's mainline, whose prefixes are the only routes to the states on it. */
const MAINLINE: readonly BookingStatus[] = [
  'draft',
  'payment_pending',
  'paid',
  'searching',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'otp_verified',
  'in_progress',
];

/**
 * The statuses to write, in order, to reach `target` legally.
 *
 * Derived from `MAINLINE` rather than hand-listed. The hand-written version of
 * this omitted a state on the route to `paid` and to `cancelled`, and the
 * failure is invisible: the walk stops one step short, the assertion then
 * complains that a booking is in a state the test did not intend, and the
 * message points at the wrong line entirely.
 */
function pathTo(target: BookingStatus): BookingStatus[] {
  const onMainline = MAINLINE.indexOf(target);
  if (onMainline !== -1) return MAINLINE.slice(0, onMainline + 1) as BookingStatus[];

  switch (target) {
    case 'extension_requested':
      return [...MAINLINE, 'extension_requested'];
    case 'completed':
      return [...MAINLINE, 'completed'];
    case 'cancelled':
      return [...MAINLINE, 'cancelled'];
    case 'refund_pending':
      return [...MAINLINE, 'cancelled', 'refund_pending'];
    case 'refunded':
      return [...MAINLINE, 'cancelled', 'refund_pending', 'refunded'];
    case 'disputed':
      return [...MAINLINE, 'disputed'];
    case 'no_show':
      return [...MAINLINE, 'no_show'];
    case 'closed':
      return [...MAINLINE, 'completed', 'closed'];
    default:
      throw new Error(`no path is defined for '${target}'`);
  }
}

describeDb('TRANSITIONS against enforce_booking_transition()', () => {
  // Every probe below is a real `update` against a real trigger over a real
  // network hop, and there are 18 × 18 of them plus the walks. The 60s the other
  // database suites use is not enough for the whole matrix.
  it(
    'agrees on all 306 real pairs',
    async () => {
      const customer = await sql(
        `select c.id from public.customers c
           join public.profiles p on p.id = c.profile_id
          where p.email = 'demo.customer@smarthelp.test';`
      );
      const professional = await sql(
        `select pr.id from public.professionals pr
           join public.profiles p on p.id = pr.profile_id
          where p.email = 'demo.pro@smarthelp.test';`
      );
      if (!customer || !professional) {
        throw new Error('no seeded customer/professional — run "npm run db:seed"');
      }

      const address = await sql(
        `insert into public.addresses
           (customer_id, label, line1, area, city, state, pincode, lat, lng)
         values ('${customer}', 'Transition parity', '221B Test Street', 'HSR Layout',
                 'Bengaluru', 'Karnataka', '560102', 12.9116, 77.6389)
         returning id;`
      );

      const client = await getClient();
      const mismatches: string[] = [];

      const insert = async (): Promise<string> => {
        const res = await client.query(
          `insert into public.bookings
             (booking_number, customer_id, professional_id, address_id,
              address_snapshot, booking_type, status, duration_minutes,
              scheduled_start_at, scheduled_end_at, subtotal, platform_fee,
              tax, tax_rate, total_amount, professional_gross, commission_pct,
              pricing_snapshot)
           values (
             public.next_booking_number(), '${customer}', '${professional}', '${address}',
             '{"line1":"221B Test Street","city":"Bengaluru"}'::jsonb,
             'scheduled', 'draft', 60,
             '2030-03-04T10:00:00+05:30', '2030-03-04T11:00:00+05:30',
             1000.00, 50.00, 180.00, 0.1800, 1230.00, 1111.11, 0.1000,
             '{"total":1230.00}'::jsonb
           ) returning id;`
        );
        return res.rows[0].id as string;
      };

      for (const from of ALL_STATUSES) {
        const id = await insert();

        for (const status of pathTo(from)) {
          if (status === 'draft') continue;
          await client.query(`update public.bookings set status = '${status}' where id = '${id}';`);
        }

        for (const to of ALL_STATUSES) {
          // `from -> from` is not a transition. `enforce_booking_transition()`
          // returns early when NEW.status is not distinct from OLD.status, so the
          // trigger necessarily "allows" it — a reschedule, a cancellation fee and
          // a note all update the row without moving it, and raising there would
          // break every one. `canTransition` deliberately answers false for the
          // same pair (see "treats a status change to itself as not a
          // transition"), so comparing them would report 18 guaranteed mismatches
          // on a table that is in fact in perfect agreement.
          if (to === from) continue;

          // Each probe runs in its own transaction and is rolled back, so a
          // successful probe does not move the booking on and leave every later
          // probe on this `from` reporting a different answer. 324 throwaway
          // bookings would work too; it just costs far more than it looks.
          await client.query('begin');
          let allowed: boolean;
          try {
            await client.query(`update public.bookings set status = '${to}' where id = '${id}';`);
            allowed = true;
          } catch {
            allowed = false;
          }
          await client.query('rollback');

          if (allowed !== canTransition(from, to)) {
            mismatches.push(
              `${from} -> ${to}: trigger ${allowed ? 'allows' : 'refuses'}, TRANSITIONS says ${canTransition(
                from,
                to
              )}`
            );
          }
        }
      }

      expect(mismatches, mismatches.join('\n')).toEqual([]);
    },
    300_000
  );
});

afterAll(closeDb);