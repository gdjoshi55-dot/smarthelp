import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

/**
 * The wallet contract (0015 §12.4), asserted against a live project.
 *
 * Four things only Postgres can answer are checked here, and each one is a
 * property the application code cannot enforce on its own:
 *
 *   1. **The balance and its ledger agree.** `apply_wallet_delta()` writes both
 *      in one statement, so a credit followed by a debit leaves a balance that
 *      re-running the ledger reproduces exactly.
 *   2. **An overdraft is refused before either write.** `WALLET_OVERDRAFT`
 *      (SQLSTATE 23514) has to be reachable — 0015's amendment (2) exists
 *      because the column's own `CHECK` would otherwise fire first and name the
 *      constraint instead of the wallet. And a refused debit must leave **no**
 *      ledger row behind.
 *   3. **Two concurrent credits cannot lose one another.** The `FOR UPDATE`
 *      read-then-write is the thing under test, and one connection cannot
 *      exercise it: the second movement has to arrive on a *separate* session or
 *      there is nothing to serialise against.
 *   4. **A non-positive amount is refused, named.** Direction is `p_type`, never
 *      the sign, so `0` and a negative are both `WALLET_AMOUNT_NOT_POSITIVE`.
 *
 * This file needs `0015_refunds_wallet.sql` applied, so it is excluded from
 * every pre-migration `npx vitest run`
 * (`--exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"`)
 * and only runs for real under `npm run test:db`, which globs `test/db.`.
 *
 *   npm run db:migrate && npm run test:db
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the wallet database tests — no SUPABASE_DB_URL available.\n' +
      '     The ledger/balance agreement, the overdraft guard and the concurrent\n' +
      '     credit are NOT covered by this run.\n'
  );
}

/** Several round-trips per case against a shared project; 5s is a timeout, not an assertion. */
const DB_TIMEOUT = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Emails this file created, so cleanup can remove them (and their wallets) by cascade. */
const createdEmails: string[] = [];
let customerSeq = 0;

/**
 * A throwaway customer, created the same way `db.payments.test.ts` does it.
 *
 * The `on_auth_user_created` trigger in `0001` makes the `profiles` and
 * `customers` rows; `phone` is omitted because `profiles.phone` is unique and a
 * shared literal would collide on the second fixture.
 */
async function freshCustomer(tag: string): Promise<string> {
  const email = `wallet.ledger.${tag}.${customerSeq++}@smarthelp.test`;
  createdEmails.push(email);

  await sql(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, email_change, email_change_token_new, recovery_token
     )
     select
       '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
       'authenticated', 'authenticated', '${email}', null, now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"role":"customer","full_name":"Wallet Ledger Fixture"}'::jsonb,
       now(), now(), '', '', '', ''
     where not exists (select 1 from auth.users where email = '${email}');`
  );

  const profileId = await sql(`select id from public.profiles where email = '${email}';`);
  const customerId = await sql(
    `select id from public.customers where profile_id = '${profileId}';`
  );
  if (!UUID_RE.test(customerId)) throw new Error(`${email} has no customers row`);
  return customerId;
}

/** A fresh customer plus the wallet `get_or_create_wallet()` opens for them. */
async function freshWallet(tag: string): Promise<{ customerId: string; walletId: string }> {
  const customerId = await freshCustomer(tag);
  const walletId = await sql(`select public.get_or_create_wallet('${customerId}');`);
  if (!UUID_RE.test(walletId)) throw new Error(`no wallet for ${customerId}`);
  return { customerId, walletId };
}

async function expectRefusal(run: () => Promise<unknown>): Promise<any> {
  let caught: any = null;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the statement to be refused').not.toBeNull();
  return caught;
}

beforeAll(() => {
  // Nothing to set up: each case creates its own customer. This hook exists so
  // the file's lifecycle mirrors the other db tests, and to make the cleanup
  // below obviously paired with it.
});

afterAll(async () => {
  if (dbUrl) {
    for (const email of createdEmails) {
      // Cascades to profiles -> customers -> wallets -> wallet_transactions.
      await sql(`delete from auth.users where email = '${email}';`).catch(() => {});
    }
  }
  createdEmails.length = 0;
  await closeDb();
});

describeDb('database: the wallet ledger and its balance', () => {
  it(
    'credits then debits, and the balance agrees with the ledger',
    async () => {
      const { walletId } = await freshWallet('agree');

      const afterCredit = await sql(
        `select public.apply_wallet_delta('${walletId}', 'credit', 500.00,
           'topup:fixture-credit', 'wallet ledger agree — credit');`
      );
      expect(Number(afterCredit)).toBe(500);

      const afterDebit = await sql(
        `select public.apply_wallet_delta('${walletId}', 'debit', 200.00,
           'refund:fixture-debit', 'wallet ledger agree — debit');`
      );
      expect(Number(afterDebit)).toBe(300);

      const balance = await sql(`select balance from public.wallets where id = '${walletId}';`);
      expect(Number(balance)).toBe(300);

      // The ledger is the truth; re-running it must reproduce the cached balance.
      const net = await sql(
        `select sum(case when type = 'credit' then amount else -amount end)
           from public.wallet_transactions where wallet_id = '${walletId}';`
      );
      expect(Number(net)).toBe(300);

      const rows = await sql(
        `select count(*) from public.wallet_transactions where wallet_id = '${walletId}';`
      );
      expect(Number(rows)).toBe(2);
    },
    DB_TIMEOUT
  );

  it(
    'refuses an overdraft, leaving no ledger row and the balance untouched',
    async () => {
      const { walletId } = await freshWallet('overdraft');

      await sql(
        `select public.apply_wallet_delta('${walletId}', 'credit', 300.00,
           'topup:fixture-seed', 'seed the wallet');`
      );

      const caught = await expectRefusal(() =>
        sql(
          `select public.apply_wallet_delta('${walletId}', 'debit', 500.00,
             'refund:fixture-over', 'more than the balance');`
        )
      );

      // The named refusal, not the column CHECK that would otherwise shadow it.
      expect(caught.code).toBe('23514');
      expect(String(caught.message)).toContain('WALLET_OVERDRAFT');

      const balance = await sql(`select balance from public.wallets where id = '${walletId}';`);
      expect(Number(balance)).toBe(300);

      // The refusal happens before either write, so nothing was recorded.
      const overRows = await sql(
        `select count(*) from public.wallet_transactions
           where wallet_id = '${walletId}' and ref_id = 'fixture-over';`
      );
      expect(Number(overRows)).toBe(0);
    },
    DB_TIMEOUT
  );

  it(
    'serialises two concurrent credits so neither is lost',
    async () => {
      const { walletId } = await freshWallet('concurrent');

      // Two separate sessions, because the `FOR UPDATE` read-then-write is the
      // property under test: a single connection cannot race against itself.
      const mk = () =>
        new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      const c1 = mk();
      const c2 = mk();
      c1.on('error', () => {});
      c2.on('error', () => {});
      await Promise.all([c1.connect(), c2.connect()]);

      try {
        await Promise.all([
          c1.query(
            `select public.apply_wallet_delta($1, 'credit', $2::numeric, $3, $4);`,
            [walletId, '100.00', 'topup:concurrent-1', 'concurrent credit 1']
          ),
          c2.query(
            `select public.apply_wallet_delta($1, 'credit', $2::numeric, $3, $4);`,
            [walletId, '100.00', 'topup:concurrent-2', 'concurrent credit 2']
          ),
        ]);
      } finally {
        await c1.end().catch(() => {});
        await c2.end().catch(() => {});
      }

      const balance = await sql(`select balance from public.wallets where id = '${walletId}';`);
      expect(Number(balance)).toBe(200);

      const rows = await sql(
        `select count(*) from public.wallet_transactions where wallet_id = '${walletId}';`
      );
      expect(Number(rows)).toBe(2);
    },
    DB_TIMEOUT
  );

  it(
    'refuses a zero or negative amount, named, with no ledger row',
    async () => {
      const { walletId } = await freshWallet('nonpositive');

      for (const amount of ['0', '-5.00']) {
        const caught = await expectRefusal(() =>
          sql(
            `select public.apply_wallet_delta('${walletId}', 'credit', ${amount},
               'topup:fixture-nonpositive', 'not a movement');`
          )
        );
        expect(caught.code).toBe('23514');
        expect(String(caught.message)).toContain('WALLET_AMOUNT_NOT_POSITIVE');
      }

      const rows = await sql(
        `select count(*) from public.wallet_transactions where wallet_id = '${walletId}';`
      );
      expect(Number(rows)).toBe(0);
    },
    DB_TIMEOUT
  );
});
