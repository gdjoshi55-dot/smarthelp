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
