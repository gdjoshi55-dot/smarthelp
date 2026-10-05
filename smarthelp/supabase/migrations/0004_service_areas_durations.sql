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
