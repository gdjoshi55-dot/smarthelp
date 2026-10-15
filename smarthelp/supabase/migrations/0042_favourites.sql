-- ============================================================
-- 0042_favourites.sql
-- SmartHelp: the customer's saved services and professionals.
--
-- Spec: §24.10 (favourites), §25.4 (GET/POST/DELETE /api/favourites).
-- Depends on: 0001 (customers, current_customer_id), 0003 (services),
--             0011 (professionals).
--
-- WHY THIS EXISTS
-- ---------------
-- §19.1's customer shell has a `favourites` tab and §24.10 names the table, but
-- the migrations have never carried it. The tab has been dead since Phase 2 for
-- want of exactly this file. The shape is the spec's: a polymorphic `target_type`
-- of `service` or `professional` with a `target_id`, and one row per
-- (customer, type, target) so re-saving is a no-op rather than a duplicate.
--
-- Read model: the customer owns their rows. Service-role writes from the route,
-- with RLS as the backstop — the same split as the wallet (0015). No UPDATE is
-- admitted: a favourite is added or removed, never edited.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

create table if not exists public.favourites (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  target_type text not null check (target_type in ('service', 'professional')),
  target_id   uuid not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists uniq_favourite
  on public.favourites (customer_id, target_type, target_id);

create index if not exists idx_favourites_customer
  on public.favourites (customer_id, created_at desc);

comment on table public.favourites is
  'A saved service or professional (§24.10). Polymorphic via target_type/target_id;
   one row per (customer, type, target). Append-only: no UPDATE is admitted.';

-- ── Row level security ─────────────────────────────────────
alter table public.favourites enable row level security;

do $$ begin
  create policy favourites_select_own on public.favourites for select
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy favourites_insert_own on public.favourites for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy favourites_delete_own on public.favourites for delete
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- ── Grants ─────────────────────────────────────────────────
revoke all on public.favourites from anon;
grant select, insert, delete on public.favourites to authenticated;
grant all on public.favourites to service_role;
