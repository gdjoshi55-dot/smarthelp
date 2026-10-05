-- ============================================================
-- seed.sql — SmartHelp demo accounts and a bookable marketplace.
--
-- Run AFTER supabase/migrations/*.sql, in the Supabase SQL editor or
-- via `supabase db reset`. Idempotent: re-running refreshes the demo
-- passwords and tops the catalogue back up; it never duplicates a row.
--
-- This file creates FOUR auth.users so that "login works for all three
-- role types" (§31.1 Phase 0 exit criteria) is verifiable without a
-- phone provider. Real customers and professionals authenticate by phone
-- OTP; demo accounts get an email + password so the flow is testable
-- on a laptop.
--
--   Role          Login                          Password
--   ------------  -----------------------------  -------------------------
--   customer      demo.customer@smarthelp.test  Demo@12345
--   professional  demo.pro@smarthelp.test        Demo@12345
--   admin         demo.admin@smarthelp.test      Demo@12345
--   support       demo.support@smarthelp.test    Demo@12345
--   ops           demo.ops@smarthelp.test        Demo@12345
--
-- The super_admin (owner) account is NOT seeded: it is created by
-- signing in with the login named in NEXT_PUBLIC_SUPARTHELP_OWNER_LOGIN,
-- which the auth route promotes to super_admin. See docs/SETUP.md.
--
-- !! NOT FOR PRODUCTION. Delete this file before the first real launch.
-- ============================================================

-- `extensions` is where Supabase keeps pgcrypto, which provides crypt() and
-- gen_salt() for the demo passwords. A search_path of `public` alone fails with
-- "function gen_salt(unknown) does not exist". On a plain Postgres where
-- pgcrypto was created into public, naming a schema that does not exist is
-- harmless, so this works in both places.
set search_path = public, extensions;

-- ── Helper: create or refresh one demo auth user ────────────
create or replace function public.seed_demo_user(
  p_email text,
  p_password text,
  p_full_name text,
  p_phone text,
  p_role public.user_role
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid := gen_random_uuid();
  v_existing uuid;
begin
  select id into v_existing from auth.users where email = lower(p_email);
  if v_existing is not null then
    v_id := v_existing;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token,
    email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    lower(p_email), crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role', p_role::text, 'full_name', p_full_name, 'phone', p_phone),
    now(), now(), '', '', '', ''
  )
  on conflict (id) do update
    set encrypted_password = crypt(p_password, gen_salt('bf')),
        email_confirmed_at = now(),
        raw_user_meta_data = jsonb_build_object(
          'role', p_role::text, 'full_name', p_full_name, 'phone', p_phone
        ),
        updated_at = now();

  -- GoTrue requires an identity row for a password sign-in to resolve.
  --
  -- The column list is checked against the project's own auth.identities rather
  -- than documentation: this version has no email_confirmed_at here (it lives on
  -- auth.users only), and naming a column that does not exist is
  -- "column \"email_confirmed_at\" of relation \"identities\" does not exist".
  --
  -- `email` is deliberately absent: it is a stored generated column computed
  -- from identity_data, so writing it is
  -- 'cannot insert a non-DEFAULT value into column "email"'. The address goes
  -- in identity_data and the generated column follows.
  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    v_id, v_id::text, v_id,
    jsonb_build_object('sub', v_id::text, 'email', lower(p_email),
                       'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do nothing;

  return v_id;
end $$;

-- ── The five staff / consumer demo accounts ────────────────
select public.seed_demo_user('demo.customer@smarthelp.test', 'Demo@12345',
  'Ananya Iyer', '+919000000001', 'customer');
select public.seed_demo_user('demo.pro@smarthelp.test', 'Demo@12345',
  'Ravi Kumar', '+919000000002', 'professional');
select public.seed_demo_user('demo.admin@smarthelp.test', 'Demo@12345',
  'Deepa Menon', '+919000000003', 'admin');
select public.seed_demo_user('demo.support@smarthelp.test', 'Demo@12345',
  'Sameer Rao', '+919000000004', 'support');
select public.seed_demo_user('demo.ops@smarthelp.test', 'Demo@12345',
  'Farida Sheikh', '+919000000005', 'ops');

-- The handle_new_user() trigger creates the profile, and a `customers`
-- row for a customer. Two accounts it deliberately does not create are
-- created here, because both are staff grants rather than sign-ups.

-- Staff roles, assigned explicitly. handle_new_user() refuses to grant
-- these on sign-up; this file runs as a trusted local session.
update public.profiles set role = 'admin'
 where email = 'demo.admin@smarthelp.test';
update public.profiles set role = 'support'
 where email = 'demo.support@smarthelp.test';
update public.profiles set role = 'ops'
 where email = 'demo.ops@smarthelp.test';

-- Backfill anything the trigger missed (e.g. auth users created before 0001).
select public.backfill_profiles();

-- A verified, available, skilled professional — the Phase 0 exit criterion
-- "a professional exists in the DB", in a state the matching engine can use.
insert into public.professionals (
  profile_id, employee_code, verification_status, training_status,
  availability_status, is_available_today, current_lat, current_lng,
  location_updated_at, service_radius_km, commission_pct,
  rating, rating_count, total_offers, accepted_offers, completed_jobs,
  experience_months, kyc_verified_at, onboarded_at
)
select p.id, 'SH-DEMO-001', 'verified', 'completed', 'online', true,
       12.978400, 77.640800, now(), 12.00, 0.2000,
       4.80, 47, 60, 51, 44, 38, now(), now()
from public.profiles p
where p.email = 'demo.pro@smarthelp.test'
on conflict (profile_id) do update
  set verification_status  = 'verified',
      training_status     = 'completed',
      availability_status = 'online',
      is_available_today  = true,
      current_lat         = excluded.current_lat,
      current_lng         = excluded.current_lng,
      location_updated_at = now(),
      kyc_verified_at     = now(),
      onboarded_at        = now();

-- Skills: cleaning and kitchen, so he is a candidate for the seeded
-- categories without being a candidate for everything.
insert into public.professional_skills (professional_id, service_id, proficiency, verified_at)
select pr.id, s.id,
       case when cat.slug in ('cleaning','kitchen') then 5 else 3 end,
       now()
from public.professionals pr
join public.profiles p      on p.id = pr.profile_id
join public.services s      on true
join public.service_categories cat on cat.id = s.category_id
where p.email = 'demo.pro@smarthelp.test'
on conflict (professional_id, service_id) do update
  set proficiency = excluded.proficiency,
      verified_at = now();

-- Working hours, 09:00-19:00 every day (0 = Sunday), and a live location
-- so availability has something to work with in Phase 1.
insert into public.professional_working_hours
  (professional_id, weekday, start_time, end_time)
select pr.id, d, '09:00', '19:00'
from public.professionals pr
join public.profiles p on p.id = pr.profile_id
cross join generate_series(0, 6) as d
where p.email = 'demo.pro@smarthelp.test'
on conflict (professional_id, weekday, start_time) do nothing;

-- A verified KYC document set, so the Phase 4 review screen has a subject.
insert into public.professional_documents (professional_id, doc_type, file_path, status)
select pr.id, v.doc_type, v.doc_type || '/demo-document.pdf', 'verified'
from public.professionals pr
join public.profiles p on p.id = pr.profile_id
cross join (values
  ('aadhaar_front'), ('aadhaar_back'), ('pan'), ('selfie'), ('address_proof')
) as v(doc_type)
where p.email = 'demo.pro@smarthelp.test'
on conflict (professional_id, doc_type) do update
  set status = 'verified',
      reviewed_at = now();

-- Addresses belong to Phase 1 (0008_addresses.sql), so this seed stops
-- at the catalogue and the professional pool.

-- ── A saved address for the demo customer ────────────────────
-- The Phase 2 checkout writes `bookings.address_id` and freezes
-- `address_snapshot` from this row, so without one the customer
-- cannot book at all and the new screens have nothing to show.
-- Indiranagar, because the seeded professional works 09:00-19:00
-- and `service_areas` covers the Bengaluru localities.
insert into public.addresses
  (customer_id, locality_id, label, address_type, line1, area, city,
   state, pincode, lat, lng, location_precision, is_default)
select c.id,
       (select l.id from public.localities l
         join public.cities ci on ci.id = l.city_id
        where lower(l.name) = 'indiranagar' and ci.is_active
        limit 1),
       'Home', 'home', '42, 5th Main', 'Indiranagar', 'Bengaluru',
       'Karnataka', '560038', 12.97194, 77.64120, 'exact', true
  from public.customers c
  join public.profiles p on p.id = c.profile_id
 where p.email = 'demo.customer@smarthelp.test'
-- `uniq_default_address` is a partial unique index on (customer_id) where
-- is_default, so this is the clause that has to name exactly that.
on conflict (customer_id) where is_default do nothing;

-- ── Two bookings in flight, so the customer screens have a subject ──
--
-- Inserted directly rather than through the API, for three reasons:
-- the state machine's trigger guards UPDATEs, not inserts, so a row can be
-- born `assigned`/`in_progress` without walking it through the ladder; the
-- history rows below give the stepper something to show; and re-running the
-- seed must not duplicate them, which the fixed `booking_number` makes safe.
--
-- The money columns are written literally rather than derived. A seeded row is
-- a screenshot of a past quote, not a live one — and `pricing_snapshot` is what
-- the receipt renders, so it carries the same figures rather than inviting a
-- reader to add them up from the catalogue.
with seeded as (
  select c.id as customer_id,
         pr.id as professional_id,
         a.id as address_id,
         a.locality_id,
         s.id as service_id,
         s.name as service_name,
         s.base_price,
         p.id as customer_profile_id
    from public.profiles p
    join public.customers c     on c.profile_id = p.id
    join public.addresses a     on a.customer_id = c.id and a.is_default
    join public.profiles pp     on pp.email = 'demo.pro@smarthelp.test'
    join public.professionals pr on pr.profile_id = pp.id
    join public.services s      on s.is_active
   where p.email = 'demo.customer@smarthelp.test'
   limit 1
), rows_to_seed (booking_number, status, hours_from_now, professional_assigned, start_offset_minutes) as (
  values
    ('SH-20260101-90001', 'in_progress', 0,    true,  0),
    ('SH-20260101-90002', 'assigned',    26,   true,  120),
    ('SH-20260101-90003', 'payment_pending', 50, false, 240),
    ('SH-20260101-90004', 'completed',   -170, true, -180),
    ('SH-20260101-90005', 'cancelled',   -300, true, -300)
)
insert into public.bookings
  (booking_number, customer_id, professional_id, address_id, address_snapshot,
   locality_id, booking_type, status, version, duration_minutes,
   scheduled_start_at, scheduled_end_at,
   subtotal, platform_fee, discount, discount_code, tax, tax_rate,
   total_amount, professional_gross, commission_pct, currency,
   pricing_snapshot, arrived_at, completed_at, closed_at, cancelled_at,
   cancellation_reason_code, cancellation_fee)
select r.booking_number,
       s.customer_id,
       case when r.professional_assigned then s.professional_id else null end,
       s.address_id,
       (select jsonb_build_object(
                'address_type', a.address_type, 'label', a.label, 'line1', a.line1,
                'area', a.area, 'city', a.city, 'state', a.state, 'pincode', a.pincode,
                'lat', a.lat, 'lng', a.lng, 'location_precision', a.location_precision,
                'frozen_at', now())
          from public.addresses a where a.id = s.address_id),
       s.locality_id,
       'scheduled',
       r.status::public.booking_status,
       1,
       60,
       now() + make_interval(hours => r.hours_from_now),
       now() + make_interval(hours => r.hours_from_now) + interval '60 minutes',
       s.base_price,
       20,
       0,
       null,
       round((s.base_price + 20) * 0.18, 2),
       0.18,
       round((s.base_price + 20) * 1.18, 2),
       round(s.base_price * 0.8, 2),
       0.2,
       'INR',
       jsonb_build_object('engineVersion', 1, 'seeded', true, 'totals',
                          jsonb_build_object('subtotal', s.base_price::text,
                                             'platformFee', '20.00',
                                             'discount', '0.00',
                                             'tax', round((s.base_price + 20) * 0.18, 2)::text,
                                             'total', round((s.base_price + 20) * 1.18, 2)::text)),
       case when r.status in ('in_progress', 'completed') then now() - interval '10 minutes' end,
       case when r.status = 'completed' then now() - interval '20 minutes' end,
       case when r.status = 'completed' then now() end,
       case when r.status = 'cancelled' then now() - interval '5 days' end,
       case when r.status = 'cancelled' then 'changed_mind' end,
       -- NOT NULL, and a non-cancelled booking has a zero fee rather than a
       -- missing one: `cancellation_fee` is what the refund arithmetic reads,
       -- and null would have to be special-cased at every reader.
       0
  from seeded s
  cross join rows_to_seed r
on conflict (booking_number) do nothing;

-- One item line per seeded booking, from the same service. `booking_items`
-- has no natural key, so the whole block is deleted and rebuilt — these are
-- demo rows, and a duplicate line on a re-run is worse than a rebuild.
delete from public.booking_items
 where booking_id in (select id from public.bookings where booking_number like 'SH-20260101-9%');

insert into public.booking_items
  (booking_id, service_id, service_name, duration_minutes, unit_price, quantity, line_total)
select b.id, s.id, s.name, b.duration_minutes, s.base_price, 1, s.base_price
  from public.bookings b
  join public.services s
    on s.is_active
   and s.id = (select id from public.services where is_active order by sort_order limit 1)
 where b.booking_number like 'SH-20260101-9%';

-- The status history the stepper renders. `booking_status_history` is
-- append-only (0011), so re-running replaces rather than appends.
delete from public.booking_status_history
 where booking_id in (select id from public.bookings where booking_number like 'SH-20260101-9%');

insert into public.booking_status_history (booking_id, from_status, to_status, actor_role, note)
select b.id, null::public.booking_status, 'payment_pending'::public.booking_status, 'customer'::public.user_role, 'Seeded demo booking'
  from public.bookings b where b.booking_number like 'SH-20260101-9%'
union all
select b.id, 'payment_pending'::public.booking_status, 'assigned'::public.booking_status, 'ops'::public.user_role, 'Assigned to the demo professional'
  from public.bookings b where b.booking_number like 'SH-20260101-9%' and b.status in ('assigned','in_progress','completed')
union all
select b.id, 'assigned'::public.booking_status, 'in_progress'::public.booking_status, 'professional'::public.user_role, null
  from public.bookings b where b.booking_number like 'SH-20260101-9%' and b.status in ('in_progress','completed')
union all
select b.id, 'in_progress'::public.booking_status, 'completed'::public.booking_status, 'professional'::public.user_role, null
  from public.bookings b where b.booking_number = 'SH-20260101-90004'
union all
select b.id, 'payment_pending'::public.booking_status, 'cancelled'::public.booking_status, 'customer'::public.user_role, 'changed_mind'
  from public.bookings b where b.booking_number = 'SH-20260101-90005';

-- ── Clean up ───────────────────────────────────────────────
-- The helper is scaffolding, not a product function.
drop function if exists public.seed_demo_user(text, text, text, text, public.user_role);
