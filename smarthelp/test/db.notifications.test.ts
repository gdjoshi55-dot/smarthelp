import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql, sqlAsRole } from './helpers/dbEnv';

/**
 * Phase 7 at the database (§24.11, §27.1, §27.4, §31.1).
 *
 * The route tests prove the handlers take the right branch and the dispatcher
 * takes the right decision, but none of them can answer the two questions that
 * only Postgres resolves:
 *
 *   1. **Does Realtime have anything to broadcast?** The channels are only as
 *      good as the publication membership — a table absent from
 *      `supabase_realtime` silently delivers nothing, and every mock in the
 *      suite would stay green.
 *   2. **Can the wrong person read a row?** `notifications` and `chat_messages`
 *      carry a person's private traffic; RLS is the backstop under the service
 *      role, and `sqlAsRole` is the only way to actually exercise it.
 *
 * Plus the Phase 7 functions: `run_service_reminders` / `run_rating_reminders`
 * must exist, be `security definer`, and be callable by the service role alone.
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn(
    '\n[db] Skipping the Phase 7 database tests — no SUPABASE_DB_URL in the environment\n' +
      '     or in .env.local. Realtime publication membership, notification RLS and the\n' +
      '     reminder functions are NOT covered by this run.\n'
  );
}

afterAll(closeDb);

/**
 * The id of a seeded profile, borrowed as an actor. `profiles.id` is the auth
 * user's id with no default, so a test cannot invent a profile; it borrows one
 * the seed already made and leaves it as it found it.
 */
async function seededProfileId(email: string): Promise<string> {
  const id = await sql(`select id from public.profiles where id in
      (select id from auth.users where email = '${email}');`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`no seeded profile for ${email} — run "npm run db:seed" first`);
  }
  return id;
}

/** The five tables 0038 creates, which the code imports. */
const PHASE7_TABLES = [
  'chat_threads',
  'chat_messages',
  'notification_templates',
  'notifications',
  'notification_devices',
];

/** The six tables 0039 puts on the `supabase_realtime` publication (§27.1). */
const PUBLISHED_TABLES = [
  'bookings',
  'booking_assignments',
  'chat_messages',
  'notifications',
  'professional_earnings',
  'support_messages',
];

describeDb('database: the Phase 7 tables are there and protected', () => {
  it('created the five tables the code imports', async () => {
    const missing = await sql(
      `select coalesce(string_agg(t, ', '), '') from unnest(array[${PHASE7_TABLES.map(
        (t) => `'${t}'`
      ).join(',')}]) as t
        where not exists (
          select 1 from information_schema.tables
           where table_schema = 'public' and table_name = t
        );`
    );
    expect(missing, `missing tables: ${missing}`).toBe('');
  });

  it('enables RLS on every one of them', async () => {
    const unprotected = await sql(
      `select coalesce(string_agg(c.relname, ', '), '')
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (${PHASE7_TABLES.map((t) => `'${t}'`).join(',')})
          and c.relrowsecurity = false;`
    );
    expect(unprotected, `tables without RLS: ${unprotected}`).toBe('');
  });

  it('has each published table in the supabase_realtime publication (§27.1)', async () => {
    const present = await sql(
      `select count(*) from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
          and tablename in (${PUBLISHED_TABLES.map((t) => `'${t}'`).join(',')});`
    );
    // Every source table §27.1 names is on the publication, so a
    // `postgres_changes` subscription to any of the channels can actually fire.
    expect(Number(present)).toBe(PUBLISHED_TABLES.length);
  });
});

describeDb('database: who may read a notification', () => {
  it('lets the recipient read their own row and nobody else', async () => {
    const customer = await seededProfileId('demo.customer@smarthelp.test');
    const other = await seededProfileId('demo.pro@smarthelp.test');

    const marker = `__test_notif_${Date.now()}`;
    const inserted = await sql(
      `insert into public.notifications (recipient_id, channel, template_code, title, body, status)
       values ('${customer}', 'in_app', '${marker}', 'hello', 'world', 'sent')
       returning id;`
    );
    expect(inserted).toMatch(/^[0-9a-f-]{36}$/i);

    try {
      const own = await sqlAsRole(
        customer,
        `select count(*) from public.notifications where id = '${inserted}';`
      );
      expect(Number(own)).toBe(1);

      const stranger = await sqlAsRole(
        other,
        `select count(*) from public.notifications where id = '${inserted}';`
      );
      expect(Number(stranger)).toBe(0);
    } finally {
      await sql(`delete from public.notifications where id = '${inserted}';`);
    }
  });

  it('gives authenticated the read grant but not the write grant', async () => {
    const grants = (
      await sql(
        `select privilege_type from information_schema.role_table_grants
          where grantee = 'authenticated' and table_schema = 'public'
            and table_name = 'notifications'
          order by privilege_type;`
      )
    )
      .split('\n')
      .filter(Boolean);
    expect(grants).toEqual(['SELECT']);
  });

  it('gives anon nothing on the Phase 7 tables', async () => {
    const grants = await sql(
      `select count(*) from information_schema.role_table_grants
        where grantee = 'anon' and table_schema = 'public'
          and table_name in (${PHASE7_TABLES.map((t) => `'${t}'`).join(',')});`
    );
    expect(Number(grants)).toBe(0);
  });

  it('refuses an authenticated write to a notification, which is service-role only', async () => {
    const customer = await seededProfileId('demo.customer@smarthelp.test');
    await expect(
      sqlAsRole(
        customer,
        `insert into public.notifications (recipient_id, channel, template_code)
         values ('${customer}', 'in_app', '__test_denied__');`
      )
    ).rejects.toThrow();
  });
});

describeDb('database: the reminder functions', () => {
  it('defines both and both are security definer', async () => {
    const notDefiner = await sql(
      `select coalesce(string_agg(p.proname, ', '), '')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('run_service_reminders', 'run_rating_reminders')
          and not p.prosecdef;`
    );
    expect(notDefiner, `not security definer: ${notDefiner}`).toBe('');

    const count = await sql(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('run_service_reminders', 'run_rating_reminders');`
    );
    expect(Number(count)).toBe(2);
  });

  it('is executable by the service role and by no client role', async () => {
    const service = await sql(
      `select has_function_privilege('service_role', 'public.run_service_reminders()', 'execute')::text;`
    );
    expect(service).toBe('true');

    const authenticated = await sql(
      `select has_function_privilege('authenticated', 'public.run_service_reminders()', 'execute')::text;`
    );
    expect(authenticated).toBe('false');

    const anon = await sql(
      `select has_function_privilege('anon', 'public.run_rating_reminders()', 'execute')::text;`
    );
    expect(anon).toBe('false');
  });

  it('runs a clean pass and returns a numeric count', async () => {
    // The pass reads the live bookings and writes reminders for anyone due;
    // what this asserts is that the function compiles, holds its lock and
    // returns the documented `{sent:n}` shape — not a particular number.
    const result = await sql(`select public.run_rating_reminders()::text;`);
    expect(result).toMatch(/^\{"sent":\s*\d+\}$/);

    const service = await sql(`select public.run_service_reminders()::text;`);
    expect(service).toMatch(/^\{"sent":\s*\d+\}$/);
  });

  it('refuses an authenticated caller of the reminder pass', async () => {
    const customer = await seededProfileId('demo.customer@smarthelp.test');
    await expect(
      sqlAsRole(customer, `select public.run_service_reminders();`)
    ).rejects.toThrow();
  });
});

describeDb('database: the seeded catalogue', () => {
  it('seeds templates, and none of them is an in_app row', async () => {
    const total = Number(await sql(`select count(*) from public.notification_templates;`));
    expect(total).toBeGreaterThan(0);

    // in_app and push share the push template at dispatch time, so seeding an
    // in_app row would be a second, drifting copy of the same copy.
    const inApp = Number(
      await sql(`select count(*) from public.notification_templates where channel = 'in_app';`)
    );
    expect(inApp).toBe(0);
  });

  it('covers the three reminder codes the crons dispatch', async () => {
    for (const code of ['SERVICE_ENDING_SOON', 'NEW_JOB_REMINDER', 'RATING_REMINDER']) {
      const present = Number(
        await sql(`select count(*) from public.notification_templates where code = '${code}';`)
      );
      expect(present, code).toBeGreaterThan(0);
    }
  });
});
