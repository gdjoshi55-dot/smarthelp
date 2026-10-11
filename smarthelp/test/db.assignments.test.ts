import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

/**
 * The Phase 4 assignment ledger, asserted against a live project (0012).
 *
 * As with `db.booking.test.ts`, these are behaviour assertions, not schema
 * inspection. The point of `accept_offer` is a compare-and-set; the only way to
 * test a compare-and-set is to actually race it, so the headline test opens
 * fifty real connections and fires fifty accepts at one live offer. A test that
 * counted indexes would pass on the day the CAS was deleted.
 *
 * These run as the migration owner, which bypasses RLS — right for a CAS, which
 * runs on the service role. The policies are covered in `db.rls.test.ts`.
 *
 *   npm run db:migrate && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the assignment database tests — no SUPABASE_DB_URL available.\n' +
      '     The double-accept guarantee and the schedule-overlap refusal are NOT covered.\n'
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
     values ('${customerId}', '${label}', '221B Test Street', 'HSR Layout',
             'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900)
     returning id;`
  );
}

/** A booking already `assigned` to a professional, so `assigned -> accepted` is legal. */
async function makeAssignedBooking(
  customerId: string,
  addressId: string,
  professionalId: string,
  opts: { start?: string; end?: string } = {}
): Promise<string> {
  const start = opts.start ?? '2030-09-04T10:00:00+05:30';
  const end = opts.end ?? '2030-09-04T11:00:00+05:30';
  return sql(
    `insert into public.bookings
       (booking_number, customer_id, professional_id, address_id, address_snapshot,
        booking_type, status, duration_minutes, scheduled_start_at, scheduled_end_at,
        total_amount)
     values (public.next_booking_number(), '${customerId}', '${professionalId}',
             '${addressId}', '{}'::jsonb, 'scheduled', 'assigned', 60,
             '${start}', '${end}', 100)
     returning id;`
  );
}

/** A live offer on a booking, expiring in `ttlMinutes` (negative for a stale one). */
async function makeOffer(
  bookingId: string,
  professionalId: string,
  ttlMinutes = 15
): Promise<string> {
  const id = await sql(
    `insert into public.booking_assignments
       (booking_id, professional_id, status, expires_at)
     values ('${bookingId}', '${professionalId}', 'offered',
             now() + make_interval(mins => ${ttlMinutes}))
     returning id;`
  );
  // Inserting the row directly skips `sweep_new_bookings`, which is the producer
  // that bumps `professionals.total_offers` when it makes an offer. `accept_offer`
  // bumps `accepted_offers`, and 0005's `acceptance_rate_positive` check requires
  // `accepted_offers <= total_offers` — so the test must record the made offer
  // itself, or the counter drifts one acceptance per run and eventually trips the
  // constraint.
  await sql(
    `update public.professionals set total_offers = total_offers + 1 where id = '${professionalId}';`
  );
  return id;
}

/**
 * A URL that tolerates many simultaneous connections.
 *
 * `SUPABASE_DB_URL` points at Supavisor in *session* mode (port 5432), which
 * pins one backend per client and caps the pool at 15 — so fifty real
 * connections there fail with EMAXCONNSESSION before the race even starts.
 * Port 6543 is the same pooler in *transaction* mode, which multiplexes many
 * clients across a small backend pool. Every statement this test sends is a
 * single call to `accept_offer`, so nothing relies on session state surviving
 * between statements, and the fifty-way race stays real rather than being
 * watered down to fit the session pool.
 *
 * On a direct (non-pooler) connection there is no 6543 to swap to, so the
 * database's own connection limit is the ceiling and the URL is used as given.
 */
function racingUrl(): string | undefined {
  if (!dbUrl) return dbUrl;
  return /\.pooler\.supabase\.com:5432\//.test(dbUrl) ? dbUrl.replace(':5432/', ':6543/') : dbUrl;
}

async function cleanup(bookingIds: string[], addressIds: string[]): Promise<void> {
  const bookings = bookingIds.map((id) => `'${id}'`).join(', ');
  const addresses = addressIds.map((id) => `'${id}'`).join(', ');
  if (bookings) {
    // Cascades: booking_assignments and professional_schedule both fall with the
    // booking (§24.8 / 0013 `on delete cascade`).
    await sql(`delete from public.bookings where id in (${bookings});`);
  }
  if (addresses) await sql(`delete from public.addresses where id in (${addresses});`);
}

describeDb(
  'database: the double-accept guarantee survives real concurrency',
  () => {
    it('lets exactly one of fifty concurrent accepts win, and refuses the other forty-nine', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Concurrent accept');
      const booking = await makeAssignedBooking(customer, address, pro);
      const offer = await makeOffer(booking, pro);

      // Fifty connections, then fifty calls fired together. One physical
      // connection would serialise them, which is not the race under test. The
      // transaction pooler is used here because the session pooler caps at 15.
      // The connects are opened together, not one after another: fifty serial
      // TLS handshakes to the pooler cost ~1s each and dominate the run when the
      // rest of `npm test` is hammering the same database.
      const clients: Client[] = [];
      let winners = 0;
      try {
        await Promise.all(
          Array.from({ length: 50 }, async () => {
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
          clients.map((c) =>
            c.query('select public.accept_offer($1, $2) as accepted', [offer, pro])
          )
        );
        // A `booking_assignments` composite comes back as a string on success and
        // as null on the CAS miss — exactly the two outcomes the function has.
        winners = results.filter((r) => r.rows[0].accepted !== null).length;
      } finally {
        await Promise.all(clients.map((c) => c.end().catch(() => {})));
      }

      expect(winners).toBe(1);

      // The booking moved once, one schedule window exists, and the pro's tally
      // was incremented once — the winner's side effects and only the winner's.
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'accepted'
      );
      expect(
        await sql(`select count(*) from public.professional_schedule where booking_id = '${booking}';`)
      ).toBe('1');
      expect(
        await sql(`select count(*) from public.booking_status_history
                    where booking_id = '${booking}' and to_status = 'accepted';`)
      ).toBe('1');

      await cleanup([booking], [address]);
    }, 120_000);

    it('refuses an offer that has already expired', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Expired offer');
      const booking = await makeAssignedBooking(customer, address, pro);
      const offer = await makeOffer(booking, pro, -1);

      const result = await sql(
        `select case when public.accept_offer('${offer}', '${pro}') is null then 'null' else 'ok' end;`
      );
      expect(result).toBe('null');
      // Still assigned: an expired offer is a tombstone, not a state change.
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'assigned'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('refuses an accept from a professional who does not own the offer', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const otherPro = await sql(
        `select id from public.professionals where id <> '${pro}' limit 1;`
      );
      if (!/^[0-9a-f-]{36}$/i.test(otherPro)) return;

      const address = await addressFor(customer, 'Cross-pro accept');
      const booking = await makeAssignedBooking(customer, address, pro);
      const offer = await makeOffer(booking, pro);

      const result = await sql(
        `select case when public.accept_offer('${offer}', '${otherPro}') is null then 'null' else 'ok' end;`
      );
      expect(result).toBe('null');
      expect(await sql(`select status::text from public.booking_assignments where id = '${offer}';`)).toBe(
        'offered'
      );

      await cleanup([booking], [address]);
    }, DB_TIMEOUT);

    it('refuses a schedule overlap with PROFESSIONAL_UNAVAILABLE, not a 500', async () => {
      const customer = await customerOf('demo.customer@smarthelp.test');
      const pro = await professionalOf('demo.pro@smarthelp.test');
      const address = await addressFor(customer, 'Overlap accept');

      // A window the pro already holds, 10:30–11:30.
      const held = await makeAssignedBooking(customer, address, pro, {
        start: '2030-09-04T10:30:00+05:30',
        end: '2030-09-04T11:30:00+05:30',
      });
      await sql(
        `insert into public.professional_schedule
           (professional_id, booking_id, starts_at, ends_at, status)
         values ('${pro}', '${held}',
                 '2030-09-04T10:30:00+05:30', '2030-09-04T11:30:00+05:30', 'reserved');`
      );

      // A second booking overlapping it, 10:00–11:00.
      const booking = await makeAssignedBooking(customer, address, pro, {
        start: '2030-09-04T10:00:00+05:30',
        end: '2030-09-04T11:00:00+05:30',
      });
      const offer = await makeOffer(booking, pro);

      // The exclusion constraint (0013) vetoes the reserve; accept_offer re-raises
      // it as PROFESSIONAL_UNAVAILABLE so the route can 409 instead of 500.
      await expect(
        sql(`select public.accept_offer('${offer}', '${pro}');`)
      ).rejects.toThrow(/PROFESSIONAL_UNAVAILABLE/);

      // The CAS already committed the assignment to `accepted` before the reserve
      // failed — so the assertion that matters is that the *booking* did not move,
      // and the route treats the raised error as a refusal.
      expect(await sql(`select status::text from public.bookings where id = '${booking}';`)).toBe(
        'assigned'
      );

      await cleanup([held, booking], [address]);
    }, DB_TIMEOUT);
  },
  DB_TIMEOUT
);
