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
