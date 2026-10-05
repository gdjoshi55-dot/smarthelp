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
