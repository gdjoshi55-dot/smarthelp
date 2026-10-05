-- ============================================================
-- SmartHelp full database schema for a fresh Supabase project.
--
-- GENERATED FILE - do not edit by hand.
-- Rebuild with: npm run db:schema
-- Source: supabase/migrations/*.sql, concatenated in filename order.
--
-- Run this in the Supabase SQL editor (SQL > New query). Every statement is
-- idempotent, so it is safe to re-run on a live project.
--
-- Then apply supabase/seed.sql for the demo accounts and a bookable
-- marketplace. Seed data is separate on purpose: schema.sql is the shape of
-- the system, seed.sql is sample content.
--
-- Phase 0 of the delivery plan (§31.1) covers migrations 0000-0007.
-- Phases 1-9 append 0008-0028; re-run `npm run db:schema` after each.
-- ============================================================


-- ------------------------------------------------------------
-- 0000_storage_buckets.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0000_storage_buckets.sql
-- SmartHelp: the six Storage buckets, created before anything
-- else so Phase 0 can verify them in the Supabase dashboard.
--
-- Numbering note: the specification fixes the migration series
-- 0001-0028. This file sorts first because the bucket rows are
-- entirely self-contained and Phase 0 requires the buckets to
-- exist. It renumbers nothing.
--
-- The bucket *policies* are not here. They call public.is_admin()
-- (defined in 0001) and public.current_professional_id() (defined
-- in 0005), so a policy created before those would not resolve —
-- `create policy` does not defer its check to call time. They live
-- in 0025_storage_policies.sql, which sorts after both.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.15, §27
-- ============================================================

-- ── Buckets ─────────────────────────────────────────────────
-- Public buckets: catalogue art and professional photos are served
-- straight from a CDN URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('service-media',  'service-media',  true,  5242880,
   array['image/jpeg','image/png','image/webp','image/avif','image/svg+xml']),
  ('pro-photos',     'pro-photos',     true,  5242880,
   array['image/jpeg','image/png','image/webp']),
  ('kyc-documents',  'kyc-documents',  false, 5242880,
   array['image/jpeg','image/png','image/webp','application/pdf']),
  ('chat-media',     'chat-media',     false, 2097152,
   array['image/jpeg','image/png','image/webp']),
  ('support-media',  'support-media',  false, 2097152,
   array['image/jpeg','image/png','image/webp','application/pdf']),
  ('invoices',       'invoices',       false, 10485760,
   array['application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── chat-media, support-media, invoices: private, no client
--    policies at all. Service role only until the phase that owns
--    them writes participant-scoped policies:
--      chat-media     -> 0019 / 0020_chat_notifications.sql
--      support-media  -> 0019_support.sql
--      invoices       -> 0012 / 0021 (Phase 3 payments)
--    A bucket with no policy is unreadable through the client API,
--    which is the correct default for every one of these.


-- ------------------------------------------------------------
-- 0001_core_identity.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0001_core_identity.sql
-- SmartHelp: profiles, customers, roles, and the RLS helper
-- predicates every later policy depends on.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: SmartHelp-Documentation.docx §24.2, §24.14, §3.1, §26.1
-- ============================================================

create extension if not exists pgcrypto;

-- ── Enums ───────────────────────────────────────────────────
do $$ begin
  create type user_role as enum (
    'customer',     -- books and pays for services
    'professional', -- performs services
    'admin',        -- full platform control
    'support',      -- tickets only, no pricing / KYC write access
    'ops',          -- bookings, assignment, refunds, disputes
    'super_admin'   -- owner account; only one, bootstrapped via env allow-list
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status as enum (
    'active', 'suspended', 'blocked', 'deleted', 'pending_verification'
  );
exception when duplicate_object then null; end $$;

-- ── updated_at maintenance ──────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── profiles ────────────────────────────────────────────────
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  role              user_role   not null default 'customer',
  status            user_status not null default 'active',
  full_name         text        not null,
  phone             text        not null,
  phone_verified_at timestamptz,
  email             text,
  avatar_url        text,
  locale            text        not null default 'en-IN',
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint profiles_phone_format check (phone ~ '^\+?[0-9]{10,15}$')
);

-- A phone number identifies exactly one human across the whole platform.
create unique index if not exists uniq_profiles_phone on public.profiles (phone);
create unique index if not exists uniq_profiles_email on public.profiles (lower(email)) where email is not null;
create index if not exists idx_profiles_role_status on public.profiles (role, status);

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── customers ───────────────────────────────────────────────
create table if not exists public.customers (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid not null unique references public.profiles(id) on delete cascade,
  referral_code      text not null unique,
  referred_by        uuid references public.customers(id) on delete set null,
  wallet_id          uuid, -- FK added in 0015_refunds_wallet.sql
  total_bookings     int not null default 0,
  completed_bookings int not null default 0,
  lifetime_value     numeric(12,2) not null default 0,
  cancelled_bookings int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_customers_referral on public.customers (referral_code);
create unique index if not exists uniq_customers_referral_per_profile
  on public.customers (referral_code, profile_id);

drop trigger if exists trg_customers_touch on public.customers;
create trigger trg_customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

-- ── RLS helper predicates ───────────────────────────────────
-- SECURITY DEFINER so they do not recurse through the RLS policies
-- of the very tables they read. Owned by postgres, which has BYPASSRLS.
create or replace function public.current_role() returns public.user_role
language sql security definer stable set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'active'
$$;

create or replace function public.current_status() returns public.user_status
language sql security definer stable set search_path = public as $$
  select status from public.profiles where id = auth.uid()
$$;

create or replace function public.is_staff(p_roles public.user_role[]) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active' and role = any (p_roles)
  )
$$;

create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select public.is_staff(array['admin','super_admin']::public.user_role[])
$$;

create or replace function public.is_ops() returns boolean
language sql security definer stable set search_path = public as $$
  select public.is_staff(
    array['admin','super_admin','ops','support']::public.user_role[]
  )
$$;

-- The caller's own customer row, or null.
create or replace function public.current_customer_id() returns uuid
language sql security definer stable set search_path = public as $$
  select id from public.customers where profile_id = auth.uid()
$$;

-- public.current_professional_id() is defined in 0005, where `professionals` exists.

-- ── Referral codes ──────────────────────────────────────────
-- Human-friendly, collision-checked, derived from the profile id.
create or replace function public.generate_referral_code(p_profile_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
begin
  for i in 1..24 loop
    candidate := upper(substr(md5(random()::text || p_profile_id::text), 1, 6));
    candidate := translate(candidate, '0123456789', '23456789AB');
    candidate := regexp_replace(candidate, '[^A-Z0-9]', '', 'g');
    if not exists (select 1 from public.customers where referral_code = candidate) then
      return candidate;
    end if;
  end loop;
  raise exception 'REFERRAL_CODE_EXHAUSTED';
end $$;

-- ── Role and status integrity ───────────────────────────────
-- True for a direct SQL session: the Supabase SQL editor, `psql`, or a
-- migration run. PostgREST always sets the claim — 'anon' with no auth
-- header — so this can only ever be true with no user attached, and a
-- session that reaches the database directly already has full table
-- access. The privilege guards below use it to let migrations and the
-- seed script do their job while still refusing every browser request.
create or replace function public.is_trusted_session() returns boolean
language sql stable set search_path = public as $$
  select coalesce(current_setting('request.jwt.claim.role', true), '') = ''
$$;

-- A signed-in user can edit their own profile but must never be able to
-- grant themselves a role, unblock themselves, or re-activate themselves.
-- The service role (Route Handlers) and admins are allowed.
create or replace function public.guard_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.role is distinct from old.role) or (new.status is distinct from old.status) then
    if public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin() then
      return new;
    end if;
    raise exception 'PROFILE_PRIVILEGE_CHANGE_FORBIDDEN'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_guard_privileges on public.profiles;
create trigger trg_profiles_guard_privileges before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ── Auth provisioning ───────────────────────────────────────
-- Creates the profile (and the customer / professional row) for every new
-- auth user. Runs as the auth server, so it is unaffected by RLS.
-- Idempotent, and safe to re-run via public.backfill_profiles().
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  requested_role public.user_role := 'customer';
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  wanted text := coalesce(meta->>'role', 'customer');
  p_full_name text := coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.phone, new.email, 'User'), '@', 1));
  p_phone text;
  p_email text;
begin
  -- Only two roles may ever be self-assigned. Staff roles are granted by an
  -- admin or by the super_admin bootstrap allow-list, never by sign-up.
  if wanted = 'professional' then
    requested_role := 'professional';
  end if;

  p_phone := coalesce(new.phone, meta->>'phone');
  if p_phone is not null and p_phone !~ '^\+?[0-9]{10,15}$' then
    p_phone := null;
  end if;
  p_email := lower(coalesce(new.email, meta->>'email'));

  -- A phone already bound to another profile wins: never hijack an identity.
  if p_phone is not null
     and exists (select 1 from public.profiles where phone = p_phone) then
    return new;
  end if;

  insert into public.profiles (id, role, status, full_name, phone, email, phone_verified_at)
  values (
    new.id,
    requested_role,
    'active',
    left(coalesce(nullif(p_full_name, ''), 'User'), 120),
    coalesce(p_phone, '+' || substr(replace(new.id::text, '-', ''), 1, 12)),
    p_email,
    case when new.phone is not null then new.phone_confirmed_at end
  )
  on conflict (id) do nothing;

  if requested_role = 'customer' then
    insert into public.customers (profile_id, referral_code)
    values (new.id, public.generate_referral_code(new.id))
    on conflict (profile_id) do nothing;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill for projects where auth users predate the trigger.
create or replace function public.backfill_profiles() returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  u record;
begin
  for u in
    select id, phone, email, raw_user_meta_data
    from auth.users
    where id not in (select id from public.profiles)
  loop
    insert into public.profiles (id, role, full_name, phone, email)
    values (
      u.id,
      case when coalesce(u.raw_user_meta_data->>'role','') = 'professional'
           then 'professional'::public.user_role else 'customer'::public.user_role end,
      left(coalesce(nullif(u.raw_user_meta_data->>'full_name',''),
                    split_part(coalesce(u.phone, u.email, 'User'), '@', 1)), 120),
      coalesce(
        case when u.phone ~ '^\+?[0-9]{10,15}$' then u.phone end,
        '+' || substr(replace(u.id::text, '-', ''), 1, 12)
      ),
      lower(u.email)
    )
    on conflict (id) do nothing;
    n := n + 1;
  end loop;

  insert into public.customers (profile_id, referral_code)
  select p.id, public.generate_referral_code(p.id)
  from public.profiles p
  where p.role = 'customer'
    and not exists (select 1 from public.customers c where c.profile_id = p.id)
  on conflict (profile_id) do nothing;

  return n;
end $$;

-- ── OTP requests ───────────────────────────────────────────
-- Placement note: the specification lists `otp_requests` under
-- 0024_audit_idempotency.sql, but Phase 0 requires login to work for
-- all three role types, and the login code is the first consumer of
-- this table. It therefore lives here, in the migration that owns
-- authentication. 0024 does not re-create it.
--
-- Only a salted SHA-256 digest is stored. The plaintext exists in
-- exactly two places: the delivery request, and the response when
-- the delivery channel is a dev inbox.
create table if not exists public.otp_requests (
  id           uuid primary key default gen_random_uuid(),
  target       text not null,       -- E.164 phone, or lowercased email
  channel      text not null check (channel in ('phone','email')),
  purpose      text not null check (purpose in ('login','staff_login','admin_mfa')),
  code_hash    text not null,
  salt         text not null,
  attempts     int not null default 0,
  max_attempts int not null default 3,
  expires_at   timestamptz not null,
  locked_until timestamptz,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_otp_target on public.otp_requests (target, purpose, created_at desc);
create index if not exists idx_otp_open on public.otp_requests (target, purpose)
  where consumed_at is null;

-- Issue a code. Enforces the 60-second resend throttle here rather than in
-- the Route Handler, so two concurrent requests cannot both slip through.
create or replace function public.issue_otp(
  p_target          text,
  p_channel         text,
  p_purpose         text,
  p_code            text,
  p_ttl_minutes     int default 10,
  p_max_attempts    int default 3,
  p_resend_seconds  int default 60,
  p_lockout_minutes int default 15
) returns uuid
-- `extensions` carries pgcrypto, which supplies gen_random_bytes() and digest()
-- below. Supabase installs pgcrypto there rather than in public, so a
-- search_path of public alone fails at run time with
-- 'function gen_random_bytes(integer) does not exist'. Naming a schema that
-- does not exist is harmless on a plain Postgres, so this works in both.
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id    uuid;
  v_salt  text;
begin
  if exists (
    select 1 from public.otp_requests
    where target = p_target and purpose = p_purpose and consumed_at is null
      and created_at > now() - make_interval(secs => p_resend_seconds)
  ) then
    -- The errcode must be a five-character SQLSTATE, not a word: `errcode =
    -- 'rate_limited'` makes the *raise itself* fail with
    -- 'unrecognized exception condition "rate_limited"', so the caller saw an
    -- internal error instead of a throttle and the 60 second window was never
    -- reported. 55000 (object_not_in_prerequisite_state) is the closest real
    -- class. The caller matches on the message, which is why that is the
    -- part that has to stay.
    raise exception 'OTP_THROTTLED' using errcode = '55000';
  end if;

  -- Only the newest unconsumed code for this target/purpose stays live.
  update public.otp_requests
     set consumed_at = now()
   where target = p_target and purpose = p_purpose and consumed_at is null;

  -- One salt, generated once, used for both the stored salt and the hash.
  -- consume_otp() re-derives the hash as digest(p_code || r.salt); hashing
  -- against anything else here would make every code unverifiable.
  v_salt := encode(gen_random_bytes(16), 'hex');

  insert into public.otp_requests (
    target, channel, purpose, code_hash, salt,
    max_attempts, expires_at
  ) values (
    p_target, p_channel, p_purpose,
    encode(digest(p_code || v_salt, 'sha256'), 'hex'),
    v_salt,
    p_max_attempts,
    now() + make_interval(mins => p_ttl_minutes)
  )
  returning id into v_id;

  return v_id;
end $$;

-- Consume a code. Returns 'ok' | 'invalid' | 'expired' | 'locked' | 'missing'.
-- The attempt counter and the consumption happen in one statement, so two
-- concurrent correct codes cannot both succeed.
create or replace function public.consume_otp(
  p_target  text,
  p_purpose text,
  p_code    text
) returns text
-- `extensions` for pgcrypto's digest(); see issue_otp() above.
language plpgsql security definer set search_path = public, extensions as $$
declare
  r public.otp_requests;
  v_ok text;
begin
  select * into r
  from public.otp_requests
  where target = p_target and purpose = p_purpose and consumed_at is null
  order by created_at desc
  limit 1
  for update;

  if not found then
    return 'missing';
  end if;

  if r.locked_until is not null and r.locked_until > now() then
    return 'locked';
  end if;

  if r.expires_at <= now() then
    return 'expired';
  end if;

  if r.code_hash = encode(digest(p_code || r.salt, 'sha256'), 'hex') then
    update public.otp_requests set consumed_at = now() where id = r.id;
    return 'ok';
  end if;

  update public.otp_requests set attempts = attempts + 1 where id = r.id;

  if r.attempts + 1 >= r.max_attempts then
    update public.otp_requests
       set locked_until = now() + make_interval(mins => 15)
     where id = r.id;
  end if;

  return 'invalid';
end $$;

-- ── Row Level Security: profiles & customers ────────────────
alter table public.profiles  enable row level security;
alter table public.customers enable row level security;

do $$ begin
  create policy profiles_select_own on public.profiles for select
    using (id = auth.uid() or public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

-- No client insert: profiles are provisioned by handle_new_user() as the
-- service role. A self-serve INSERT would let anyone pick their own role.
do $$ begin
  create policy profiles_no_insert on public.profiles for insert with check (false);
exception when duplicate_object then null; end $$;

-- UPDATE is narrowed further by the guard_profile_privileges() trigger, which
-- blocks role and status changes.
do $$ begin
  create policy profiles_update_own on public.profiles for update
    using (id = auth.uid())
    with check (id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy profiles_no_delete on public.profiles for delete using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy customers_select_own on public.customers for select
    using (profile_id = auth.uid() or public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy customers_no_insert on public.customers for insert with check (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy customers_update_own on public.customers for update
    using (profile_id = auth.uid())
    with check (profile_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy customers_no_delete on public.customers for delete using (false);
exception when duplicate_object then null; end $$;

-- Nobody reads or writes the OTP table through the client. The two
-- functions above are the only way in, and they are callable by the
-- service role alone: a browser must never be able to mint a code.
alter table public.otp_requests enable row level security;

do $$ begin
  create policy otp_no_client_access on public.otp_requests for all using (false);
exception when duplicate_object then null; end $$;

revoke all on public.otp_requests from anon, authenticated;

-- Postgres grants EXECUTE to PUBLIC on every new function, so `revoke ...
-- from public` also strips it from service_role. The Route Handlers call
-- these through PostgREST as service_role, and a missing EXECUTE grant is a
-- hard `permission denied for function` — not a warning. Re-grant it to
-- service_role alone; the browser must never be able to mint or burn a code.
revoke all on function public.issue_otp(text, text, text, text, int, int, int, int) from public, anon, authenticated;
revoke all on function public.consume_otp(text, text, text) from public, anon, authenticated;
grant execute on function public.issue_otp(text, text, text, text, int, int, int, int) to service_role;
grant execute on function public.consume_otp(text, text, text) to service_role;

-- Grant the minimal surface to the browser clients. The service role bypasses
-- all of this and is used only inside Route Handlers.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.customers to authenticated;
grant update (full_name, email, avatar_url, locale, last_seen_at)
  on public.profiles to authenticated;

-- customers is deliberately read-only for the browser. total_bookings,
-- lifetime_value and the referral counters are money-adjacent bookkeeping that
-- only ever moves as a side effect of a real booking, so a column-level UPDATE
-- grant would let any customer inflate their own history. The write path is
-- the service role inside the booking routes, and every such change is audited.
grant execute on function public.current_role() to anon, authenticated;
grant execute on function public.is_staff(public.user_role[]) to anon, authenticated;


-- ------------------------------------------------------------
-- 0002_geo.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0002_geo.sql
-- SmartHelp: cities and localities — the resolution chain that
-- turns a typed address into a "serviceable" pair.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.3, §5.1
-- ============================================================

create table if not exists public.cities (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  state            text not null,
  country          text not null default 'India',
  country_code     char(2) not null default 'IN',
  time_zone        text not null default 'Asia/Kolkata',
  default_currency char(3) not null default 'INR',
  pincode_prefixes text[] not null default '{}',
  lat              numeric(9,6),
  lng              numeric(9,6),
  business_hours   jsonb not null default '{"mon":{"open":"08:00","close":"21:00"},
                                           "tue":{"open":"08:00","close":"21:00"},
                                           "wed":{"open":"08:00","close":"21:00"},
                                           "thu":{"open":"08:00","close":"21:00"},
                                           "fri":{"open":"08:00","close":"21:00"},
                                           "sat":{"open":"08:00","close":"21:00"},
                                           "sun":{"open":"09:00","close":"20:00"}}'::jsonb,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

create unique index if not exists uniq_cities_name_state on public.cities (lower(name), lower(state));
create index if not exists idx_cities_active on public.cities (is_active);

create table if not exists public.localities (
  id         uuid primary key default gen_random_uuid(),
  city_id    uuid not null references public.cities(id) on delete cascade,
  name       text not null,
  lat        numeric(9,6) not null,
  lng        numeric(9,6) not null,
  radius_km  numeric(5,2) not null default 8.00,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists uniq_locality_per_city on public.localities (city_id, lower(name));

-- "Find every locality within 5 km of me" is an index scan, not a seq scan.
-- point() takes (x, y) = (lng, lat) so the GiST operator matches.
create extension if not exists btree_gist;
create index if not exists idx_localities_geo
  on public.localities using gist (point(lng, lat));
create index if not exists idx_localities_city_active on public.localities (city_id, is_active);

-- ── RLS: geography is public reference data ─────────────────
alter table public.cities     enable row level security;
alter table public.localities enable row level security;

do $$ begin
  create policy cities_public_read on public.cities for select
    using (is_active or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy cities_admin_write on public.cities for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy localities_public_read on public.localities for select
    using (is_active or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy localities_admin_write on public.localities for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

grant select on public.cities, public.localities to anon, authenticated;


-- ------------------------------------------------------------
-- 0003_catalogue.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0003_catalogue.sql
-- SmartHelp: service categories, services, the scope contract,
-- gallery images and search keywords.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.4, §4.2, §4.4
-- ============================================================

create table if not exists public.service_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  icon_key   text not null,               -- lucide icon name, resolved in the UI
  image_url  text,
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_service_categories_active
  on public.service_categories (sort_order) where is_active;

do $$ begin
  create type pricing_type as enum ('hourly','flat','per_unit');
exception when duplicate_object then null; end $$;

create table if not exists public.services (
  id                  uuid primary key default gen_random_uuid(),
  category_id         uuid not null references public.service_categories(id) on delete restrict,
  name                text not null,
  slug                text not null unique,
  short_description   text,
  description         text,
  image_url           text,
  base_price          numeric(10,2) not null check (base_price >= 0),
  pricing_type        pricing_type not null default 'hourly',
  unit_label          text,               -- 'kg' | 'piece' for per_unit
  unit_price          numeric(10,2),
  min_duration_min    int not null default 30  check (min_duration_min > 0),
  max_duration_min    int not null default 360 check (max_duration_min >= min_duration_min),
  prep_minutes        int not null default 0,  -- lead time before a slot can start
  max_active_jobs     int not null default 1,  -- concurrency cap for a single pro
  materials_included  boolean not null default false,
  materials_note      text,
  requires_photo_proof boolean not null default false,
  sort_order          int not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint per_unit_needs_unit check (
    pricing_type <> 'per_unit' or (unit_label is not null and unit_price is not null)
  )
);

create index if not exists idx_services_category_active on public.services (category_id) where is_active;
create index if not exists idx_services_active_order on public.services (sort_order, name) where is_active;

create table if not exists public.service_tasks (
  id         uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  kind       text not null check (kind in ('included','excluded')),
  label      text not null,
  sort_order int not null default 0
);

create index if not exists idx_service_tasks_service
  on public.service_tasks (service_id, kind, sort_order);

create table if not exists public.service_images (
  id         uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  url        text not null,
  alt_text   text,
  sort_order int not null default 0
);

create index if not exists idx_service_images_service
  on public.service_images (service_id, sort_order);

-- Search keywords are unique per service, ignoring case, so "Leak" and "leak"
-- cannot both be attached to one service.
--
-- That constraint is a unique *index* rather than a primary key on purpose: a
-- PRIMARY KEY constraint takes column names only and cannot hold an expression,
-- so `primary key (service_id, lower(keyword))` is a syntax error (42601). The
-- index gives the same guarantee.
create table if not exists public.service_keywords (
  service_id uuid not null references public.services(id) on delete cascade,
  keyword    text not null
);

create unique index if not exists uq_service_keywords_case_insensitive
  on public.service_keywords (service_id, lower(keyword));

-- Lookups search by keyword alone, which the index above cannot serve: it is
-- keyed on service_id first.
create index if not exists idx_service_keywords_kw on public.service_keywords (lower(keyword));

drop trigger if exists trg_services_touch on public.services;
create trigger trg_services_touch before update on public.services
  for each row execute function public.touch_updated_at();

-- ── RLS: the catalogue is world-readable; only admins write it ──
alter table public.service_categories enable row level security;
alter table public.services           enable row level security;
alter table public.service_tasks       enable row level security;
alter table public.service_images      enable row level security;
alter table public.service_keywords    enable row level security;

do $$ begin
  create policy categories_public_read on public.service_categories for select
    using (is_active or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy categories_admin_write on public.service_categories for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy services_public_read on public.services for select
    using (is_active or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy services_admin_write on public.services for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

-- Tasks, images and keywords inherit visibility from their service.
do $$ begin
  create policy service_tasks_public_read on public.service_tasks for select
    using (exists (select 1 from public.services s
                   where s.id = service_tasks.service_id
                     and (s.is_active or public.is_admin())));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_tasks_admin_write on public.service_tasks for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_images_public_read on public.service_images for select
    using (exists (select 1 from public.services s
                   where s.id = service_images.service_id
                     and (s.is_active or public.is_admin())));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_images_admin_write on public.service_images for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_keywords_public_read on public.service_keywords for select
    using (exists (select 1 from public.services s
                   where s.id = service_keywords.service_id
                     and (s.is_active or public.is_admin())));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_keywords_admin_write on public.service_keywords for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

grant select on public.service_categories, public.services, public.service_tasks,
                   public.service_images, public.service_keywords to anon, authenticated;


-- ------------------------------------------------------------
-- 0004_service_areas_durations.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0004_service_areas_durations.sql
-- SmartHelp: where a service is offered, and how long a booking of
-- it can be. Both are rows, never code.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.4, §4.3, §5.3
-- ============================================================

create table if not exists public.service_areas (
  id            uuid primary key default gen_random_uuid(),
  locality_id   uuid not null references public.localities(id) on delete cascade,
  service_id    uuid not null references public.services(id) on delete cascade,
  lead_minutes  int  not null default 0,
  slot_capacity int  not null default 4,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (locality_id, service_id),
  constraint slot_capacity_positive check (slot_capacity > 0)
);

create index if not exists idx_service_areas_lookup
  on public.service_areas (locality_id, service_id) where is_active;
create index if not exists idx_service_areas_service
  on public.service_areas (service_id) where is_active;

create table if not exists public.service_durations (
  id               uuid primary key default gen_random_uuid(),
  service_id       uuid not null references public.services(id) on delete cascade,
  minutes          int  not null check (minutes > 0),
  price            numeric(10,2),   -- flat override, nullable
  price_multiplier numeric(6,3),    -- or a multiplier on the hourly base
  is_active        boolean not null default true,
  unique (service_id, minutes),
  -- A row carries a flat price, a multiplier, or neither (base price applies).
  constraint duration_pricing_defined check (
    price is null or price_multiplier is null
  )
);

create index if not exists idx_service_durations_service
  on public.service_durations (service_id, minutes) where is_active;

-- ── Serviceability ──────────────────────────────────────────
-- The single gate every availability and booking check funnels
-- through: is this service offered at this locality right now?
create or replace function public.is_serviceable(
  p_locality_id uuid,
  p_service_id  uuid,
  p_at          timestamptz default now()
) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from public.service_areas sa
    join public.services  s  on s.id  = sa.service_id
    join public.localities l  on l.id  = sa.locality_id
    where sa.locality_id = p_locality_id
      and sa.service_id  = p_service_id
      and sa.is_active
      and s.is_active
      and l.is_active
      and (p_at is null or s.created_at <= p_at)
  )
$$;

-- ── RLS: coverage is public reference data; only admins write it ──
alter table public.service_areas     enable row level security;
alter table public.service_durations enable row level security;

do $$ begin
  create policy service_areas_public_read on public.service_areas for select
    using (is_active or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_areas_admin_write on public.service_areas for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_durations_public_read on public.service_durations for select
    using (is_active or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_durations_admin_write on public.service_durations for all
    using (public.is_staff(array['admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

grant select on public.service_areas, public.service_durations to anon, authenticated;
grant execute on function public.is_serviceable(uuid, uuid, timestamptz) to anon, authenticated;


-- ------------------------------------------------------------
-- 0005_professionals.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0005_professionals.sql
-- SmartHelp: the professional record, KYC documents, skills,
-- working hours and time off — plus the public pro profile view.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.5, §3.1, §9.1
-- ============================================================

do $$ begin
  create type verification_status as enum
    ('not_submitted','submitted','in_review','verified','rejected','expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type training_status as enum ('not_started','in_progress','completed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type availability_status as enum ('offline','online','busy','break');
exception when duplicate_object then null; end $$;

create table if not exists public.professionals (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid not null unique references public.profiles(id) on delete cascade,
  employee_code      text unique,
  verification_status verification_status not null default 'not_submitted',
  training_status    training_status     not null default 'not_started',
  availability_status availability_status not null default 'offline',
  is_available_today boolean not null default false,
  current_lat        numeric(9,6),
  current_lng        numeric(9,6),
  location_updated_at timestamptz,
  service_radius_km  numeric(5,2) not null default 12.00,
  commission_pct     numeric(5,4) not null default 0.2000,
  rating             numeric(3,2) check (rating between 0 and 5),
  rating_count       int not null default 0,
  total_offers       int not null default 0,
  accepted_offers    int not null default 0,
  completed_jobs     int not null default 0,
  cancelled_jobs     int not null default 0,
  no_shows           int not null default 0,
  experience_months  int not null default 0,
  probation_until    timestamptz,
  suspended_reason   text,
  kyc_verified_at    timestamptz,
  onboarded_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint acceptance_rate_positive check (accepted_offers <= total_offers),
  constraint commission_range check (commission_pct between 0 and 0.5),
  constraint service_radius_positive check (service_radius_km > 0)
);

create index if not exists idx_prof_matchable
  on public.professionals (verification_status, training_status, availability_status);
create index if not exists idx_prof_rating
  on public.professionals (rating desc nulls last) where verification_status = 'verified';
create index if not exists idx_prof_geo
  on public.professionals using gist (point(current_lng, current_lat))
  where current_lat is not null;

drop trigger if exists trg_professionals_touch on public.professionals;
create trigger trg_professionals_touch before update on public.professionals
  for each row execute function public.touch_updated_at();

create table if not exists public.professional_documents (
  id               uuid primary key default gen_random_uuid(),
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  doc_type         text not null check (doc_type in
                   ('aadhaar_front','aadhaar_back','pan','address_proof','selfie',
                    'police_verification','training_certificate','bank_passbook')),
  file_path        text not null,  -- storage path, never a public URL
  status           verification_status not null default 'submitted',
  rejection_reason text,
  reviewed_by      uuid references public.profiles(id) on delete set null,
  reviewed_at      timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);

create unique index if not exists uniq_prof_doc
  on public.professional_documents (professional_id, doc_type);
create index if not exists idx_prof_doc_status
  on public.professional_documents (status, created_at) where status in ('submitted','in_review');

create table if not exists public.professional_working_hours (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  weekday         smallint not null check (weekday between 0 and 6),  -- 0 = Sunday
  start_time      time not null,
  end_time        time not null,
  is_active       boolean not null default true,
  constraint valid_range check (end_time > start_time),
  unique (professional_id, weekday, start_time)
);

create table if not exists public.professional_time_off (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text,
  constraint valid_range check (ends_at > starts_at)
);

create index if not exists idx_time_off_range
  on public.professional_time_off (professional_id, starts_at, ends_at);

-- ── RLS helper, defined here because `professionals` now exists ──
create or replace function public.current_professional_id() returns uuid
language sql security definer stable set search_path = public as $$
  select id from public.professionals where profile_id = auth.uid()
$$;

-- ── Privilege guard ─────────────────────────────────────────
-- A professional may flip their own availability and push their own location.
-- They may never verify themselves, move their own commission, edit their own
-- rating, or clear their suspension. The service role and admins may.
create or replace function public.guard_professional_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.verification_status is distinct from old.verification_status
     or new.commission_pct   is distinct from old.commission_pct
     or new.rating           is distinct from old.rating
     or new.rating_count     is distinct from old.rating_count
     or new.employee_code    is distinct from old.employee_code
     or new.probation_until  is distinct from old.probation_until
     or new.suspended_reason is distinct from old.suspended_reason
     or new.kyc_verified_at  is distinct from old.kyc_verified_at
     or new.onboarded_at     is distinct from old.onboarded_at then
    if public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin() then
      return new;
    end if;
    raise exception 'PROFESSIONAL_PRIVILEGE_CHANGE_FORBIDDEN'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_professionals_guard_privileges on public.professionals;
create trigger trg_professionals_guard_privileges before update on public.professionals
  for each row execute function public.guard_professional_privileges();

-- The pro owns the upload, only staff own the verdict. A professional can
-- replace a file while it is still awaiting review, and never after that.
create or replace function public.guard_professional_document_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Swapping the file behind a reviewed document is the whole attack: keep
  -- `status = 'verified'` and replace `file_path` with a document nobody ever
  -- looked at. So the *file* is guarded as firmly as the verdict, and a
  -- professional may only move it while the document is un-reviewed.
  if new.file_path is distinct from old.file_path
     or new.doc_type is distinct from old.doc_type then
    if public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin() then
      return new;
    end if;
    if old.status in ('verified', 'in_review') then
      raise exception 'KYC_DOCUMENT_LOCKED'
        using errcode = 'insufficient_privilege',
              hint = 'A reviewed document cannot be replaced. Request a re-upload from support.';
    end if;
  end if;

  if new.status           is distinct from old.status
     or new.rejection_reason is distinct from old.rejection_reason
     or new.reviewed_by    is distinct from old.reviewed_by
     or new.reviewed_at    is distinct from old.reviewed_at then
    if public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin() then
      return new;
    end if;
    raise exception 'KYC_REVIEW_FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;

  -- Replacing a rejected or expired document restarts the review rather than
  -- inheriting the old verdict.
  if new.file_path is distinct from old.file_path
     and new.status is not distinct from old.status
     and old.status in ('rejected', 'expired', 'not_submitted') then
    new.status := 'submitted';
  end if;

  return new;
end $$;

drop trigger if exists trg_prof_documents_guard on public.professional_documents;
create trigger trg_prof_documents_guard before update on public.professional_documents
  for each row execute function public.guard_professional_document_review();

-- ── Public pro profile ──────────────────────────────────────
-- `professionals` holds live coordinates and the commission rate, so the
-- browser clients get no direct read on it. The public profile is this view:
-- a fixed, reviewed column list, no coordinates, no money.
create or replace view public.public_professionals as
select
  pr.id,
  p.full_name,
  p.avatar_url,
  pr.rating,
  pr.rating_count,
  pr.completed_jobs,
  pr.experience_months,
  pr.verification_status,
  pr.training_status,
  pr.is_available_today,
  pr.availability_status,
  pr.service_radius_km,
  pr.onboarded_at
from public.professionals pr
join public.profiles p on p.id = pr.profile_id
where p.status = 'active'
  and pr.verification_status = 'verified';

comment on view public.public_professionals is
  'Verified professionals, safe columns only. No live location, no commission.';

-- ── RLS ─────────────────────────────────────────────────────
-- public.professional_skills is deliberately absent: it is created by
-- 0006_professional_skills.sql, which enables RLS on it itself. Enabling it
-- here fails on a fresh database with
-- 'relation "public.professional_skills" does not exist'.
alter table public.professionals            enable row level security;
alter table public.professional_documents    enable row level security;
alter table public.professional_working_hours enable row level security;
alter table public.professional_time_off     enable row level security;

-- Read your own row; admins read all; staff can locate professionals by id.
do $$ begin
  create policy professionals_select_own on public.professionals for select
    using (profile_id = auth.uid() or public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

-- The professional row is created by the service role (apply endpoint / signup
-- handler), never by the client.
do $$ begin
  create policy professionals_no_insert on public.professionals for insert with check (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy professionals_update_own on public.professionals for update
    using (profile_id = auth.uid())
    with check (profile_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy professionals_no_delete on public.professionals for delete using (false);
exception when duplicate_object then null; end $$;

-- Metadata only. The file itself is fetched through a signed, staff-guarded URL.
do $$ begin
  create policy pro_docs_select_own on public.professional_documents for select
    using (professional_id = public.current_professional_id()
           or public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_docs_insert_own on public.professional_documents for insert
    with check (professional_id = public.current_professional_id()
                and status = 'submitted');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_docs_update_own on public.professional_documents for update
    using (professional_id = public.current_professional_id())
    with check (professional_id = public.current_professional_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_docs_no_delete on public.professional_documents for delete
    using (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_hours_select_own on public.professional_working_hours for select
    using (professional_id = public.current_professional_id() or public.is_ops());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_hours_write_own on public.professional_working_hours for all
    using (professional_id = public.current_professional_id() or public.is_admin())
    with check (professional_id = public.current_professional_id() or public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_time_off_select_own on public.professional_time_off for select
    using (professional_id = public.current_professional_id() or public.is_ops());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_time_off_write_own on public.professional_time_off for all
    using (professional_id = public.current_professional_id() or public.is_admin())
    with check (professional_id = public.current_professional_id() or public.is_admin());
exception when duplicate_object then null; end $$;

-- The browser can read its own professional row and its own documents.
-- Everything else on `professionals` is service-role only.
grant select on public.professionals, public.professional_documents to authenticated;
grant update (availability_status, is_available_today, current_lat, current_lng,
              location_updated_at, service_radius_km)
  on public.professionals to authenticated;
grant insert, update on public.professional_documents to authenticated;
grant select, insert, update, delete on public.professional_working_hours,
                                     public.professional_time_off to authenticated;
grant select on public.public_professionals to anon, authenticated;
grant execute on function public.current_professional_id() to anon, authenticated;


-- ------------------------------------------------------------
-- 0006_professional_skills.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0006_professional_skills.sql
-- SmartHelp: which professional is qualified for which service.
-- This is the table the matching engine (§9.2) filters on, so it
-- is the one place a "verified to do this" claim can live.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.5, §9.2
-- ============================================================

create table if not exists public.professional_skills (
  professional_id uuid not null references public.professionals(id) on delete cascade,
  service_id      uuid not null references public.services(id) on delete cascade,
  proficiency     int not null default 3 check (proficiency between 1 and 5),
  verified_at     timestamptz,
  primary key (professional_id, service_id)
);

create index if not exists idx_prof_skills_service on public.professional_skills (service_id);
create index if not exists idx_prof_skills_prof
  on public.professional_skills (professional_id) where verified_at is not null;

-- A skill may only be marked verified by the service role (the KYC workflow),
-- never by the professional holding it.
create or replace function public.guard_skill_verification() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.verified_at is distinct from old.verified_at then
    if public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin() then
      return new;
    end if;
    raise exception 'SKILL_VERIFICATION_FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_prof_skills_guard on public.professional_skills;
create trigger trg_prof_skills_guard before update on public.professional_skills
  for each row execute function public.guard_skill_verification();

-- ── RLS ─────────────────────────────────────────────────────
-- No PII here: an id pair plus a 1-5 proficiency. Safe to read
-- publicly, and it is what the public pro profile renders.
alter table public.professional_skills enable row level security;

do $$ begin
  create policy pro_skills_public_read on public.professional_skills for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_skills_write_own on public.professional_skills for all
    using (professional_id = public.current_professional_id() or public.is_admin())
    with check (professional_id = public.current_professional_id() or public.is_admin());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.professional_skills to anon, authenticated;


-- ------------------------------------------------------------
-- 0007_service_catalogue_seed.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0007_service_catalogue_seed.sql
-- SmartHelp: the launch city, its localities, the five service
-- categories, twenty services, their duration ladder, their
-- scope contract, and where each service is offered.
--
-- Everything here is a row an admin can edit. Nothing in the app
-- hardcodes a category, a service, a price or a coverage area.
--
-- Idempotent: safe to re-run. Inserts are keyed on the natural
-- unique key (slug / name / service+minutes / locality+service),
-- so a re-run updates nothing and inserts nothing.
--
-- Spec: §4.1, §4.3, §4.4, §5.1
-- ============================================================

-- ── City ────────────────────────────────────────────────────
insert into public.cities (name, state, lat, lng)
values ('Bengaluru', 'Karnataka', 12.971600, 77.594600)
on conflict do nothing;

-- ── Localities ──────────────────────────────────────────────
-- (name, lat, lng, radius_km)
insert into public.localities (city_id, name, lat, lng, radius_km)
select c.id, v.name, v.lat, v.lng, v.radius_km
from (values
  ('Indiranagar',       12.978400, 77.640800, 8.00),
  ('Koramangala',       12.935200, 77.624500, 8.00),
  ('HSR Layout',        12.911600, 77.647400, 8.00),
  ('Jayanagar',         12.925000, 77.593800, 8.00),
  ('Rajajinagar',       12.991500, 77.552000, 8.00),
  ('Malleshwaram',      13.003500, 77.570000, 8.00),
  ('Kalyan Nagar',      13.016700, 77.600000, 8.00),
  ('Whitefield',        12.969800, 77.750000, 10.00),
  ('Marathahalli',      12.959100, 77.697400, 10.00),
  ('Bannerghatta Road', 12.901000, 77.618000, 10.00),
  ('Yelahanka',         13.100700, 77.596300, 10.00),
  ('Electronic City',   12.845200, 77.660200, 12.00)
) as v(name, lat, lng, radius_km)
join public.cities c on lower(c.name) = 'bengaluru' and lower(c.state) = 'karnataka'
on conflict do nothing;

-- ── Categories ──────────────────────────────────────────────
-- (slug, name, icon_key, sort_order)
insert into public.service_categories (name, slug, icon_key, sort_order)
values
  ('Cleaning',  'cleaning',  'Sparkles',      10),
  ('Kitchen',   'kitchen',   'ChefHat',       20),
  ('Laundry',   'laundry',   'Shirt',         30),
  ('Household', 'household', 'House',         40),
  ('Appliance', 'appliance', 'Wrench',        50)
on conflict (slug) do update
  set name       = excluded.name,
      icon_key   = excluded.icon_key,
      sort_order = excluded.sort_order;

-- ── Services ────────────────────────────────────────────────
-- base_price is the HOURLY rate for hourly services, the total for flat
-- services, and the per-unit rate for per_unit services.
insert into public.services
  (category_id, name, slug, short_description, description,
   base_price, pricing_type, unit_label, unit_price,
   min_duration_min, max_duration_min, prep_minutes, max_active_jobs,
   materials_included, materials_note, requires_photo_proof, sort_order)
select
  cat.id, v.name, v.slug, v.short_description, v.description,
  v.base_price, v.pricing_type::public.pricing_type, v.unit_label, v.unit_price,
  v.min_duration_min, v.max_duration_min, v.prep_minutes, v.max_active_jobs,
  v.materials_included, v.materials_note, v.requires_photo_proof, v.sort_order
from (values
  -- Cleaning · hourly 30-240
  ('cleaning', 'Full House Cleaning', 'full-house-cleaning',
   'Deep clean for the whole home — rooms, kitchen, bathrooms and floors.',
   'A trained professional cleans every room in scope: dusting, surface wiping, floor mopping, bathroom and kitchen sanitising, and a final walkthrough with you before they leave. Bring your own supplies unless you opt for the included-materials variant.',
   249.00, 'hourly', null, null, 30, 240, 60, 1, false,
   'Please keep a broom, mop and a dry cloth accessible on each floor.', false, 10),

  ('cleaning', 'Bathroom Cleaning', 'bathroom-cleaning',
   'Tiles, fittings, floors and drains cleaned and sanitised.',
   'Specialist deep clean of one bathroom: floor and joint scrubbing, toilet bowl and exterior, basin, taps and mirror, shower area and glass fittings, and the small fixtures people forget. Ideal as a fortnightly or monthly reset.',
   349.00, 'hourly', null, null, 30, 180, 45, 1, false,
   'Keep cleaning liquids and a cloth within reach of the bathroom.', false, 20),

  ('cleaning', 'Kitchen Deep Clean', 'kitchen-deep-clean',
   'Oils, grease and residue removed from every kitchen surface.',
   'A full kitchen reset: platform, countertop, cabinet fronts, backsplash, sink and drain, stove and chimney exterior, and inside the empty fridge if you have switched it off. One of the highest-demand services on SmartHelp.',
   399.00, 'hourly', null, null, 60, 240, 60, 1, false,
   'Please empty the countertop and switch off the fridge the night before.', false, 30),

  ('cleaning', 'Balcony & Window Cleaning', 'balcony-window-cleaning',
   'Glass, rails, grills and floors in balconies and windows.',
   'Outside surfaces, reached from a balcony with a standard step stool: window glass both sides, frames, sills, railings, grillwork, and a wash-down of the balcony floor. High-reach or rope-access glass is not included.',
   299.00, 'hourly', null, null, 30, 180, 30, 1, false,
   'Remove drying clothes and unlock balcony access before arrival.', false, 40),

  ('cleaning', 'Fan & Appliance Cleaning', 'fan-appliance-cleaning',
   'Ceiling fans, geysers and small appliances cleaned in place.',
   'Dust-off and clean of ceiling and pedestal fans (blade, motor housing, regulator), geyser exterior, mixer and extension boards. Appliances are cleaned where they hang, not dismantled, unless the service detail says otherwise.',
   349.00, 'hourly', null, null, 30, 120, 30, 1, false,
   'Switch off the main breaker to the ceiling fan area before arrival.', false, 50),

  ('cleaning', 'Mopping & Floor Scrubbing', 'mopping-floor-scrubbing',
   'Grout, tile and stone floors scrubbed and machine-mopped.',
   'Floor-only service for homes where the rest is already clean: dry sweeping, scrub-in of grout and joints, and a uniform mop-down with a neutral solution so the floor does not streak. Ideal before a guest arrival or a festival.',
   229.00, 'hourly', null, null, 30, 180, 30, 2, false,
   'Please move furniture you want cleaned under before arrival.', false, 60),

  -- Kitchen · hourly 60-240
  ('kitchen', 'Dishwashing', 'dishwashing',
   'Every dish, pan and utensil washed, dried and put away.',
   'Post-meal or daily-load dishwashing with a sink-side soak, degreasing of the chimney filter, and the dishes dried and stacked back where you keep them. Utensils used for eating are washed separately with a food-safe solution.',
   199.00, 'hourly', null, null, 60, 180, 30, 2, false,
   'Please leave hot pans to cool and rinse before the professional arrives.', false, 70),

  ('kitchen', 'Daily Cooking Support', 'daily-cooking-support',
   'A cook in your kitchen for the prep, the meal and the cleanup.',
   'Support for your own recipes: shopping list and prep, cooking on the stove or in the oven, plating and serving, and washing up afterwards. Ingredients are cooked to your taste and dietary preference. Pantry management and recipe creation are agreed in the booking notes.',
   249.00, 'hourly', null, null, 60, 240, 30, 1, true,
   'Ingredients are included. Please keep a running list of what the cook should buy.', false, 80),

  ('kitchen', 'Vegetable Prep & Chopping', 'vegetable-prep-chopping',
   'Washing, peeling and chopping for a week of cooking.',
   'Bulk prep for a busy household: vegetables washed, peeled, cut and stored; lentils and grains portioned; and the prep area cleaned. Not a cooking service — prep only, ready for you to cook when you want.',
   199.00, 'hourly', null, null, 60, 180, 30, 2, false,
   'Keep storage containers and a labelled box ready for the prepped items.', false, 90),

  ('kitchen', 'Counter & Platform Cleaning', 'counter-platform-cleaning',
   'Kitchen counters, platform and sink scrubbed and degreased.',
   'Every exposed horizontal surface in the kitchen: counter, platform, sink, mixer and chimney exterior, backsplash tiles, and the area behind the gas stove. A fast, high-frequency service for a kitchen that is used daily.',
   199.00, 'hourly', null, null, 60, 180, 30, 2, false,
   'Please move countertop appliances you want cleaned under before arrival.', false, 100),

  ('kitchen', 'Gas Stove & Chimney Wipe-down', 'gas-stove-chimney-wipe',
   'Burners, knobs, chimney and its filter degreased.',
   'Degreasing of the gas stove top, burners, knobs and counter around it, plus the chimney body, glass and the removable filter. The filter is washed, dried and refitted. Deep internal servicing is a different service.',
   249.00, 'hourly', null, null, 60, 120, 30, 1, false,
   'Switch off the stove at the regulator before the professional arrives.', false, 110),

  -- Laundry · per kg or hourly, 60-240
  ('laundry', 'Washing & Dry', 'washing-and-dry',
   'Per kilogram wash, dry and fold, collected from your door.',
   'Sorted, washed, dried and folded laundry billed per kilogram. Common-garment, bedsheet and towel rates are at the per-kilogram rate; delicate and dry-clean-only items are returned untouched and are not billed.',
   45.00, 'per_unit', 'kg', 45.00, 60, 240, 120, 1, true,
   'Detergent is included. A separate laundry bag keeps your colours apart.', false, 120),

  ('laundry', 'Ironing & Folding', 'ironing-and-folding',
   'Per kilogram pressed, folded and sorted by type.',
   'Collected laundry pressed and folded, and returned sorted into your own cupboards or onto a rail. Shirt and trouser creases are set properly; heavier items such as curtains and blankets are quoted before starting.',
   18.00, 'per_unit', 'kg', 18.00, 60, 180, 60, 2, true,
   'An iron and a clean surface are provided. Iron-on embellished items are excluded.', false, 130),

  ('laundry', 'Stain Removal', 'stain-removal',
   'Oil, grease, ink and tea stains worked on the spot.',
   'Per-hour stain treatment for washable garments and household linen: stain identification, pre-treatment, agitation or solvent work, rinse and a dry-off. Heavily set-in or dyed stains may not clear completely; the professional will tell you honestly before starting.',
   299.00, 'hourly', null, null, 60, 180, 60, 1, false,
   'Please check the care label — dry-clean-only items are refused on arrival.', false, 140),

  ('laundry', 'Blanket & Heavy Curtain Wash', 'blanket-curtain-wash',
   'Per piece wash for blankets, comforters and heavy drapes.',
   'Per-piece machine wash and dry for bulky items: cotton and wool blankets, comforters, mattress covers, and heavy blackout or velvet drapes. Pieces are laundered individually and returned dry, folded and covered.',
   120.00, 'per_unit', 'piece', 120.00, 60, 240, 180, 1, true,
   'Detergent is included. Very large drapes are quoted after a photo check.', false, 150),

  -- Household · hourly 60-360
  ('household', 'Decluttering & Organising', 'decluttering-organising',
   'Sort, label, store — the clutter actually leaves the house.',
   'A systematic second pair of hands: sort and categorise, label and store, and dispose of or donate what you no longer want. You decide what leaves; the professional handles the sorting, the labelling and the carrying.',
   299.00, 'hourly', null, null, 60, 360, 60, 1, false,
   'Keep storage boxes, labels and spare hangers ready on the day.', false, 160),

  ('household', 'Moving Help (Packing)', 'moving-help-packing',
   'Packing, labelling and unpacking for a house move.',
   'Two or more professionals for the heavy part of a move: wrapping and packing by room and category, labelling every carton, and reassembly at the other end. Packing material is included; the vehicle and the transport are not.',
   349.00, 'hourly', null, null, 120, 360, 120, 1, true,
   'Bubble wrap, cartons and tape are included. Fragile items are declared in the notes.', true, 170),

  ('household', 'Post-Partition Deep Clean', 'post-partition-deep-clean',
   'A whole-home reset after a move in or a move out.',
   'The heaviest clean on the platform: inside cupboards, ceiling fans, light fittings, window tracks, balcony, and the kitchen and bathrooms in full. Intended for a home that was previously occupied or is being vacated.',
   449.00, 'hourly', null, null, 180, 360, 180, 1, false,
   'Please ensure the home is empty of furniture and the water supply is on.', false, 180),

  ('household', 'Errand & Shopping Run', 'errand-shopping-run',
   'One fixed run: your list, the shops, the doorstep.',
   'A flat-fee run for errands: a shopping list up to 10 kg of provisions, pharmacy pickups, document drop-offs, or returning something across the city. Receipts are shared back with you. Multiple stops are priced by agreement in the notes.',
   199.00, 'flat', null, null, 90, 90, 30, 2, false,
   'No materials needed. Keep the shopping list and any prescription handy.', false, 190),

  -- Appliance · fixed or hourly, 60-180
  ('appliance', 'Refrigerator Deep Clean', 'refrigerator-deep-clean',
   'Shelves, drawers, coils and gasket scrubbed and sanitised.',
   'Unplugged, emptied, and cleaned inside and out: shelves, drawers, door gasket, interior walls, the condenser coil and the back panel, then deodorised and dried. Food must be removed and transported by you.',
   599.00, 'flat', null, null, 120, 120, 60, 1, false,
   'Please empty the refrigerator and store the food elsewhere before arrival.', true, 200),

  ('appliance', 'Microwave Clean', 'microwave-clean',
   'Interior, glass turntable and door seal degreased.',
   'The microwave is cleaned inside and out: cavity, ceiling and floor, glass turntable, waveguide cover, door seal and the outer body, then deodorised. Leftover spills and reheated odours are the usual reason for booking.',
   349.00, 'flat', null, null, 60, 60, 30, 1, false,
   'Please unplug the microwave before the professional arrives.', true, 210),

  ('appliance', 'Air Conditioner Service', 'air-conditioner-service',
   'Filter clean, coil wash, full function check.',
   'A service visit for split and window AC: filter removal and clean, indoor unit coil wash, drain line flush, and a full function check with a temperature reading. Refrigerant top-up, if needed, is quoted separately and in advance.',
   899.00, 'flat', null, null, 90, 90, 60, 1, false,
   'The unit must be accessible and the AC switched off at the isolator.', true, 220),

  ('appliance', 'Chimney Deep Clean', 'chimney-deep-clean',
   'Filters, motor and duct interior degreased.',
   'A proper chimney clean: both removable filters washed, the impeller and motor housing degreased, the interior duct and hood walls wiped down, and the unit reassembled and tested. Kitchen grease, not a wipe-down.',
   799.00, 'flat', null, null, 90, 90, 60, 1, false,
   'Please keep the chimney switch accessible and clear the platform below it.', true, 230)
) as v(cat_slug, name, slug, short_description, description,
       base_price, pricing_type, unit_label, unit_price,
       min_duration_min, max_duration_min, prep_minutes, max_active_jobs,
       materials_included, materials_note, requires_photo_proof, sort_order)
join public.service_categories cat on cat.slug = v.cat_slug
on conflict (slug) do update
  set category_id          = excluded.category_id,
      name                 = excluded.name,
      short_description    = excluded.short_description,
      description          = excluded.description,
      base_price           = excluded.base_price,
      pricing_type         = excluded.pricing_type,
      unit_label           = excluded.unit_label,
      unit_price           = excluded.unit_price,
      min_duration_min     = excluded.min_duration_min,
      max_duration_min     = excluded.max_duration_min,
      prep_minutes         = excluded.prep_minutes,
      max_active_jobs      = excluded.max_active_jobs,
      materials_included   = excluded.materials_included,
      materials_note       = excluded.materials_note,
      requires_photo_proof = excluded.requires_photo_proof,
      sort_order           = excluded.sort_order;

-- ── Duration ladder ─────────────────────────────────────────
-- Default ladder: 30, 45, 60, 90, 120, 180, 240, 300, 360 minutes.
-- A row may carry a flat `price` OR a `price_multiplier`, never both.
-- Flat-priced services get exactly one row: the time the job takes.
insert into public.service_durations (service_id, minutes, price_multiplier)
select s.id, v.minutes, v.price_multiplier::numeric
from (values
  (30,  0.600), (45,  0.850), (60,  1.000), (90,  1.350),
  (120, 1.700), (180, 2.400), (240, 3.100), (300, 3.800), (360, 4.500)
) as v(minutes, price_multiplier)
join public.services s
  on s.pricing_type = 'hourly'
 and v.minutes between s.min_duration_min and s.max_duration_min
on conflict (service_id, minutes) do update
  set price_multiplier = excluded.price_multiplier,
      is_active = true;

-- Flat-priced services: one row, no ladder, no multiplier.
insert into public.service_durations (service_id, minutes, price)
select s.id, s.max_duration_min, s.base_price
from public.services s
where s.pricing_type = 'flat'
on conflict (service_id, minutes) do update
  set price = excluded.price,
      is_active = true;

-- Per-unit services are priced on the weight or the piece, but the
-- professional still spends time: give them the standard ladder.
insert into public.service_durations (service_id, minutes, price_multiplier)
select s.id, v.minutes, v.price_multiplier::numeric
from (values
  (60, 1.000), (90, 1.350), (120, 1.700), (180, 2.400), (240, 3.100)
) as v(minutes, price_multiplier)
join public.services s
  on s.pricing_type = 'per_unit'
 and v.minutes between s.min_duration_min and s.max_duration_min
on conflict (service_id, minutes) do nothing;

-- ── Scope contract (service_tasks) ──────────────────────────
-- The ✓ included / ✕ excluded list on the service detail screen. A
-- dispute is adjudicated against these rows, so they are written as
-- specific, checkable statements — never "general cleaning".
insert into public.service_tasks (service_id, kind, label, sort_order)
select s.id, v.kind, v.label, v.sort_order
from (values
  -- Bathroom Cleaning: the canonical example from the specification
  ('bathroom-cleaning', 'included', 'Floor cleaning (tiles, joints, drains)', 10),
  ('bathroom-cleaning', 'included', 'Toilet bowl, seat, exterior & flush cleaning', 20),
  ('bathroom-cleaning', 'included', 'Basin, taps, mirror & tap stains', 30),
  ('bathroom-cleaning', 'included', 'Shower area, glass & fittings', 40),
  ('bathroom-cleaning', 'included', 'Soap dish, holder, tissue, door handle', 50),
  ('bathroom-cleaning', 'excluded', 'Hazardous / bleach chemical deep treatment', 60),
  ('bathroom-cleaning', 'excluded', 'Outdoor or high-reach glass cleaning', 70),
  ('bathroom-cleaning', 'excluded', 'Moving heavy or fixed furniture', 80),
  ('bathroom-cleaning', 'excluded', 'Construction stain / paint removal', 90),

  ('full-house-cleaning', 'included', 'Dust-off of all surfaces, ledges and shelves', 10),
  ('full-house-cleaning', 'included', 'Mopping and wiping of all floors', 20),
  ('full-house-cleaning', 'included', 'Kitchen counter, platform and sink cleaning', 30),
  ('full-house-cleaning', 'included', 'Bathroom fixtures and floors', 40),
  ('full-house-cleaning', 'included', 'Beds, mattress top and side surfaces', 50),
  ('full-house-cleaning', 'included', 'Dustbins emptied and relined', 60),
  ('full-house-cleaning', 'excluded', 'Inside the refrigerator or oven', 70),
  ('full-house-cleaning', 'excluded', 'Interior of cupboards and wardrobe shelves', 80),
  ('full-house-cleaning', 'excluded', 'Window glass outside, from a rope or a high ledge', 90),
  ('full-house-cleaning', 'excluded', 'Pest control, termite treatment or shampooing', 100),

  ('kitchen-deep-clean', 'included', 'Platform, counter and backsplash degreasing', 10),
  ('kitchen-deep-clean', 'included', 'Cabinet doors and handles, outside surfaces', 20),
  ('kitchen-deep-clean', 'included', 'Sink, drain and the area under the sink', 30),
  ('kitchen-deep-clean', 'included', 'Gas stove, burners, knobs and surrounding counter', 40),
  ('kitchen-deep-clean', 'included', 'Chimney exterior, glass and filter', 50),
  ('kitchen-deep-clean', 'excluded', 'Duct interior beyond the filter', 60),
  ('kitchen-deep-clean', 'excluded', 'Refrigerator interior (a separate service)', 70),
  ('kitchen-deep-clean', 'excluded', 'Repainting, retiling or re-grouting', 80),

  ('daily-cooking-support', 'included', 'Shopping and ingredient preparation', 10),
  ('daily-cooking-support', 'included', 'Cooking your recipes on the stove or in the oven', 20),
  ('daily-cooking-support', 'included', 'Plating and serving', 30),
  ('daily-cooking-support', 'included', 'Washing up and cleaning of the cooking area', 40),
  ('daily-cooking-support', 'excluded', 'Baking cakes, bread or pastries', 50),
  ('daily-cooking-support', 'excluded', 'Dietary planning or nutrition advice', 60),
  ('daily-cooking-support', 'excluded', 'Serving non-vegetarian food without prior agreement', 70),

  ('washing-and-dry', 'included', 'Sorting, washing and drying', 10),
  ('washing-and-dry', 'included', 'Folding and bagging by category', 20),
  ('washing-and-dry', 'excluded', 'Dry cleaning or steam ironing of special fabrics', 30),
  ('washing-and-dry', 'excluded', 'Stain removal above 30 minutes (a separate service)', 40),

  ('ironing-and-folding', 'included', 'Ironing and creasing of foldable garments', 10),
  ('ironing-and-folding', 'included', 'Sorting and folding by type', 20),
  ('ironing-and-folding', 'excluded', 'Iron-on embellishments, velvet and wool coats', 30),

  ('refrigerator-deep-clean', 'included', 'Shelves, drawers and interior walls', 10),
  ('refrigerator-deep-clean', 'included', 'Door gasket and seal cleaned', 20),
  ('refrigerator-deep-clean', 'included', 'Condenser coil and back panel dust-off', 30),
  ('refrigerator-deep-clean', 'excluded', 'Compressor repair or gas refilling', 40),
  ('refrigerator-deep-clean', 'excluded', 'Disposal of the food you removed', 50),

  ('air-conditioner-service', 'included', 'Filter removal, clean and refit', 10),
  ('air-conditioner-service', 'included', 'Indoor unit coil wash', 20),
  ('air-conditioner-service', 'included', 'Drain line flush', 30),
  ('air-conditioner-service', 'included', 'Full function check with a temperature reading', 40),
  ('air-conditioner-service', 'excluded', 'Refrigerant top-up (quoted separately, in advance)', 50),
  ('air-conditioner-service', 'excluded', 'Outdoor unit, installation or shifting', 60),

  ('post-partition-deep-clean', 'included', 'Inside cupboards, almirahs and wardrobe shelves', 10),
  ('post-partition-deep-clean', 'included', 'Ceiling fans and light fittings', 20),
  ('post-partition-deep-clean', 'included', 'Window tracks, sills and glass from the inside', 30),
  ('post-partition-deep-clean', 'included', 'Balcony, walls and skirting boards', 40),
  ('post-partition-deep-clean', 'included', 'Full kitchen and bathroom clean', 50),
  ('post-partition-deep-clean', 'excluded', 'Paint, whitewash and wall treatment', 60),
  ('post-partition-deep-clean', 'excluded', 'Carpets, sofa and mattress shampooing', 70),
  ('post-partition-deep-clean', 'excluded', 'Removal and disposal of furniture or debris', 80)
) as v(slug, kind, label, sort_order)
join public.services s on s.slug = v.slug
on conflict do nothing;

-- ── Service areas (coverage) ────────────────────────────────
-- A service is bookable only where an active service_areas row exists.
-- The ten core localities carry the full catalogue; the three outer
-- localities carry Cleaning and Kitchen only, so the
-- SERVICE_UNAVAILABLE path (§25.2) is reachable with real data.
insert into public.service_areas (locality_id, service_id, lead_minutes, slot_capacity)
select l.id, s.id,
       greatest(s.prep_minutes, case when l.name in ('Electronic City','Yelahanka') then 45 else 0 end),
       case when l.name in ('Electronic City','Yelahanka','Bannerghatta Road') then 2 else 4 end
from public.localities l
join public.cities c on c.id = l.city_id
join public.services s on true
join public.service_categories cat on cat.id = s.category_id
where lower(c.name) = 'bengaluru'
  and (l.name not in ('Electronic City','Yelahanka','Bannerghatta Road')
       or cat.slug in ('cleaning','kitchen'))
on conflict (locality_id, service_id) do update
  set lead_minutes  = excluded.lead_minutes,
      slot_capacity = excluded.slot_capacity,
      is_active     = true;


-- ------------------------------------------------------------
-- 0008_addresses.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0008_addresses.sql
-- SmartHelp: a customer's saved addresses, and the one
-- transaction that makes a default address.
--
-- Everything downstream of Phase 1 gates on a locality:
-- a service is bookable where an active service_areas row
-- exists, and that row is keyed on locality. An address is
-- how a locality gets resolved from something a person can
-- actually type or grant from the browser.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.6, §5.2, §5.4
-- ============================================================

do $$ begin
  create type address_type as enum ('home','work','other');
exception when duplicate_object then null; end $$;

create table if not exists public.addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  locality_id  uuid references public.localities(id) on delete set null,
  label        text not null default 'Home',
  address_type address_type not null default 'home',
  line1        text not null,          -- flat / house
  line2        text,                   -- building / society
  area         text not null,          -- locality name, as typed
  city         text not null,
  state        text not null,
  pincode      text not null,
  lat          numeric(9,6) not null,
  lng          numeric(9,6) not null,
  landmark     text,
  -- Gate code, floor, "no lift on 4th", parking. Shown to the
  -- professional during the approach, and the field whose absence
  -- loses the most jobs on arrival.
  access_notes text,
  -- 'exact' when the browser gave us a pin, 'locality_centre' when the
  -- person typed an area and we fell back to the locality's middle. §5.4
  -- makes the professional's approach depend on which, and §9.1 warns the
  -- customer to add a landmark in the second case — so the difference has
  -- to outlive the write, not just the response that carried it.
  location_precision text not null default 'locality_centre',
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Cheap here, expensive to debug later. A latitude of 191 or a
  -- four-digit pincode is always a bad geocode, never a real address.
  constraint latitude_in_range  check (lat between -90 and 90),
  constraint longitude_in_range check (lng between -180 and 180),
  constraint pincode_shape     check (pincode ~ '^[0-9]{6}$'),
  constraint line1_present     check (length(btrim(line1)) > 0),
  constraint area_present      check (length(btrim(area)) > 0),
  constraint precision_known   check (location_precision in ('exact','locality_centre'))
);

-- The precision column was added after 0008 had already been applied on some
-- projects, and `create table if not exists` will not add a column to a table
-- that exists. Without this, a re-run would leave the old table without the
-- column every insert now writes.
alter table public.addresses
  add column if not exists location_precision text not null default 'locality_centre';

do $$ begin
  alter table public.addresses
    add constraint precision_known
      check (location_precision in ('exact','locality_centre'));
exception when duplicate_object then null; end $$;

comment on column public.addresses.locality_id is
  'Resolved from `area` or `lat`/`lng` at save time, and re-used by every
   availability check. NULL happens only when a locality is deleted from under
   the row (`on delete set null`): an address that cannot be placed in the
   first place is refused by the API, because lat/lng are not null and a
   guessed point sends the professional to the wrong building. When the id is
   NULL the API answers with `coverage: ''not_yet_available''` and the UI shows
   a badge. The resolution rule lives in lib/geo.ts, not here, because it is
   business logic with radius semantics and wants unit tests.';

-- Exactly one default per customer. A partial unique index, because the
-- column is nullable and a plain unique would count the NULLs.
create unique index if not exists uniq_default_address
  on public.addresses (customer_id) where is_default;
create index if not exists idx_addresses_customer
  on public.addresses (customer_id, created_at desc);
create index if not exists idx_addresses_locality
  on public.addresses (locality_id) where locality_id is not null;

drop trigger if exists trg_addresses_touch on public.addresses;
create trigger trg_addresses_touch before update on public.addresses
  for each row execute function public.touch_updated_at();

-- ── Set the default, in one transaction ─────────────────────
-- Two statements from a Route Handler ("clear all, then set this")
-- can interleave with a second request and leave a customer with no
-- default address at all. The whole thing is one statement here,
-- so the invariant holds even under two simultaneous calls.
create or replace function public.set_default_address(
  p_customer_id uuid,
  p_address_id  uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  -- The function is callable directly, so it checks ownership itself
  -- rather than trusting whoever wired it up.
  if not (
       public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin()
       or public.current_customer_id() = p_customer_id
     ) then
    raise exception 'ADDRESS_NOT_OWNED'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.addresses where id = p_address_id and customer_id = p_customer_id
  ) then
    raise exception 'ADDRESS_NOT_FOUND'
      using errcode = 'foreign_key_violation';
  end if;

  update public.addresses set is_default = false where customer_id = p_customer_id and is_default;
  update public.addresses set is_default = true  where id = p_address_id;

  return p_address_id;
end $$;

comment on function public.set_default_address(uuid, uuid) is
  'Clears the customer''s default and sets this one, atomically.';

-- ── RLS ─────────────────────────────────────────────────────
-- An address is the most sensitive row a customer owns: it is
-- where they live, and `access_notes` describes how to get in.
-- So there is no anon grant at all, and no policy an anonymous
-- session can satisfy — `current_customer_id()` is NULL without
-- an `auth.uid()`, and NULL = NULL is false in a `using` clause.
--
-- The Route Handlers use the service role and enforce ownership in
-- the handler, which is what allows staff support tooling to read
-- an address; a browser session cannot take that path.
alter table public.addresses enable row level security;

do $$ begin
  create policy addresses_select_own on public.addresses for select
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy addresses_insert_own on public.addresses for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy addresses_update_own on public.addresses for update
    using (customer_id = public.current_customer_id())
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy addresses_delete_own on public.addresses for delete
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

revoke all on public.addresses from anon;
grant select, insert, update, delete on public.addresses to authenticated;
grant execute on function public.set_default_address(uuid, uuid) to authenticated, service_role;

-- ── Deferred to Phase 2 ─────────────────────────────────────
-- §24.6 also defines block_address_delete_with_future_bookings(),
-- which refuses to delete an address a live booking points at. It is
-- not here because it references `bookings`, and a migration that
-- names a table that does not exist fails to apply. Nothing can
-- reference an address yet, so there is nothing to guard; the
-- function ships with the booking tables.
--
-- Likewise, addresses.area is compared to localities.name in §5.3
-- rather than joined on a stored locality_id. The stored id is the
-- better key — it survives a locality being renamed — so it is what
-- Phase 1 uses, and locality_id is nullable only so that deleting a
-- locality cannot fail on the rows that pointed at it.


-- ------------------------------------------------------------
-- 0008a_drop_legacy_booking_schema.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0009a_drop_legacy_booking_schema.sql
-- SmartHelp: remove a pre-spec bookings schema that no
-- migration ever created.
--
-- The live project carries tables that are in none of
-- supabase/migrations/. They were built outside the migration
-- system, and they disagree with the specification on almost
-- every column:
--
--   bookings            status is a 15-label enum with
--                       `pending`, `quoted`, `en_route` and
--                       `awaiting_otp` — none of which §8.1 has.
--                       Money is `int` paise, not `numeric(12,2)`.
--                       One `service_id` per booking, so a cart of
--                       three services has nowhere to live.
--                       `starts_at`/`ends_at` instead of
--                       `scheduled_start_at`/`scheduled_end_at`.
--   coupons             `kind`/`amount`/`min_subtotal`, against
--                       §24.7's `discount_type`/`discount_value`/
--                       `min_booking_amount`.
--   coupon_redemptions  against §24.7's `coupon_usage`.
--
-- Leaving them would mean creating the specification's tables
-- beside them under different names, and every later file would
-- have to remember which one it meant. A schema with two answers
-- to "what is a booking" is a schema where the wrong one gets
-- used.
--
-- All three are empty, and this migration refuses to run if that
-- ever stops being true — see the guard below. Nothing else in
-- public depends on them; the probe that established this is in
-- the Phase 2 notes.
--
-- `pricing_type` is deliberately KEPT. The legacy `bookings`
-- table used it, but so does `services.pricing_type`, which is
-- migration-owned and in live use — dropping the enum to tidy up
-- a dead table would break the catalogue.
--
-- Idempotent: safe to re-run, and safe on a project that never
-- had the legacy schema at all.
-- Spec: §24.7
-- ============================================================

-- ── Refuse to destroy data ─────────────────────────────────
-- If someone has somehow started using these tables, the correct
-- outcome is a failed migration and a human reading this, not a
-- silent drop. An empty table is indistinguishable from a table
-- nobody has touched yet, and the cost of being wrong here is
-- somebody's bookings.
--
-- Written with EXECUTE rather than three static counts because a
-- static `select count(*) from public.bookings` is a parse-time
-- reference to a table that may not be there — this file has to be
-- re-runnable on a project that never had the legacy schema at all,
-- and on this one after it has already run once. `to_regclass`
-- answers the question without naming a relation.
do $$
declare
  v_n      bigint := 0;
  v_present text[];
  t        text;
begin
  select coalesce(array_agg(u.name), '{}')
    into v_present
    from unnest(array['bookings', 'coupons', 'coupon_redemptions']) as u(name)
   where to_regclass('public.' || u.name) is not null;

  foreach t in array v_present loop
    execute format('select count(*) from public.%I', t) into v_n;
    -- Assigned, not accumulated: the loop reports the first table that has
    -- data, which is the one a human needs to go and export.
    exit when v_n > 0;
  end loop;

  if v_n > 0 then
    raise exception
      'LEGACY_BOOKING_DATA_PRESENT: % row(s) found in % . '
      'Migrating this data to the §24.7 shape is manual work — stop and export it first.',
      v_n, array_to_string(v_present, ', ')
      using errcode = 'check_violation';
  end if;
end $$;

-- Triggers and policies travel with their tables, so there is nothing to drop
-- separately. Order matters in one place: sync_coupon_usage() is wired to
-- trg_coupon_usage on coupon_redemptions, and a function cannot be dropped while
-- a trigger depends on it. Dropping the child table first takes the trigger with
-- it, which frees the function — so the legacy coupon counters go before the
-- legacy coupon tables, not after.
--
-- coupons goes before bookings: coupon_redemptions holds FKs into both, and
-- dropping the parents first would need CASCADE, which is the thing to avoid
-- having to say.
drop table if exists public.coupon_redemptions;
drop table if exists public.coupons;
drop table if exists public.bookings;

drop function if exists public.sync_coupon_usage();

-- Now nothing references the legacy enum, so it can go without
-- CASCADE — and CASCADE here would silently drop anything else
-- that had picked up the type, which is exactly the failure this
-- file is trying to avoid.
drop type if exists public.booking_status;


-- ------------------------------------------------------------
-- 0009_booking_enum.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0009_booking_enum.sql
-- SmartHelp: the two enums a booking is made of.
--
-- Both are created in full, before the code that uses most of
-- them exists. That is deliberate and it is the opposite of
-- "add a value when you need it".
--
-- A Postgres enum's labels are stored inline in every row that
-- uses them, so adding one is an ALTER TYPE that rewrites the
-- table and takes an ACCESS EXCLUSIVE lock. On `bookings` that
-- is a table with a history row behind every row and a GiST
-- index — not something to do during a launch. Worse, a partial
-- enum makes the state machine incomplete in a way that is only
-- visible in the gaps: `cancelled -> refund_pending` looks legal
-- because both labels are there, and nothing says the money
-- path behind it does not exist yet.
--
-- So Phase 2 ships the whole 18-value enum and reaches four of
-- them. The unreached states are unreachable because no code
-- writes them, not because the database would refuse.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §8.1, §24.7
-- ============================================================

do $$ begin
  create type booking_type as enum ('instant', 'scheduled', 'recurring');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status as enum (
    'draft',                -- built in the client, not yet submitted
    'payment_pending',      -- payment order created, awaiting verification
    'paid',                 -- gateway signature / webhook verified
    'searching',            -- matching engine running, offers fanning out
    'assigned',             -- a professional holds an unexpired offer
    'accepted',             -- professional accepted the job
    'on_the_way',           -- professional started travelling
    'arrived',              -- at the address, awaiting OTP
    'otp_verified',         -- OTP consumed; immediately becomes in_progress
    'in_progress',          -- timer running
    'extension_requested',  -- customer asked for more time
    'completed',            -- professional ended the service
    'cancelled',            -- by customer, professional, ops or system
    'refund_pending',       -- cancellation with money to return
    'refunded',             -- refund completed at the gateway
    'disputed',             -- a support ticket flagged the booking
    'no_show',              -- nobody attended
    'closed'                -- rated / archived; terminal
  );
exception when duplicate_object then null; end $$;

comment on type public.booking_status is
  'The 18 states of §8.1. Legality of a move between two of them is not
   decided by this enum — it is decided by enforce_booking_transition() in
   0011, which is the only thing that may write `status`. Phase 2 reaches
   draft, payment_pending, cancelled and (via the seed) paid and in_progress;
   the rest become reachable as their phases land.';


-- ------------------------------------------------------------
-- 0010_bookings.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0010_bookings.sql
-- SmartHelp: the booking itself, its line items, and the
-- trail of states it has been in.
--
-- A booking is three things at once and the table has to hold
-- all three without one of them corrupting the others:
--
--   1. What the customer agreed to. Frozen. `address_snapshot`
--      and `pricing_snapshot` exist so that a later edit to the
--      catalogue, or a correction to the address, cannot rewrite
--      what was agreed. That frozen copy is what a dispute is
--      argued from.
--   2. What it costs. Every money column is computed on the
--      server and never read from the client.
--   3. Where it is in its life. That is not this table's job —
--      0011 owns it, and this table only carries the timestamp
--      columns the individual states stamp.
--
-- Money columns are numeric(12,2) and rate columns are
-- numeric(5,4). Rates are stored as rates — 0.1800, not 18 —
-- because a column called `tax_rate` holding `18` invites
-- somebody to divide by 100 at the read site, and every one of
-- those sites is a place the tax can come out wrong.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.7, §8.1, §24.6
-- ============================================================

-- Declared here, as §24.7 places it in 0010, even though only
-- Phase 3 reads it. Same reasoning as the booking_status enum:
-- the alternative is a second migration that alters a type.
do $$ begin
  create type payment_purpose as enum ('booking', 'extension', 'wallet_topup', 'penalty');
exception when duplicate_object then null; end $$;

-- ── The booking number ─────────────────────────────────────
-- SH-20260926-00124. §24.7 shows a per-day counter restarting at
-- 1 each morning. Implementing that needs a per-day row and a
-- lock to make two simultaneous first-bookings agree, which is a
-- table and a contention point in exchange for cosmetics on a
-- label nobody parses. One global sequence rendered per day
-- gives the same shape, never collides (the unique constraint is
-- the real guarantee) and cannot deadlock at midnight.
create sequence if not exists public.booking_number_seq;

create or replace function public.next_booking_number(p_at timestamptz default now())
returns text
language plpgsql set search_path = public as $$
declare
  n bigint;
begin
  n := nextval('public.booking_number_seq');
  -- Rendered in the booking's own city zone, not the server's:
  -- a booking made at 00:10 IST is the 26th in India even when
  -- the database is configured for UTC.
  return 'SH-' || to_char(p_at at time zone 'Asia/Kolkata', 'YYYYMMDD') || '-' || lpad(n::text, 5, '0');
end $$;

comment on function public.next_booking_number(timestamptz) is
  'Renders the §24.7 booking number from one global sequence, so the suffix is
   unique without a per-day counter row. The date part is rendered in
   Asia/Kolkata because that is the city the booking is in; the sequence is
   global so the number is never ambiguous.';

-- ── bookings ───────────────────────────────────────────────
create table if not exists public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  booking_number      text not null unique,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  professional_id     uuid references public.professionals(id) on delete set null,
  address_id          uuid not null references public.addresses(id) on delete restrict,
  -- Frozen at creation. The dispute evidence (§24.7): an address
  -- corrected or renamed later must not rewrite what the
  -- professional was told to turn up at.
  address_snapshot    jsonb not null,
  locality_id         uuid references public.localities(id) on delete set null,
  city_id             uuid references public.cities(id) on delete set null,

  booking_type        public.booking_type not null,
  status              public.booking_status not null default 'draft',
  -- Optimistic lock (§28.1). Every mutation is
  -- `update … where id = $1 and version = $n`; zero rows
  -- affected is STALE_VERSION, never a silent overwrite. Two
  -- devices rescheduling the same booking produce one winner and
  -- one conflict, not two bookings.
  version             int not null default 1,

  scheduled_start_at  timestamptz,
  scheduled_end_at    timestamptz,
  duration_minutes    int not null check (duration_minutes > 0),
  extended_minutes    int not null default 0,

  -- Money. Computed on the server, frozen at creation (§7.1).
  subtotal            numeric(12,2) not null default 0,
  platform_fee        numeric(12,2) not null default 0,
  discount            numeric(12,2) not null default 0,
  discount_code       text,
  tax                 numeric(12,2) not null default 0,
  tax_rate            numeric(5,4)  not null default 0,
  total_amount        numeric(12,2) not null default 0,
  professional_gross  numeric(12,2) not null default 0,
  commission_pct      numeric(5,4)  not null default 0,
  currency            char(3) not null default 'INR',
  quote_token         text,
  -- Every rule that was applied, in the order it was applied,
  -- with the value of each rule's parameters. §24.7 calls this
  -- "for audit" and that is exactly its job: when a customer
  -- disputes a price six weeks later, the question is what the
  -- engine saw, and a single stored total cannot answer it.
  pricing_snapshot    jsonb not null default '{}'::jsonb,

  -- Service execution. Written by the professional app (Phase 4).
  otp_hash            text,
  otp_expires_at      timestamptz,
  otp_attempts        int not null default 0,
  otp_generations     int not null default 0,
  otp_verified_at     timestamptz,
  started_at          timestamptz,
  ends_at             timestamptz,
  ended_at            timestamptz,
  actual_duration_minutes int,

  -- Assignment and SLA. Phase 5.
  search_started_at   timestamptz,
  search_expires_at   timestamptz,
  matched_at          timestamptz,
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  eta_minutes         int,
  assignment_rounds   int not null default 0,

  -- Cancellation and resolution.
  cancelled_at        timestamptz,
  cancellation_reason_code text,
  cancellation_fee    numeric(12,2) not null default 0,
  completed_at        timestamptz,
  closed_at           timestamptz,
  notes               text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An instant booking is "as soon as we can", so a wall-clock
  -- start on it is a category error rather than a default.
  constraint instant_not_scheduled
    check (booking_type <> 'instant' or scheduled_start_at is null),
  -- Free money is a bug; a negative platform fee is a worse one.
  constraint money_non_negative
    check (subtotal >= 0 and platform_fee >= 0 and discount >= 0
           and tax >= 0 and total_amount >= 0 and professional_gross >= 0),
  -- A rate outside [0,1] means someone stored 18 where 0.18
  -- belongs, which is the mistake numeric(5,4) invites.
  constraint rates_are_rates
    check (tax_rate between 0 and 1 and commission_pct between 0 and 1),
  -- The window has to end after it starts, and a scheduled
  -- booking has to have one.
  constraint window_is_forward
    check (scheduled_start_at is null or scheduled_end_at is null
           or scheduled_end_at > scheduled_start_at),
  constraint scheduled_has_a_start
    check (booking_type = 'instant' or scheduled_start_at is not null)
);

comment on column public.bookings.address_snapshot is
  'The address row frozen at creation: label, type, line1, line2, area, city,
   state, pincode, lat, lng, landmark, access_notes and location_precision.
   A correction to `addresses` must not rewrite what a professional was told to
   turn up at, and this is what a dispute reads.';

comment on column public.bookings.pricing_snapshot is
  'The pricing engine''s full breakdown for this booking: the line inputs, every
   multiplier and coupon applied in order with its parameters, the rounding
   points, and the derived commission_amount and platform_revenue. Those two
   are stored here rather than as columns because they are arithmetic on
   columns that are already stored — a third column would be a second thing to
   drift. §24.7 does not list them as columns and this is where they live.';

comment on column public.bookings.quote_token is
  'The signed quote the customer confirmed, kept for the trail. It is NOT what
   enforces the price: the server re-derives the price on every create and
   compares (§7.2). A tampered amount is PRICE_CHANGED whether or not a token
   was presented.';

-- Indexes from §24.7. The Phase-5 ones are declared now rather
-- than later, because an index is cheap to add to an empty table
-- and expensive to add to a live one — and `create index` on
-- `bookings` blocks writes for as long as it runs.
create index if not exists idx_bookings_customer
  on public.bookings (customer_id, created_at desc);
create index if not exists idx_bookings_profession
  on public.bookings (professional_id, scheduled_start_at desc);
create index if not exists idx_bookings_status
  on public.bookings (status, created_at desc);
create index if not exists idx_bookings_upcoming
  on public.bookings (scheduled_start_at)
  where status in ('paid','searching','assigned','accepted');
create index if not exists idx_bookings_search_exp
  on public.bookings (search_expires_at) where status = 'searching';
create index if not exists idx_bookings_city_date
  on public.bookings (city_id, scheduled_start_at);
create index if not exists idx_bookings_number
  on public.bookings (booking_number text_pattern_ops);

-- §24.7 writes this as
--   point(address_snapshot->>'lng', address_snapshot->>'lat')
-- which does not compile: jsonb ->> yields text, and there is no
-- point(text, text). The casts are what the index needs, and the
-- GiST operator class comes from btree_gist, which 0002 already
-- installed for the same reason.
create index if not exists idx_bookings_geo
  on public.bookings using gist (
    point((address_snapshot->>'lng')::double precision,
          (address_snapshot->>'lat')::double precision)
  );

drop trigger if exists trg_bookings_touch on public.bookings;
create trigger trg_bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();

-- ── booking_items ──────────────────────────────────────────
-- One row per service on the booking. Every descriptive and money
-- column is a snapshot: `service_name` because the catalogue is
-- editable, `unit_price` because the price is, and
-- `scope_snapshot` because the included/excluded list a customer
-- agreed to is the thing a complaint is about.
create table if not exists public.booking_items (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  service_id       uuid not null references public.services(id) on delete restrict,
  service_name     text not null,
  duration_minutes int not null check (duration_minutes > 0),
  unit_price       numeric(10,2) not null,
  quantity         int not null default 1 check (quantity > 0),
  line_total       numeric(12,2) not null check (line_total >= 0),
  scope_snapshot   jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_booking_items_booking
  on public.booking_items (booking_id);
-- One service cannot appear twice on one booking. Two lines for
-- the same service mean the engine is wrong, and a constraint is
-- cheaper than finding out from a customer's total.
create unique index if not exists uniq_booking_service
  on public.booking_items (booking_id, service_id);

-- ── booking_status_history ─────────────────────────────────
create table if not exists public.booking_status_history (
  id          bigserial primary key,
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  from_status public.booking_status,
  to_status   public.booking_status not null,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_role  public.user_role,
  note        text,
  ip          inet,
  created_at  timestamptz not null default now()
);

create index if not exists idx_bsh_booking
  on public.booking_status_history (booking_id, created_at);
create index if not exists idx_bsh_actor
  on public.booking_status_history (actor_id, created_at desc);

comment on table public.booking_status_history is
  'Append-only. Rows are written by enforce_booking_transition() (0011) rather
   than by the Route Handler, so no route can forget and no route can forge a
   hop it did not make. 0011 also installs the immutability trigger: a history
   somebody can edit is not a history.';

-- ── Deferred from Phase 1, landing now ─────────────────────
-- §24.6 defines block_address_delete_with_future_bookings(), which
-- refuses to delete an address a live booking points at. It could
-- not be in 0008 because it names `bookings`, and a migration that
-- references a missing table fails to apply — so it lives here,
-- one file after the last table it needs.
create or replace function public.block_address_delete_with_future_bookings()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_count int;
  v_next  timestamptz;
  v_live  int;
begin
  select count(*),
         min(scheduled_start_at),
         count(*) filter (where status in
           ('draft','payment_pending','paid','searching','assigned','accepted',
            'on_the_way','arrived','otp_verified','in_progress','extension_requested'))
    into v_count, v_next, v_live
    from public.bookings
   where address_id = old.id
     and status <> 'closed';

  -- Every non-closed booking is counted, not only the upcoming ones, because
  -- `bookings.address_id` is ON DELETE RESTRICT (§24.7) and RESTRICT ignores
  -- status: any booking at all pins the address, so a narrower predicate here
  -- would just be handing some cases to the foreign key, and the foreign key's
  -- error is the raw constraint name. A cancelled booking can still be disputed
  -- or refunded, so it legitimately blocks too.
  if v_count > 0 then
    raise exception 'ADDRESS_IN_USE % %', v_count, coalesce(to_char(v_next, 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'unknown')
      using errcode = 'foreign_key_violation',
            detail = format('{"upcomingBookings":%s,"liveBookings":%s,"nextBookingAt":"%s"}',
                            v_count, v_live,
                            coalesce(to_char(v_next, 'YYYY-MM-DD"T"HH24:MI:SSOF'), ''));
  end if;

  return old;
end $$;

comment on function public.block_address_delete_with_future_bookings() is
  'Refuses to delete an address that any non-closed booking points at, and says how
   many and when. Until Phase 2 this was unreachable because nothing referenced an
   address; now a booking does, so the window is real and the guard is not optional.

   Note that this trigger cannot be the only thing standing in the way:
   bookings.address_id is ON DELETE RESTRICT, so a booking in `closed` still pins
   the address and this predicate lets the foreign key raise instead. That is
   intentional — the aggregate of a professional''s rating history and the refund
   trail both need an address that resolves — but it does mean an address a
   customer once booked to is not deletable. Worth revisiting as a product
   question; see the Phase 2 notes.';

drop trigger if exists trg_addresses_block_delete on public.addresses;
create trigger trg_addresses_block_delete before delete on public.addresses
  for each row execute function public.block_address_delete_with_future_bookings();

-- ── RLS ────────────────────────────────────────────────────
-- A booking is a customer's: their address, their money, their
-- professional's name and where they are. No anon grant at all,
-- for the same reason `addresses` has none.
--
-- `professional_id` is readable by that professional because the
-- professional app (Phase 4) needs their own job list, and the
-- alternative — a second table holding the same fact — would be
-- one more thing to keep in step.
alter table public.bookings enable row level security;

do $$ begin
  create policy bookings_select_own on public.bookings for select
    using (customer_id = public.current_customer_id()
           or professional_id = public.current_professional_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bookings_insert_own on public.bookings for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- Deliberately no UPDATE or DELETE policy.
--
-- `status` is owned by enforce_booking_transition() and `version`
-- by the optimistic lock; a policy that let a browser session write
-- either would hand out exactly the two things the state machine
-- exists to protect. Every legitimate write to `bookings` goes
-- through a Route Handler using the service role, which checks
-- ownership and bumps the version itself.
--
-- (The same reasoning applies to `booking_items` and
-- `booking_status_history`: they are written only as part of
-- creating a booking.)

alter table public.booking_items enable row level security;
do $$ begin
  create policy booking_items_select_own on public.booking_items for select
    using (exists (select 1 from public.bookings b
                    where b.id = booking_id
                      and b.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

alter table public.booking_status_history enable row level security;
do $$ begin
  create policy bsh_select_own on public.booking_status_history for select
    using (exists (select 1 from public.bookings b
                    where b.id = booking_id
                      and b.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

-- The transition trigger writes history as `SECURITY DEFINER`, so
-- it does not go through these policies — but a reader must still
-- not be able to forge one, hence no INSERT grant either.
revoke all on public.bookings from anon;
revoke all on public.booking_items from anon;
revoke all on public.booking_status_history from anon;

grant select on public.bookings to authenticated;
grant select, insert on public.booking_items to authenticated;
grant select on public.booking_status_history to authenticated;

grant execute on function public.next_booking_number(timestamptz) to service_role;


-- ------------------------------------------------------------
-- 0011_booking_state_machine.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0011_booking_state_machine.sql
-- SmartHelp: the only thing that may write `bookings.status`.
--
-- §8.2 requires the transition table to be enforced twice: once
-- by the API guard, so the customer sees a sentence, and once by
-- Postgres, so that the guarantee does not depend on every future
-- caller remembering. This file is the second half, and it is the
-- half that matters.
--
-- Why a trigger and not application code:
--
--   A policy that let a browser session UPDATE `bookings` — or a
--   Route Handler written next year that forgets to call the
--   guard — can produce `refunded -> paid`. There is no test that
--   catches that, because the test would have to enumerate every
--   way to write the column. The trigger makes the answer a
--   property of the database instead of a property of the code.
--
-- It also writes `booking_status_history` itself, in the same
-- statement, so a hop cannot happen without leaving a trace and a
-- trace cannot be written without a hop.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §8.2
-- ============================================================

create or replace function public.enforce_booking_transition()
returns trigger
language plpgsql set search_path = public as $$
declare
  allowed text[];
  v_note  text;
  v_actor uuid;
  v_role  public.user_role;
begin
  -- Nothing to enforce on the way in: a booking is born `draft`.
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is not distinct from old.status then
    -- Not a transition. A reschedule, a cancellation fee or a note
    -- all update this row without moving it, and raising here would
    -- break every one of them.
    return new;
  end if;

  -- §8.2's table, read as "which states may legally become this
  -- one". Listed from NEW.status exactly as the specification
  -- writes it, so the two can be diffed by eye.
  allowed := case new.status
    when 'payment_pending'      then array['draft']
    when 'paid'                 then array['payment_pending']
    when 'searching'            then array['paid']
    when 'assigned'             then array['searching']
    when 'accepted'             then array['assigned']
    when 'on_the_way'           then array['accepted']
    when 'arrived'              then array['on_the_way']
    when 'otp_verified'         then array['arrived']
    when 'in_progress'          then array['otp_verified','extension_requested']
    when 'extension_requested'  then array['in_progress']
    when 'completed'            then array['in_progress']
    -- `paid..accepted -> cancelled` and `accepted..in_progress ->
    -- cancelled` from the table, flattened.
    when 'cancelled'            then array['draft','payment_pending','paid','searching',
                                              'assigned','accepted','on_the_way','arrived',
                                              'otp_verified','in_progress','extension_requested']
    when 'refund_pending'       then array['cancelled','paid','accepted','on_the_way',
                                              'arrived','disputed']
    when 'refunded'             then array['refund_pending']
    when 'disputed'             then array['accepted','on_the_way','arrived',
                                              'in_progress','completed']
    when 'no_show'              then array['accepted','on_the_way','arrived',
                                              'otp_verified','in_progress']
    when 'closed'               then array['completed','refunded','no_show']
    else array[]::text[]
  end;

  if not (old.status::text = any(allowed)) then
    raise exception 'ILLEGAL_TRANSITION % -> % on booking %',
      old.status, new.status, old.id
      using errcode = 'check_violation',
            detail = format('{"from":"%s","to":"%s"}', old.status, new.status);
  end if;

  -- §8.2 takes the actor from `auth.uid()` and `auth.jwt()->>'role'`.
  -- That is null on every privileged write in this codebase: Route
  -- Handlers reach Postgres through the service-role client, so
  -- there is no customer JWT inside the database and the trail would
  -- be anonymous for exactly the events that matter — a
  -- cancellation, a refund, an ops override.
  --
  -- So the caller sets both as transaction-local settings, having
  -- already validated who they are, and the auth values are only a
  -- fallback for a direct browser write that somehow got a policy.
  v_note  := current_setting('app.transition_note', true);
  v_actor := nullif(current_setting('app.transition_actor', true), '')::uuid;
  v_role  := nullif(current_setting('app.transition_actor_role', true), '')::public.user_role;

  if v_actor is null then
    v_actor := auth.uid();
  end if;
  if v_role is null then
    v_role := nullif(auth.jwt() ->> 'role', '')::public.user_role;
  end if;

  insert into public.booking_status_history
    (booking_id, from_status, to_status, actor_id, actor_role, note)
  values
    (new.id, old.status, new.status, v_actor, v_role, v_note);

  return new;
end $$;

comment on function public.enforce_booking_transition() is
  'The §8.2 transition table, enforced in Postgres. Raises ILLEGAL_TRANSITION
   (check_violation, which the Route Handler maps to 409) for any move outside
   the legal set, and writes booking_status_history for every legal one. The
   application guard in lib/bookingServer.ts exists to produce a readable error;
   this trigger is what makes the state safe.';

drop trigger if exists trg_booking_transition on public.bookings;
create trigger trg_booking_transition
  before update of status on public.bookings
  for each row execute function public.enforce_booking_transition();

-- A second trigger, AFTER, to bump the version on every write —
-- not only on a status change. A reschedule that forgot to bump it
-- would let a second device reschedule from a window that has
-- already moved, which is the exact double-booking the lock exists
-- to prevent.
--
-- Kept separate from the status trigger so that "did the state
-- change?" and "did anything change?" stay two questions. Merging
-- them would mean a reschedule silently skips the version bump.
create or replace function public.bump_booking_version()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status
     or new.scheduled_start_at is distinct from old.scheduled_start_at
     or new.scheduled_end_at is distinct from old.scheduled_end_at
     or new.duration_minutes is distinct from old.duration_minutes
     or new.notes is distinct from old.notes then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_booking_version on public.bookings;
create trigger trg_booking_version
  before update on public.bookings
  for each row execute function public.bump_booking_version();

comment on function public.bump_booking_version() is
  'Optimistic-lock bump (§28.1). Only the fields a second device could race on
   move the version: a status change, a window change, a duration change or a
   note. A pure read-side UPDATE — touching updated_at — does not, so a no-op
   write cannot make a client''s held version stale for no reason.';

-- ── The history is append-only ─────────────────────────────
-- Same shape as audit_logs_are_immutable() in 0024, because a
-- status history somebody can edit is not one. audit_logs is
-- never cascaded away, so it can refuse every delete; this one
-- cannot, because `bookings.booking_id` is ON DELETE CASCADE and
-- the booking has to be removable.
--
-- The distinction the first version got wrong: the trigger fired
-- on the cascade too, so `delete from bookings` failed with
-- BOOKING_HISTORY_IMMUTABLE and no booking could ever be deleted.
--
-- Postgres runs a referential action from an AFTER trigger on the
-- parent, so by the time the child's BEFORE DELETE fires the parent
-- row is already gone. Testing for the parent's existence is
-- therefore exactly the discriminator wanted: cascade finds no
-- parent and is allowed, a hand-rolled `delete from
-- booking_status_history` finds one and is refused.
create or replace function public.booking_history_is_immutable()
returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- Every update is refused, full stop. Returning OLD here instead would make
    -- the trigger silently discard the change rather than report it: the caller
    -- sees no error, believes the note was rewritten, and the trail disagrees.
    -- A guard that quietly does nothing is worse than no guard, because it looks
    -- like it worked.
    raise exception 'BOOKING_HISTORY_IMMUTABLE' using errcode = 'insufficient_privilege',
      detail = '{"hint":"history rows are append-only; they go away only with the booking itself"}';
  end if;

  -- DELETE is refused unless it is the cascade from a dropped booking. Postgres
  -- fires the referential action from an AFTER trigger on the parent, so by the
  -- time this runs on the child the booking is already gone — which is the
  -- discriminator.
  if exists (select 1 from public.bookings where id = old.booking_id) then
    raise exception 'BOOKING_HISTORY_IMMUTABLE' using errcode = 'insufficient_privilege',
      detail = '{"hint":"history rows are append-only; they go away only with the booking itself"}';
  end if;

  return old;
end $$;

comment on function public.booking_history_is_immutable() is
  'Refuses edits and refuses a hand-rolled delete, but permits the cascade from a
   deleted booking — which is why the guard tests whether the parent row still
   exists rather than firing unconditionally. Dropping a booking takes its trail
   with it; rewriting or orphaning it is not allowed.';

drop trigger if exists trg_bsh_immutable on public.booking_status_history;
create trigger trg_bsh_immutable
  before update or delete on public.booking_status_history
  for each row execute function public.booking_history_is_immutable();

revoke all on function public.booking_history_is_immutable() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 0013_professional_schedule.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0013_professional_schedule.sql
-- SmartHelp: reserved windows on a professional's calendar.
--
-- `professional_working_hours` (0005) says when someone is
-- generally willing to work; this says when they are actually
-- spoken for. A booking takes a window out of the calendar the
-- moment it is created, not when it is accepted or paid, because
-- by then the customer has already been told this professional is
-- available at that time and telling them otherwise afterwards is
-- the cancellation they would rather avoid.
--
-- The overlap guarantee is a GiST exclusion constraint rather
-- than application code that checks "is this window free?". An
-- availability check is a read followed by a write, and two
-- concurrent bookings for the same slot both read "free". The
-- constraint is atomic: the second insert simply fails, and the
-- application catches that and offers the next slot. Nothing has
-- to be trusted.
--
-- btree_gist comes from 0002, which installed it for
-- local/city/service_areas. `professional_id WITH =` needs it
-- because that operator class is otherwise text-only.
--
-- `booking_assignments` and `assignment_status` are also declared
-- in §24.9 but are deliberately NOT here — they belong to the
-- matching engine, and a table with no matching engine behind it
-- is a table that can only ever contain rows nothing wrote.
-- They land in 0012 with Phase 5.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.9
-- ============================================================

do $$ begin
  create type schedule_status as enum ('reserved', 'in_progress', 'completed', 'released');
exception when duplicate_object then null; end $$;

create table if not exists public.professional_schedule (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  -- Nullable: a block of time off does not belong to a booking.
  booking_id      uuid references public.bookings(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          public.schedule_status not null default 'reserved',
  created_at      timestamptz not null default now(),
  constraint valid_window check (ends_at > starts_at),
  -- A reserved window has to say whose booking it is. Without this, a
  -- cancelled booking's window could be released by a row that never
  -- had one, and the calendar would drift away from the bookings.
  constraint reserved_needs_booking
    check (status <> 'reserved' or booking_id is not null)
);

comment on table public.professional_schedule is
  'Time a professional has spoken for. `reserved` rows are created when a booking
   is created and released on cancellation; `released` rows are kept as the trail
   rather than deleted, so a later dispute can see that the slot did exist. The
   exclusion constraint is the double-booking guarantee and it is atomic — an
   availability check would not be.';

-- Overlapping live windows are structurally impossible.
--
-- The WHERE clause is what makes this survivable in production. Without it a
-- completed booking from last week would block the same slot forever, and the
-- calendar would be permanently full as soon as it had any history. Only the
-- two states that actually occupy time are excluded.
do $$ begin
  alter table public.professional_schedule
    add constraint professional_no_overlap exclude using gist (
      professional_id with =,
      tstzrange(starts_at, ends_at, '[)') with &&
    ) where (status in ('reserved', 'in_progress'));
exception when duplicate_object then null; end $$;

comment on constraint professional_no_overlap on public.professional_schedule is
  'The double-booking guarantee (§24.9). Two transactions reserving the same
   window cannot both win: the loser gets exclusion_violation (23P01), which
   lib/bookingServer.ts turns into the next available slot rather than a 500.';

create index if not exists idx_schedule_prof
  on public.professional_schedule (professional_id, starts_at);
create index if not exists idx_schedule_booking
  on public.professional_schedule (booking_id);

-- `professional_working_hours` answers "when could they work"; this answers
-- "when are they spoken for". Availability is the difference, and Phase 2 needs
-- both to tell a customer the truth about a slot.
create index if not exists idx_schedule_live
  on public.professional_schedule (professional_id, starts_at)
  where status in ('reserved', 'in_progress');

-- ── RLS ────────────────────────────────────────────────────
-- Readable by the professional it belongs to and by the customer
-- who booked it — a customer has to see that the slot they hold is
-- genuinely held.
--
-- Written only by the service role from the booking Route Handlers,
-- which create and release the window as part of the same
-- transaction as the booking itself. No INSERT policy: a row here
-- that no booking created is a row the exclusion constraint is
-- honouring while nothing occupies that time.
alter table public.professional_schedule enable row level security;

do $$ begin
  create policy schedule_select_related on public.professional_schedule for select
    using (professional_id = public.current_professional_id()
           or exists (select 1 from public.bookings b
                       where b.id = booking_id
                         and b.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

revoke all on public.professional_schedule from anon;
grant select on public.professional_schedule to authenticated;


-- ------------------------------------------------------------
-- 0016_coupons.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0016_coupons.sql
-- SmartHelp: coupons and the ledger of who used one where.
--
-- The design decision here is that `coupons.usage_count` is a
-- cache, never the truth. `coupon_usage` is the truth: one row
-- per booking that spent a coupon, and a unique index on
-- booking_id makes "one coupon per booking" a property of the
-- schema instead of a check the pricing engine has to remember
-- to run.
--
-- The alternative — a counter incremented on the coupons row —
-- makes the count a thing that can disagree with the rows it
-- summarises, and a discount that has been over-redeemed is the
-- kind of bug that shows up as money. A limit is then a read
-- under contention on a hot row, for no reason: the count is
-- already available as `select count(*)`.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.7
-- ============================================================

do $$ begin
  create type discount_type as enum ('percentage', 'fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.coupons (
  id                      uuid primary key default gen_random_uuid(),
  code                    text not null,
  description             text,
  discount_type           public.discount_type not null,
  discount_value          numeric(10,2) not null check (discount_value > 0),
  -- The cap that stops a 50% coupon being applied to a large
  -- booking. Only meaningful for percentages.
  max_discount            numeric(10,2),
  min_booking_amount      numeric(10,2) not null default 0,
  -- A belt-and-braces ceiling: no single coupon may take more than
  -- this share of the total even if max_discount is set higher.
  -- A marketing mistake in the coupon row must not be able to
  -- produce a negative payable.
  max_discount_pct_of_total numeric(5,2) not null default 40.00,
  valid_from              timestamptz not null default now(),
  valid_to                timestamptz,
  usage_limit             int,
  usage_count             int not null default 0 check (usage_count >= 0),
  per_user_limit          int not null default 1,
  -- Empty array means "all", which is what makes a sitewide coupon
  -- a row with two empty arrays rather than a join table.
  applicable_services     uuid[] not null default '{}',
  applicable_cities       uuid[] not null default '{}',
  first_time_only         boolean not null default false,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- A percentage discount with no cap can be set to 100 and
  -- produce a zero, or above 100 and produce a negative.
  constraint percentage_needs_cap
    check (discount_type <> 'percentage' or max_discount is not null),
  constraint percentage_is_sane
    check (discount_type <> 'percentage' or discount_value <= 100),
  constraint window_is_forward
    check (valid_to is null or valid_to > valid_from),
  constraint cap_is_usable
    check (max_discount is null or max_discount > 0),
  constraint counts_are_positive
    check (usage_limit is null or usage_limit > 0)
);

comment on column public.coupons.usage_count is
  'A denormalised count of coupon_usage rows, maintained by the booking Route
   Handler. It exists so the catalogue can render "3 of 10 left" without a
   correlated count on every listing, and it is NOT what enforces usage_limit —
   coupon_usage is. Treat a disagreement as a bug to report, not something to
   reconcile at read time.';

comment on column public.coupons.max_discount_pct_of_total is
  'The hard ceiling on any one coupon, independent of max_discount. A coupon
   misconfigured with max_discount above the total would otherwise drive the
   discount above the subtotal and the total negative, so this is the last check
   before the money stops making sense.';

-- Case-insensitive: a customer types the code, and "SAVE20" and "save20" being
-- different coupons is a support ticket rather than a feature.
create unique index if not exists uniq_coupons_code on public.coupons (upper(code));
create index if not exists idx_coupons_active
  on public.coupons (is_active, valid_from, valid_to);

drop trigger if exists trg_coupons_touch on public.coupons;
create trigger trg_coupons_touch before update on public.coupons
  for each row execute function public.touch_updated_at();

-- ── The ledger ─────────────────────────────────────────────
create table if not exists public.coupon_usage (
  id               uuid primary key default gen_random_uuid(),
  coupon_id        uuid not null references public.coupons(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  -- What this coupon was actually worth, after the cap. Storing the
  -- realised amount rather than re-deriving it from coupon_id means a
  -- later edit to the coupon cannot change what a past booking was
  -- actually charged.
  discount_amount  numeric(10,2) not null check (discount_amount > 0),
  used_at          timestamptz not null default now()
);

-- One coupon per booking. This is the whole reason the table exists:
-- a constraint, not an `if`.
create unique index if not exists uniq_coupon_usage_booking
  on public.coupon_usage (booking_id);
create index if not exists idx_coupon_usage_coupon
  on public.coupon_usage (coupon_id, customer_id);
-- Per-user limit is enforced by counting these rows for a customer.
create index if not exists idx_coupon_usage_customer
  on public.coupon_usage (customer_id, coupon_id, used_at desc);

comment on table public.coupon_usage is
  'Append-only. Row exists means the coupon was spent. A cancelled booking may
   release it, which is a deletion here — the discount stops counting because
   the ledger row went with the booking.';

-- ── RLS ────────────────────────────────────────────────────
-- A coupon is public information; its redemption history is not.
alter table public.coupons enable row level security;

do $$ begin
  create policy coupons_read_authenticated on public.coupons for select
    using (is_active);
exception when duplicate_object then null; end $$;

alter table public.coupon_usage enable row level security;

do $$ begin
  create policy coupon_usage_select_own on public.coupon_usage for select
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- No INSERT policy: a redemption is written by the booking Route
-- Handler in the same transaction as the booking. A client that
-- could insert here could mark a coupon as spent without a booking.
revoke all on public.coupon_usage from anon;
grant select on public.coupon_usage to authenticated;
grant select on public.coupons to anon, authenticated;


-- ------------------------------------------------------------
-- 0017_ratings.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0017_ratings.sql
-- SmartHelp: one review per completed booking.
--
-- A rating is the one table here that is mostly a claim about
-- something else — it asserts that a booking happened, that this
-- customer was in it, that this professional did it, and that it
-- finished. All four are checkable against `bookings`, so they
-- are checked in the database rather than in the Route Handler.
--
-- The reason is trust, not tidiness. If `customer_id` and
-- `professional_id` are whatever the caller passed, then anyone
-- with a booking id can rate any professional — and the rating
-- table is what every professional's public reputation is
-- computed from. That is a single-request path to a defamatory
-- review of an arbitrary person, so the invariant is a BEFORE
-- INSERT trigger rather than a line in a handler that a future
-- handler might not have.
--
-- §24.7 also declares `favourites` in this file. It is not here:
-- favourites are a Phase 5 feature and an empty table nobody
-- writes is a table that only makes the schema harder to read.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.7, §8.1
-- ============================================================

create table if not exists public.ratings (
  id               uuid primary key default gen_random_uuid(),
  -- UNIQUE does double duty: one review per booking (the edit path
  -- updates), and it makes a duplicate POST fail at the database
  -- rather than being deduped in application code.
  booking_id       uuid not null unique references public.bookings(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  overall          int not null check (overall between 1 and 5),
  professionalism  int check (professionalism between 1 and 5),
  quality          int check (quality between 1 and 5),
  punctuality      int check (punctuality between 1 and 5),
  behaviour        int check (behaviour between 1 and 5),
  cleanliness      int check (cleanliness between 1 and 5),
  comment          text check (char_length(comment) <= 1000),
  pro_response     text check (char_length(pro_response) <= 250),
  is_hidden        boolean not null default false,
  hidden_by        uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  responded_at     timestamptz
);

create index if not exists idx_ratings_pro
  on public.ratings (professional_id, created_at desc);
create index if not exists idx_ratings_cust
  on public.ratings (customer_id, created_at desc);
-- Moderation reads hidden rows; the public profile reads visible ones. Without
-- the partial index the moderation query scans every visible review too.
create index if not exists idx_ratings_hidden
  on public.ratings (professional_id, created_at desc) where is_hidden;

comment on table public.ratings is
  'Reviews. The public aggregate for a professional is computed over rows where
   is_hidden is false; hidden rows stay for moderation history rather than being
   deleted, so an admin action can be explained later. Only completed bookings
   may be rated — enforced by validate_rating_booking(), not by the API.';

-- ── The eligibility check ──────────────────────────────────
create or replace function public.validate_rating_booking()
returns trigger
language plpgsql set search_path = public as $$
declare
  b public.bookings%rowtype;
begin
  select * into b from public.bookings where id = new.booking_id;

  if not found then
    raise exception 'RATING_NO_SUCH_BOOKING' using errcode = 'foreign_key_violation';
  end if;

  -- The three things a rating asserts, each checked against the row
  -- that is supposed to prove it.
  if b.customer_id is distinct from new.customer_id then
    raise exception 'RATING_CUSTOMER_MISMATCH' using errcode = 'check_violation',
      detail = format('{"bookingCustomer":"%s"}', b.customer_id);
  end if;

  if b.professional_id is distinct from new.professional_id then
    raise exception 'RATING_PROFESSIONAL_MISMATCH' using errcode = 'check_violation',
      detail = format('{"bookingProfessional":"%s"}', b.professional_id);
  end if;

  -- §8.1: `closed` is reachable only from completed/refunded/no_show. A
  -- rating is the thing that normally closes a completed booking, so the gate
  -- is "has the service finished", not "is the booking closed" — otherwise
  -- there would be no way to ever rate anything.
  if b.status not in ('completed', 'closed') then
    raise exception 'RATING_NOT_ALLOWED %', b.status using errcode = 'check_violation',
      detail = format('{"bookingStatus":"%s"}', b.status);
  end if;

  new.professional_id := coalesce(b.professional_id, new.professional_id);
  return new;
end $$;

comment on function public.validate_rating_booking() is
  'Stops anyone rating a booking they were not part of, for a professional who
   did not do it, or for a service that has not finished. This is the trust
   boundary for the whole reputation system, so it lives in Postgres: a rating is
   what every professional''s public score is computed from, and application-level
   checks are only as strong as the least careful future caller.';

drop trigger if exists trg_rating_validate on public.ratings;
create trigger trg_rating_validate before insert on public.ratings
  for each row execute function public.validate_rating_booking();

-- Moderation must not be able to change who rated whom or what the scores were —
-- only whether the row is shown. Without this, an admin "hiding" a review could
-- quietly rewrite its contents on the way past.
--
-- DELETE is refused for a hand-rolled delete but permitted for the cascade from a
-- dropped booking, which is the same discrimination booking_status_is_immutable()
-- makes: Postgres fires the referential action from an AFTER trigger on the
-- parent, so by the time this fires on the child the booking is already gone.
create or replace function public.guard_rating_immutability()
returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.bookings where id = old.booking_id) then
      raise exception 'RATING_DELETE_FORBIDDEN'
        using errcode = 'insufficient_privilege',
              detail = '{"hint":"set is_hidden instead — a deleted review leaves a gap in the aggregate"}';
    end if;
    return old;
  end if;

  if new.booking_id        is distinct from old.booking_id
     or new.customer_id    is distinct from old.customer_id
     or new.professional_id is distinct from old.professional_id
     or new.overall         is distinct from old.overall
     or new.professionalism is distinct from old.professionalism
     or new.quality         is distinct from old.quality
     or new.punctuality     is distinct from old.punctuality
     or new.behaviour       is distinct from old.behaviour
     or new.cleanliness     is distinct from old.cleanliness
     or new.comment         is distinct from old.comment then
    raise exception 'RATING_IMMUTABLE' using errcode = 'insufficient_privilege',
      detail = '{"hint":"only is_hidden, hidden_by, pro_response and responded_at may change"}';
  end if;

  return new;
end $$;

comment on function public.guard_rating_immutability() is
  'Ratings are append-only in substance: moderation may hide a row but may not
   rewrite the scores, the comment, or who rated whom. Deletes are refused unless
   they are the cascade from a deleted booking — a review outlives its
   cancellation, and the aggregate for a professional is computed over visible
   rows, so a silent delete would leave a hole nobody can account for.';

drop trigger if exists trg_rating_guard on public.ratings;
create trigger trg_rating_guard before update or delete on public.ratings
  for each row execute function public.guard_rating_immutability();

-- ── RLS ────────────────────────────────────────────────────
-- Visible reviews are public — they are the reason the table
-- exists. Hidden ones are not, and the policy is what stops a
-- hidden review leaking through an open data view.
alter table public.ratings enable row level security;

do $$ begin
  create policy ratings_read_visible on public.ratings for select
    using (not is_hidden);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy ratings_insert_own on public.ratings for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- The professional can answer a review of their own work. Nothing
-- else about the row is writable by them — the guard trigger would
-- stop it anyway, but a policy that permits it is a trap for the
-- next reader.
do $$ begin
  create policy ratings_pro_respond on public.ratings for update
    using (professional_id = public.current_professional_id())
    with check (professional_id = public.current_professional_id());
exception when duplicate_object then null; end $$;

grant select on public.ratings to anon, authenticated;
grant insert on public.ratings to authenticated;
grant update (pro_response, responded_at) on public.ratings to authenticated;


-- ------------------------------------------------------------
-- 0024_audit_idempotency.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0024_audit_idempotency.sql
-- SmartHelp: the append-only audit trail and the idempotency
-- ledger.
--
-- Placement note: the delivery plan places this migration in Phase 9,
-- but the Phase 0 auth routes are already privileged writes, and the
-- Definition of Done requires every privileged route to leave an
-- audit row. The two tables are self-contained — no Phase 1-8 table is
-- referenced — so the file is applied in Phase 0 and needs no edit in
-- the phase it was named for.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.13, §28.2, §26.2
-- ============================================================

-- ── Audit log ──────────────────────────────────────────────
-- Append only. No UPDATE, no DELETE, from anyone: the trigger refuses
-- them even for the service role, because an audit trail that can be
-- rewritten is not a trail.
create table if not exists public.audit_logs (
  id               uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_role       public.user_role,
  action           text not null,          -- 'booking.create', 'refund.execute', …
  entity_type      text not null,          -- 'bookings', 'payments', …
  entity_id        text,
  before_state     jsonb,
  after_state      jsonb,
  metadata         jsonb,
  ip_address       text,
  user_agent       text,
  request_id       text,
  created_at       timestamptz not null default now()
);

create index if not exists idx_audit_created on public.audit_logs (created_at desc);
create index if not exists idx_audit_entity  on public.audit_logs (entity_type, entity_id, created_at desc);
create index if not exists idx_audit_actor   on public.audit_logs (actor_profile_id, created_at desc);
create index if not exists idx_audit_action  on public.audit_logs (action, created_at desc);

create or replace function public.audit_logs_are_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_LOG_IMMUTABLE' using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists trg_audit_logs_immutable on public.audit_logs;
create trigger trg_audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.audit_logs_are_immutable();

-- The single writer. Every privileged Route Handler calls this; nothing
-- else may insert, so a stray client INSERT cannot forge a trail.
create or replace function public.write_audit(
  p_actor_profile_id uuid,
  p_action           text,
  p_entity_type      text,
  p_entity_id        text default null,
  p_before_state     jsonb default null,
  p_after_state      jsonb default null,
  p_metadata         jsonb default null,
  p_ip_address       text default null,
  p_user_agent       text default null,
  p_request_id       text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_profile_id;

  insert into public.audit_logs (
    actor_profile_id, actor_role, action, entity_type, entity_id,
    before_state, after_state, metadata, ip_address, user_agent, request_id
  ) values (
    p_actor_profile_id, v_role, p_action, p_entity_type, p_entity_id,
    p_before_state, p_after_state, p_metadata, p_ip_address, p_user_agent, p_request_id
  )
  returning id into v_id;

  return v_id;
end $$;

-- ── Idempotency ledger ─────────────────────────────────────
-- One row per (key, operation, caller). A replay of the same key with
-- the same body returns the stored response; a replay with a different
-- body is a conflict, because it means the client changed its mind
-- under a key it had already spent.
create table if not exists public.idempotency_keys (
  id             uuid primary key default gen_random_uuid(),
  key            text not null,
  operation      text not null,
  actor_profile_id uuid references public.profiles(id) on delete cascade,
  request_hash   text not null,          -- sha256 of the canonical body
  response_status int,
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  unique (key, operation, actor_profile_id)
);

create index if not exists idx_idempotency_created on public.idempotency_keys (created_at desc);

-- Claim a key, or return the already-stored response.
-- Returns: 'claimed' | 'replay' | 'in_flight' | 'conflict'
create or replace function public.claim_idempotency_key(
  p_key             text,
  p_operation       text,
  p_actor_profile_id uuid,
  p_request_hash    text
) returns table (
  outcome          text,
  stored_status    int,
  stored_body      jsonb
)
language plpgsql security definer set search_path = public as $$
declare
  r public.idempotency_keys;
begin
  select * into r
  from public.idempotency_keys
  where key = p_key and operation = p_operation and actor_profile_id = p_actor_profile_id;

  if not found then
    insert into public.idempotency_keys (key, operation, actor_profile_id, request_hash)
    values (p_key, p_operation, p_actor_profile_id, p_request_hash)
    on conflict do nothing;
    return query select 'claimed'::text, null::int, null::jsonb;
    return;
  end if;

  if r.request_hash <> p_request_hash then
    return query select 'conflict'::text, null::int, null::jsonb;
    return;
  end if;

  if r.completed_at is null then
    return query select 'in_flight'::text, null::int, null::jsonb;
    return;
  end if;

  return query select 'replay'::text, r.response_status, r.response_body;
end $$;

create or replace function public.complete_idempotency_key(
  p_key         text,
  p_operation   text,
  p_actor_profile_id uuid,
  p_status       int,
  p_body         jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.idempotency_keys
     set response_status = p_status,
         response_body   = p_body,
         completed_at    = now()
   where key = p_key and operation = p_operation and actor_profile_id = p_actor_profile_id;
end $$;

-- ── RLS ────────────────────────────────────────────────────
alter table public.audit_logs      enable row level security;
alter table public.idempotency_keys enable row level security;

-- Staff-readable, nobody-writable. The insert path is write_audit() only.
do $$ begin
  create policy audit_read_staff on public.audit_logs for select
    using (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_no_write on public.audit_logs for insert with check (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_no_update on public.audit_logs for update using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_no_delete on public.audit_logs for delete using (false);
exception when duplicate_object then null; end $$;

-- A caller sees only their own keys, and only while they are in flight.
do $$ begin
  create policy idempotency_select_own on public.idempotency_keys for select
    using (actor_profile_id = auth.uid() and completed_at is null);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy idempotency_claim_own on public.idempotency_keys for insert
    with check (actor_profile_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy idempotency_complete_own on public.idempotency_keys for update
    using (actor_profile_id = auth.uid())
    with check (actor_profile_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy idempotency_no_delete on public.idempotency_keys for delete using (false);
exception when duplicate_object then null; end $$;

-- Nobody writes directly. The only insert path is write_audit().
-- SELECT is retained for `authenticated` so that the RLS policies above are
-- the thing that actually decides visibility — revoking the table grant
-- instead would make every policy on it decorative.
revoke all on public.audit_logs from anon;
revoke insert, update, delete on public.audit_logs from authenticated;
grant select on public.audit_logs to authenticated;

revoke all on public.idempotency_keys from anon;
revoke delete on public.idempotency_keys from authenticated;
grant select, insert, update on public.idempotency_keys to authenticated;

-- The functions are security definer, so their bodies already run with the
-- owner's rights; the EXECUTE grant is what the *caller* needs. Default ACL
-- gives EXECUTE to PUBLIC, and revoking from PUBLIC also takes it away from
-- service_role — which would make every privileged route's RPC fail with
-- `permission denied for function`. Re-grant it explicitly, to service_role
-- only: the browser must never be able to write an audit row.
revoke all on function public.write_audit(uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_idempotency_key(text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_idempotency_key(text, text, uuid, int, jsonb) from public, anon, authenticated;

grant execute on function public.write_audit(uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text) to service_role;
grant execute on function public.claim_idempotency_key(text, text, uuid, text) to service_role;
grant execute on function public.complete_idempotency_key(text, text, uuid, int, jsonb) to service_role;


-- ------------------------------------------------------------
-- 0025_storage_policies.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0025_storage_policies.sql
-- The object policies for the six buckets created in
-- 0000_storage_buckets.sql.
--
-- These were originally in 0000, which cannot work: a policy body
-- is checked when the policy is created, and they call
-- public.is_admin() (0001) and public.current_professional_id()
-- (0005). On a fresh project, applying in filename order therefore
-- failed at the very first file with
-- "function public.is_admin() does not exist".
--
-- 0025 sorts after both, so the functions exist when these are
-- created. Nothing here depends on anything later.
--
-- Idempotent: every policy is created inside a block that swallows
-- duplicate_object, so a re-run is a no-op rather than an error.
-- Spec: §24.15, §27
-- ============================================================

-- ── service-media: world-readable, admin-written ────────────
do $$ begin
  create policy service_media_public_read on storage.objects for select
    using (bucket_id = 'service-media');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_media_admin_write on storage.objects for insert
    with check (bucket_id = 'service-media' and public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_media_admin_update on storage.objects for update
    using (bucket_id = 'service-media' and public.is_admin())
    with check (bucket_id = 'service-media' and public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_media_admin_delete on storage.objects for delete
    using (bucket_id = 'service-media' and public.is_admin());
exception when duplicate_object then null; end $$;

-- ── pro-photos: public bucket, but a pro may only write its own folder.
--    Objects are named '<profileId>/<filename>' by the upload route.
do $$ begin
  create policy pro_photos_public_read on storage.objects for select
    using (bucket_id = 'pro-photos');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_photos_insert_own on storage.objects for insert
    with check (bucket_id = 'pro-photos'
                and (public.is_admin()
                     or (storage.foldername(name))[1] = auth.uid()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_photos_update_own on storage.objects for update
    using (bucket_id = 'pro-photos'
           and (public.is_admin()
                or (storage.foldername(name))[1] = auth.uid()::text))
    with check (bucket_id = 'pro-photos'
                and (public.is_admin()
                     or (storage.foldername(name))[1] = auth.uid()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_photos_delete_own on storage.objects for delete
    using (bucket_id = 'pro-photos'
           and (public.is_admin()
                or (storage.foldername(name))[1] = auth.uid()::text));
exception when duplicate_object then null; end $$;

-- ── kyc-documents: private. There is deliberately NO select policy,
--    so a signed-in professional cannot read the object back with the
--    anon key. Metadata lives in professional_documents; the bytes are
--    fetched through a staff-guarded signed URL (Phase 4).
--    Objects are named '<professionalId>/<docType>/<file>'.
do $$ begin
  create policy kyc_insert_own on storage.objects for insert
    with check (bucket_id = 'kyc-documents'
                and (public.is_admin()
                     or (storage.foldername(name))[1] =
                         public.current_professional_id()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy kyc_update_own on storage.objects for update
    using (bucket_id = 'kyc-documents'
           and (public.is_admin()
                or (storage.foldername(name))[1] =
                    public.current_professional_id()::text))
    with check (bucket_id = 'kyc-documents'
                and (public.is_admin()
                     or (storage.foldername(name))[1] =
                         public.current_professional_id()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy kyc_admin_delete on storage.objects for delete
    using (bucket_id = 'kyc-documents' and public.is_admin());
exception when duplicate_object then null; end $$;


-- ------------------------------------------------------------
-- 0026_otp_signup_and_reset_purposes.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0026_otp_signup_and_reset_purposes.sql
-- Widens public.otp_requests.purpose for the email + password
-- sign-up flow.
--
-- 0001 constrained purpose to ('login','staff_login','admin_mfa'),
-- which was correct while the only email codes were staff MFA.
-- The passwordless phone login has been replaced by SmartPOS-style
-- email + password sign-up, which needs two codes of its own:
--
--   'signup'         proves the person controls the mailbox before
--                    the auth user is created at all
--   'password_reset' proves the same before a password is changed
--
-- Both are keyed on the same (target, purpose) throttle, attempt
-- counter and lockout that already exist, so each gets an
-- independent budget and cannot be used to exhaust the others.
--
-- The channel stays 'email' for both. The 'phone' channel remains
-- supported by issue_otp/consume_otp for phone verification later
-- on, but the sign-up and reset paths only ever use email.
--
-- Idempotent: drops the old check by name if present, then adds one
-- with the full set. Safe to re-run.
-- Spec: §26.1
-- ============================================================

do $$ begin
  alter table public.otp_requests
    drop constraint if exists otp_requests_purpose_check;
exception
  when undefined_table then null;
end $$;

do $$ begin
  alter table public.otp_requests
    add constraint otp_requests_purpose_check
    check (purpose in (
      'login',
      'staff_login',
      'admin_mfa',
      'signup',
      'password_reset'
    ));
exception
  when duplicate_object then null;
end $$;

-- The audit action allow-list also enumerates purposes indirectly, so
-- make sure an existing account cannot be re-pointed at a purpose the
-- server does not recognise. The check constraint above is the single
-- source of truth; this index is the lookup the routes use to find an
-- open reset code for a target.
create index if not exists idx_otp_open_reset
  on public.otp_requests (target, purpose)
  where consumed_at is null and purpose = 'password_reset';


-- ------------------------------------------------------------
-- 0027_phone_is_optional.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0027_phone_is_optional.sql
-- Makes public.profiles.phone nullable, and stops handle_new_user()
-- inventing a placeholder for it.
--
-- THE BUG
-- 0001 declared profiles.phone NOT NULL with a check of
-- '^\+?[0-9]{10,15}$' — digits only. To satisfy NOT NULL for an
-- account created without a phone, handle_new_user() fabricated
-- one out of the user id:
--
--     '+' || substr(replace(new.id::text, '-', ''), 1, 12)
--
-- A UUID is hex, so twelve characters of it contain letters
-- roughly 99.7% of the time (all-digits is (10/16)^12). The
-- check then rejected the row and the whole signup died with
--
--   new row for relation "profiles" violates check constraint
--   "profiles_phone_format"
--
-- which GoTrue reports to the API as the useless
-- "Database error creating new user".
--
-- It went unnoticed because the only accounts that existed were
-- seeded with real phone numbers, so coalesce() never reached
-- the fallback. The passwordless phone sign-up was broken for
-- effectively everyone; 0026 replaced it with email + password,
-- and this fixes the provisioning path underneath that.
--
-- WHY NULLABLE IS THE FIX
-- A new email + password account genuinely has no phone. Storing
-- a made-up one put a fragment of a UUID into a column that means
-- "a dialable number", and it would eventually collide with a real
-- one under uniq_profiles_phone. NULL says what is true, needs no
-- reservation scheme, and the check constraint is satisfied by it
-- (a check passes on NULL). uniq_profiles_phone still holds:
-- Postgres treats NULLs as distinct, which is what we want.
--
-- A professional adds and verifies a real number during
-- onboarding, as before.
--
-- Idempotent. Safe to re-run.
-- Spec: §26.1
-- ============================================================

-- ── the column ──────────────────────────────────────────────
alter table public.profiles
  alter column phone drop not null;

-- The constraint is kept as-is. It now reads "a phone, if there
-- is one, is 10-15 digits", which is the real requirement, and it
-- passes on NULL. Re-adding it makes the intent explicit and keeps
-- it present if a previous run somehow dropped it.
do $$ begin
  alter table public.profiles
    drop constraint if exists profiles_phone_format;
exception when undefined_table then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_phone_format check (phone is null or phone ~ '^\+?[0-9]{10,15}$');
exception when duplicate_object then null; end $$;

-- ── the trigger ─────────────────────────────────────────────
-- Body is the 0001 version with exactly one change: the fabricated
-- placeholder is replaced by p_phone, which is NULL when the signup
-- supplied no number. Everything else — the two self-assignable
-- roles, the never-hijack-an-identity guard, the customers row, the
-- on-conflict clause — is unchanged.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  requested_role public.user_role := 'customer';
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  wanted text := coalesce(meta->>'role', 'customer');
  p_full_name text := coalesce(
    new.raw_user_meta_data->>'full_name',
    split_part(coalesce(new.phone, new.email, 'User'), '@', 1)
  );
  p_phone text;
  p_email text;
begin
  -- Only two roles may ever be self-assigned. Staff roles are granted by an
  -- admin or by the super_admin bootstrap allow-list, never by sign-up.
  if wanted = 'professional' then
    requested_role := 'professional';
  end if;

  p_phone := coalesce(new.phone, meta->>'phone');
  if p_phone is not null and p_phone !~ '^\+?[0-9]{10,15}$' then
    p_phone := null;
  end if;
  p_email := lower(coalesce(new.email, meta->>'email'));

  -- A phone already bound to another profile wins: never hijack an identity.
  if p_phone is not null
     and exists (select 1 from public.profiles where phone = p_phone) then
    return new;
  end if;

  insert into public.profiles (id, role, status, full_name, phone, email, phone_verified_at)
  values (
    new.id,
    requested_role,
    'active',
    left(coalesce(nullif(p_full_name, ''), 'User'), 120),
    p_phone,
    p_email,
    case when new.phone is not null then new.phone_confirmed_at end
  )
  on conflict (id) do nothing;

  if requested_role = 'customer' then
    insert into public.customers (profile_id, referral_code)
    values (new.id, public.generate_referral_code(new.id))
    on conflict (profile_id) do nothing;
  end if;

  return new;
end $$;

-- backfill_profiles() (0001) already wrote
--   case when u.phone ~ '^\+?[0-9]{10,15}$' then u.phone end
-- which yields NULL rather than a fabrication, so it needs no
-- change. It is called on re-provision and must not reintroduce the
-- placeholder, and it no longer can.


-- ------------------------------------------------------------
-- 0028_booking_write_paths.sql
-- ------------------------------------------------------------

-- ============================================================
-- 0028_booking_write_paths.sql
-- SmartHelp: booking creation and cancellation as single statements.
--
-- Why this file exists
-- --------------------
-- 0011 made `bookings.status` safe: only the transition table may
-- move it, and every hop writes `booking_status_history`. It says
-- nothing about the rows *around* a status change, and the Route
-- Handlers were assembling a booking out of three separate
-- PostgREST requests:
--
--   1. INSERT bookings            (status draft)
--   2. INSERT booking_items
--   3. UPDATE bookings SET status = 'payment_pending'
--
-- A failure between 2 and 3 leaves a priced row with nothing
-- itemised behind it and nothing in the timeline, and no rollback
-- reaches across three HTTP requests. It is not a hypothetical:
-- `booking_items` has a unique index on (booking_id, service_id),
-- so a retry of a create whose items insert had actually landed
-- fails on that index and leaves the orphan behind permanently.
--
-- The second gap was the actor. 0011's trigger reads
-- `app.transition_actor`, `app.transition_actor_role` and
-- `app.transition_note` as *transaction-local* settings, and
-- PostgREST cannot set them in the same transaction as the update
-- it accompanies — `set_config` needs a third request, and a third
-- request is not the transaction it looks like. So
-- `transitionBooking(bookingId, to, actor, note)` passed an actor
-- that was dropped on the floor, and the trail said `system` for a
-- customer's cancellation.
--
-- Both need a statement that can do more than one thing at once,
-- which means a function. These three are `security definer` and
-- executable by `service_role` only, for the same reason 0024's are:
-- the caller is the Route Handler, which has already authenticated
-- the person and priced the booking, and nothing else may call them.
--
-- The state machine is untouched. These functions do not decide
-- whether a move is legal — they set the actor settings and then
-- write `status`, and 0011's trigger still refuses anything
-- outside §8.2. An illegal transition still raises ILLEGAL_TRANSITION
-- and the Route Handler still answers 409.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §8.2, §25.6, §28.1
-- ============================================================

-- ── Create ─────────────────────────────────────────────────
-- The whole booking: the row, its item lines, and the
-- `draft -> payment_pending` hop, in one statement.
--
-- `p_money` carries the pricing columns as text literals because
-- they come out of `toBookingMoneyColumns()` already rendered for
-- numeric; spelling each one as a parameter would mean adding a
-- parameter every time the pricing engine grows a column. The
-- function reads named keys out of it and nothing else, so an
-- unexpected key is a no-op rather than a hole.
create or replace function public.create_booking(
  p_customer_id        uuid,
  p_address_id         uuid,
  p_locality_id        uuid,
  p_address_snapshot   jsonb,
  p_booking_type       public.booking_type,
  p_duration_minutes   int,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at   timestamptz,
  p_notes              text,
  p_money              jsonb,
  p_discount_code      text,
  p_pricing_snapshot   jsonb,
  p_quote_token        text,
  p_items              jsonb,
  p_actor              uuid,
  p_actor_role         public.user_role
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
  v_item    jsonb;
begin
  -- Set before the write so the history row the trigger writes for
  -- the `draft -> payment_pending` hop names the customer who asked
  -- for it. `true` is the transaction-local form: the setting dies
  -- with this transaction instead of being inherited by whatever
  -- pooled connection serves the next request.
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', 'booking created', true);

  insert into public.bookings (
    booking_number, customer_id, address_id, address_snapshot, locality_id,
    booking_type, duration_minutes, scheduled_start_at, scheduled_end_at,
    notes, subtotal, platform_fee, discount, discount_code, tax, tax_rate,
    total_amount, professional_gross, commission_pct, currency,
    pricing_snapshot, quote_token
  ) values (
    public.next_booking_number(), p_customer_id, p_address_id, p_address_snapshot,
    p_locality_id, p_booking_type, p_duration_minutes, p_scheduled_start_at,
    p_scheduled_end_at, p_notes,
    (p_money ->> 'subtotal')::numeric,
    (p_money ->> 'platform_fee')::numeric,
    (p_money ->> 'discount')::numeric,
    p_discount_code,
    (p_money ->> 'tax')::numeric,
    (p_money ->> 'tax_rate')::numeric,
    (p_money ->> 'total_amount')::numeric,
    (p_money ->> 'professional_gross')::numeric,
    (p_money ->> 'commission_pct')::numeric,
    coalesce(p_money ->> 'currency', 'INR')::char(3),
    coalesce(p_pricing_snapshot, '{}'::jsonb),
    p_quote_token
  )
  returning * into v_booking;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.booking_items (
      booking_id, service_id, service_name, duration_minutes, unit_price,
      quantity, line_total, scope_snapshot
    ) values (
      v_booking.id,
      (v_item ->> 'service_id')::uuid,
      v_item ->> 'service_name',
      (v_item ->> 'duration_minutes')::int,
      (v_item ->> 'unit_price')::numeric,
      coalesce((v_item ->> 'quantity')::int, 1),
      (v_item ->> 'line_total')::numeric,
      coalesce(v_item -> 'scope_snapshot', '[]'::jsonb)
    );
  end loop;

  -- §25.6: created bookings wait for payment, and Phase 2 takes no
  -- money. Phase 3 adds the payment row to this same function, which
  -- is the reason it is a function.
  update public.bookings
     set status = 'payment_pending'
   where id = v_booking.id
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.create_booking(uuid, uuid, uuid, jsonb, public.booking_type, int, timestamptz, timestamptz, text, jsonb, text, jsonb, text, jsonb, uuid, public.user_role) is
  'Writes a booking, its items and the draft -> payment_pending hop in one
   statement, so a partial booking cannot exist: there is no other request to
   interrupt between them. The status hop goes through enforce_booking_transition
   like any other, and booking_status_history names the actor passed here.';

-- ── Cancel ─────────────────────────────────────────────────
-- One UPDATE rather than an annotate-then-transition pair. The two
-- were separate requests, so a booking could read `cancelled` with
-- no fee and no reason recorded against it, or carry a fee with
-- nothing cancelled. Both are wrong in the way a refund dispute
-- notices.
--
-- Returns null when the version no longer matches, which the Route
-- Handler reports as STALE_VERSION. The legal-move question is not
-- answered here: the trigger refuses an illegal `status` write
-- whatever this function passes it.
create or replace function public.cancel_booking(
  p_booking_id   uuid,
  p_expected_version int,
  p_reason_code  text,
  p_fee          numeric,
  p_note         text,
  p_actor        uuid,
  p_actor_role   public.user_role
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.bookings
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancellation_reason_code = p_reason_code,
         cancellation_fee     = p_fee
   where id = p_booking_id
     and (p_expected_version is null or version = p_expected_version)
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.cancel_booking(uuid, int, text, numeric, text, uuid, public.user_role) is
  'Cancels a booking and records the reason and fee in the same statement, with the
   actor in booking_status_history. Returns null when the version has moved on, so
   the caller can answer STALE_VERSION rather than overwriting a change.';

-- ── The plain transition ───────────────────────────────────
-- Same shape as cancel_booking for every other move, so
-- `transitionBooking()` stops dropping its actor. `p_patch` is
-- limited to the columns a status change is allowed to carry: a
-- reschedule's new window, and nothing else. An unknown key is
-- ignored rather than written, because this runs with the owner's
-- rights.
create or replace function public.transition_booking(
  p_booking_id      uuid,
  p_to              public.booking_status,
  p_actor           uuid,
  p_actor_role      public.user_role,
  p_note            text,
  p_expected_version int,
  p_window_from     timestamptz,
  p_window_to       timestamptz
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.bookings
     set status             = p_to,
         scheduled_start_at  = coalesce(p_window_from, scheduled_start_at),
         scheduled_end_at    = coalesce(p_window_to, scheduled_end_at)
   where id = p_booking_id
     and (p_expected_version is null or version = p_expected_version)
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.transition_booking(uuid, public.booking_status, uuid, public.user_role, text, int, timestamptz, timestamptz) is
  'Moves a booking to a new status with the actor recorded in booking_status_history,
   optionally moving its window at the same time. The transition table is still what
   decides legality: an illegal move raises ILLEGAL_TRANSITION from
   enforce_booking_transition exactly as a direct write would.';

-- ── Grants ─────────────────────────────────────────────────
-- 0024's note applies verbatim: `security definer` means the body runs
-- with the owner's rights, so the EXECUTE grant is what the *caller*
-- needs. Anonymous and authenticated callers have no business
-- creating bookings, so they get none.
revoke all on function public.create_booking(uuid, uuid, uuid, jsonb, public.booking_type, int, timestamptz, timestamptz, text, jsonb, text, jsonb, text, jsonb, uuid, public.user_role) from public, anon, authenticated;
revoke all on function public.cancel_booking(uuid, int, text, numeric, text, uuid, public.user_role) from public, anon, authenticated;
revoke all on function public.transition_booking(uuid, public.booking_status, uuid, public.user_role, text, int, timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.create_booking(uuid, uuid, uuid, jsonb, public.booking_type, int, timestamptz, timestamptz, text, jsonb, text, jsonb, text, jsonb, uuid, public.user_role) to service_role;
grant execute on function public.cancel_booking(uuid, int, text, numeric, text, uuid, public.user_role) to service_role;
grant execute on function public.transition_booking(uuid, public.booking_status, uuid, public.user_role, text, int, timestamptz, timestamptz) to service_role;
