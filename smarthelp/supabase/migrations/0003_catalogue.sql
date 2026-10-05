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
