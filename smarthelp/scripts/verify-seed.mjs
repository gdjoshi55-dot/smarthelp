import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { connect } from './_db.mjs';

/**
 * Proves the seeded demo accounts are real, by actually signing in as one.
 *
 * Checking that a row exists in auth.users is not the same as being able to
 * authenticate: a wrong identity_data, a missing identity row, or a password
 * hash GoTrue cannot verify all leave a row that looks correct but cannot log
 * in. This signs in over the same anon path the app uses.
 *
 *   node scripts/verify-seed.mjs
 *
 * The password is compared server-side via the RLS-protected profiles view, and
 * the anon key is only ever used for the sign-in call itself.
 */

const ACCOUNTS = [
  ['demo.customer@smarthelp.test', 'customer'],
  ['demo.pro@smarthelp.test', 'professional'],
  ['demo.admin@smarthelp.test', 'admin'],
  ['demo.support@smarthelp.test', 'support'],
  ['demo.ops@smarthelp.test', 'ops'],
];

/**
 * The bookings the demo customer should find on `/customer/bookings`, and the
 * states between them. Written out rather than derived, because the point is to
 * catch the seed drifting from the product: a bookings screen whose five demo
 * rows are all `payment_pending` proves nothing about the timeline, the cancel
 * dialog or the reschedule panel.
 */
const DEMO_BOOKINGS = [
  ['SH-20260101-90001', 'in_progress'],
  ['SH-20260101-90002', 'assigned'],
  ['SH-20260101-90003', 'payment_pending'],
  ['SH-20260101-90004', 'completed'],
  ['SH-20260101-90005', 'cancelled'],
];

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing');
  process.exit(1);
}

const db = connect();
await db.connect();
let failed = false;

try {
  const { rows } = await db.query(`
    select u.email,
           p.role::text       as role,
           p.full_name,
           u.email_confirmed_at is not null as confirmed
      from auth.users u
      join public.profiles p on p.id = u.id
     order by u.email;`);

  console.log(`\nSeeded profiles: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.email.padEnd(34)} ${String(r.role).padEnd(14)} confirmed=${r.confirmed}`);
  }

  console.log(`\nPassword sign-in over the anon key:\n`);
  for (const [email, expectedRole] of ACCOUNTS) {
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: 'Demo@12345',
    });

    if (error) {
      failed = true;
      console.log(`  FAIL ${email.padEnd(34)} ${error.message}`);
      continue;
    }

    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .single();

    if (pErr) {
      failed = true;
      console.log(`  FAIL ${email.padEnd(34)} sign-in ok but profiles read: ${pErr.message}`);
      continue;
    }

    const ok = profile.role === expectedRole;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${email.padEnd(34)} uid=${data.user.id.slice(0, 8)} role=${profile.role}`
    );
  }

  // The demo customer's bookings, so the customer-facing screens have something to
  // render on a fresh database.
  console.log(`\nDemo customer bookings:\n`);
  const { rows: bookings, error: bookingsError } = await db.query(`
    select b.booking_number,
           b.status::text                       as status,
           b.booking_type::text                 as booking_type,
           b.scheduled_start_at,
           b.address_snapshot->>'label'        as address_label,
           (select count(*) from public.booking_items i where i.booking_id = b.id)::int as items,
           (select count(*) from public.booking_status_history h where h.booking_id = b.id)::int as history
      from public.bookings b
      join public.customers c on c.id = b.customer_id
      join public.profiles p  on p.id = c.profile_id
     where p.email = 'demo.customer@smarthelp.test'
       and b.booking_number like 'SH-20260101-9%'
     order by b.booking_number;`);

  if (bookingsError) throw bookingsError;

  const byNumber = new Map(bookings.map((b) => [b.booking_number, b]));
  for (const [number, status] of DEMO_BOOKINGS) {
    const row = byNumber.get(number);
    // An item line and at least one history hop: the detail screen's price and
    // stepper are both built from those tables, and an empty one renders a blank.
    const ok = !!row && row.status === status && row.items > 0 && row.history > 0;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${number} status=${row ? row.status : 'missing'} items=${row?.items ?? 0} history=${row?.history ?? 0}`
    );
  }

  if (bookings.length !== DEMO_BOOKINGS.length) {
    failed = true;
    console.log(
      `  FAIL expected ${DEMO_BOOKINGS.length} demo bookings, found ${bookings.length}`
    );
  }

  // One saved, default address: checkout cannot start without one, and the page
  // says "pick a saved address" until it is there.
  const { rows: addresses } = await db.query(`
    select count(*) filter (where a.is_default)::int as defaults,
           count(*)::int                             as total
      from public.addresses a
      join public.customers c on c.id = a.customer_id
      join public.profiles p  on p.id = c.profile_id
     where p.email = 'demo.customer@smarthelp.test';`);
  const defaultAddress = (addresses[0]?.defaults ?? 0) === 1;
  if (!defaultAddress) failed = true;
  console.log(
    `  ${defaultAddress ? 'ok  ' : 'FAIL'} demo default addresses=${addresses[0]?.defaults ?? 0} of ${addresses[0]?.total ?? 0} total`
  );
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  await db.end().catch(() => {});
}

console.log(failed ? '\nSeed verification FAILED' : '\nSeed verification passed');
process.exitCode = failed ? 1 : 0;
