-- ============================================================
-- 0021_earnings.sql
-- SmartHelp Phase 4: the professional earnings ledger (read model).
--
-- Spec: §24.12 (verbatim DDL), §7.5 (commission basis)
-- Depends on: 0005 (current_professional_id), 0010 (bookings),
--             0001 (is_staff).
--
-- WHY THIS IS PARTIAL
-- -------------------
-- §24.12 describes a payout ledger. Phase 4 ships only the half it can
-- honour: `professional_earnings`. The `payouts` table, batch payout
-- runs and the payout_weekday cron are Phase 8's, and §24.12's
-- `payout_id` is left a bare `uuid` with no foreign key for exactly
-- that reason — the column is spec-shaped and points at a table this
-- phase does not create. D4 recorded this partial ship deliberately.
--
-- The row is written by `complete_job` (0029), once per booking
-- (`booking_id` is UNIQUE). No application code writes it directly and
-- no browser may read another professional's rows.
--
-- COMMISSION BASIS (§7.5 vs the engine)
-- -------------------------------------
-- §7.5 computes `professional_gross = taxable × (1 − commission)`, while
-- this repository's pricing engine deliberately departs from that and
-- freezes `professional_gross = taxable − platform_fee − commission`
-- (see STATE.md). The engine's number is already frozen on the booking
-- (`bookings.professional_gross` and `bookings.pricing_snapshot.totals`),
-- so the earnings row copies the frozen figure rather than recomputing
-- §7.5 — the two would disagree, and the frozen one is what the customer
-- was charged against. The arithmetic lives in `complete_job`; §7.5's
-- `earnings_hold_hours = 24` is the `available_at` delay, hardcoded there
-- because no settings table exists yet.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

do $$ begin
  create type earning_status as enum ('pending','available','paid','reversed');
exception when duplicate_object then null; end $$;

create table if not exists public.professional_earnings (
  id               uuid primary key default gen_random_uuid(),
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  booking_id       uuid not null unique references public.bookings(id) on delete cascade,
  gross_amount     numeric(12,2) not null,
  commission_pct   numeric(5,4)  not null,
  commission_amount numeric(12,2) not null,
  net_amount       numeric(12,2) not null,
  bonus_amount     numeric(12,2) not null default 0,
  status           earning_status not null default 'pending',
  available_at     timestamptz not null,
  -- §24.12: no FK. `payouts` is Phase 8.
  payout_id        uuid,
  reversed_reason  text,
  created_at       timestamptz not null default now()
);

comment on table public.professional_earnings is
  'The professional earnings ledger (§24.12). One row per completed
   booking (booking_id UNIQUE), written by complete_job. status starts
   at pending and becomes available after the §7.5 hold (available_at);
   the transition to paid is Phase 8''s payout run. payout_id is a bare
   uuid because the payouts table is Phase 8.';

create index if not exists idx_earnings_pro
  on public.professional_earnings (professional_id, created_at desc);
create index if not exists idx_earnings_ready
  on public.professional_earnings (available_at)
  where status = 'available';

comment on index public.idx_earnings_ready is
  'The payout run''s work list (§24.12): earnings whose hold has
   elapsed and have not yet been paid.';

-- ── Row level security ─────────────────────────────────────
-- Owner and staff read; nobody writes from the browser. complete_job
-- (0029) is the only writer and runs on the service role.
alter table public.professional_earnings enable row level security;
alter table public.professional_earnings force row level security;

drop policy if exists professional_earnings_select_own on public.professional_earnings;
create policy professional_earnings_select_own on public.professional_earnings
  for select using (
    professional_id = public.current_professional_id()
    or public.is_staff(array['admin','super_admin','ops']::public.user_role[])
  );

revoke all on public.professional_earnings from anon, authenticated;
grant select on public.professional_earnings to authenticated;
grant all on public.professional_earnings to service_role;
