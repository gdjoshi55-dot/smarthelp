import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

/**
 * The Phase 4 job-execution contract, asserted against a live project (0029).
 *
 * Every one of `arrive_job`, `issue_service_otp`, `verify_service_otp`,
 * `complete_job` and `no_show_job` is a single security-definer statement whose
 * *only* guarantee is the one the database enforces: the 0011 state machine
 * decides legality, and the version column decides the race. So these are
 * behaviour assertions — the tests attempt the illegal moves and expect the
 * database to refuse them, and they read back the money the completion wrote.
 *
 * Two things are deliberately *not* re-tested here. Ownership (a booking that is
 * not the caller's) is a Route Handler concern and lives in
 * `test/routes.professionals.test.ts`. The `otp_hash` column hardening is
 * `db.rls.test.ts`'s (Pitfall 1). This file covers the SQL mechanisms those
 * layers depend on.
 *
 * These run as the migration owner, which bypasses RLS — right for these
 * functions, which run on the service role.
 *
 *   npm run db:migrate && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the job-flow database tests — no SUPABASE_DB_URL available.\n' +
      '     The completion arithmetic, the OTP lockout and the no-show release\n' +
      '     are NOT covered by this run.\n'
  );
}

afterAll(closeDb);

const DB_TIMEOUT = 60_000;

// ── Fixtures ───────────────────────────────────────────────

async function profileId(email: string): Promise<string> {
  const id = await sql(`select id from public.profiles where email = '${email}';`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`no seeded profile for ${email} — run "npm run db:seed"`);
  }
  return id;
}

async function customerOf(email: string): Promise<string> {
  const p = await profileId(email);
  const c = await sql(`select id from public.customers where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(c)) throw new Error(`${email} has no customers row`);
  return c;
}

async function professionalOf(email: string): Promise<string> {
  const p = await profileId(email);
  const pr = await sql(`select id from public.professionals where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(pr)) throw new Error(`${email} has no professionals row`);
  return pr;
}

async function addressFor(customerId: string, label: string): Promise<string> {
  return sql(
    `insert into public.addresses
       (customer_id, label, line1, area, city, state, pincode, lat, lng)
     values ('${customerId}', 'jobflow: ${label}', '221B Test Street', 'HSR Layout',
             'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900)
     returning id;`
  );
}

/**
 * Removes any fixture this file left behind when a run died between setup and
 * cleanup. Keyed on the `jobflow:` label prefix, so it can never touch a real
 * address, and scoped to this file's rows so the other live-db files that run in
 * the same database are untouched.
 */
async function purgeJobFixtures(): Promise<void> {
  const found = await sql(`select id from public.addresses where label like 'jobflow:%';`);
  const ids = found ? found.split('\n').filter(Boolean) : [];
  if (!ids.length) return;
  const list = ids.map((id) => `'${id}'`).join(', ');
  await sql(`delete from public.bookings where address_id in (${list});`);
  await sql(`delete from public.addresses where id in (${list});`);
}

beforeAll(async () => {
  if (dbUrl) await purgeJobFixtures();
});

/** The frozen money the engine would have written at checkout (0021). */
const TOTALS =
  `'{"totals":{"professionalGross":"900.00","commission":"100.00"}}'::jsonb`;

/**
 * A booking sitting at an arbitrary state.
 *
 * Inserting straight at a status is safe here: the state machine trigger only
 * guards a *transition* (an UPDATE), so the fixture can place a booking anywhere
 * a test needs to start. `0028`'s `create_booking` is the app's real entry point
 * and is covered in `db.booking.test.ts`.
 *
 * The earnings basis is the frozen snapshot: net `900.00`, commission `100.00`,
 * so `complete_job` should write gross `1000.00`.
 */
async function makeJob(
  customerId: string,
  addressId: string,
  professionalId: string,
  opts: { status?: string; otp?: string; ttlMinutes?: number; generations?: number } = {}
): Promise<string> {
  const status = opts.status ?? 'arrived';
  const otp = opts.otp ?? null;
  const ttl = opts.ttlMinutes ?? 10;
  const generations = opts.generations ?? 0;
  const otpHash = otp ? `encode(digest('${otp}', 'sha256'), 'hex')` : 'null';

  return sql(
    `insert into public.bookings
       (booking_number, customer_id, professional_id, address_id, address_snapshot,
        booking_type, status, duration_minutes, scheduled_start_at, scheduled_end_at,
        subtotal, platform_fee, tax, tax_rate, total_amount, professional_gross,
        commission_pct, pricing_snapshot,
        otp_hash, otp_expires_at, otp_generations)
     values (
       public.next_booking_number(), '${customerId}', '${professionalId}', '${addressId}',
       '{"line1":"221B Test Street","area":"HSR Layout","city":"Bengaluru","lat":12.9116,"lng":77.6389}'::jsonb,
       'scheduled', '${status}', 60,
       '2030-09-05T10:00:00+05:30', '2030-09-05T11:00:00+05:30',
       1000.00, 50.00, 180.00, 0.1800, 1230.00, 900.00,
       0.1000, ${TOTALS},
       ${otpHash},
       ${otp ? `now() + make_interval(mins => ${ttl})` : 'null'},
       ${generations}
     )
     returning id;`
  );
}

async function reserve(bookingId: string, professionalId: string, status = 'reserved'): Promise<void> {
  await sql(
    `insert into public.professional_schedule
       (professional_id, booking_id, starts_at, ends_at, status)
     values ('${professionalId}', '${bookingId}',
             '2030-09-05T10:00:00+05:30', '2030-09-05T11:00:00+05:30', '${status}');`
  );
}

async function cleanup(bookingIds: string[], addressIds: string[]): Promise<void> {
  const bookings = bookingIds.filter(Boolean).map((id) => `'${id}'`).join(', ');
  const addresses = addressIds.filter(Boolean).map((id) => `'${id}'`).join(', ');
  if (bookings) {
    // Cascades: assignments, schedule and the earnings row all fall with the booking.
    await sql(`delete from public.bookings where id in (${bookings});`);
  }
  if (addresses) await sql(`delete from public.addresses where id in (${addresses});`);
}

// ── Completion ─────────────────────────────────────────────

describeDb(
  'database: completing a job closes it and pays the professional (0029)',
  () => {
    it('starts through the OTP, completes, and writes one pending earning with the frozen arithmetic', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Complete happy path');
      const booking = await makeJob(customer, address, pro, {
        status: 'arrived',
        otp: '1234',
        generations: 1,
      });
      await reserve(booking, pro);

      const completedBefore = await sql(
        `select completed_jobs from public.professionals where id = '${pro}';`
      );

      // The OTP verify both checks the code and starts the clock.
      const verified = await sql(
        `select count(*) from public.verify_service_otp('${booking}', '1234', 3);`
      );
      expect(verified).toBe('1');
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'in_progress'
      );

      // Backdate the start so actual_duration_minutes is a number worth asserting
      // rather than a zero-second race.
      await sql(
        `update public.bookings set started_at = now() - interval '30 minutes'
          where id = '${booking}';`
      );
      const version = await sql(`select version from public.bookings where id = '${booking}';`);

      const outcome = await sql(
        `select case when public.complete_job('${booking}', '${pro}', ${version}) is null
                     then 'null' else 'ok' end;`
      );
      expect(outcome).toBe('ok');

      const shape = await sql(
        `select status::text || '|' || (ended_at is not null)::text || '|' ||
                actual_duration_minutes::text
           from public.bookings where id = '${booking}';`
      );
      expect(shape).toBe('completed|true|30');

      // The calendar slot is spent, not left reserved forever.
      expect(
        await sql(`select status::text from public.professional_schedule where booking_id = '${booking}';`)
      ).toBe('completed');

      expect(
        await sql(`select completed_jobs from public.professionals where id = '${pro}';`)
      ).toBe(String(Number(completedBefore) + 1));

      // The earnings row: net is the frozen professionalGross, commission the
      // frozen commission, gross the sum, and the §7.5 hold is 24 hours out.
      const earning = await sql(
        `select status::text || '|' || gross_amount || '|' || commission_amount || '|' ||
                net_amount || '|' || (available_at > now())::text
           from public.professional_earnings where booking_id = '${booking}';`
      );
      expect(earning).toBe('pending|1000.00|100.00|900.00|true');

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('refuses to complete a job that never started, because the state machine is in charge', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Complete too early');
      const booking = await makeJob(customer, address, pro, { status: 'arrived' });

      await expect(
        sql(`select public.complete_job('${booking}', '${pro}', 1);`)
      ).rejects.toThrow(/ILLEGAL_TRANSITION/);

      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'arrived'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('does not count or pay a job twice when a completion is retried', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Double complete');
      const booking = await makeJob(customer, address, pro, {
        status: 'arrived',
        otp: '1234',
        generations: 1,
      });
      await reserve(booking, pro);

      await sql(`select public.verify_service_otp('${booking}', '1234', 3);`);
      const version = await sql(`select version from public.bookings where id = '${booking}';`);
      await sql(`select public.complete_job('${booking}', '${pro}', ${version});`);

      const after = await sql(
        `select completed_jobs from public.professionals where id = '${pro}';`
      );
      const settled = await sql(`select version from public.bookings where id = '${booking}';`);

      // Retry with the freshly-read version: the booking is already `completed`,
      // so the guard makes this a no-op that returns NULL rather than a second
      // increment of the professional's tally (the 0011 trigger ignores a
      // same-status update).
      const retry = await sql(
        `select case when public.complete_job('${booking}', '${pro}', ${settled}) is null
                     then 'null' else 'ok' end;`
      );
      expect(retry).toBe('null');
      expect(
        await sql(`select completed_jobs from public.professionals where id = '${pro}';`)
      ).toBe(after);
      expect(
        await sql(`select count(*) from public.professional_earnings where booking_id = '${booking}';`)
      ).toBe('1');

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('answers a lost version with nothing rather than overwriting a concurrent change', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Complete stale');
      const booking = await makeJob(customer, address, pro, { status: 'in_progress' });

      const outcome = await sql(
        `select case when public.complete_job('${booking}', '${pro}', 99) is null
                     then 'null' else 'ok' end;`
      );
      expect(outcome).toBe('null');
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'in_progress'
      );
      expect(
        await sql(`select count(*) from public.professional_earnings where booking_id = '${booking}';`)
      ).toBe('0');

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);
  },
  DB_TIMEOUT
);

// ── OTP gates ──────────────────────────────────────────────

describeDb(
  'database: the service OTP refuses a wrong, locked or expired code (0029)',
  () => {
    it('locks after the attempt cap and then refuses even the correct code', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'OTP lockout');
      const booking = await makeJob(customer, address, pro, {
        status: 'arrived',
        otp: '1234',
        generations: 1,
      });

      for (let i = 0; i < 3; i += 1) {
        const rows = await sql(
          `select count(*) from public.verify_service_otp('${booking}', '9999', 3);`
        );
        expect(rows).toBe('0');
      }

      const attempts = await sql(
        `select otp_attempts || '|' || (otp_locked_until is not null)::text
           from public.bookings where id = '${booking}';`
      );
      expect(attempts).toBe('3|true');

      // The correct code now fails too: the lockout outranks it.
      const afterLock = await sql(
        `select count(*) from public.verify_service_otp('${booking}', '1234', 3);`
      );
      expect(afterLock).toBe('0');
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'arrived'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('refuses an expired code without burning an attempt', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'OTP expired');
      const booking = await makeJob(customer, address, pro, {
        status: 'arrived',
        otp: '1234',
        generations: 1,
        ttlMinutes: -1,
      });

      const rows = await sql(
        `select count(*) from public.verify_service_otp('${booking}', '1234', 3);`
      );
      expect(rows).toBe('0');

      // An expired window is not a failed guess: the attempt counter is untouched.
      const attempts = await sql(
        `select otp_attempts from public.bookings where id = '${booking}';`
      );
      expect(attempts).toBe('0');
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'arrived'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);
  },
  DB_TIMEOUT
);

// ── No-show ────────────────────────────────────────────────

describeDb(
  'database: a no-show releases the calendar and touches no money (0029)',
  () => {
    it('records the reason, releases the window, bumps the counter, and writes no refund', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'No show release');
      const booking = await makeJob(customer, address, pro, { status: 'accepted' });
      await reserve(booking, pro);

      const noShowsBefore = await sql(
        `select no_shows from public.professionals where id = '${pro}';`
      );

      const outcome = await sql(
        `select case when public.no_show_job('${booking}', '${pro}', 'Address not found') is null
                     then 'null' else 'ok' end;`
      );
      expect(outcome).toBe('ok');

      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'no_show'
      );
      expect(await sql(`select notes from public.bookings where id = '${booking}';`)).toBe(
        'Address not found'
      );
      expect(
        await sql(`select status::text from public.professional_schedule where booking_id = '${booking}';`)
      ).toBe('released');
      expect(
        await sql(`select no_shows from public.professionals where id = '${pro}';`)
      ).toBe(String(Number(noShowsBefore) + 1));

      // Hard rule 2: a professional's own cancellation never enters the refund
      // or wallet path — that resolution is ops'.
      expect(
        await sql(`select count(*) from public.refunds where booking_id = '${booking}';`)
      ).toBe('0');
      expect(
        await sql(
          `select count(*) from public.wallet_transactions
            where ref_type = 'booking' and ref_id = '${booking}';`
        )
      ).toBe('0');

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('refuses a no-show with a blank reason, before it touches the booking', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'No show blank');
      const booking = await makeJob(customer, address, pro, { status: 'accepted' });

      await expect(
        sql(`select public.no_show_job('${booking}', '${pro}', '   ');`)
      ).rejects.toThrow(/NO_SHOW_REASON_REQUIRED/);

      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'accepted'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('refuses a job the professional does not own, with no state change', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const otherPro = await sql(
        `select id from public.professionals where id <> '${pro}' limit 1;`
      );
      if (!/^[0-9a-f-]{36}$/i.test(otherPro)) return;

      const address = await addressFor(customer, 'No show cross-pro');
      const booking = await makeJob(customer, address, pro, { status: 'accepted' });

      const outcome = await sql(
        `select case when public.no_show_job('${booking}', '${otherPro}', 'Access refused') is null
                     then 'null' else 'ok' end;`
      );
      expect(outcome).toBe('null');
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'accepted'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);
  },
  DB_TIMEOUT
);
