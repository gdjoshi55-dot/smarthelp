-- ============================================================
-- 0035_pricing_policies.sql
-- SmartHelp Phase 6: the editable pricing rules and the
-- cancellation ladder as rows.
--
-- Spec: §24 (pricing_rules, cancellation_policies), §7.1 (surge),
--       §11.1 (the cancellation table), §31.1 (Phase 6).
-- Depends on: 0001 (is_staff/is_admin, touch_updated_at),
--             0003 (service_categories, services).
--
-- WHY THIS EXISTS
-- ---------------
-- Two rules the business can retune have until now been code:
--
--   §11.1's cancellation ladder is `DEFAULT_CANCELLATION_POLICIES` in
--   `lib/cancellation.ts` — a five-row table frozen in a constant. It
--   is exactly the kind of number a business wants to change without a
--   deploy ("the 2–6h band should be 30% this quarter"), and §24 already
--   names the table it should live in.
--
--   §7.1's surge is not implemented at all: the pricing engine has no
--   notion of "this is a Sunday evening, multiply by 1.2". `pricing_rules`
--   is the surge-window table the spec describes — a multiplier scoped to
--   the whole catalogue, a category, or one service, optionally bounded to
--   days of the week and a minute-of-day window.
--
-- Both tables are backfilled with today's behaviour (the cancellation
-- ladder verbatim; no surge rules), so nothing changes until an admin
-- edits one.
--
-- Read model: staff read, admin write — the same split as
-- `platform_settings` (0033). Every write goes through a Route Handler on
-- the service role; the policies are projected for the browser.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── cancellation_policies ──────────────────────────────────
-- One row per band. `hours_before` is the band **ceiling**, matching
-- `lib/cancellation.ts`'s `resolveCancellationPolicy` and §11.1's SQL
-- (`where $2 <= hours_before order by hours_before asc limit 1`). Storing
-- the floor instead is the classic way to get this table wrong: a request
-- four hours out would match the 24 and 6 rows and be charged 10% when
-- §11.1 says 25%. `hours_before is null` is the unbounded row ("≥ 24h").
--
-- `applies_when_arrived` is the arrival row, which §11.1 keys on arrival
-- rather than on time. `service_id is null` is the platform-wide default;
-- a service-specific set can override it per service (§11.1's `ORDER BY
-- (service_id is not null) desc`).
do $$ begin
  create type public.cancellation_fee_type as enum ('free', 'percentage', 'fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.cancellation_policies (
  id                   uuid primary key default gen_random_uuid(),
  -- NULL = the platform-wide default ladder; a service id overrides it.
  service_id           uuid references public.services(id) on delete cascade,
  -- The band ceiling in hours; NULL = no upper bound ("≥ 24h").
  hours_before         numeric(6,2),
  fee_type             public.cancellation_fee_type not null,
  -- Percent (0–100) for percentage, rupees for fixed, ignored for free.
  fee_value            numeric(10,2) not null default 0 check (fee_value >= 0),
  applies_when_arrived boolean not null default false,
  -- Shown to the operator and carried onto the quote, so a band cannot be
  -- misnamed in the console.
  band                 text,
  sort_order           int not null default 0,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint cancellation_percentage_is_sane
    check (fee_type <> 'percentage' or (fee_value >= 0 and fee_value <= 100)),
  constraint cancellation_arrival_has_no_hours
    check (not applies_when_arrived or hours_before is null)
);

create index if not exists idx_cancellation_policies_scope
  on public.cancellation_policies (service_id, sort_order) where is_active;

comment on table public.cancellation_policies is
  'The §11.1 cancellation ladder as rows (§24). hours_before is the band
   ceiling, matching lib/cancellation.ts; NULL is the unbounded "≥ 24h" row.
   service_id NULL is the platform default. Backfilled with the previous
   DEFAULT_CANCELLATION_POLICIES, so behaviour is unchanged until edited.';
comment on column public.cancellation_policies.hours_before is
  'The band CEILING in hours, not the floor: a request is charged the smallest
   ceiling that still covers it. Storing the floor silently undercharges.';
comment on column public.cancellation_policies.applies_when_arrived is
  'The arrival row: keyed on arrival, not on hours. Once the professional is at
   the door, how long ago the slot was booked is irrelevant.';

-- Backfill, only when the platform default ladder is absent, so a re-run of
-- this migration on a live project that has since been edited does not
-- clobber the admin's rows.
insert into public.cancellation_policies
  (service_id, hours_before, fee_type, fee_value, applies_when_arrived, band, sort_order)
select * from (values
  (null::uuid, null::numeric, 'free'::public.cancellation_fee_type,       0::numeric, false, 'over_24h', 10),
  (null::uuid, 24::numeric,   'percentage'::public.cancellation_fee_type, 10::numeric, false, '6_to_24h', 20),
  (null::uuid, 6::numeric,    'percentage'::public.cancellation_fee_type, 25::numeric, false, '2_to_6h', 30),
  (null::uuid, 2::numeric,    'percentage'::public.cancellation_fee_type, 50::numeric, false, 'under_2h', 40),
  (null::uuid, null::numeric, 'percentage'::public.cancellation_fee_type, 100::numeric, true, 'after_arrival', 50)
) as seed(service_id, hours_before, fee_type, fee_value, applies_when_arrived, band, sort_order)
where not exists (
  select 1 from public.cancellation_policies
   where service_id is null
);

-- ── pricing_rules ──────────────────────────────────────────
-- The §7.1 surge windows. A rule is a multiplier over a scope:
--
--   scope = 'global'   → whole catalogue
--   scope = 'category' → one top-level category
--   scope = 'service'  → one service
--
-- Optionally bounded to a set of days of the week (0=Sunday…6=Saturday,
-- empty = every day) and a minute-of-day window in local time
-- (start_minute inclusive, end_minute exclusive; a window that wraps
-- midnight is expressed with end_minute < start_minute). `priority`
-- breaks ties between overlapping rules — the highest priority wins, and
-- a narrower scope should carry a higher priority.
--
-- No rules are seeded: "no surge" is the empty table, which is the current
-- behaviour. The pricing engine applies the resolved multiplier only when
-- a caller asks it to.
create table if not exists public.pricing_rules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  scope        text not null default 'global'
               check (scope in ('global', 'category', 'service')),
  category_id  uuid references public.service_categories(id) on delete cascade,
  service_id   uuid references public.services(id) on delete cascade,
  multiplier   numeric(6,3) not null check (multiplier > 0),
  -- 0=Sunday … 6=Saturday. Empty means every day.
  days_of_week smallint[] not null default '{}',
  -- Minutes from local midnight. NULL pair means "all day".
  start_minute smallint check (start_minute between 0 and 1439),
  end_minute   smallint check (end_minute between 0 and 1439),
  priority     int not null default 0,
  valid_from   timestamptz,
  valid_to     timestamptz,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint pricing_rule_scope_target check (
    (scope = 'global'   and category_id is null     and service_id is null) or
    (scope = 'category' and category_id is not null and service_id is null) or
    (scope = 'service'  and service_id is not null)
  ),
  constraint pricing_rule_window_is_ordered
    check (start_minute is null or end_minute is null or start_minute <> end_minute),
  constraint pricing_rule_days_are_valid
    check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  constraint pricing_rule_validity_is_forward
    check (valid_to is null or valid_from is null or valid_to > valid_from)
);

create index if not exists idx_pricing_rules_active
  on public.pricing_rules (scope, priority desc) where is_active;

comment on table public.pricing_rules is
  'The §7.1 surge windows (§24): a multiplier scoped global/category/service,
   optionally bounded by days_of_week and a minute-of-day window. Empty table =
   no surge, which is the prior behaviour. lib/pricingServer.ts resolves the
   winning rule for a service at a moment in time.';
comment on column public.pricing_rules.days_of_week is
  '0=Sunday…6=Saturday; empty array means every day, the same "empty = all"
   convention coupons use for their applicable_services.';

drop trigger if exists trg_cancellation_policies_touch on public.cancellation_policies;
create trigger trg_cancellation_policies_touch before update on public.cancellation_policies
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_pricing_rules_touch on public.pricing_rules;
create trigger trg_pricing_rules_touch before update on public.pricing_rules
  for each row execute function public.touch_updated_at();

-- ── Row level security ─────────────────────────────────────
-- Staff read both; only admins write. The browser never writes these — the
-- console goes through the service role and re-checks the capability itself
-- (D3) — but the policy is the backstop, exactly as on platform_settings.
alter table public.cancellation_policies enable row level security;
alter table public.pricing_rules         enable row level security;

do $$ begin
  create policy cancellation_policies_read_staff on public.cancellation_policies for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy cancellation_policies_write_admin on public.cancellation_policies for all
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pricing_rules_read_staff on public.pricing_rules for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pricing_rules_write_admin on public.pricing_rules for all
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

revoke all on public.cancellation_policies from anon;
revoke all on public.pricing_rules from anon;
grant select on public.cancellation_policies to authenticated;
grant select on public.pricing_rules to authenticated;
grant all on public.cancellation_policies to service_role;
grant all on public.pricing_rules to service_role;
