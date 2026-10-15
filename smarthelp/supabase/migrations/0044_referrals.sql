-- ============================================================
-- 0044_referrals.sql
-- SmartHelp Phase 8: referrals (§15.2, §24.12, §25.9).
--
-- Spec: §15.2 (referrals), §24.12 (referrals DDL), §25.9
--       (POST /api/referrals/validate).
-- Depends on: 0001 (customers, generate_referral_code),
--             0015 (get_or_create_wallet, apply_wallet_delta).
--
-- WHY THIS EXISTS
-- ---------------
-- Every customer already gets a `referral_code` on signup (0001's
-- `generate_referral_code()` and the `handle_new_user` trigger) and
-- `customers.referred_by` has been there since 0001 — but nothing has
-- ever written a referral *row*, so the code is decoration. This file
-- gives the feature its table and the two functions the flows call:
-- one to record a referral at signup, one to pay it out when the
-- referee's first booking completes.
--
-- The payout is deliberately late — §15.2 rewards only after the
-- referee's **first booking reaches `completed`** — which is what
-- stops signup farming. The two functions are `security definer` and
-- service-role-only, because both move wallet money and both must be
-- callable by no client role.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── referral_status ────────────────────────────────────────
do $$ begin
  create type public.referral_status as enum ('pending', 'qualified', 'rewarded', 'rejected');
exception when duplicate_object then null; end $$;

-- ── referrals ──────────────────────────────────────────────
create table if not exists public.referrals (
  id              uuid primary key default gen_random_uuid(),
  referrer_id     uuid not null references public.customers(id) on delete cascade,
  referee_id      uuid not null unique references public.customers(id) on delete cascade,
  code            text not null,
  status          public.referral_status not null default 'pending',
  referee_reward  numeric(10,2) not null default 0,
  referrer_reward numeric(10,2) not null default 0,
  device_hash     text,
  instrument_hash text,
  reject_reason   text,
  rewarded_at     timestamptz,
  created_at      timestamptz not null default now(),
  constraint no_self_referral check (referrer_id <> referee_id)
);

create index if not exists idx_referrals_referrer
  on public.referrals (referrer_id, created_at desc);

-- One referral per device and per payment instrument: §15.2's
-- anti-abuse core. Partial, because a referral recorded without a
-- device or instrument must not collide with every other one.
create unique index if not exists uniq_referral_device
  on public.referrals (device_hash) where device_hash is not null;
create unique index if not exists uniq_referral_instrument
  on public.referrals (instrument_hash) where instrument_hash is not null;

comment on table public.referrals is
  'One row per referred customer (§24.12). `referee_id` is unique, so a
   customer can be referred once; the reward is paid only when their first
   booking reaches `completed`. Writes are service-role-only.';

-- ── Row level security ─────────────────────────────────────
alter table public.referrals enable row level security;

-- A customer may see referrals they are either end of; staff see all.
-- There is no client INSERT/UPDATE: a referral is written by the signup
-- path and paid by the completion path, both from the service role.
do $$ begin
  create policy referrals_select_party on public.referrals for select
    using (
      referrer_id = public.current_customer_id()
      or referee_id = public.current_customer_id()
      or public.is_ops()
    );
exception when duplicate_object then null; end $$;

revoke all on public.referrals from anon;
grant select on public.referrals to authenticated;
grant all on public.referrals to service_role;

-- ── record_referral() ──────────────────────────────────────
-- Called once, at signup, with the new account's profile id and the
-- code they typed. Resolves both customers, refuses a self-referral,
-- writes the pending row and points `customers.referred_by` at the
-- referrer. Returns the new referral id, or null when the code is
-- unknown / self-referential / already used by this referee — all of
-- which are non-events, not errors: signup must not fail because
-- somebody fat-fingered a code.
create or replace function public.record_referral(
  p_referee_profile uuid,
  p_code            text,
  p_device_hash     text default null,
  p_instrument_hash text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_referee  uuid;
  v_referrer uuid;
  v_id       uuid;
begin
  if p_referee_profile is null or coalesce(trim(p_code), '') = '' then
    return null;
  end if;

  select id into v_referee from public.customers where profile_id = p_referee_profile;
  if v_referee is null then
    return null;
  end if;

  select id into v_referrer
    from public.customers
   where referral_code = upper(trim(p_code));

  -- Unknown code, or a customer referring themselves.
  if v_referrer is null or v_referrer = v_referee then
    return null;
  end if;

  insert into public.referrals (referrer_id, referee_id, code, device_hash, instrument_hash)
  values (v_referrer, v_referee, upper(trim(p_code)), p_device_hash, p_instrument_hash)
  on conflict (referee_id) do nothing
  returning id into v_id;

  if v_id is not null then
    update public.customers
       set referred_by = v_referrer
     where id = v_referee
       and referred_by is distinct from v_referrer;
  end if;

  return v_id;
end $$;

comment on function public.record_referral(uuid, text, text, text) is
  'Records a referral at signup (§15.2). Idempotent per referee; returns null
   for an unknown code, a self-referral, or a referee who already has a row.';

-- ── grant_referral_reward() ────────────────────────────────
-- Called when a booking completes. If the referee has a pending
-- referral and this is their first completed booking, it pays both
-- sides in one transaction: the referrer's wallet and the referee's
-- wallet, through `apply_wallet_delta()` — the same single writer every
-- other credit uses. The referral row is locked `for update` and moved
-- `pending -> rewarded` in the same statement, so a concurrent second
-- completion cannot pay twice.
--
-- The reward amounts are parameters: they are `platform_settings`
-- (`referralRewardReferrer` / `referralRewardReferee`), so the caller
-- reads the live figures and passes them.
create or replace function public.grant_referral_reward(
  p_referee_customer uuid,
  p_referrer_reward  numeric,
  p_referee_reward   numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ref       uuid;
  v_referrer  uuid;
  v_rw        numeric;
  v_ew        numeric;
  v_wallet    uuid;
begin
  -- Claim the pending referral for this referee, if any.
  select id, referrer_id into v_ref, v_referrer
    from public.referrals
   where referee_id = p_referee_customer
     and status = 'pending'
   for update;

  if v_ref is null then
    return null;
  end if;

  -- §15.2: only after the referee's first booking reaches `completed`.
  if not exists (
    select 1 from public.bookings
     where customer_id = p_referee_customer and status = 'completed'
  ) then
    return null;
  end if;

  v_rw := greatest(coalesce(p_referrer_reward, 0), 0);
  v_ew := greatest(coalesce(p_referee_reward, 0), 0);

  if v_rw > 0 then
    v_wallet := public.get_or_create_wallet(v_referrer);
    perform public.apply_wallet_delta(
      v_wallet, 'credit', v_rw,
      'referral:' || v_ref::text,
      'Referral reward'
    );
  end if;

  if v_ew > 0 then
    v_wallet := public.get_or_create_wallet(p_referee_customer);
    perform public.apply_wallet_delta(
      v_wallet, 'credit', v_ew,
      'referral:' || v_ref::text,
      'Welcome referral reward'
    );
  end if;

  update public.referrals
     set status = 'rewarded',
         referrer_reward = v_rw,
         referee_reward = v_ew,
         rewarded_at = now()
   where id = v_ref;

  return jsonb_build_object(
    'referral_id', v_ref,
    'referrer_id', v_referrer,
    'referrer_reward', v_rw,
    'referee_reward', v_ew
  );
end $$;

comment on function public.grant_referral_reward(uuid, numeric, numeric) is
  'Pays a pending referral once the referee has a completed booking (§15.2).
   Credits both wallets through apply_wallet_delta and marks the row rewarded
   in one transaction; returns null when there is nothing to pay.';

-- ── Grants: service-role only ──────────────────────────────
revoke all on function public.record_referral(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.grant_referral_reward(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.record_referral(uuid, text, text, text) to service_role;
grant execute on function public.grant_referral_reward(uuid, numeric, numeric) to service_role;

-- ── Seed the reward settings ───────────────────────────────
-- §15.2: "referrer gets wallet credit (referral_reward_referrer / _referee,
-- both configurable)". Two `platform_settings` rows, in rupees like every
-- other money setting here. `lib/settingsServer.ts` types both and falls
-- back to `PLATFORM_DEFAULTS`, so this seed is the live value.
insert into public.platform_settings (key, value)
values ('referralRewardReferrer', '100'::jsonb)
on conflict (key) do nothing;

insert into public.platform_settings (key, value)
values ('referralRewardReferee', '50'::jsonb)
on conflict (key) do nothing;
