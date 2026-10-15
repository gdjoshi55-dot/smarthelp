import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql, sqlAsRole } from './helpers/dbEnv';

/**
 * Phase 6's two staff write paths and the settings table they read (0033–0034).
 *
 * The Route Handler tests (`test/routes.admin.test.ts`) prove the console takes
 * the right branch; this file proves the branch is *safe*. Three things can only
 * be answered by Postgres:
 *
 *   `platform_settings` is staff-readable and customer-invisible — the read
 *   policy is the whole reason the tax rate is not a public fact.
 *
 *   `admin_cancel_booking` frees a cancellation's two loose ends in the same
 *   statement that cancels it: the holding offer becomes `withdrawn` and the
 *   reserved window is deleted. A cancelled booking that still pins a
 *   professional's calendar is the bug the function exists to prevent.
 *
 *   `admin_assign_booking` raises an *ordinary* offer — a `booking_assignments`
 *   row the professional still has to accept. Ops raises the chance, it does not
 *   forge the acceptance, and the §9.4 advisory lock is what keeps it from racing
 *   the matching sweeper.
 *
 * These run as the migration owner, which bypasses RLS — right for a write path
 * that runs on the service role. The policies are read through `sqlAsRole`, which
 * drops to `authenticated` with the seeded accounts' claims.
 *
 *   npm run db:migrate && npm run db:seed && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the admin console database tests — no SUPABASE_DB_URL available.\n' +
      '     The settings policy and both 0034 write paths are NOT covered.\n'
  );
}

afterAll(closeDb);

const DB_TIMEOUT = 60_000;

// ── Fixtures ───────────────────────────────────────────────

async function seededProfileId(email: string): Promise<string> {
  const id = await sql(`select id from public.profiles where email = '${email}';`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`no seeded profile for ${email} — run "npm run db:seed"`);
  }
  return id;
}

async function customerOf(email: string): Promise<string> {
  const p = await seededProfileId(email);
  const c = await sql(`select id from public.customers where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(c)) throw new Error(`${email} has no customers row`);
  return c;
}

async function professionalOf(email: string): Promise<string> {
  const p = await seededProfileId(email);
  const pr = await sql(`select id from public.professionals where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(pr)) throw new Error(`${email} has no professionals row`);
  return pr;
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

interface BookingOptions {
  status?: string;
  professionalId?: string | null;
}

async function makeBooking(
  customerId: string,
  addressId: string,
  opts: BookingOptions = {}
): Promise<string> {
  const status = opts.status ?? 'paid';
  const pro = opts.professionalId ? `'${opts.professionalId}'` : 'null';
  return sql(
    `insert into public.bookings
       (booking_number, customer_id, professional_id, address_id, address_snapshot,
        booking_type, status, duration_minutes, scheduled_start_at, scheduled_end_at,
        total_amount)
     values (public.next_booking_number(), '${customerId}', ${pro}, '${addressId}',
             '{}'::jsonb, 'scheduled', '${status}', 60,
             '2032-01-01T10:00:00+05:30', '2032-01-01T11:00:00+05:30', 1000)
     returning id;`
  );
}

/** A professional that is not verified, to exercise the refusal path. */
async function unverifiedProfessional(profileId: string): Promise<string> {
  return sql(
    `insert into public.professionals (profile_id, verification_status)
     values ('${profileId}', 'submitted')
     returning id;`
  );
}

async function cleanup(bookingIds: string[], addressIds: string[], professionalIds: string[]): Promise<void> {
  const bookings = bookingIds.map((id) => `'${id}'`).join(', ');
  const addresses = addressIds.map((id) => `'${id}'`).join(', ');
  const professionals = professionalIds.map((id) => `'${id}'`).join(', ');
  if (bookings) await sql(`delete from public.bookings where id in (${bookings});`);
  if (addresses) await sql(`delete from public.addresses where id in (${addresses});`);
  if (professionals) await sql(`delete from public.professionals where id in (${professionals});`);
}

// ── platform_settings ──────────────────────────────────────

describeDb('database: platform_settings (0033)', () => {
  it('seeds every PLATFORM_DEFAULTS key', async () => {
    const count = await sql(`select count(*) from public.platform_settings;`);
    expect(Number(count)).toBe(23);
    // jsonb numbers flatten back as text; the contract is the typed reader, this
    // is only here to catch a seed that stored the value under the wrong key.
    expect(
      await sql(`select value from public.platform_settings where key = 'offerTtlMinutes';`)
    ).toBe('15');
  });

  it('lets staff read the settings and no one else', async () => {
    const admin = await seededProfileId('demo.admin@smarthelp.test');
    const customer = await seededProfileId('demo.customer@smarthelp.test');

    expect(await sqlAsRole(admin, `select count(*) from public.platform_settings;`)).toBe('23');
    // A customer sees nothing — the tax rate and the support limit are business
    // facts, not catalogue facts.
    expect(await sqlAsRole(customer, `select count(*) from public.platform_settings;`)).toBe('0');
    // An anonymous visitor is not even a staff candidate.
    expect(await sqlAsRole(null, `select count(*) from public.platform_settings;`)).toBe('0');
  });
});

// ── admin_cancel_booking ───────────────────────────────────

describeDb('database: admin_cancel_booking (0034)', () => {
  it('cancels, records the fee, withdraws the offer and frees the slot', async () => {
    const customer = await customerOf('demo.customer@smarthelp.test');
    const pro = await professionalOf('demo.pro@smarthelp.test');
    const actor = await seededProfileId('demo.ops@smarthelp.test');
    const address = await addressFor(customer, 'Admin cancel');
    const booking = await makeBooking(customer, address, { status: 'assigned', professionalId: pro });

    const assignment = await sql(
      `insert into public.booking_assignments
         (booking_id, professional_id, status, expires_at)
       values ('${booking}', '${pro}', 'offered', now() + interval '10 minutes')
       returning id;`
    );
    await sql(
      `insert into public.professional_schedule
         (professional_id, booking_id, starts_at, ends_at, status)
       values ('${pro}', '${booking}', '2032-01-01T10:00:00+05:30',
               '2032-01-01T11:00:00+05:30', 'reserved');`
    );

    await sql(
      `select public.admin_cancel_booking(
         '${booking}'::uuid, 'ops_cancelled', 250, 'customer called', '${actor}', 'ops');`
    );

    expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
      'cancelled'
    );
    expect(
      await sql(`select cancellation_fee::text from public.bookings where id = '${booking}';`)
    ).toBe('250.00');
    expect(
      await sql(`select cancellation_reason_code from public.bookings where id = '${booking}';`)
    ).toBe('ops_cancelled');

    // The two loose ends a plain status flip would leave behind.
    expect(
      await sql(`select status::text from public.booking_assignments where id = '${assignment}';`)
    ).toBe('withdrawn');
    expect(
      await sql(
        `select count(*) from public.professional_schedule
          where booking_id = '${booking}' and status = 'reserved';`
      )
    ).toBe('0');

    await cleanup([booking], [address], []);
  }, DB_TIMEOUT);
});

// ── admin_assign_booking ───────────────────────────────────

describeDb('database: admin_assign_booking (0034)', () => {
  it('raises an ordinary offer a professional still has to accept', async () => {
    const customer = await customerOf('demo.customer@smarthelp.test');
    const pro = await professionalOf('demo.pro@smarthelp.test');
    const actor = await seededProfileId('demo.ops@smarthelp.test');
    const address = await addressFor(customer, 'Admin assign');
    const booking = await makeBooking(customer, address, { status: 'paid' });

    const outcome = await sql(
      `select public.admin_assign_booking(
         '${booking}'::uuid, '${pro}'::uuid, 15, 'manual', '${actor}', 'ops') ->> 'outcome';`
    );
    expect(outcome).toBe('assigned');

    expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
      'assigned'
    );
    expect(await sql(`select professional_id from public.bookings where id = '${booking}';`)).toBe(
      pro
    );

    // The offer is a live `offered` row, not an `accepted` one: ops raised the
    // chance, the professional still accepts through the normal flow.
    expect(
      await sql(
        `select status::text from public.booking_assignments
          where booking_id = '${booking}' and professional_id = '${pro}';`
      )
    ).toBe('offered');

    // A second assignment to the same professional updates the one row rather
    // than inserting another (0012's uniq_prof_booking_offer).
    await sql(
      `select public.admin_assign_booking(
         '${booking}'::uuid, '${pro}'::uuid, 15, 'again', '${actor}', 'ops');`
    );
    expect(
      await sql(
        `select count(*) from public.booking_assignments where booking_id = '${booking}';`
      )
    ).toBe('1');

    await cleanup([booking], [address], []);
  }, DB_TIMEOUT);

  it('refuses an unverified professional and an unknown booking', async () => {
    const customer = await customerOf('demo.customer@smarthelp.test');
    const customerProfile = await seededProfileId('demo.customer@smarthelp.test');
    const actor = await seededProfileId('demo.ops@smarthelp.test');
    const address = await addressFor(customer, 'Admin assign refusal');
    const booking = await makeBooking(customer, address, { status: 'paid' });
    const unverified = await unverifiedProfessional(customerProfile);

    const unverifiedOutcome = await sql(
      `select public.admin_assign_booking(
         '${booking}'::uuid, '${unverified}'::uuid, 15, null, '${actor}', 'ops') ->> 'outcome';`
    );
    expect(unverifiedOutcome).toBe('professional_unverified');
    // A refused assignment writes nothing.
    expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
      'paid'
    );

    const missingOutcome = await sql(
      `select public.admin_assign_booking(
         gen_random_uuid(), '${unverified}'::uuid, 15, null, '${actor}', 'ops') ->> 'outcome';`
    );
    expect(missingOutcome).toBe('not_found');

    await cleanup([booking], [address], [unverified]);
  }, DB_TIMEOUT);
});
