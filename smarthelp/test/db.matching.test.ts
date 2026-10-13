import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

/**
 * Phase 5's matching engine, asserted against a live project (0032).
 *
 * 05-PLAN.md's exit criterion is "no double assignment under concurrency;
 * exhausted search auto-refunds". The second half is JS (the refund) and is
 * covered by `test/matching.test.ts`; the first half is the advisory lock in
 * `match_booking()`, and the only way to test a lock is to actually race it, so
 * the headline test opens many real connections and fires them at one booking at
 * once. A test that inspected `pg_advisory_xact_lock` in the source would pass on
 * the day it was deleted.
 *
 * Since 0036 the engine *broadcasts*: one call offers the job to every eligible
 * professional, so the race asserts that exactly one caller does the broadcast
 * (the rest see the live offers and no-op), not that exactly one offer exists.
 *
 * The two other tests pin the reassignment cascade's two visible ends: a stale
 * offer is tombstoned by the matcher before it decides anything, and a search
 * with no candidate past its deadline is cancelled `no_professional_available`.
 *
 * These run as the migration owner, which bypasses RLS — right for an engine,
 * which runs on the service role. The ledger's policies are in `db.rls.test.ts`.
 *
 *   npm run db:migrate && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the matching-engine database tests — no SUPABASE_DB_URL available.\n' +
      '     The concurrency guarantee and the exhausted-search cancel are NOT covered.\n'
  );
}

afterAll(closeDb);

const DB_TIMEOUT = 120_000;

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
     values ('${customerId}', '${label}', '221B Test Street', 'HSR Layout',
             'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900)
     returning id;`
  );
}

interface BookingOptions {
  status?: string;
  professionalId?: string | null;
  searchExpiresAt?: string | null;
}

/**
 * A booking in whatever state the test needs.
 *
 * Inserted at its target status directly — the transition trigger returns early
 * on `INSERT`, so a fixture is allowed the shortcut a real booking never is.
 * With no `booking_items`, every verified professional is a candidate
 * (`rank_candidates` only requires a pro to be skilled for the services on the
 * booking, and there are none), which is what makes the concurrency test about
 * the lock rather than about the ranking.
 */
async function makeBooking(
  customerId: string,
  addressId: string,
  opts: BookingOptions = {}
): Promise<string> {
  const status = opts.status ?? 'paid';
  const pro = opts.professionalId ? `'${opts.professionalId}'` : 'null';
  const expires = opts.searchExpiresAt ? `'${opts.searchExpiresAt}'` : 'null';
  return sql(
    `insert into public.bookings
       (booking_number, customer_id, professional_id, address_id, address_snapshot,
        booking_type, status, duration_minutes, scheduled_start_at, scheduled_end_at,
        search_expires_at, total_amount)
     values (public.next_booking_number(), '${customerId}', ${pro}, '${addressId}',
             '{}'::jsonb, 'scheduled', '${status}', 60,
             '2031-04-04T10:00:00+05:30', '2031-04-04T11:00:00+05:30',
             ${expires}, 100)
     returning id;`
  );
}

/**
 * A URL that tolerates many simultaneous connections.
 *
 * Same reasoning as `db.assignments.test.ts`: `SUPABASE_DB_URL` points at the
 * session pooler (5432), which caps at 15 backends and would fail the race
 * before it started. Port 6543 is the transaction pooler, and every statement
 * here is a single `match_booking` call, so nothing depends on session state
 * surviving between statements.
 */
function racingUrl(): string | undefined {
  if (!dbUrl) return dbUrl;
  return /\.pooler\.supabase\.com:5432\//.test(dbUrl) ? dbUrl.replace(':5432/', ':6543/') : dbUrl;
}

async function cleanup(bookingIds: string[], addressIds: string[]): Promise<void> {
  const bookings = bookingIds.map((id) => `'${id}'`).join(', ');
  const addresses = addressIds.map((id) => `'${id}'`).join(', ');
  if (bookings) await sql(`delete from public.bookings where id in (${bookings});`);
  if (addresses) await sql(`delete from public.addresses where id in (${addresses});`);
}

describeDb('database: the matching engine (0032)', () => {
  it('lets exactly one concurrent match win, so no booking is double-assigned', async () => {
    const customer = await customerOf('demo.customer@smarthelp.test');
    const address = await addressFor(customer, 'Concurrent match');
    const booking = await makeBooking(customer, address, { status: 'paid' });

    const clients: Client[] = [];
    let offered = 0;
    try {
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          const c = new Client({
            connectionString: racingUrl(),
            ssl: { rejectUnauthorized: false },
          });
          c.on('error', () => {});
          await c.connect();
          clients.push(c);
        })
      );

      const results = await Promise.all(
        clients.map((c) => c.query(`select public.match_booking('${booking}'::uuid) as outcome`))
      );
      // jsonb comes back as a JS object, so the outcome is read as a field.
      offered = results.filter((r) => r.rows[0].outcome?.outcome === 'offered').length;
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }

    // The advisory lock serialised the racers: the first broadcast the job to
    // every eligible professional, the rest saw the live offers and no-opped.
    // Exactly one caller broadcasts — that is the lock's whole job — and the
    // round it opened holds one live `offered` row per professional, none of
    // them accepted, with the booking dispatched but unowned (no `professional_id`).
    expect(offered).toBe(1);
    expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
      'assigned'
    );
    expect(
      await sql(
        `select count(*) from public.bookings where id = '${booking}' and professional_id is null;`
      )
    ).toBe('1');

    const live = Number(
      await sql(
        `select count(*) from public.booking_assignments
          where booking_id = '${booking}' and status = 'offered';`
      )
    );
    expect(live).toBeGreaterThanOrEqual(1);
    // One professional never holds two offers on the same booking, broadcast
    // or not (uniq_prof_booking_offer, 0012).
    const distinctOffers = Number(
      await sql(
        `select count(distinct professional_id) from public.booking_assignments
          where booking_id = '${booking}' and status = 'offered';`
      )
    );
    expect(distinctOffers).toBe(live);
    // Nobody has accepted, so the double-accept index has nothing to hold.
    expect(
      await sql(
        `select count(*) from public.booking_assignments
          where booking_id = '${booking}' and status = 'accepted';`
      )
    ).toBe('0');

    await cleanup([booking], [address]);
  }, DB_TIMEOUT);

  it('tombstones a stale offer before it decides, so a re-offer is a fresh row', async () => {
    const customer = await customerOf('demo.customer@smarthelp.test');
    const pro = await professionalOf('demo.pro@smarthelp.test');
    const address = await addressFor(customer, 'Stale offer match');
    const booking = await makeBooking(customer, address, {
      status: 'assigned',
      professionalId: pro,
    });

    const stale = await sql(
      `insert into public.booking_assignments
         (booking_id, professional_id, status, expires_at)
       values ('${booking}', '${pro}', 'offered', now() - interval '1 minute')
       returning id;`
    );

    await sql(`select public.match_booking('${booking}'::uuid);`);

    // The stale offer is now a tombstone. Whether the engine then found the
    // seeded pro again (it never will — one offer per pro per booking) or a
    // different candidate, the old row's status is the deterministic fact.
    expect(
      await sql(`select status::text from public.booking_assignments where id = '${stale}';`)
    ).toBe('expired');

    await cleanup([booking], [address]);
  }, DB_TIMEOUT);

  it('cancels a search that exhausted its window with no candidate', async () => {
    // A booking whose service nobody is skilled in: `rank_candidates` requires a
    // professional to be skilled for *every* service on the booking, so an
    // unstaffed service makes the candidate list empty for everyone. The service
    // is created for this test rather than borrowed from the seed (where every
    // service has someone), and removed again below — nothing shared is mutated.
    const orphanSlug = `__test-orphan-${Date.now()}`;
    const orphanService = await sql(
      `insert into public.services (category_id, name, slug, base_price)
       values ((select id from public.service_categories limit 1),
               '__test unstaffed service', '${orphanSlug}', 100)
       returning id;`
    );

    const customer = await customerOf('demo.customer@smarthelp.test');
    const address = await addressFor(customer, 'Exhausted search');
    const past = new Date(Date.now() - 60_000).toISOString();
    const booking = await makeBooking(customer, address, {
      status: 'searching',
      searchExpiresAt: past,
    });
    await sql(
      `insert into public.booking_items
         (booking_id, service_id, service_name, duration_minutes, unit_price, quantity, line_total)
       values ('${booking}', '${orphanService}', 'Unstaffed service', 60, 100, 1, 100);`
    );

    const outcome = await sql(`select public.match_booking('${booking}'::uuid) -> 'outcome';`);
    expect(outcome).toBe('exhausted');

    expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
      'cancelled'
    );
    expect(
      await sql(
        `select cancellation_reason_code from public.bookings where id = '${booking}';`
      )
    ).toBe('no_professional_available');

    await cleanup([booking], [address]);
    await sql(`delete from public.services where id = '${orphanService}';`);
  }, DB_TIMEOUT);
});
