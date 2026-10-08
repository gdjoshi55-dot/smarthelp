import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, fixtureLabel, purgeTestFixtures, sql, sqlAsRole } from './helpers/dbEnv';

/**
 * The Phase 3 database contract, asserted against a live project — and the
 * §29.3 isolation test for this phase.
 *
 * Wave B adds the `refunds` / `wallets` / `wallet_transactions` half to this
 * same file, because §29.3 asks for one isolation test per phase rather than one
 * per table, and the four tables are read by the same two roles.
 *
 * Three things only Postgres can answer are asserted here:
 *
 *   1. `confirm_booking_payment()` moves a booking **once**. The replay guard is
 *      the `status in ('created','pending')` in its WHERE clause, and a test
 *      that only checks the final state cannot tell "confirmed twice" from
 *      "confirmed once" — so the history rows are counted.
 *   2. Customer A's payment is invisible to customer B, and to a session with
 *      nobody signed in. Route Handlers cannot answer this: they use the service
 *      role, which bypasses RLS entirely.
 *   3. There is no write policy to attempt. A `payments` row a browser could
 *      insert would let it set `status = 'success'` and hand itself a paid
 *      booking, so the absence of the policy is the assertion, not the content
 *      of one.
 *
 * The file is excluded from every pre-migration `npx vitest run`
 * (`--exclude "test/db.payments.test.ts"`), because `0014` has to be applied
 * before `public.payments` exists. It runs for real under `npm run test:db`.
 *
 *   npm run db:migrate && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the payments database tests — no SUPABASE_DB_URL available.\n' +
      '     Payment isolation, the replay guard and the absence of a write policy\n' +
      '     are NOT covered by this run.\n'
  );
}

/**
 * Deliberate budget: these tests do several round-trips per case against a
 * shared connection, and `confirm_booking_payment()` takes row locks on two
 * tables. The default 5s is a timeout, not an assertion.
 */
const DB_TIMEOUT = 60_000;

/**
 * The three signatures the `confirm_booking_payment()` calls below pass.
 *
 * `payments.gateway_signature` is `text`, and Razorpay's own signature is 64
 * hex characters, so 64 is the shape worth asserting.
 *
 * They are built here rather than spelled `'a'.repeat(64)` inside the SQL
 * template literals: inside a template that is *literal text*, Postgres reads
 * `'a'.repeat(64)` as a string followed by `.repeat` and rejects the statement
 * with `syntax error at or near "."`. Interpolating a value that JavaScript has
 * already repeated keeps the fixture readable and the SQL valid.
 */
const SIG_CONFIRM = 'a'.repeat(64);
const SIG_MISMATCH = 'b'.repeat(64);
const SIG_AFTER_CANCEL = 'c'.repeat(64);

/**
 * The second customer.
 *
 * The seed ships exactly one `customer` account, and isolation needs two rows
 * with different owners. Staff accounts are no substitute: `admin`, `super_admin`
 * and `ops` are *meant* to read every payment, so a test that used one of them as
 * "somebody else" would fail for the wrong reason and `support` has no
 * `customers` row to own a payment with.
 *
 * `seed_demo_user()` is the function `supabase/seed.sql` defines for exactly this
 * and is idempotent by email — but this live project does not have it
 * (`db:seed` has not been re-run here, and this session forbids it), so the
 * fixture is created directly: the same column set `seed_demo_user()` writes,
 * guarded by email so a re-run after a failed cleanup reuses the same auth user
 * instead of piling up a second one. The `on_auth_user_created` trigger in `0001`
 * then makes the `profiles` and `customers` rows.
 */
const SECOND_CUSTOMER_EMAIL = 'payments.isolation.b@smarthelp.test';

async function profileId(email: string): Promise<string> {
  const id = await sql(`select id from public.profiles where email = '${email}';`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`no profile for ${email} — run "npm run db:seed" first`);
  }
  return id;
}

async function customerOf(email: string): Promise<{ profileId: string; customerId: string }> {
  const p = await profileId(email);
  const c = await sql(`select id from public.customers where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(c)) throw new Error(`${email} has no customers row`);
  return { profileId: p, customerId: c };
}

async function createSecondCustomer(): Promise<void> {
  // Seeded by `seed_demo_user()` when the seed is present; inserted directly
  // otherwise (see the header note above). The INSERT ... WHERE NOT EXISTS is
  // what keeps a re-run idempotent — the same shape the seed's own existence
  // check achieves. No password is needed: `sqlAsRole()` impersonates via JWT
  // claims, it does not sign in.
  await sql(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, email_change, email_change_token_new, recovery_token
     )
     select
       '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
       'authenticated', 'authenticated', '${SECOND_CUSTOMER_EMAIL}', null, now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"role":"customer","full_name":"Payments Isolation B","phone":"+919876500002"}'::jsonb,
       now(), now(), '', '', '', ''
     where not exists (
       select 1 from auth.users where email = '${SECOND_CUSTOMER_EMAIL}'
     );`
  );
}

/**
 * A throwaway address, carrying `FIXTURE_LABEL_PREFIX` so
 * `purgeTestFixtures()` can tell it from one somebody saved through the app.
 */
async function addressFor(customerId: string, label: string): Promise<string> {
  return sql(
    `insert into public.addresses
       (customer_id, label, line1, area, city, state, pincode, lat, lng)
     values ('${customerId}', '${fixtureLabel(label)}', '221B Test Street', 'HSR Layout',
             'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900)
     returning id;`
  );
}

/**
 * A booking already waiting for its money.
 *
 * Inserted directly rather than walked to `payment_pending`, because the
 * transition trigger guards `update`, not `insert` — `db.booking.test.ts` does
 * the same. `quote_token` is set: `create-order` refuses a booking without one,
 * and the webhook is what nulls it, so a payment lifecycle has to start with it
 * present. `scheduled_start_at` is set because `0010`'s
 * `scheduled_has_a_start` refuses a `scheduled` booking without one — the row
 * has to satisfy the real schema before it can test the payment one.
 */
async function bookingPendingPayment(customerId: string, addressId: string): Promise<string> {
  return sql(
    `insert into public.bookings
       (booking_number, customer_id, address_id, address_snapshot,
        booking_type, status, duration_minutes, scheduled_start_at, scheduled_end_at,
        subtotal, platform_fee, tax, tax_rate, total_amount, professional_gross,
        commission_pct, pricing_snapshot, quote_token)
     values (
       public.next_booking_number(), '${customerId}', '${addressId}',
       '{"label":"Test","line1":"221B Test Street","area":"HSR Layout","city":"Bengaluru","state":"Karnataka","pincode":"560102","lat":12.9116,"lng":77.6389}'::jsonb,
       'scheduled', 'payment_pending', 60,
       now() + interval '2 hours', now() + interval '3 hours',
       1000.00, 50.00, 180.00, 0.1800, 1230.00, 1111.11, 0.1000,
       '{"subtotal":1000.00,"platform_fee":50.00,"tax":180.00,"total":1230.00}'::jsonb,
       'quote-token-fixture'
     )
     returning id;`
  );
}

/**
 * A charge attempt in `created`, the state a row is in after `create-order`
 * wrote it and before the gateway answered.
 */
async function pendingPayment(
  customerId: string,
  bookingId: string,
  order: string,
  key: string
): Promise<string> {
  return sql(
    `insert into public.payments
       (booking_id, customer_id, purpose, amount, currency, gateway,
        gateway_order_id, status, idempotency_key)
     values ('${bookingId}', '${customerId}', 'booking', 1230.00, 'INR', 'razorpay',
             '${order}', 'created', '${key}')
     returning id;`
  );
}

/** Ids the cleanup below removes, so a failed run does not accumulate rows. */
let cleanup: { bookings: string[]; addresses: string[]; secondProfile: boolean } = {
  bookings: [],
  addresses: [],
  secondProfile: false,
};

beforeAll(async () => {
  if (!dbUrl) return;
  const { bookings, addresses } = await purgeTestFixtures();
  if (bookings || addresses) {
    console.warn(
      `[db] Cleared ${bookings} booking(s) and ${addresses} address(es) left by an earlier run.`
    );
  }
});

afterAll(async () => {
  if (dbUrl) {
    const bookingIds = cleanup.bookings.map((id) => `'${id}'`).join(', ');
    // Payments go with their booking — `payments.booking_id` is `on delete
    // cascade` — so only the bookings and the address need naming here.
    if (bookingIds) await sql(`delete from public.bookings where id in (${bookingIds});`);
    if (cleanup.addresses.length) {
      const addressIds = cleanup.addresses.map((id) => `'${id}'`).join(', ');
      await sql(`delete from public.addresses where id in (${addressIds});`);
    }
    if (cleanup.secondProfile) {
      // Cascades to `profiles`, `customers` and any payment still pointing at
      // that customer. Non-fatal: `seed_demo_user` is idempotent, so a leftover
      // fixture is reused by the next run rather than duplicated.
      await sql(
        `delete from auth.users where email = '${SECOND_CUSTOMER_EMAIL}';`
      ).catch(() => {});
    }
  }
  cleanup = { bookings: [], addresses: [], secondProfile: false };
  await closeDb();
});

describeDb('database: confirm_booking_payment is the only writer of success', () => {
  it(
    'confirms once, and returns null on a replay of the same arguments',
    async () => {
      const a = await customerOf('demo.customer@smarthelp.test');
      const addressId = await addressFor(a.customerId, 'Payments confirm replay');
      const bookingId = await bookingPendingPayment(a.customerId, addressId);
      cleanup.addresses.push(addressId);
      cleanup.bookings.push(bookingId);
      const paymentId = await pendingPayment(
        a.customerId,
        bookingId,
        'order_confirm_replay',
        'idem_confirm_replay'
      );

      const first = await sql(
        `select status from public.confirm_booking_payment(
           '${paymentId}', 'order_confirm_replay', '${bookingId}',
           'pay_confirm_replay', '${SIG_CONFIRM}',
           'payment confirmed by webhook (payment.captured, pay_confirm_replay)');`
      );
      expect(first).toBe('success');

      const status = await sql(`select status from public.bookings where id = '${bookingId}';`);
      expect(status).toBe('paid');

      // The token is nulled by the webhook's confirmation, which is what makes
      // it single-use across the payment lifecycle.
      //
      // Its own statement, deliberately: `sql()` joins a row's columns with
      // `\n` and then trims the result, so a NULL in the *second* column of a
      // two-column select is a trailing newline that gets trimmed away — the
      // caller then receives `undefined` where the empty string it is asserting
      // for never arrives. Isolated, the NULL is the whole row and renders as
      // the empty string the helper promises.
      const quoteToken = await sql(
        `select quote_token from public.bookings where id = '${bookingId}';`
      );
      expect(quoteToken).toBe('');

      // The replay: same arguments, no write at all. An empty string is
      // `sql()`'s rendering of a NULL return.
      const second = await sql(
        `select public.confirm_booking_payment(
           '${paymentId}', 'order_confirm_replay', '${bookingId}',
           'pay_confirm_replay', '${SIG_CONFIRM}', 'replayed');`
      );
      expect(second).toBe('');

      // "Moves the booking once" has to be counted, not inferred: the final
      // state looks identical whether the second call wrote or did not.
      const hops = await sql(
        `select count(*) from public.booking_status_history
          where booking_id = '${bookingId}' and to_status = 'paid';`
      );
      expect(Number(hops)).toBe(1);

      // And the note the replay would have written never reached the row.
      const signature = await sql(
        `select gateway_signature from public.payments where id = '${paymentId}';`
      );
      expect(signature).toBe(SIG_CONFIRM);
    },
    DB_TIMEOUT
  );

  it(
    'refuses a payment whose gateway order id does not match',
    async () => {
      const a = await customerOf('demo.customer@smarthelp.test');
      const addressId = await addressFor(a.customerId, 'Payments confirm order mismatch');
      const bookingId = await bookingPendingPayment(a.customerId, addressId);
      cleanup.addresses.push(addressId);
      cleanup.bookings.push(bookingId);
      const paymentId = await pendingPayment(
        a.customerId,
        bookingId,
        'order_expected',
        'idem_order_mismatch'
      );

      const wrongOrder = await sql(
        `select public.confirm_booking_payment(
           '${paymentId}', 'order_somebody_else', '${bookingId}',
           'pay_mismatch', '${SIG_MISMATCH}', 'mismatch');`
      );
      expect(wrongOrder).toBe('');

      const status = await sql(`select status from public.payments where id = '${paymentId}';`);
      expect(status).toBe('created');
      const bookingStatus = await sql(`select status from public.bookings where id = '${bookingId}';`);
      expect(bookingStatus).toBe('payment_pending');
    },
    DB_TIMEOUT
  );

  it(
    'leaves a cancelled booking cancelled when the money arrives anyway',
    async () => {
      const a = await customerOf('demo.customer@smarthelp.test');
      const addressId = await addressFor(a.customerId, 'Payments confirm cancelled booking');
      const bookingId = await bookingPendingPayment(a.customerId, addressId);
      cleanup.addresses.push(addressId);
      cleanup.bookings.push(bookingId);
      const paymentId = await pendingPayment(
        a.customerId,
        bookingId,
        'order_after_cancel',
        'idem_after_cancel'
      );

      await sql(`update public.bookings set status = 'cancelled' where id = '${bookingId}';`);

      const confirmed = await sql(
        `select status from public.confirm_booking_payment(
           '${paymentId}', 'order_after_cancel', '${bookingId}',
           'pay_after_cancel', '${SIG_AFTER_CANCEL}', 'captured after cancel');`
      );
      // The money did arrive, so the payment is success — and it is now a
      // refund somebody owes rather than a job that should start.
      expect(confirmed).toBe('success');
      const bookingStatus = await sql(`select status from public.bookings where id = '${bookingId}';`);
      expect(bookingStatus).toBe('cancelled');
    },
    DB_TIMEOUT
  );
});

describeDb('database: payments are private to their owner', () => {
  it(
    'shows a customer their own payment, another customer nothing, and a visitor nothing',
    async () => {
      const a = await customerOf('demo.customer@smarthelp.test');
      await createSecondCustomer();
      cleanup.secondProfile = true;
      const b = await customerOf(SECOND_CUSTOMER_EMAIL);

      const addressA = await addressFor(a.customerId, 'Payments isolation A');
      const bookingA = await bookingPendingPayment(a.customerId, addressA);
      const paymentA = await pendingPayment(
        a.customerId,
        bookingA,
        'order_isolation_a',
        'idem_isolation_a'
      );

      const addressB = await addressFor(b.customerId, 'Payments isolation B');
      const bookingB = await bookingPendingPayment(b.customerId, addressB);
      const paymentB = await pendingPayment(
        b.customerId,
        bookingB,
        'order_isolation_b',
        'idem_isolation_b'
      );
      cleanup.addresses.push(addressA, addressB);
      cleanup.bookings.push(bookingA, bookingB);

      const asOwner = await sqlAsRole(
        a.profileId,
        `select count(*) from public.payments where id = '${paymentA}';`
      );
      expect(asOwner).toBe('1');

      // RLS filters the row out rather than raising, which is what a browser
      // would actually experience.
      const asOther = await sqlAsRole(
        b.profileId,
        `select count(*) from public.payments where id = '${paymentA}';`
      );
      expect(asOther).toBe('0');

      // The other direction too: B can read B and not A.
      const bOwn = await sqlAsRole(
        b.profileId,
        `select count(*) from public.payments where id = '${paymentB}';`
      );
      expect(bOwn).toBe('1');
      const bNotA = await sqlAsRole(
        b.profileId,
        `select count(*) from public.payments where id = '${paymentA}';`
      );
      expect(bNotA).toBe('0');

      // A session with nobody signed in sees nothing at all.
      const asNobody = await sqlAsRole(null, `select count(*) from public.payments;`);
      expect(asNobody).toBe('0');
    },
    DB_TIMEOUT
  );

  it(
    'revokes anon outright rather than admitting it through a policy',
    async () => {
      // Two ways to say the same thing, because they fail differently: the
      // grant is a permission error the role never reaches a policy through,
      // and the policy check is what would catch a `using (true)` added later.
      const anonCanSelect = await sql(
        `select has_table_privilege('anon', 'public.payments', 'select');`
      );
      expect(anonCanSelect).toBe('false');

      const anonPolicies = await sql(
        `select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'payments' and roles = '{anon}';`
      );
      expect(Number(anonPolicies)).toBe(0);
    },
    DB_TIMEOUT
  );

  it(
    'has no write policy for a browser session to attempt',
    async () => {
      // This is the assertion, not the content of a policy: a row a browser
      // could insert would let it set status = 'success' itself.
      const writePolicies = await sql(
        `select coalesce(string_agg(policyname || ':' || cmd, ','), '') from pg_policies
          where schemaname = 'public' and tablename = 'payments'
            and cmd in ('INSERT', 'UPDATE', 'DELETE');`
      );
      expect(writePolicies).toBe('');

      // Belt and braces: even with a policy, `authenticated` has no table-level
      // privilege to write through.
      const canUpdate = await sql(
        `select has_table_privilege('authenticated', 'public.payments', 'update');`
      );
      expect(canUpdate).toBe('false');
    },
    DB_TIMEOUT
  );
});
