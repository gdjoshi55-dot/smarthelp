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
