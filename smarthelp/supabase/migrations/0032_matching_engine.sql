-- ============================================================
-- 0032_matching_engine.sql
-- SmartHelp Phase 5: the ranked matching engine.
--
-- Spec: §9.1 (candidate ranking), §9.4 (advisory lock), §8.2 (the
--       assigned -> searching edge), §24.8 (the offer ledger),
--       §16 #20 (hold/reassign), §25.11 (the sweeper).
-- Depends on: 0005/0006 (professionals, skills), 0010/0011 (bookings +
--             state machine), 0012 (booking_assignments + CAS RPCs),
--             0013 (professional_schedule).
--
-- WHY THIS EXISTS
-- ---------------
-- Phase 4 shipped the offer *ledger* but not the matcher: a one-line
-- `sweep_new_bookings()` that offers a booking to the first eligible
-- professional in `created_at` order. Its own header says Phase 5
-- replaces it whole, and `booking_assignments`' comment reserves
-- `attempt_no` and `round_no` for exactly this file.
--
-- Phase 5 adds the four things that make it an engine:
--
--   1. A ranked candidate list (`rank_candidates`), so "the next
--      eligible professional" is a choice rather than a table scan.
--   2. An advisory-locked single-booking matcher (`match_booking`), so
--      two concurrent sweeps agree on who is next instead of racing.
--   3. The reassignment cascade — a declined or expired offer puts the
--      booking back in `searching` (the spec's §8.2 edge, absent from
--      the Phase 4 table) and the next round offers the next candidate.
--   4. Exhaustion: when the ranked list is empty and the search window
--      has closed, the booking is cancelled `no_professional_available`
--      and the JS caller refunds it (the Phase 3 cancel path, reused).
--
-- FAN-OUT IS ROUND-BASED, NOT SIMULTANEOUS
-- ----------------------------------------
-- `uniq_active_assignment_per_booking` (0012) permits at most one live
-- (`offered`|`accepted`) assignment per booking, which is the whole of
-- the double-assign guarantee. Offering the same booking to three
-- professionals at once is therefore structurally impossible without
-- dropping that index. The engine ranks and offers in *rounds*: a
-- decline or expiry advances `round_no` and offers the next candidate.
-- This is decision D1 in `05-PLAN.md`, and it is why `attempt_no` and
-- `round_no` exist on the ledger.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── Restore the spec's assigned -> searching edge ──────────
-- 0011's deployed `allowed` case omitted `'assigned'` from the
-- predecessors of `searching`, on purpose: Phase 4 could not reassign,
-- so allowing the hop would have been a door with no corridor behind
-- it. Phase 5 builds the corridor. This is §8.2 row "assigned ->
-- searching, actor system, offer expired or professional declined".
--
-- The body is 0011's verbatim with that one addition — the history
-- write, the actor GUCs and the immutability guard are untouched.
create or replace function public.enforce_booking_transition()
returns trigger
language plpgsql set search_path = public as $$
declare
  allowed text[];
  v_note  text;
  v_actor uuid;
  v_role  public.user_role;
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  allowed := case new.status
    when 'payment_pending'      then array['draft']
    when 'paid'                 then array['payment_pending']
    -- Phase 5 restores 'assigned' here (reassignment after a decline or
    -- an expiry); the spec's §8.2 lists both predecessors.
    when 'searching'            then array['paid','assigned']
    when 'assigned'             then array['searching']
    when 'accepted'             then array['assigned']
    when 'on_the_way'           then array['accepted']
    when 'arrived'              then array['on_the_way']
    when 'otp_verified'         then array['arrived']
    when 'in_progress'          then array['otp_verified','extension_requested']
    when 'extension_requested'  then array['in_progress']
    when 'completed'            then array['in_progress']
    when 'cancelled'            then array['draft','payment_pending','paid','searching',
                                              'assigned','accepted','on_the_way','arrived',
                                              'otp_verified','in_progress','extension_requested']
    when 'refund_pending'       then array['cancelled','paid','accepted','on_the_way',
                                              'arrived','disputed']
    when 'refunded'             then array['refund_pending']
    when 'disputed'             then array['accepted','on_the_way','arrived',
                                              'in_progress','completed']
    when 'no_show'              then array['accepted','on_the_way','arrived',
                                              'otp_verified','in_progress']
    when 'closed'               then array['completed','refunded','no_show']
    else array[]::text[]
  end;

  if not (old.status::text = any(allowed)) then
    raise exception 'ILLEGAL_TRANSITION % -> % on booking %',
      old.status, new.status, new.id
      using errcode = 'check_violation',
            detail = format('{"from":"%s","to":"%s"}', old.status, new.status);
  end if;

  v_note  := current_setting('app.transition_note', true);
  v_actor := nullif(current_setting('app.transition_actor', true), '')::uuid;
  v_role  := nullif(current_setting('app.transition_actor_role', true), '')::public.user_role;

  if v_actor is null then
    v_actor := auth.uid();
  end if;
  if v_role is null then
    v_role := nullif(
      case when auth.jwt() ->> 'role' in (
        'customer', 'professional', 'admin', 'support', 'ops', 'super_admin'
      ) then auth.jwt() ->> 'role'
      end,
      ''
    )::public.user_role;
  end if;

  insert into public.booking_status_history
    (booking_id, from_status, to_status, actor_id, actor_role, note)
  values
    (new.id, old.status, new.status, v_actor, v_role, v_note);

  return new;
end $$;

comment on function public.enforce_booking_transition() is
  'The §8.2 transition table, enforced in Postgres. Phase 5 restores the
   assigned -> searching edge (§8.2: offer expired or professional declined) that
   0011 omitted while reassignment did not exist. Raises ILLEGAL_TRANSITION for
   any move outside the legal set and writes booking_status_history for every
   legal one.';

-- ── expire_stale_offers ────────────────────────────────────
-- The sweeper's first half: every offer past its TTL becomes a tombstone,
-- globally, and the affected bookings are returned so the caller can
-- immediately re-match them. Phase 4 expired only the *caller's* offers on
-- their inbox read (Pitfall 6); that left another professional's stale offer
-- on the same booking nobody revisited. This is the eager half.
create or replace function public.expire_stale_offers(p_now timestamptz default now())
returns setof uuid
language sql security definer set search_path = public as $$
  update public.booking_assignments
     set status = 'expired'
   where status = 'offered'
     and expires_at <= p_now
  returning booking_id;
$$;

comment on function public.expire_stale_offers(timestamptz) is
  'Expires every offer past its TTL and returns the affected booking ids, so the
   sweeper can re-offer them in the same pass. A tombstone (expired) is never
   picked up again; the reassignment cascade makes a fresh row.';

-- ── rank_candidates ────────────────────────────────────────
-- The ranked list of professionals who could take this booking, best first.
-- Eligibility is the shape 0012's minimal producer used (the same facts Phase
-- 5 keeps true), minus anyone who has already held an offer for this booking —
-- `uniq_prof_booking_offer` makes a re-offer a bug, not a retry.
--
-- Ranking is decision D3: repeat first (this professional has completed a job
-- for this customer), then load (fewest live windows — a busy professional is
-- offered last), then tenure as a stable tie-break. Distance and rating are
-- deliberately null: `earthdistance` is not installed (0002) and there is no
-- ratings roll-up until Phase 8, so a fabricated score would be a lie. `score`
-- is written as null, exactly as 0012 chose.
create or replace function public.rank_candidates(p_booking_id uuid)
returns table (
  professional_id uuid,
  was_repeat      boolean,
  load            int,
  score           numeric
)
language sql stable security definer set search_path = public as $$
  with target as (
    select b.customer_id,
           coalesce(b.scheduled_start_at, now()) as v_start,
           coalesce(
             b.scheduled_end_at,
             coalesce(b.scheduled_start_at, now()) + make_interval(mins => b.duration_minutes)
           ) as v_end
      from public.bookings b
     where b.id = p_booking_id
  )
  select
    p.id as professional_id,
    -- The professional has finished a job for this customer before.
    exists (
      select 1 from public.bookings h
       where h.professional_id = p.id
         and h.customer_id = (select customer_id from target)
         and h.status in ('completed', 'closed')
    ) as was_repeat,
    -- Live windows held right now; fewer is better.
    (
      select count(*)::int from public.professional_schedule s
       where s.professional_id = p.id
         and s.status in ('reserved', 'in_progress')
    ) as load,
    null::numeric as score
  from public.professionals p
  where p.verification_status = 'verified'
    and p.availability_status = 'online'
    and p.is_available_today
    -- Skilled for every service on the booking.
    and not exists (
      select 1 from public.booking_items bi
       where bi.booking_id = p_booking_id
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
             && tstzrange((select v_start from target), (select v_end from target), '[)')
    )
    -- Calendar is clear.
    and not exists (
      select 1 from public.professional_schedule s
       where s.professional_id = p.id
         and s.status in ('reserved', 'in_progress')
         and tstzrange(s.starts_at, s.ends_at, '[)')
             && tstzrange((select v_start from target), (select v_end from target), '[)')
    )
    -- Never offered this booking before (one offer per pro per booking).
    and not exists (
      select 1 from public.booking_assignments a
       where a.booking_id = p_booking_id
         and a.professional_id = p.id
    )
  order by was_repeat desc, load asc, p.accepted_offers asc, p.created_at, p.id;
$$;

comment on function public.rank_candidates(uuid) is
  'The ranked, eligible professionals for a booking, best first (§9.1). Repeat
   before load before tenure; distance and rating are null until earthdistance
   and the ratings roll-up exist. Excludes professionals already offered this
   booking.';

-- ── match_booking ──────────────────────────────────────────
-- Match one booking, under the spec's advisory lock (§9.4):
-- `pg_advisory_xact_lock(hashtext('assign:'||booking_id))`. Two concurrent
-- sweeps serialise here, so the second sees the first's live offer and no-ops
-- instead of issuing a second one. `uniq_active_assignment_per_booking` is the
-- backstop; the lock is what makes the *choice* deterministic.
--
-- It walks the legal hops one at a time (the transition trigger is still the
-- only thing that writes `status`), stamps the SLA columns, and returns a
-- small outcome object so the JS caller knows whether to refund an exhaustion.
create or replace function public.match_booking(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  -- Mirrors PLATFORM_DEFAULTS in lib/constants.ts (offerTtlMinutes,
  -- searchWindowMinutes). A `platform_settings` read lands in Phase 6.
  v_offer_ttl_minutes   constant int := 15;
  v_search_window_min   constant int := 30;
  v_booking       public.bookings;
  v_pro           uuid;
  v_was_repeat    boolean;
  v_score         numeric;
  v_attempt       int;
  v_round         int;
  v_assignment_id uuid;
  v_live          int;
begin
  perform pg_advisory_xact_lock(hashtext('assign:' || p_booking_id::text)::bigint);

  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    return jsonb_build_object('outcome', 'noop', 'booking_id', p_booking_id);
  end if;

  -- Tombstone this booking's stale offers before deciding anything.
  update public.booking_assignments
     set status = 'expired'
   where booking_id = p_booking_id
     and status = 'offered'
     and expires_at <= now();

  -- A live offer or acceptance means somebody already holds it.
  select count(*) into v_live
    from public.booking_assignments
   where booking_id = p_booking_id
     and status in ('offered', 'accepted');
  if v_live > 0 then
    return jsonb_build_object('outcome', 'noop', 'booking_id', p_booking_id);
  end if;

  -- paid -> searching, starting the SLA clock once.
  if v_booking.status = 'paid' then
    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'matching started', true);

    update public.bookings
       set status = 'searching',
           search_started_at = coalesce(search_started_at, now()),
           search_expires_at = coalesce(
             search_expires_at,
             now() + make_interval(mins => v_search_window_min)
           )
     where id = p_booking_id and status = 'paid'
    returning * into v_booking;

    if v_booking.id is null then
      select * into v_booking from public.bookings where id = p_booking_id;
    end if;
  end if;

  if v_booking.status not in ('searching', 'assigned') then
    return jsonb_build_object('outcome', 'noop', 'booking_id', p_booking_id);
  end if;

  -- Reassignment: a booking left `assigned` by a decline or an expiry
  -- (Phase 4's deliberate dead-end) walks back into the search.
  if v_booking.status = 'assigned' then
    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'reassignment after decline/expiry', true);

    update public.bookings
       set status = 'searching'
     where id = p_booking_id and status = 'assigned'
    returning * into v_booking;

    if v_booking.id is null then
      select * into v_booking from public.bookings where id = p_booking_id;
    end if;
  end if;

  -- The best remaining candidate.
  select r.professional_id, r.was_repeat, r.score
    into v_pro, v_was_repeat, v_score
    from public.rank_candidates(p_booking_id) r
   limit 1;

  if v_pro is not null then
    select count(*)::int + 1 into v_attempt
      from public.booking_assignments where booking_id = p_booking_id;
    v_round := v_booking.assignment_rounds + 1;

    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'offer sent', true);

    update public.bookings
       set status = 'assigned',
           professional_id = v_pro,
           matched_at = now(),
           assignment_rounds = assignment_rounds + 1
     where id = p_booking_id and status = 'searching'
    returning * into v_booking;

    insert into public.booking_assignments
      (booking_id, professional_id, status, attempt_no, round_no,
       score, was_repeat, was_favourite, offered_at, expires_at)
    values
      (p_booking_id, v_pro, 'offered', v_attempt, v_round,
       v_score, coalesce(v_was_repeat, false), false, now(),
       now() + make_interval(mins => v_offer_ttl_minutes))
    returning id into v_assignment_id;

    update public.professionals
       set total_offers = total_offers + 1
     where id = v_pro;

    return jsonb_build_object(
      'outcome', 'offered',
      'booking_id', p_booking_id,
      'professional_id', v_pro,
      'assignment_id', v_assignment_id,
      'round_no', v_round
    );
  end if;

  -- No candidate. The spec closes the search on a deadline: if it has
  -- passed, the booking is cancelled for want of a professional and the JS
  -- caller refunds it (D2); otherwise it stays searching for the sweeper.
  if now() >= coalesce(v_booking.search_expires_at, now()) then
    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'no_professional_available', true);

    update public.bookings
       set status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason_code = 'no_professional_available'
     where id = p_booking_id and status = 'searching'
    returning * into v_booking;

    return jsonb_build_object('outcome', 'exhausted', 'booking_id', p_booking_id);
  end if;

  return jsonb_build_object('outcome', 'searching', 'booking_id', p_booking_id);
end $$;

comment on function public.match_booking(uuid) is
  'Matches one booking under the §9.4 advisory lock. Walks paid -> searching ->
   assigned, or assigned -> searching for a reassignment, making one ranked
   offer (§9.1, round-based per D1). Returns {outcome: offered|searching|
   exhausted|noop, ...}; exhausted means the search window closed with no
   candidate and the booking is now cancelled no_professional_available for the
   caller to refund.';

-- ── run_matching_sweep ─────────────────────────────────────
-- The producer. Expires every stale offer, then matches every booking that is
-- waiting: a fresh `paid` booking, a `searching` booking still inside its
-- window (retry), or an `assigned` booking whose offer was declined or expired.
-- Called by the offers inbox read today and by the §25.11 cron when one exists.
create or replace function public.run_matching_sweep()
returns setof jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform public.expire_stale_offers(now());

  for v_id in
    select b.id
      from public.bookings b
     where not exists (
             select 1 from public.booking_assignments a
              where a.booking_id = b.id and a.status in ('offered', 'accepted')
           )
       and (
         b.status = 'paid'
         or b.status = 'searching'
         or (
           b.status = 'assigned'
           and exists (
             select 1 from public.booking_assignments a2
              where a2.booking_id = b.id and a2.status in ('rejected', 'expired')
           )
         )
       )
     order by b.created_at
  loop
    return next public.match_booking(v_id);
  end loop;
end $$;

comment on function public.run_matching_sweep() is
  'The matching producer: expire stale offers, then match every waiting booking
   and return one {outcome,...} per booking. Idempotent — a booking with a live
   offer is a noop, so the inbox read and a cron can both call it.';

-- ── Retire the Phase 4 producer ────────────────────────────
drop function if exists public.sweep_new_bookings();

-- ── Grants ─────────────────────────────────────────────────
-- security definer: the EXECUTE grant belongs to the *caller*. These write
-- the offer ledger and the booking's state, so anon and authenticated get
-- nothing; only the service role (Route Handlers, cron) may.
revoke all on function public.expire_stale_offers(timestamptz) from public, anon, authenticated;
revoke all on function public.rank_candidates(uuid) from public, anon, authenticated;
revoke all on function public.match_booking(uuid) from public, anon, authenticated;
revoke all on function public.run_matching_sweep() from public, anon, authenticated;

grant execute on function public.expire_stale_offers(timestamptz) to service_role;
grant execute on function public.rank_candidates(uuid) to service_role;
grant execute on function public.match_booking(uuid) to service_role;
grant execute on function public.run_matching_sweep() to service_role;
