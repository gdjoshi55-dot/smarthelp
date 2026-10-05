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
