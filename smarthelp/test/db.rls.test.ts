import { afterAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { closeDb, dbUrl, hasAuthAdmin, serviceRoleKey, sql, sqlAsRole, supabaseUrl } from './helpers/dbEnv';

/**
 * The database tests — the part of §29.1 that cannot be faked.
 *
 * Every other suite mocks Supabase, and that is right: a mock proves the
 * *route* takes the right branch, but it proves nothing about who may read a
 * row. Only Postgres answers that, so these assertions run against a real
 * database with the real migration history applied.
 *
 * These are the only tests here that talk to a live service, so they need
 * SUPABASE_DB_URL — read from the environment or from `.env.local`, which
 * ./helpers/dbEnv loads for us. Without it the file skips, loudly, rather than
 * passing quietly: a green suite that never checked row-level security would
 * be worse than no suite at all.
 *
 * The database must be migrated and seeded first:
 *
 *   npm run db:migrate && npm run db:seed && npm run test:db
 *
 * Everything runs as the migration owner, which bypasses RLS — so these assert
 * that RLS *exists*, not what it lets through. The RLS-enabled behaviour itself
 * is covered by the seeded accounts signing in through the anon key, which
 * `npm run db:verify` does.
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the database tests — no SUPABASE_DB_URL in the environment\n' +
      '     or in .env.local. Row-level security, the OTP ledger and the audit\n' +
      '     triggers are NOT covered by this run.\n'
  );
}

afterAll(closeDb);

/** A phone number nobody can be holding, so the ledger starts empty. */
function freshTarget(): string {
  return `+9199${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;
}

/**
 * The id of a seeded profile, to act as the author of an audit row or an
 * idempotency key.
 *
 * A throwaway uuid is not usable here: audit_logs.actor_profile_id and
 * idempotency_keys.actor_profile_id both reference public.profiles, and
 * profiles.id is in turn the auth user's id with no default, so a test cannot
 * invent a profile. A row written to audit_logs then cannot be removed — the
 * immutability trigger blocks the delete — so making one per run would litter
 * the trail. Borrowing a seeded account keeps the run side-effect free apart
 * from the audit row itself, which is the thing under test.
 */
async function seededProfileId(email: string): Promise<string> {
  const id = await sql(`select id from public.profiles where id in
      (select id from auth.users where email = '${email}');`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`no seeded profile for ${email} — run "npm run db:seed" first`);
  }
  return id;
}

const issue = (target: string, code: string, purpose = 'login') =>
  sql(`select public.issue_otp('${target}', 'phone', '${purpose}', '${code}', 10, 3, 60, 15);`);
const consume = (target: string, code: string, purpose = 'login') =>
  sql(`select public.consume_otp('${target}', '${purpose}', '${code}');`);

describeDb('database: the schema is actually there', () => {
  it('has RLS enabled on every table in public', async () => {
    const unprotected = await sql(
      `select coalesce(string_agg(c.relname, ', '), '')
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relrowsecurity = false;`
    );
    expect(unprotected, `tables without RLS: ${unprotected}`).toBe('');
  });

  it('created the tables the code imports', async () => {
    const missing = await sql(
      `select coalesce(string_agg(t, ', '), '') from unnest(array[
         'profiles','customers','professionals','services',
         'professional_skills','professional_documents',
         'otp_requests','audit_logs','idempotency_keys'
       ]) as t
       where not exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = t
       );`
    );
    expect(missing, `missing tables: ${missing}`).toBe('');
  });

  it('gives the anon role policies on profiles rather than no access at all', async () => {
    // Not "no grants": on Supabase, anon and authenticated are granted table
    // privileges on the public schema and RLS is what decides rows. Asserting
    // the absence of grants would only be true on a hand-built database, and
    // would pass while the policies were all missing. What matters is that
    // policies exist and admit nobody, which the next two tests check.
    const policies = await sql(
      `select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'profiles';`
    );
    expect(Number(policies)).toBeGreaterThan(0);
  });

  it('has no policy that lets anyone read every profile', async () => {
    // A `for select ... using (true)` on profiles would hand the public every
    // row in the table, including phone numbers and roles. This is the single
    // most damaging policy mistake available here, so it is named explicitly.
    const wideOpen = await sql(
      `select coalesce(string_agg(policyname, ', '), '') from pg_policies
        where schemaname = 'public' and tablename = 'profiles'
          and cmd = 'SELECT' and qual = 'true';`
    );
    expect(wideOpen, `profiles readable by anyone: ${wideOpen}`).toBe('');
  });

  it('created the six storage buckets', async () => {
    const missing = await sql(
      `select coalesce(string_agg(b, ', '), '') from unnest(array[
         'service-media','pro-photos','kyc-documents',
         'chat-media','support-media','invoices'
       ]) as b
       where not exists (select 1 from storage.buckets where id = b);`
    );
    expect(missing, `missing buckets: ${missing}`).toBe('');
  });

  it('seeded the five demo accounts as confirmed email logins', async () => {
    const unusable = await sql(
      `select coalesce(string_agg(u.email, ', '), '')
         from auth.users u
         join public.profiles p on p.id = u.id
        where u.email like '%@smarthelp.test'
          and (u.email_confirmed_at is null or not exists (
                select 1 from auth.identities i
                 where i.user_id = u.id and i.provider = 'email'));`
    );
    expect(unusable, `demo accounts not usable for email sign-in: ${unusable}`).toBe('');
  });
});

describeDb('database: the OTP ledger', () => {
  it('stores a salted hash, so the code is not recoverable from the row', async () => {
    const target = freshTarget();
    const code = '135790';
    await issue(target, code);

    const row = await sql(
      `select code_hash || '|' || salt from public.otp_requests
        where target = '${target}' and consumed_at is null;`
    );
    const [hash, salt] = row.split('|');

    expect(hash).toHaveLength(64); // sha256, hex
    expect(salt).toHaveLength(32); // 16 random bytes, hex
    expect(hash).not.toContain(code);
    expect(row).not.toContain(code);
  });

  it('salts each code separately, so two equal codes hash differently', async () => {
    const first = freshTarget();
    const second = freshTarget();
    await issue(first, '246813');
    await issue(second, '246813');

    const hashes = await Promise.all(
      [first, second].map((t) =>
        sql(`select code_hash from public.otp_requests where target = '${t}';`)
      )
    );
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('accepts the right code and refuses a wrong one', async () => {
    const target = freshTarget();
    await issue(target, '112233');
    expect(await consume(target, '999999')).toBe('invalid');
    expect(await consume(target, '112233')).toBe('ok');
  });

  it('will not accept the same code twice', async () => {
    const target = freshTarget();
    await issue(target, '112234');
    expect(await consume(target, '112234')).toBe('ok');
    expect(await consume(target, '112234')).toBe('missing');
  });

  it('ignores a code issued for a different purpose', async () => {
    const target = freshTarget();
    await issue(target, '556677', 'login');
    expect(await consume(target, '556677', 'staff_login')).toBe('missing');
  });

  it('throttles a resend inside the 60 second window', async () => {
    const target = freshTarget();
    await issue(target, '445566');
    // The ledger signals this by raising, so the rejection is the assertion.
    await expect(issue(target, '445567')).rejects.toThrow(/OTP_THROTTLED/);
  });

  it('keeps only the newest code live', async () => {
    const target = freshTarget();
    // Issue two codes far enough apart to clear the throttle.
    await issue(target, '778899');
    await sql(`update public.otp_requests set created_at = now() - interval '10 minutes'
          where target = '${target}';`);
    await issue(target, '778800');

    // 'invalid', not 'missing': issuing supersedes the old row by stamping
    // consumed_at, but consume_otp reads the newest *unconsumed* row — which
    // is now the new code's — and simply fails to match. What matters is that
    // the superseded code does not verify.
    expect(await consume(target, '778899')).not.toBe('ok');
    expect(await consume(target, '778800')).toBe('ok');
  });

  it('locks the target on the third wrong attempt, and says so on the fourth', async () => {
    // Three failures are reported as 'invalid' — the third is what sets the
    // lock. The lock is visible on the next attempt, which is what the
    // Route Handler turns into a 429.
    const target = freshTarget();
    await issue(target, '121212');
    expect(await consume(target, '000001')).toBe('invalid');
    expect(await consume(target, '000002')).toBe('invalid');
    expect(await consume(target, '000003')).toBe('invalid');
    expect(await consume(target, '121212')).toBe('locked');
  });

  it('reports an expired code as expired rather than wrong', async () => {
    const target = freshTarget();
    await issue(target, '343434');
    await sql(`update public.otp_requests set expires_at = now() - interval '1 second'
          where target = '${target}';`);
    expect(await consume(target, '343434')).toBe('expired');
  });
});

describeDb('database: audit trail', () => {
  it('refuses to update or delete a row', async () => {
    const actor = await seededProfileId('demo.admin@smarthelp.test');
    const id = await sql(
      `select public.write_audit('${actor}', 'test.action', 'profiles', '${actor}');`
    );

    await expect(
      sql(`update public.audit_logs set action = 'tampered' where id = '${id}';`)
    ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);

    await expect(sql(`delete from public.audit_logs where id = '${id}';`)).rejects.toThrow(
      /AUDIT_LOG_IMMUTABLE/
    );

    // The rows stay: their immutability is the point, and the run is a reading
    // of the trail rather than a clean-up of it.
  });
});

describeDb('database: idempotency ledger', () => {  it('claims a key once, replays it after completion, and refuses a changed body', async () => {
    const key = `test-${Date.now()}`;
    const actor = await seededProfileId('demo.ops@smarthelp.test');

    const claim = (hash: string) =>
      sql(
        `select outcome from public.claim_idempotency_key('${key}', 'test.op', '${actor}', '${hash}');`
      );

    expect(await claim('hash-a')).toBe('claimed');
    // Same key, still running: the caller must wait, not start a second write.
    expect(await claim('hash-a')).toBe('in_flight');
    // Same key, different body: the client changed its mind — refuse.
    expect(await claim('hash-b')).toBe('conflict');

    await sql(
      `select public.complete_idempotency_key('${key}', 'test.op', '${actor}', 200, '{"ok":true}');`
    );

    expect(await claim('hash-a')).toBe('replay');
  });
});

/*
 * Addresses are the one table where "who may read this" is the whole point: it
 * says where a person lives, and `access_notes` describes how to get in. So
 * these assertions impersonate a real signed-in customer and count what comes
 * back, rather than trusting that the policies exist.
 */

/** The seeded demo customer, as a profile id and a customers id. */
async function demoCustomerIds(): Promise<{ profileId: string; customerId: string }> {
  const profileId = await seededProfileId('demo.customer@smarthelp.test');
  const customerId = await sql(
    `select id from public.customers where profile_id = '${profileId}';`
  );
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) {
    throw new Error('the seeded demo customer has no customers row — run "npm run db:seed"');
  }
  return { profileId, customerId };
}

/** A throwaway address, so the run does not disturb the seeded catalogue. */
async function makeAddress(customerId: string, label: string): Promise<string> {
  const id = await sql(
    `insert into public.addresses
       (customer_id, label, line1, area, city, state, pincode, lat, lng)
     values ('${customerId}', '${label}', '221B Test Street', 'HSR Layout',
             'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900)
     returning id;`
  );
  return id;
}

/*
 * RLS tests impersonate a signed-in user, which is a role switch plus three
 * set_config calls inside a transaction before the assertion even runs. That is
 * several round-trips per test against a shared connection, and under a full
 * parallel suite run it can exceed vitest's 5s default — which fails as a
 * timeout, not as a real assertion. Hence the explicit budget.
 */
describeDb(
  'database: addresses are private to their owner',
  () => {
  it('lets the owner read their own address and nobody else read it', async () => {
    const owner = await demoCustomerIds();
    const mine = await makeAddress(owner.customerId, 'Owner isolation test');

    // The owner sees it.
    const asOwner = await sqlAsRole(
      owner.profileId,
      `select count(*) from public.addresses where id = '${mine}';`
    );
    expect(asOwner).toBe('1');

    // A different signed-in customer does not — RLS filters the row out rather
    // than raising, which is what the browser would actually experience.
    const other = await seededProfileId('demo.ops@smarthelp.test');
    const asOther = await sqlAsRole(
      other,
      `select count(*) from public.addresses where id = '${mine}';`
    );
    expect(asOther).toBe('0');

    // And an anonymous visitor sees nothing at all.
    expect(await sqlAsRole(null, `select count(*) from public.addresses;`)).toBe('0');
  });

  it('refuses an insert that would give the row to somebody else', async () => {
    const owner = await demoCustomerIds();
    const other = await seededProfileId('demo.ops@smarthelp.test');

    await expect(
      sqlAsRole(
        other,
        `insert into public.addresses
           (customer_id, label, line1, area, city, state, pincode, lat, lng)
         values ('${owner.customerId}', 'Forged', '1 Forged Road', 'HSR Layout',
                 'Bengaluru', 'Karnataka', '560102', 12.911600, 77.638900);`
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('silently refuses an update and a delete of somebody else’s address', async () => {
    const owner = await demoCustomerIds();
    const other = await seededProfileId('demo.ops@smarthelp.test');
    const mine = await makeAddress(owner.customerId, 'Write isolation test');

    // An update or delete under a filtering RLS policy affects zero rows and
    // raises nothing — only an insert trips the WITH CHECK and errors. So these
    // are asserted as "the row is untouched", which is the honest shape of the
    // guarantee. Counting through a CTE makes the zero visible rather than
    // trusting the absence of an error message.
    const affected = await sqlAsRole(
      other,
      `with changed as (
         update public.addresses set label = 'Hijacked' where id = '${mine}'
         returning 1
       )
       select count(*) from changed;`
    );
    expect(affected).toBe('0');

    const deleted = await sqlAsRole(
      other,
      `with gone as (
         delete from public.addresses where id = '${mine}' returning 1
       )
       select count(*) from gone;`
    );
    expect(deleted).toBe('0');

    // Still the owner's, and untouched — checked as the owner, who can see it.
    expect(
      await sqlAsRole(owner.profileId, `select label from public.addresses where id = '${mine}';`)
    ).toBe('Write isolation test');
  });

  it('keeps exactly one default address per customer', async () => {
    const owner = await demoCustomerIds();
    const first = await makeAddress(owner.customerId, 'Default test one');
    const second = await makeAddress(owner.customerId, 'Default test two');

    // Start from a known state. These rows accumulate — the audit trigger does
    // not apply here, and an address row is harmless — so a default left by an
    // earlier run would otherwise trip the index at the wrong assertion.
    await sql(
      `update public.addresses set is_default = false
       where customer_id = '${owner.customerId}' and is_default;`
    );

    await sql(`update public.addresses set is_default = true where id = '${first}';`);

    // The partial unique index is what stops two rows claiming to be the
    // default, which is the invariant the booking form depends on.
    await expect(
      sql(`update public.addresses set is_default = true where id = '${second}';`)
    ).rejects.toThrow(/uniq_default_address/);

    // The RPC is the only supported way to move it, and it moves both halves.
    await sql(`select public.set_default_address('${owner.customerId}', '${second}');`);

    const defaults = await sql(
      `select id from public.addresses
       where customer_id = '${owner.customerId}' and is_default;`
    );
    expect(defaults).toBe(second);
  });

  it('refuses set_default_address for somebody else’s address', async () => {
    const owner = await demoCustomerIds();
    const other = await seededProfileId('demo.ops@smarthelp.test');
    const mine = await makeAddress(owner.customerId, 'RPC isolation test');

    // This is the one that would matter if the function trusted its caller: it
    // is security definer, so without its own ownership check it could set any
    // customer's default. `is_trusted_session()` is false for a browser
    // session, which is what makes the check bite.
    await expect(
      sqlAsRole(
        other,
        `select public.set_default_address('${owner.customerId}', '${mine}');`
      )
    ).rejects.toThrow(/ADDRESS_NOT_OWNED/);
  });

  it('rejects a bad pincode and an impossible latitude at the database', async () => {
    const owner = await demoCustomerIds();

    await expect(
      sql(
        `insert into public.addresses
           (customer_id, label, line1, area, city, state, pincode, lat, lng)
         values ('${owner.customerId}', 'Bad pin', '9 Test Street', 'HSR Layout',
                 'Bengaluru', 'Karnataka', '102', 12.911600, 77.638900);`
      )
    ).rejects.toThrow(/pincode_shape/);

    await expect(
      sql(
        `insert into public.addresses
           (customer_id, label, line1, area, city, state, pincode, lat, lng)
         values ('${owner.customerId}', 'Bad lat', '9 Test Street', 'HSR Layout',
                 'Bengaluru', 'Karnataka', '560102', 191.000000, 77.638900);`
      )
    ).rejects.toThrow(/latitude_in_range/);
  });
  },
  60_000
);

/*
 * Account provisioning, and the bug that made every signup fail.
 *
 * `admin.createUser` is the one call in the sign-up path that talks to GoTrue
 * rather than to our own tables, so the mocked Route Handler tests cannot
 * cover it: they replace the admin client with a fake that always succeeds.
 * That is exactly the gap a real bug fell through.
 *
 * The bug: 0001 declared profiles.phone NOT NULL with a digits-only check, and
 * satisfied the NOT NULL for a user who gave no number by fabricating one from
 * the user id — '+' followed by the first twelve characters of the uuid. A
 * uuid is hex, so those twelve characters are letters about 99.7% of the time
 * and the check rejected the row. GoTrue collapsed that into the one line
 * "Database error creating new user", so nothing pointed at the real cause.
 *
 * It stayed hidden because every existing account was seeded with a phone, so
 * coalesce() never reached the fabricated branch. A test that only seeds
 * therefore cannot find it; one that creates a user the way a signup does can.
 */

const describeAuth = hasAuthAdmin ? describe : describe.skip;

if (!hasAuthAdmin) {
  console.warn(
    '\n[db] Skipping the auth provisioning tests — no NEXT_PUBLIC_SUPABASE_URL or\n' +
      '     SUPABASE_SERVICE_ROLE_KEY in .env.local. The fix for the "Database\n' +
      '     error creating new user" signup failure is NOT covered by this run.\n'
  );
}

let admin: SupabaseClient;

function adminClient(): SupabaseClient {
  if (!admin) {
    admin = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}

/** An address no real signup is using, so the run cannot collide with a person. */
function freshEmail(tag: string): string {
  return `probe.${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.invalid`;
}

/**
 * `admin.createUser` over a transport that drops the odd request.
 *
 * Every assertion in this file is about what GoTrue did with a user, and `fetch
 * failed` says nothing about that — it is a DNS blip, a reset socket or a TLS
 * hiccup, and it arrives often enough on a dev link to have taken out complete
 * runs. Retrying it is safe because the call is idempotent here: each attempt
 * uses a fresh email, so a retry cannot collide with a user the previous attempt
 * actually created.
 *
 * An error *object* is not retried. `createUser` returning `{ error }` is GoTrue
 * answering, and the whole point of the assertion below is that this answer is
 * checked rather than swallowed — retrying it would turn a real provisioning bug
 * into a passing suite.
 */
async function createUserWithRetry(
  attributes: Parameters<SupabaseClient['auth']['admin']['createUser']>[0]
): Promise<Awaited<ReturnType<SupabaseClient['auth']['admin']['createUser']>>> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await adminClient().auth.admin.createUser(attributes);
    } catch (e) {
      if (attempt === attempts) throw e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error('unreachable');
}

/**
 * Creates a user exactly as `/api/auth/sign-up/complete` does and hands its id
 * to `body`, deleting it again afterwards whether or not the body passed.
 *
 * The teardown has to be inside the test rather than in an afterAll: a failed
 * assertion would otherwise leave a real auth user and a real profile behind,
 * and the next run would then fail for a reason that has nothing to do with
 * what it is testing.
 */
async function provisioned(
  userMetadata: Record<string, unknown>,
  body: (userId: string, email: string) => Promise<void>
): Promise<void> {
  const email = freshEmail('prov');
  const created = await createUserWithRetry({
    email,
    password: 'Provision-Me-2026',
    email_confirm: true,
    user_metadata: userMetadata,
  });

  // This is the assertion that was missing when the bug shipped. GoTrue reports
  // a failing trigger as this same opaque string, so checking it here is what
  // turns "signup is broken" into "the profile constraint rejected the row".
  if (created.error) {
    throw new Error(
      `createUser failed, which is the bug this test exists to catch: ${created.error.message}`
    );
  }

  const userId = created.data.user!.id;
  try {
    await body(userId, email);
  } finally {
    await adminClient().auth.admin.deleteUser(userId);
  }
}

/*
 * Same reasoning as the address block above, but the cost here is the Supabase
 * Admin API rather than Postgres: every test in this block creates a real auth
 * user, runs the provisioning trigger, and deletes the user again — three
 * network round-trips. "will not let a signup grant itself a staff role" does
 * that four times over, one per role it tries to claim, which is the whole point
 * of the test and is why it alone sat just past vitest's 5s default.
 */
describeAuth(
  'database: a new auth user is provisioned',
  () => {
  it('creates a profile with no phone rather than inventing one', async () => {
    await provisioned({ full_name: 'No Phone Person' }, async (userId) => {
      const row = await sql(
        `select coalesce(phone, '<null>') from public.profiles where id = '${userId}';`
      );

      // The regression. Before 0027 this was '+' plus twelve uuid characters,
      // which is letters 99.7% of the time and so failed profiles_phone_format.
      expect(row).toBe('<null>');
    });
  });

  it('stores the name, marks the account active and records the address', async () => {
    await provisioned({ full_name: 'Ada Lovelace' }, async (userId, email) => {
      const row = await sql(
        `select full_name || '|' || status || '|' || coalesce(email, '<null>') || '|' ||
                (phone_verified_at is null)::text
           from public.profiles where id = '${userId}';`
      );

      expect(row).toBe(`Ada Lovelace|active|${email}|true`);
    });
  });

  it('gives a customers row to a customer', async () => {
    await provisioned({ full_name: 'Buyer', role: 'customer' }, async (userId) => {
      const row = await sql(
        `select count(*) from public.customers where profile_id = '${userId}';`
      );
      expect(row).toBe('1');
    });
  });

  it('does not give a professional a customers row', async () => {
    await provisioned({ full_name: 'Fixer', role: 'professional' }, async (userId) => {
      const role = await sql(`select role from public.profiles where id = '${userId}';`);
      const rows = await sql(
        `select count(*) from public.customers where profile_id = '${userId}';`
      );

      expect(role).toBe('professional');
      expect(rows).toBe('0');
    });
  });

  it('will not let a signup grant itself a staff role', async () => {
    for (const claimed of ['admin', 'support', 'ops', 'super_admin']) {
      await provisioned({ full_name: 'Aspirant', role: claimed }, async (userId) => {
        const role = await sql(`select role from public.profiles where id = '${userId}';`);

        // Only 'customer' and 'professional' may be self-assigned; anything
        // else falls back to customer, so a signup cannot mint itself access.
        expect(role).toBe('customer');
      });
    }
  });

  it('does not take over a phone number that already belongs to someone', async () => {
    // demo.pro holds +919000000002. A signup claiming it must be refused
    // rather than re-pointed at the account that already exists.
    const before = await sql(
      `select count(*) from public.profiles where phone = '+919000000002';`
    );

    await provisioned({ full_name: 'Impostor', phone: '+919000000002' }, async (userId) => {
      const rows = await sql(`select count(*) from public.profiles where id = '${userId}';`);

      // No profile at all: the trigger returns early rather than provisioning a
      // second account onto an identity that is already in use.
      expect(rows).toBe('0');
    });

    const after = await sql(
      `select count(*) from public.profiles where phone = '+919000000002';`
    );
    expect(after).toBe(before);
  });

  it('keeps two phone-less accounts distinct, since NULL is not a shared phone', async () => {
    // uniq_profiles_phone cannot use a plain unique index to stop one person
    // claiming another's number when the number is absent, so this is the
    // assertion that the nullable column did not quietly become a shared
    // sentinel value.
    const first = await createUserWithRetry({
      email: freshEmail('dup'),
      password: 'Provision-Me-2026',
      email_confirm: true,
    });
    const second = await createUserWithRetry({
      email: freshEmail('dup'),
      password: 'Provision-Me-2026',
      email_confirm: true,
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    try {
      const bothNull = await sql(
        `select count(*) from public.profiles
          where id in ('${first.data.user!.id}', '${second.data.user!.id}')
            and phone is null;`
      );
      expect(bothNull).toBe('2');
    } finally {
      await adminClient().auth.admin.deleteUser(first.data.user!.id);
      await adminClient().auth.admin.deleteUser(second.data.user!.id);
    }
  });
  },
  60_000
);
