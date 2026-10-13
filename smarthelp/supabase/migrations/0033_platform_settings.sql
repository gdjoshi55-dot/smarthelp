-- ============================================================
-- 0033_platform_settings.sql
-- SmartHelp Phase 6: the editable platform settings table.
--
-- Spec: §24.14 (platform_settings), §22 (the settings API),
--       §31.1 (Phase 6), §7.1 / §11.1 / §12.3 (the rules it feeds).
-- Depends on: 0001 (profiles, is_staff/is_admin, touch_updated_at).
--
-- WHY THIS EXISTS
-- ---------------
-- Every rule the business can retune — the tax rate, the commission,
-- the platform fee, the offer TTL, the search window, the support
-- refund limit — has until now been a constant in `lib/constants.ts`.
-- The header of that file says it exactly: "Anything that a business
-- can change lives in a database row, not here." This is that row.
--
-- Shape: `(key text primary key, value jsonb, updated_by, updated_at)`.
-- A single jsonb column rather than one column per setting, because the
-- set of tunables grows and a migration per knob is how a settings table
-- becomes a table nobody adds to. `lib/settingsServer.ts` is the one
-- typed reader: it names each key, gives it a default from
-- `PLATFORM_DEFAULTS`, and parses the jsonb, so no call site ever sees
-- raw jsonb and a missing row is not an error.
--
-- The rows are seeded with today's `PLATFORM_DEFAULTS`, so nothing
-- changes until an admin edits one — which is the wave's whole point.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.platform_settings is
  'Editable business rules (§24.14). One row per setting, value as jsonb. Read
   through `lib/settingsServer.ts`, which types each key and falls back to
   `PLATFORM_DEFAULTS`; the constants in `lib/constants.ts` describe the
   initial state, not the rule.';
comment on column public.platform_settings.value is
  'jsonb rather than a column per knob: the tunable set grows, and a migration
   per setting is how this table stops being updated. The typed reader is the
   contract, not the column type.';
comment on column public.platform_settings.updated_by is
  'The staff profile that last wrote this row, stamped by the Route Handler
   (there is no DB-authoritative actor here the way there is for a booking).';

-- ── Seed the current defaults ──────────────────────────────
-- The numbers are `PLATFORM_DEFAULTS`' documented defaults, not the
-- environment-derived values: an env override was always described as a
-- fallback "until platform_settings lands", and this is it landing.
insert into public.platform_settings (key, value)
select key, value
  from jsonb_each(
    '{
      "currency": "INR",
      "taxRate": 0.18,
      "commissionPct": 0.2,
      "platformFeePct": 0.04,
      "platformFeeMin": 20,
      "serviceOtpLength": 4,
      "instantLeadMinutes": 30,
      "maxBookingMinutes": 480,
      "maxSchedulingDaysAhead": 30,
      "instantMatchTargetSeconds": 120,
      "lateArrivalThresholdMin": 15,
      "noShowAfterMin": 45,
      "supportRefundLimit": 1500,
      "offerTtlMinutes": 15,
      "searchWindowMinutes": 30,
      "otpTtlMinutes": 10,
      "otpMaxAttempts": 3,
      "otpLockoutMinutes": 15,
      "otpMaxGenerations": 3,
      "defaultArrivalRadiusM": 100,
      "proLocationFreshMinutes": 15,
      "proLocationThrottleSeconds": 30
    }'::jsonb
  )
on conflict (key) do nothing;

-- ── updated_at maintenance ─────────────────────────────────
drop trigger if exists trg_platform_settings_touch on public.platform_settings;
create trigger trg_platform_settings_touch before update on public.platform_settings
  for each row execute function public.touch_updated_at();

-- ── Row level security ─────────────────────────────────────
-- Every write goes through a Route Handler on the service role; the
-- browser only ever reads, and only as staff. The read policy is the
-- belt to that brace: even if a client somehow reached the table as
-- itself, a customer sees nothing.
alter table public.platform_settings enable row level security;

do $$ begin
  create policy platform_settings_read_staff on public.platform_settings for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy platform_settings_write_admin on public.platform_settings for all
    using (public.is_admin())
    with check (public.is_admin());
exception when duplicate_object then null; end $$;

-- A setting is never public (the tax rate and the support limit are
-- business facts, not catalogue facts), so anon gets nothing.
revoke all on public.platform_settings from anon;
grant select on public.platform_settings to authenticated;
grant all on public.platform_settings to service_role;
