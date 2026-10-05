import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

/**
 * The Phase 2 database contract, asserted against a live project.
 *
 * Everything in `0010`/`0011`/`0013`/`0016`/`0017` exists to make a specific
 * mistake impossible. This file is the proof that it worked, and the assertions
 * are deliberately written as behaviour rather than as schema inspection: a test
 * that counts policies passes when a policy is wrong, and a test that counts
 * columns passes when the constraint that uses them is missing.
 *
 * The state machine is the clearest example. `booking_status` is an enum, and an
 * enum happily contains all eighteen labels while the actual rule — which
 * transitions are legal — lives somewhere else entirely. Checking
 * `select unnest(enum_range(null::booking_status))` would return eighteen names
 * and mean nothing. So the tests below attempt the illegal moves and expect the
 * database to refuse them.
 *
 * These run as the migration owner, which bypasses RLS. That is right for the
 * constraints — they apply to everyone, including the service role — but it means
 * these tests do not cover the policies. `db.rls.test.ts` covers those.
 *
 *   npm run db:migrate && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the booking database tests — no SUPABASE_DB_URL available.\n' +
      '     The booking state machine, the schedule exclusion constraint and the\n' +
      '     rating eligibility check are NOT covered by this run.\n'
  );
}

afterAll(closeDb);

/**
 * Every test that hits the network shares one connection, and these do real
 * writes with triggers and exclusion constraints behind them. See the same note
 * on the address block in db.rls.test.ts.
 */
const DB_TIMEOUT = 60_000;

// ── Fixtures ───────────────────────────────────────────────

async function profileId(email: string): Promise<string> {
  const id = await sql(`select id from public.profiles where email = '${email}';`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`no seeded profile for ${email} — run "npm run db:seed"`);
  }
  return id;
}

async function customerOf(email: string): Promise<{ profileId: string; customerId: string }> {
  const p = await profileId(email);
  const c = await sql(`select id from public.customers where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(c)) throw new Error(`${email} has no customers row`);
  return { profileId: p, customerId: c };
}

async function professionalOf(email: string): Promise<{ profileId: string; professionalId: string }> {
  const p = await profileId(email);
  const pr = await sql(`select id from public.professionals where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(pr)) throw new Error(`${email} has no professionals row`);
  return { profileId: p, professionalId: pr };
}

async function addressFor(customerId: string, label: string): Promise<string> {
  return sql(
    `insert into public.addresses
       (customer_id, label, line1, area, city, state, pincode, lat, lng)
     values ('${customerId}', '${label}', '221B Test Street', 'HSR Layout',
             'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900)
     returning id;`
  );
}

/**
 * A throwaway booking on a real address.
 *
 * `bookings.address_id` is NOT NULL and points at an `addresses` row, so a
 * booking cannot be created with an invented address — which is correct, and
 * means the fixture has to make one. `status` is left at the default `draft` and
 * `professional_id` is set, so a test can drive the state machine from wherever
 * it needs.
 *
 * `booking_number` is generated rather than supplied: `next_booking_number()`
 * drawing from a sequence is itself worth asserting, and hand-written numbers
 * would collide across runs.
 */
async function makeRealBooking(
  customerId: string,
  addressId: string,
  professionalId: string | null,
  opts: { bookingType?: string; minutes?: number; status?: string } = {}
): Promise<string> {
  const bookingType = opts.bookingType ?? 'scheduled';
  const minutes = opts.minutes ?? 60;
  const status = opts.status ?? 'draft';

  const sched = bookingType === 'instant' ? 'null' : `'2030-03-04T10:00:00+05:30'`;
  const schedEnd = bookingType === 'instant' ? 'null' : `'2030-03-04T11:00:00+05:30'`;

  return sql(
    `insert into public.bookings
       (booking_number, customer_id, professional_id, address_id, address_snapshot,
        locality_id, city_id, booking_type, status, duration_minutes,
        scheduled_start_at, scheduled_end_at, subtotal, platform_fee,
        tax, tax_rate, total_amount, professional_gross, commission_pct,
        pricing_snapshot)
     values (
       public.next_booking_number(), '${customerId}', ${professionalId ? `'${professionalId}'` : 'null'},
       '${addressId}',
       '{"label":"Test","line1":"221B Test Street","area":"HSR Layout","city":"Bengaluru","state":"Karnataka","pincode":"560102","lat":12.9116,"lng":77.6389}'::jsonb,
       null, null, '${bookingType}', '${status}', ${minutes},
       ${sched}, ${schedEnd},
       1000.00, 50.00, 180.00, 0.1800, 1230.00, 1111.11, 0.1000,
       '{"subtotal":1000.00,"platform_fee":50.00,"tax":180.00,"total":1230.00}'::jsonb
     )
     returning id;`
  );
}

/**
 * §8.2's mainline, in order. Every state between draft and in_progress has
 * exactly one legal predecessor, so the path to any of them is just a prefix of
 * this list.
 */
const MAINLINE = [
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
] as const;

/**
 * The sequence of statuses to write, in order, to reach `target` legally.
 *
 * Derived rather than hand-tabulated. The first version of this file listed a
 * path per target, and got `paid` and `cancelled` wrong by omitting their own
 * final state — a walk that stops one step short of where it claims to be. The
 * failure is silent and lands far from its cause: the walk succeeds, and then an
 * unrelated assertion complains that a booking is `in_progress` when the test
 * believed it was `completed`. Deriving the paths from the one chain the
 * specification defines removes the whole category.
 *
 * Off-mainline targets branch explicitly. `cancelled` is legal from `draft`
 * onwards, so it is reached from the far end of the mainline to prove the
 * long-lived branch works rather than the short one. `refunded` must go through
 * cancellation because that is the only route §8.2 allows money to take:
 * accepted -> cancelled -> refund_pending -> refunded.
 */
function pathTo(target: string): string[] {
  const onMainline = MAINLINE.indexOf(target as (typeof MAINLINE)[number]);
  if (onMainline !== -1) {
    return MAINLINE.slice(0, onMainline + 1) as unknown as string[];
  }

  switch (target) {
    case 'completed':
      return [...MAINLINE, 'completed'];
    case 'cancelled':
      return [...MAINLINE, 'cancelled'];
    case 'refund_pending':
      return [...MAINLINE, 'cancelled', 'refund_pending'];
    case 'refunded':
      return [...MAINLINE, 'cancelled', 'refund_pending', 'refunded'];
    default:
      throw new Error(
        `no path is defined for '${target}' — add it here rather than writing a status by hand`
      );
  }
}

describeDb(
  'database: a booking is written whole or not at all (0028)',
  () => {
  it('writes the booking, its items and the payment_pending hop in one call', async () => {
    const { profileId, customerId } = await customerOf('demo.customer@smarthelp.test');
    const address = await addressFor(customerId, 'Atomic create');
    const serviceId = await sql(
      `select id from public.services where is_active order by sort_order limit 1;`
    );

    const id = await sql(
      `select (public.create_booking(
         p_customer_id        => '${customerId}',
         p_address_id         => '${address}',
         p_locality_id        => null,
         p_address_snapshot   => '{"label":"Atomic","line1":"221B Test Street","area":"HSR Layout","pincode":"560102"}'::jsonb,
         p_booking_type       => 'scheduled',
         p_duration_minutes   => 60,
         p_scheduled_start_at => '2030-05-06T10:00:00+05:30',
         p_scheduled_end_at   => '2030-05-06T11:00:00+05:30',
         p_notes              => 'created by the atomicity test',
         p_money              => '{"subtotal":"500.00","platform_fee":"20.00","discount":"0.00","tax":"93.60","tax_rate":"0.1800","total_amount":"613.60","professional_gross":"470.40","commission_pct":"0.2000","currency":"INR"}'::jsonb,
         p_discount_code      => null,
         p_pricing_snapshot   => '{"engineVersion":1}'::jsonb,
         p_quote_token        => null,
         p_items              => '[{"service_id":"${serviceId}","service_name":"Test service","duration_minutes":60,"unit_price":"500.00","quantity":1,"line_total":"500.00","scope_snapshot":[]}]'::jsonb,
         p_actor              => '${profileId}',
         p_actor_role         => 'customer'
       )).id;`
    );

    // All three, from one statement. Before 0028 the item lines were a second
    // request, so a booking could exist with a total and nothing behind it.
    expect(await sql(`select status::text from public.bookings where id = '${id}';`)).toBe(
      'payment_pending'
    );
    expect(
      await sql(`select total_amount::text from public.bookings where id = '${id}';`)
    ).toBe('613.60');
    expect(
      await sql(`select count(*) from public.booking_items where booking_id = '${id}';`)
    ).toBe('1');
    expect(
      await sql(`select count(*) from public.booking_status_history where booking_id = '${id}';`)
    ).toBe('1');

    await sql(`delete from public.bookings where id = '${id}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('leaves nothing behind when one of the item lines is impossible', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const address = await addressFor(customerId, 'Atomic rollback');
    const serviceId = await sql(
      `select id from public.services where is_active order by sort_order limit 1;`
    );
    const before = await sql(`select count(*) from public.bookings;`);

    // Two lines for one service: `uniq_booking_service` refuses the second, and
    // the refusal has to take the booking with it. Three separate requests would
    // have left the first line — and the booking — committed.
    await expect(
      sql(
        `select (public.create_booking(
           p_customer_id        => '${customerId}',
           p_address_id         => '${address}',
           p_locality_id        => null,
           p_address_snapshot   => '{}'::jsonb,
           p_booking_type       => 'scheduled',
           p_duration_minutes   => 60,
           p_scheduled_start_at => '2030-05-06T10:00:00+05:30',
           p_scheduled_end_at   => '2030-05-06T11:00:00+05:30',
           p_notes              => null,
           p_money              => '{"subtotal":"500.00","platform_fee":"20.00","discount":"0.00","tax":"93.60","tax_rate":"0.1800","total_amount":"613.60","professional_gross":"470.40","commission_pct":"0.2000","currency":"INR"}'::jsonb,
           p_discount_code      => null,
           p_pricing_snapshot   => '{}'::jsonb,
           p_quote_token        => null,
           p_items              => '[{"service_id":"${serviceId}","service_name":"A","duration_minutes":60,"unit_price":"500.00","quantity":1,"line_total":"500.00"},{"service_id":"${serviceId}","service_name":"B","duration_minutes":60,"unit_price":"500.00","quantity":1,"line_total":"500.00"}]'::jsonb,
           p_actor              => null,
           p_actor_role         => null
         )).id;`
      )
    ).rejects.toThrow(/uniq_booking_service|duplicate key/i);

    expect(await sql(`select count(*) from public.bookings;`)).toBe(before);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('names the actor who created the booking in its history', async () => {
    const { profileId, customerId } = await customerOf('demo.customer@smarthelp.test');
    const address = await addressFor(customerId, 'Atomic actor');

    const id = await sql(
      `select (public.create_booking(
         p_customer_id        => '${customerId}',
         p_address_id         => '${address}',
         p_locality_id        => null,
         p_address_snapshot   => '{}'::jsonb,
         p_booking_type       => 'instant',
         p_duration_minutes   => 30,
         p_scheduled_start_at => null,
         p_scheduled_end_at   => null,
         p_notes              => null,
         p_money              => '{"subtotal":"300.00","platform_fee":"20.00","discount":"0.00","tax":"57.60","tax_rate":"0.1800","total_amount":"377.60","professional_gross":"260.40","commission_pct":"0.2000","currency":"INR"}'::jsonb,
         p_discount_code      => null,
         p_pricing_snapshot   => '{}'::jsonb,
         p_quote_token        => null,
         p_items              => '[]'::jsonb,
         p_actor              => '${profileId}',
         p_actor_role         => 'customer'
       )).id;`
    );

    // Every transition ever made named `system` because PostgREST could not set
    // `app.transition_actor` in the same transaction as the update it belonged to.
    const actor = await sql(
      `select coalesce(actor_id::text, 'null') from public.booking_status_history
        where booking_id = '${id}' order by id limit 1;`
    );
    expect(actor).toBe(profileId);

    await sql(`delete from public.bookings where id = '${id}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('still refuses an illegal move, because the trigger is what decides', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Atomic refusal');
    const booking = await makeRealBooking(customerId, address, professionalId, {
      status: 'draft',
    });

    // A function that writes `status` is not a way around the state machine. If
    // this ever succeeds, `create_booking` and `cancel_booking` are a hole in §8.2.
    await expect(
      sql(
        `select public.transition_booking(
           p_booking_id => '${booking}', p_to => 'paid', p_actor => null,
           p_actor_role => null, p_note => null, p_expected_version => 1,
           p_window_from => null, p_window_to => null
         );`
      )
    ).rejects.toThrow(/ILLEGAL_TRANSITION/i);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('answers a cancellation that lost its version with nothing, not with a row', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Atomic stale');
    const booking = await makeRealBooking(customerId, address, professionalId, {
      status: 'payment_pending',
    });

    // A version of 99 does not match, so the function writes nothing and returns
    // null — which the Route Handler turns into STALE_VERSION rather than
    // overwriting whatever changed it.
    const result = await sql(
      `select coalesce(
         (select 'wrote' from public.cancel_booking(
            p_booking_id => '${booking}', p_expected_version => 99,
            p_reason_code => 'changed_mind', p_fee => 100,
            p_note => 'stale', p_actor => null, p_actor_role => null
          ) where id is not null), 'null');`
    );
    expect(result).toBe('null');
    expect(
      await sql(`select status::text from public.bookings where id = '${booking}';`)
    ).toBe('payment_pending');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('cancels and records the fee and the actor in one statement', async () => {
    const { profileId, customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Atomic cancel');
    const booking = await makeRealBooking(customerId, address, professionalId, {
      status: 'payment_pending',
    });

    await sql(
      `select public.cancel_booking(
         p_booking_id => '${booking}', p_expected_version => 1,
         p_reason_code => 'pro_unavailable', p_fee => 153.40,
         p_note => 'pro_unavailable: nobody came',
         p_actor => '${profileId}', p_actor_role => 'customer'
       );`
    );

    const row = await sql(
      `select status::text || '|' || cancellation_reason_code || '|' || cancellation_fee::text
         from public.bookings where id = '${booking}';`
    );
    // Status, reason and fee together — there is no statement in which the
    // booking is cancelled and the fee is missing.
    expect(row).toBe('cancelled|pro_unavailable|153.40');
    expect(
      await sql(
        `select coalesce(actor_id::text, 'null') from public.booking_status_history
          where booking_id = '${booking}' order by id desc limit 1;`
      )
    ).toBe(profileId);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });
  },
  DB_TIMEOUT
);

describeDb(
  'database: the booking state machine is the only way status moves',
  () => {
  it('refuses draft straight to paid, which is the transition that skips payment', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Transition refusal');
    const booking = await makeRealBooking(customerId, address, professionalId);

    // draft -> paid has to be illegal. If it were legal, a booking could be
    // marked paid without a payment existing, and every downstream guarantee
    // about money would be resting on the caller having remembered.
    await expect(
      sql(`update public.bookings set status = 'paid' where id = '${booking}';`)
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);

    const status = await sql(`select status from public.bookings where id = '${booking}';`);
    expect(status).toBe('draft');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses cancelled straight back to in_progress, so a dead booking cannot be revived', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'No revival');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('cancelled')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    await expect(
      sql(`update public.bookings set status = 'in_progress' where id = '${booking}';`)
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('walks the legal path and writes one history row per hop', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'History walk');

    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('paid')) {
      await sql(
        `update public.bookings set status = '${s}' where id = '${booking}';`
      );
    }

    // draft -> payment_pending -> paid is two hops, so two rows. The count is
    // the assertion that matters: a trigger that validated the transition but
    // forgot to record it would leave a booking with no explanation of how it
    // got paid.
    const hops = await sql(
      `select count(*) from public.booking_status_history where booking_id = '${booking}';`
    );
    expect(hops).toBe('2');

    const trail = await sql(
      `select from_status::text || '->' || to_status::text
         from public.booking_status_history
        where booking_id = '${booking}'
        order by created_at;`
    );
    expect(trail).toBe('draft->payment_pending\npayment_pending->paid');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('records the actor the caller declared, not an anonymous customer', async () => {
    const { customerId, profileId: customerProfile } = await customerOf(
      'demo.customer@smarthelp.test'
    );
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Actor recorded');
    const booking = await makeRealBooking(customerId, address, professionalId);

    // A privileged write arrives with no auth.uid() — the service-role client
    // carries no customer JWT. If the trigger only read auth.uid(), the trail
    // would attribute a cancellation or refund to nobody, which is the one thing
    // the trail exists to prevent.
    await sql(
      `select set_config('app.transition_actor', '${customerProfile}', false);`
    );
    await sql(
      `select set_config('app.transition_actor_role', 'customer', false);`
    );
    await sql(`select set_config('app.transition_note', 'created by test', false);`);

    await sql(`update public.bookings set status = 'payment_pending' where id = '${booking}';`);

    const actor = await sql(
      `select coalesce(actor_id::text, '<null>')
         from public.booking_status_history where booking_id = '${booking}';`
    );
    expect(actor).toBe(customerProfile);

    const note = await sql(
      `select note from public.booking_status_history where booking_id = '${booking}';`
    );
    expect(note).toBe('created by test');

    await sql(`select set_config('app.transition_actor', '', false);`);
    await sql(`select set_config('app.transition_actor_role', '', false);`);
    await sql(`select set_config('app.transition_note', '', false);`);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('bumps the version on a window change so two devices cannot both reschedule', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Version bump');
    const booking = await makeRealBooking(customerId, address, professionalId);

    const before = await sql(`select version from public.bookings where id = '${booking}';`);
    expect(before).toBe('1');

    await sql(
      `update public.bookings
          set scheduled_start_at = '2030-03-05T10:00:00+05:30',
              scheduled_end_at   = '2030-03-05T11:00:00+05:30'
        where id = '${booking}';`
    );

    const after = await sql(`select version from public.bookings where id = '${booking}';`);
    expect(after).toBe('2');

    // The optimistic lock is `where id = $1 and version = $2`. Zero rows affected
    // is the conflict, and it only works if the version moved. This is the
    // assertion that the reschedule path has something to compare against.
    const stale = await sql(
      `update public.bookings set notes = 'from the other device'
        where id = '${booking}' and version = 1;`
    );
    expect(stale).toBe('');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses to edit or delete a history row', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'History immutable');
    const booking = await makeRealBooking(customerId, address, professionalId);

    await sql(`update public.bookings set status = 'payment_pending' where id = '${booking}';`);

    await expect(
      sql(`update public.booking_status_history set note = 'rewritten' where booking_id = '${booking}';`)
    ).rejects.toThrow(/BOOKING_HISTORY_IMMUTABLE/);

    await expect(
      sql(`delete from public.booking_status_history where booking_id = '${booking}';`)
    ).rejects.toThrow(/BOOKING_HISTORY_IMMUTABLE/);

    // The booking itself still cascades on delete; the history goes with it
    // rather than surviving as an orphan that names a booking that no longer
    // exists.
    await sql(`delete from public.bookings where id = '${booking}';`);
    const orphans = await sql(
      `select count(*) from public.booking_status_history where booking_id = '${booking}';`
    );
    expect(orphans).toBe('0');

    await sql(`delete from public.addresses where id = '${address}';`);
  });
  },
  DB_TIMEOUT
);

describeDb(
  'database: a booking cannot hold an impossible shape',
  () => {
  it('refuses an instant booking with a wall-clock start time', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Instant shape');

    // `instant_not_scheduled` is the constraint under test. It is written by hand
    // rather than through the fixture because the fixture deliberately builds a
    // *valid* instant booking — it nulls the window, which is the correct shape —
    // and the whole point here is the contradiction the fixture would never emit.
    // An instant booking means "as soon as somebody is free", so a start time on
    // it is not a leftover default, it is a claim about the future that cannot be
    // true.
    await expect(
      sql(
        `insert into public.bookings
           (booking_number, customer_id, professional_id, address_id, address_snapshot,
            booking_type, duration_minutes, scheduled_start_at, scheduled_end_at,
            total_amount)
         values (public.next_booking_number(), '${customerId}', '${professionalId}',
                 '${address}', '{}'::jsonb, 'instant', 60,
                 '2030-04-01T10:00:00+05:30', '2030-04-01T11:00:00+05:30', 100);`
      )
    ).rejects.toThrow(/instant_not_scheduled/i);

    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('accepts an instant booking with no window, which is the shape it should have', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Instant ok');
    const booking = await makeRealBooking(customerId, address, professionalId, {
      bookingType: 'instant',
    });

    // The counterpart to the test above. A constraint with no positive case is a
    // constraint that might be wrong; this proves the instant path still works and
    // that only the contradiction is refused.
    const window = await sql(
      `select coalesce(scheduled_start_at::text, '<null>')
         from public.bookings where id = '${booking}';`
    );
    expect(window).toBe('<null>');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses a scheduled booking with no start time', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'No start');

    await expect(
      sql(
        `insert into public.bookings
           (booking_number, customer_id, professional_id, address_id, address_snapshot,
            booking_type, duration_minutes, total_amount)
         values (public.next_booking_number(), '${customerId}', '${professionalId}',
                 '${address}', '{}'::jsonb, 'scheduled', 60, 100);`
      )
    ).rejects.toThrow(/scheduled_has_a_start/i);

    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses a tax rate written as 18 rather than 0.18, and says so in two ways', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Rate sanity');

    const insert = (rate: string) =>
      sql(
        `insert into public.bookings
           (booking_number, customer_id, professional_id, address_id, address_snapshot,
            booking_type, duration_minutes, scheduled_start_at, scheduled_end_at,
            total_amount, tax_rate)
         values (public.next_booking_number(), '${customerId}', '${professionalId}',
                 '${address}', '{}'::jsonb, 'scheduled', 60,
                 '2030-04-01T10:00:00+05:30', '2030-04-01T11:00:00+05:30',
                 100, ${rate});`
      );

    // This is the mistake numeric(5,4) is there to stop, and it stops it twice.
    //
    // First, 18 does not fit: precision 5 with scale 4 caps the value at 9.9999,
    // so the column refuses to hold it at all. That is the cheaper of the two
    // defences and it is the reason the scale is 4 rather than 2 — `numeric(5,2)`
    // would hold 18.00 happily and the mistake would survive to checkout, where
    // the customer sees tax of 18 times their subtotal.
    await expect(insert('18')).rejects.toThrow(/numeric field overflow/i);

    // Second, a rate that *does* fit but is still not a rate: 1.5 is inside
    // numeric(5,4) and outside [0,1], so only the check can catch it. Without
    // `rates_are_rates` this would sit in the table and quietly multiply by 1.5
    // somewhere downstream.
    await expect(insert('1.5')).rejects.toThrow(/rates_are_rates/i);

    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('accepts a rate stored as a fraction, and stores it as given', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Rate ok');
    const booking = await makeRealBooking(customerId, address, professionalId);

    const rate = await sql(`select tax_rate from public.bookings where id = '${booking}';`);
    expect(rate).toBe('0.1800');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses a window that ends before it starts', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Backwards window');

    await expect(
      sql(
        `insert into public.bookings
           (booking_number, customer_id, professional_id, address_id, address_snapshot,
            booking_type, duration_minutes, scheduled_start_at, scheduled_end_at,
            total_amount)
         values (public.next_booking_number(), '${customerId}', '${professionalId}',
                 '${address}', '{}'::jsonb, 'scheduled', 60,
                 '2030-04-01T12:00:00+05:30', '2030-04-01T11:00:00+05:30', 100);`
      )
    ).rejects.toThrow(/window_is_forward/i);

    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('numbers bookings from one sequence, so a same-day pair cannot collide', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Numbering');

    const a = await makeRealBooking(customerId, address, professionalId);
    const b = await makeRealBooking(customerId, address, professionalId);

    const na = await sql(`select booking_number from public.bookings where id = '${a}';`);
    const nb = await sql(`select booking_number from public.bookings where id = '${b}';`);

    expect(na).toMatch(/^SH-\d{8}-\d{5}$/);
    expect(nb).toMatch(/^SH-\d{8}-\d{5}$/);
    // Two bookings, one sequence: this is what replaces the per-day counter the
    // specification sketches, which would need a lock to keep two simultaneous
    // first-bookings of the day from agreeing on the same suffix.
    expect(na).not.toBe(nb);

    await sql(`delete from public.bookings where id in ('${a}', '${b}');`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });
  },
  DB_TIMEOUT
);

describeDb(
  'database: a professional cannot be booked twice at once',
  () => {
  it('refuses a second reserved window that overlaps the first', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Overlap one');
    const booking = await makeRealBooking(customerId, address, professionalId);

    await sql(
      `insert into public.professional_schedule
         (professional_id, booking_id, starts_at, ends_at)
       values ('${professionalId}', '${booking}',
               '2030-03-04T10:00:00+05:30', '2030-03-04T11:00:00+05:30');`
    );

    // This is the whole reason the exclusion constraint exists. A check that
    // reads "is the slot free?" and then inserts is a read followed by a write,
    // and two customers booking the same professional at the same time both
    // read free. The constraint is atomic, so the second insert simply fails.
    const other = await addressFor(customerId, 'Overlap two');
    const booking2 = await makeRealBooking(customerId, other, professionalId);

    await expect(
      sql(
        `insert into public.professional_schedule
           (professional_id, booking_id, starts_at, ends_at)
         values ('${professionalId}', '${booking2}',
                 '2030-03-04T10:30:00+05:30', '2030-03-04T11:30:00+05:30');`
      )
    ).rejects.toThrow(/professional_no_overlap|conflicting key|exclusion/i);

    await sql(`delete from public.bookings where id in ('${booking}', '${booking2}');`);
    await sql(`delete from public.addresses where id in ('${address}', '${other}');`);
  });

  it('lets a completed window be rebooked, so the calendar is not permanently full', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Reuse one');
    const booking = await makeRealBooking(customerId, address, professionalId);

    const first = await sql(
      `insert into public.professional_schedule
         (professional_id, booking_id, starts_at, ends_at, status)
       values ('${professionalId}', '${booking}',
               '2030-06-01T09:00:00+05:30', '2030-06-01T10:00:00+05:30', 'completed')
       returning id;`
    );

    // The partial predicate on the exclusion constraint is what makes this
    // possible. Without `where (status in ('reserved','in_progress'))` a window
    // from last month would block that slot forever, and the calendar would be
    // permanently full as soon as it had any history.
    const other = await addressFor(customerId, 'Reuse two');
    const booking2 = await makeRealBooking(customerId, other, professionalId);

    const second = await sql(
      `insert into public.professional_schedule
         (professional_id, booking_id, starts_at, ends_at)
       values ('${professionalId}', '${booking2}',
               '2030-06-01T09:00:00+05:30', '2030-06-01T10:00:00+05:30')
       returning id;`
    );

    expect(second).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);

    await sql(`delete from public.professional_schedule where id in ('${first}', '${second}');`);
    await sql(`delete from public.bookings where id in ('${booking}', '${booking2}');`);
    await sql(`delete from public.addresses where id in ('${address}', '${other}');`);
  });

  it('refuses a reserved window with no booking behind it', async () => {
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');

    // A `reserved` row with no booking is a slot the exclusion constraint is
    // honouring while nothing occupies that time — the calendar drifts away
    // from the bookings and no booking can ever be created there.
    await expect(
      sql(
        `insert into public.professional_schedule
           (professional_id, booking_id, starts_at, ends_at, status)
         values ('${professionalId}', null,
                 '2030-07-01T09:00:00+05:30', '2030-07-01T10:00:00+05:30', 'reserved');`
      )
    ).rejects.toThrow(/reserved_needs_booking/i);
  });
  },
  DB_TIMEOUT
);

describeDb(
  'database: an address with a live booking cannot be deleted',
  () => {
  it('names how many bookings are in the way, because a constraint name is not an answer', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Guarded delete');
    const booking = await makeRealBooking(customerId, address, professionalId);

    await sql(`update public.bookings set status = 'payment_pending' where id = '${booking}';`);

    let detail = '';
    try {
      await sql(`delete from public.addresses where id = '${address}';`);
      throw new Error('the delete should not have succeeded');
    } catch (e) {
      detail = (e as { detail?: string }).detail ?? (e as Error).message;
    }

    // The guard lands here as a deferred Phase 1 item because it names
    // `bookings`, which did not exist when 0008 ran. The detail carries the count
    // and the next booking time so the Route Handler can say something a person
    // can act on — "This address is used by 2 upcoming bookings" rather than a
    // raw constraint name.
    expect(detail).toContain('upcomingBookings');
    expect(detail).toContain('1');

    const still = await sql(`select count(*) from public.addresses where id = '${address}';`);
    expect(still).toBe('1');

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('still pins the address after cancellation, but with a message a person can read', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Pinned delete');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('cancelled')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    // This asserts behaviour that is easy to mistake for a bug, so it is worth
    // stating plainly.
    //
    // §24.7 declares `bookings.address_id ... on delete restrict`, and RESTRICT
    // does not care about the booking's status — any booking at all pins the
    // address. The guard's predicate therefore counts every non-`closed` booking
    // rather than only upcoming ones, so a cancelled booking gets the sentence
    // and the count instead of the raw foreign-key error. A `closed` booking
    // still falls through to the constraint, which is the one gap left.
    //
    // That pinning is deliberate — a cancelled booking can still be disputed or
    // refunded, and the trail needs an address that resolves. The cost is that an
    // address somebody once booked to is not deletable, which is a product
    // question rather than a defect. Locked in here so that changing `restrict`
    // is a deliberate act.
    let detail = '';
    try {
      await sql(`delete from public.addresses where id = '${address}';`);
      throw new Error('the delete should not have succeeded');
    } catch (e) {
      detail = (e as { detail?: string }).detail ?? (e as Error).message;
    }
    expect(detail).toContain('liveBookings');

    // Cancelled, so nothing is live — but the booking still exists, and that is
    // what holds the address.
    expect(detail).toContain('"liveBookings":0');

    // The booking itself is still removable, which is the escape hatch.
    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);

    // A bare DELETE returns no rows, so the row count is the assertion � the
    // same shape the Phase 1 address tests use.
    const left = await sql(`select count(*) from public.addresses where id = '${address}';`);
    expect(left).toBe('0');
  });

  it('releases the address once the booking is closed', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Closed release');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of [...pathTo('completed'), 'closed']) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    // A closed booking is the archive, not the live record, so the guard stands
    // aside. The foreign key still points at the row, which is why the booking
    // has to go first — and that ordering is exactly what the Route Handler has
    // to get right when a customer deletes an address.
    await expect(
      sql(`delete from public.addresses where id = '${address}';`)
    ).rejects.toThrow(/bookings_address_id_fkey/i);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);

    // A bare DELETE returns no rows, so the row count is the assertion � the
    // same shape the Phase 1 address tests use.
    const left = await sql(`select count(*) from public.addresses where id = '${address}';`);
    expect(left).toBe('0');
  });
  },
  DB_TIMEOUT
);

describeDb(
  'database: a review has to belong to a booking that actually happened',
  () => {
  it('refuses to rate a booking that has not finished', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Early rating');
    const booking = await makeRealBooking(customerId, address, professionalId);

    // paid, or even in_progress, is not evidence that a service happened.
    for (const s of pathTo('paid')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    await expect(
      sql(
        `insert into public.ratings
           (booking_id, customer_id, professional_id, overall, comment)
         values ('${booking}', '${customerId}', '${professionalId}', 1, 'never arrived');`
      )
    ).rejects.toThrow(/RATING_NOT_ALLOWED/);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses to rate a booking the customer was not part of', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Impostor rating');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('completed')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    // Any other real customer, picked at run time rather than hardcoded: a test
    // that named a specific demo account would break the day somebody's seed
    // changed. This is the single-request path to a defamatory review of an
    // arbitrary person, which is why the check is a trigger and not a line in a
    // handler that some future endpoint might not have.
    const impostor = await sql(
      `select id from public.customers where id <> '${customerId}' limit 1;`
    );
    if (!/^[0-9a-f-]{36}$/i.test(impostor)) {
      // Only one customer exists, so there is nobody else to be refused.
      await sql(`delete from public.bookings where id = '${booking}';`);
      await sql(`delete from public.addresses where id = '${address}';`);
      return;
    }

    await expect(
      sql(
        `insert into public.ratings
           (booking_id, customer_id, professional_id, overall)
         values ('${booking}', '${impostor}', '${professionalId}', 5);`
      )
    ).rejects.toThrow(/RATING_CUSTOMER_MISMATCH/);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses to credit a professional who did not do the work', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Wrong pro rating');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('completed')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    // The mirror of the check above, and it matters just as much: the rating is
    // what a professional's public score is computed from, so writing one that
    // names the wrong professional is both a lie to the customer and a theft of
    // somebody else's reputation.
    const otherPro = await sql(
      `select id from public.professionals where id <> '${professionalId}' limit 1;`
    );
    if (!/^[0-9a-f-]{36}$/i.test(otherPro)) {
      await sql(`delete from public.bookings where id = '${booking}';`);
      await sql(`delete from public.addresses where id = '${address}';`);
      return;
    }

    await expect(
      sql(
        `insert into public.ratings
           (booking_id, customer_id, professional_id, overall)
         values ('${booking}', '${customerId}', '${otherPro}', 1);`
      )
    ).rejects.toThrow(/RATING_PROFESSIONAL_MISMATCH/);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('accepts a review of a completed booking, and refuses a second one', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Real rating');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('completed')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    await sql(
      `insert into public.ratings
         (booking_id, customer_id, professional_id, overall, quality, comment)
       values ('${booking}', '${customerId}', '${professionalId}', 5, 4, 'thorough work');`
    );

    // booking_id is UNIQUE, so the second review fails at the database. Without
    // it this would be deduped in application code, which is one more place to
    // forget — and a professional's score would be double-counted by whichever
    // request raced.
    await expect(
      sql(
        `insert into public.ratings
           (booking_id, customer_id, professional_id, overall)
         values ('${booking}', '${customerId}', '${professionalId}', 1);`
      )
    ).rejects.toThrow(/unique|duplicate key/i);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('lets moderation hide a review but not rewrite it', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Moderated rating');
    const booking = await makeRealBooking(customerId, address, professionalId);

    for (const s of pathTo('completed')) {
      await sql(`update public.bookings set status = '${s}' where id = '${booking}';`);
    }

    await sql(
      `insert into public.ratings
         (booking_id, customer_id, professional_id, overall, comment)
       values ('${booking}', '${customerId}', '${professionalId}', 2, 'rude');`
    );

    // Hiding is allowed, and it keeps the row rather than deleting it so the
    // action can be explained later.
    await sql(`update public.ratings set is_hidden = true where booking_id = '${booking}';`);

    await expect(
      sql(`update public.ratings set overall = 5 where booking_id = '${booking}';`)
    ).rejects.toThrow(/RATING_IMMUTABLE/);

    await expect(
      sql(`update public.ratings set comment = 'edited' where booking_id = '${booking}';`)
    ).rejects.toThrow(/RATING_IMMUTABLE/);

    // A delete is refused outright: the aggregate for a professional is computed
    // over visible rows, and deleting would leave a gap that looks like the
    // review never happened.
    await expect(
      sql(`delete from public.ratings where booking_id = '${booking}';`)
    ).rejects.toThrow(/RATING_DELETE_FORBIDDEN/);

    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });
  },
  DB_TIMEOUT
);

describeDb(
  'database: a coupon is spent once per booking, in the ledger',
  () => {
  it('refuses a second coupon on the same booking', async () => {
    const { customerId } = await customerOf('demo.customer@smarthelp.test');
    const { professionalId } = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customerId, 'Coupon once');
    const booking = await makeRealBooking(customerId, address, professionalId);

    const coupon = await sql(
      `insert into public.coupons (code, discount_type, discount_value, max_discount)
       values ('TEST-ONCE-${Date.now()}', 'fixed', 100.00, null)
       returning id;`
    );

    await sql(
      `insert into public.coupon_usage (coupon_id, customer_id, booking_id, discount_amount)
       values ('${coupon}', '${customerId}', '${booking}', 100.00);`
    );

    // uniq_coupon_usage_booking. This is the reason coupon_usage exists rather
    // than a counter on the coupons row: "one coupon per booking" is a property
    // of the schema, not a check the pricing engine has to remember to run.
    await expect(
      sql(
        `insert into public.coupon_usage (coupon_id, customer_id, booking_id, discount_amount)
         values ('${coupon}', '${customerId}', '${booking}', 50.00);`
      )
    ).rejects.toThrow(/unique|duplicate key/i);

    await sql(`delete from public.coupon_usage where booking_id = '${booking}';`);
    await sql(`delete from public.coupons where id = '${coupon}';`);
    await sql(`delete from public.bookings where id = '${booking}';`);
    await sql(`delete from public.addresses where id = '${address}';`);
  });

  it('refuses a percentage coupon with no cap, which would allow a zero total', async () => {
    await expect(
      sql(
        `insert into public.coupons (code, discount_type, discount_value)
         values ('TEST-NOCAP-${Date.now()}', 'percentage', 50);`
      )
    ).rejects.toThrow(/percentage_needs_cap/i);
  });

  it('refuses a percentage discount above 100', async () => {
    await expect(
      sql(
        `insert into public.coupons (code, discount_type, discount_value, max_discount)
         values ('TEST-OVER100-${Date.now()}', 'percentage', 150, 500);`
      )
    ).rejects.toThrow(/percentage_is_sane/i);
  });

  it('treats SAVE20 and save20 as one coupon', async () => {
    const code = `TEST-CASE-${Date.now()}`;
    await sql(
      `insert into public.coupons (code, discount_type, discount_value)
       values ('${code.toLowerCase()}', 'fixed', 20);`
    );

    // A customer types the code. Two coupons differing only in case is a support
    // ticket, not a feature.
    await expect(
      sql(
        `insert into public.coupons (code, discount_type, discount_value)
         values ('${code.toUpperCase()}', 'fixed', 30);`
      )
    ).rejects.toThrow(/unique|duplicate key/i);

    await sql(`delete from public.coupons where upper(code) = upper('${code}');`);
  });
  },
  DB_TIMEOUT
);
