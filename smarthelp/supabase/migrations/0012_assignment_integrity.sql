-- ============================================================
-- 0012_assignment_integrity.sql
-- SmartHelp Phase 4: the offer ledger and its two guarantees.
--
-- Spec: §24.8 (verbatim DDL), §8.2 (transitions), §9.1 (matching)
-- Depends on: 0005 (professionals, current_professional_id),
--             0010/0011 (bookings + the state machine),
--             0001 (is_staff).
--
-- WHY THIS EXISTS
-- ---------------
-- Phase 4's job flow starts with an offer: a booking is handed to
-- one professional, who accepts or declines. Two things must be
-- structurally impossible, and neither is something an application
-- check can promise:
--
--   1. Two professionals accepting the same booking. Handled here by
--      `uniq_active_assignment_per_booking`, a partial unique index on
--      `booking_id` for the live states (`offered`, `accepted`). A
--      second `offered`/`accepted` row cannot exist; the accept itself
--      is a compare-and-set UPDATE (see `accept_offer`).
--
--   2. One professional accepting two bookings that overlap in time.
--      That half is *not* here: it is the GiST exclusion constraint on
--      `professional_schedule` (0013), the same structure §24.9 uses
--      for double-booking. `accept_offer` writes a `reserved` window
--      and lets that constraint veto the accept. The two halves are
--      deliberately independent so neither depends on the other being
--      correct.
--
-- The `assignment_status` enum and the table shape are §24.8 verbatim
-- (`_docgen/part3_tech.py`). The value set is `offered | accepted |
-- rejected | expired | withdrawn`: a *decline* is `rejected`, and an
-- offer that times out is `expired`. Do not confuse `rejected` with a
-- plan-era guess of `declined`; the spec's spelling is what the
-- application types mirror.
--
-- NOTE ON ORDERING: `accept_offer` references `public.professional_schedule`,
-- which 0013 creates. PostgreSQL defers plpgsql relation resolution to
-- execution time, so the forward reference is intentional and safe; the
-- dry-run in `scripts/check-migrations.mjs` is what proves it.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

do $$ begin
  create type assignment_status as enum
    ('offered','accepted','rejected','expired','withdrawn');
exception when duplicate_object then null; end $$;

create table if not exists public.booking_assignments (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings(id) on delete cascade,
  professional_id uuid not null references public.professionals(id) on delete cascade,
  status          assignment_status not null default 'offered',
  attempt_no      int not null default 1,
  round_no        int not null default 1,
  distance_km     numeric(6,2),
  score           numeric(6,2),
  was_favourite   boolean not null default false,
  was_repeat      boolean not null default false,
  offered_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  responded_at    timestamptz,
  decline_reason  text
);

comment on table public.booking_assignments is
  'The offer ledger (§24.8). One row per offer made to one professional;
   the row is the record of the CAS — a decline and an expiry are both
   tombstones (rejected / expired), never rows that are picked up again.
   Phase 4 makes one offer per booking for a demo; Phase 5''s ranking
   engine is what fills attempt_no and round_no.';

-- The offer inbox read: a professional's live offers, expiring soonest.
create index if not exists idx_assign_booking
  on public.booking_assignments (booking_id, attempt_no);
create index if not exists idx_assign_prof
  on public.booking_assignments (professional_id, status, expires_at);

-- Guarantee (1): at most one live assignment per booking. This is the
-- whole of the double-accept guarantee for a single booking; the accept
-- UPDATE below races against it and loses cleanly.
create unique index if not exists uniq_active_assignment_per_booking
  on public.booking_assignments (booking_id)
  where status in ('offered', 'accepted');

-- One professional never holds two offers on the same booking, even
-- across rounds. A re-offer to the same pro is a bug, not a retry.
create unique index if not exists uniq_prof_booking_offer
  on public.booking_assignments (professional_id, booking_id);

comment on index public.uniq_active_assignment_per_booking is
  'The double-accept guarantee (§24.8): a booking has one live offer or
   acceptance at a time. Combined with accept_offer''s compare-and-set,
   the second of two concurrent accepts affects zero rows.';

-- ── Row level security ─────────────────────────────────────
-- A professional reads their own offers from the browser; staff read
-- the ledger for support. Nobody writes from the browser: every write
-- goes through the security-definer functions below on the service role.
alter table public.booking_assignments enable row level security;
alter table public.booking_assignments force row level security;

drop policy if exists booking_assignments_select_own on public.booking_assignments;
create policy booking_assignments_select_own on public.booking_assignments
  for select using (
    professional_id = public.current_professional_id()
    or public.is_staff(array['admin','super_admin','ops']::public.user_role[])
  );

revoke all on public.booking_assignments from anon, authenticated;
grant select on public.booking_assignments to authenticated;
grant all on public.booking_assignments to service_role;

-- ── accept_offer ───────────────────────────────────────────
-- Compare-and-set, then two independent safety nets:
--   * the CAS UPDATE is the concurrency control — a second tap, an
--     expired offer, or a stale offer id all affect zero rows and the
--     function returns null (the route maps that to 409/410);
--   * the schedule insert lets 0013's exclusion constraint veto an
--     overlap, which is re-raised as PROFESSIONAL_UNAVAILABLE.
-- Only then does the booking move `assigned -> accepted` (a legal hop
-- per 0011; the transition trigger records the history row).
create or replace function public.accept_offer(
  p_assignment_id   uuid,
  p_professional_id uuid
) returns public.booking_assignments
language plpgsql security definer set search_path = public as $$
declare
  v_assignment public.booking_assignments;
  v_booking    public.bookings;
  v_profile    uuid;
  v_start      timestamptz;
  v_end        timestamptz;
begin
  update public.booking_assignments
     set status = 'accepted',
         responded_at = now()
   where id = p_assignment_id
     and professional_id = p_professional_id
     and status = 'offered'
     and expires_at > now()
  returning * into v_assignment;

  if not found then
    return null;
  end if;

  select * into v_booking from public.bookings where id = v_assignment.booking_id;

  v_start := coalesce(v_booking.scheduled_start_at, now());
  v_end   := coalesce(
    v_booking.scheduled_end_at,
    v_start + make_interval(mins => v_booking.duration_minutes)
  );

  begin
    insert into public.professional_schedule
      (professional_id, booking_id, starts_at, ends_at, status)
    values
      (p_professional_id, v_assignment.booking_id, v_start, v_end, 'reserved');
  exception when exclusion_violation then
    raise exception 'PROFESSIONAL_UNAVAILABLE'
      using errcode = '23P01',
            detail = 'the professional already has a booking in this window';
  end;

  -- booking_status_history.actor_id references profiles, so record the
  -- professional's *profile*, not their professionals row.
  select profile_id into v_profile
    from public.professionals where id = p_professional_id;

  perform set_config('app.transition_actor', coalesce(v_profile::text, ''), true);
  perform set_config('app.transition_actor_role', 'professional', true);
  perform set_config('app.transition_note', 'offer accepted', true);

  update public.bookings
     set status = 'accepted',
         accepted_at = now()
   where id = v_assignment.booking_id
   returning * into v_booking;

  update public.professionals
     set accepted_offers = accepted_offers + 1
   where id = p_professional_id;

  return v_assignment;
end $$;

comment on function public.accept_offer(uuid, uuid) is
  'Accepts an offer by compare-and-set (§24.8). Returns the assignment on
   success, or NULL if the offer was not live (already answered, expired,
   or a different professional). Reserves the booking window through the
   professional_schedule exclusion constraint; an overlap surfaces as
   PROFESSIONAL_UNAVAILABLE (23P01).';

-- ── decline_offer ──────────────────────────────────────────
-- Records the decline as a tombstone. The booking is left `assigned`:
-- the deployed 0011 state machine permits no `assigned -> searching`,
-- so re-offering after a decline is deliberately out of Phase 4's scope.
-- Phase 5's engine owns reassignment; this is recorded so the absence is
-- a decision, not an oversight.
create or replace function public.decline_offer(
  p_assignment_id   uuid,
  p_professional_id uuid,
  p_reason          text default null
) returns public.booking_assignments
language plpgsql security definer set search_path = public as $$
declare
  v_assignment public.booking_assignments;
begin
  update public.booking_assignments
     set status = 'rejected',
         responded_at = now(),
         decline_reason = p_reason
   where id = p_assignment_id
     and professional_id = p_professional_id
     and status = 'offered'
  returning * into v_assignment;

  return v_assignment;
end $$;

comment on function public.decline_offer(uuid, uuid, text) is
  'Declines an offer by compare-and-set. Returns the rejected assignment,
   or NULL if it was not live. The booking stays `assigned` — 0011 permits
   no reassign hop, so Phase 5 owns re-offering.';

-- ── sweep_new_bookings ─────────────────────────────────────
-- The minimal Phase 4 matcher: for each paid booking with no live
-- assignment, pick one eligible professional and make one offer.
--
-- Deliberately not a ranking engine. §10.4's scoring, geo radius and
-- fan-out are Phase 5; 0002 has no earthdistance, so distance is not
-- computed here at all. Eligibility is the same shape Phase 5 will reuse:
-- verified, online, available today, skilled for every service the
-- booking contains, free on both the time-off calendar and the schedule.
--
-- Only `paid` bookings are swept. An expired or declined offer is a
-- tombstone that this function never revisits (D3), and the transition
-- table's `paid -> searching -> assigned` is walked one legal hop at a
-- time. The offer TTL is PLATFORM_DEFAULTS.offerTtlMinutes = 15 in
-- lib/constants.ts; with no settings table the value is mirrored here.
create or replace function public.sweep_new_bookings()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_offer_ttl_minutes constant int := 15;
  v_booking  public.bookings;
  v_pro      uuid;
  v_start    timestamptz;
  v_end      timestamptz;
  v_count    int := 0;
begin
  for v_booking in
    select * from public.bookings b
     where b.status = 'paid'
       and not exists (
         select 1 from public.booking_assignments a
          where a.booking_id = b.id and a.status in ('offered', 'accepted')
       )
     order by b.created_at
  loop
    v_start := coalesce(v_booking.scheduled_start_at, now());
    v_end   := coalesce(
      v_booking.scheduled_end_at,
      v_start + make_interval(mins => v_booking.duration_minutes)
    );

    select p.id into v_pro
      from public.professionals p
     where p.verification_status = 'verified'
       and p.availability_status = 'online'
       and p.is_available_today
       -- Skilled for every service on the booking.
       and not exists (
         select 1 from public.booking_items bi
          where bi.booking_id = v_booking.id
            and not exists (
              select 1 from public.professional_skills ps
               where ps.professional_id = p.id
                 and ps.service_id = bi.service_id
            )
       )
       -- Not on a booked day off.
       and not exists (
         select 1 from public.professional_time_off t
          where t.professional_id = p.id
            and tstzrange(t.starts_at, t.ends_at, '[)')
                && tstzrange(v_start, v_end, '[)')
       )
       -- Calendar is clear.
       and not exists (
         select 1 from public.professional_schedule s
          where s.professional_id = p.id
            and s.status in ('reserved', 'in_progress')
            and tstzrange(s.starts_at, s.ends_at, '[)')
                && tstzrange(v_start, v_end, '[)')
       )
     order by p.created_at, p.id
     limit 1;

    if v_pro is null then
      continue;
    end if;

    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'assignment sweep', true);

    -- paid -> searching -> assigned, one legal hop at a time.
    update public.bookings
       set status = 'searching'
     where id = v_booking.id and status = 'paid';

    update public.bookings
       set status = 'assigned',
           professional_id = v_pro,
           matched_at = now()
     where id = v_booking.id and status = 'searching';

    insert into public.booking_assignments
      (booking_id, professional_id, status, offered_at, expires_at)
    values
      (v_booking.id, v_pro, 'offered', now(),
       now() + make_interval(mins => v_offer_ttl_minutes))
    on conflict do nothing;

    update public.professionals
       set total_offers = total_offers + 1
     where id = v_pro;

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

comment on function public.sweep_new_bookings() is
  'Phase 4''s minimal matcher: makes one offer per paid, unassigned
   booking to one eligible professional and walks paid -> searching ->
   assigned. Returns the number of offers made. Ranking, fan-out and geo
   are Phase 5; the offer TTL mirrors PLATFORM_DEFAULTS.offerTtlMinutes.';

-- ── Grants ─────────────────────────────────────────────────
-- security definer: the EXECUTE grant belongs to the *caller*. These
-- write the offer ledger and the booking's state, so anon and
-- authenticated get nothing; only the service role (Route Handlers) may.
revoke all on function public.accept_offer(uuid, uuid) from public, anon, authenticated;
revoke all on function public.decline_offer(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sweep_new_bookings() from public, anon, authenticated;

grant execute on function public.accept_offer(uuid, uuid) to service_role;
grant execute on function public.decline_offer(uuid, uuid, text) to service_role;
grant execute on function public.sweep_new_bookings() to service_role;
