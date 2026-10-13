-- ============================================================
-- 0036_broadcast_matching.sql
-- SmartHelp: broadcast matching — one booking, every eligible
-- professional at once, first accept wins.
--
-- Spec: §8.2 (transitions), §9.1 (candidate eligibility), §9.4
--       (the advisory lock), §24.8 (the offer ledger).
-- Depends on: 0010/0011 (bookings + state machine), 0012
--       (booking_assignments + CAS RPCs), 0032 (the engine this
--       replaces), 0034 (the `assign:<id>` lock's other users).
--
-- WHY THIS EXISTS
-- ---------------
-- 0032's engine was deliberately round-based. `uniq_active_assignment_per_booking`
-- (0012) permitted at most one live (`offered`|`accepted`) row per booking, so
-- "offer this job to three professionals at once" was structurally impossible
-- without dropping that index, and the engine ranked and offered in rounds
-- instead (decision D1 in 05-PLAN.md).
--
-- The product decision is now the other one: a booking is *broadcast* to every
-- eligible professional at the same time, and the first acceptance wins — the
-- job disappears from everyone else's inbox the instant it is taken. That is
-- why this file exists, and it is the only thing it changes:
--
--   1. The double-accept guarantee moves from the *live* row to the
--      *accepted* row. Many offers may be live on one booking; only one
--      acceptance ever can be. `uniq_accepted_assignment_per_booking`
--      replaces `uniq_active_assignment_per_booking`.
--   2. `match_booking` offers to the whole ranked candidate list instead of
--      `limit 1`. The booking still walks `searching -> assigned`, but it
--      carries no `professional_id` while the round is open: nobody owns it
--      until they accept.
--   3. `accept_offer` is unchanged in spirit — still a compare-and-set — but
--      it now takes the §9.4 advisory lock, sets the booking's `professional_id`
--      to the winner, and withdraws every other live offer for the booking in
--      the same transaction.
--
-- The state machine is untouched. `assigned` keeps its meaning of "the job has
-- been dispatched and awaits an answer"; the only difference is that many
-- professionals can be awaiting it rather than one. An exhaustion still walks
-- `searching -> cancelled` and the JS caller refunds it, exactly as 0032 built.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── Allow many live offers, still only one acceptance ──────
-- The old index watched `offered` and `accepted` together. Broadcast needs
-- `offered` to be many, so the guarantee is narrowed to the state that must
-- stay unique: a booking can be accepted by at most one professional, ever.
--
-- Round-based re-offers were the old reason a second `offered` row was a bug;
-- with a broadcast, every eligible professional legitimately holds one at the
-- same time. `uniq_prof_booking_offer` (0012) still holds: one professional
-- never holds two rows for the same booking, broadcast or not.
drop index if exists public.uniq_active_assignment_per_booking;

create unique index if not exists uniq_accepted_assignment_per_booking
  on public.booking_assignments (booking_id)
  where status = 'accepted';

comment on index public.uniq_accepted_assignment_per_booking is
  'The double-accept guarantee (§24.8), narrowed for broadcast matching: a
   booking may carry many live offers but is accepted by at most one
   professional. Combined with accept_offer''s compare-and-set under the §9.4
   advisory lock, the second of two concurrent accepts affects zero rows.';

-- ── match_booking: broadcast to the whole ranked list ──────
-- Same shape as 0032's matcher, with the fan-out decision changed: it offers
-- to *every* eligible professional, best-ranked first, rather than to one.
-- The advisory lock, the stale-offer tombstoning, the `paid -> searching`
-- clock, the `assigned -> searching` reassignment edge and the exhaustion
-- branch are all 0032's, unchanged.
--
-- `rank_candidates` remains the eligibility gate (verified, online, available
-- today, skilled for every service, free on the calendar, never offered this
-- booking) and the sort: repeat, then load, then tenure. Broadcast changes the
-- *count* offered, not who is eligible for an offer in the first place.
--
-- The booking leaves `searching` on the first offer and stays `assigned` for
-- the life of the round, but keeps `professional_id = null`: during a
-- broadcast nobody owns the job yet, and naming one of many offered pros would
-- be a lie the customer's track screen would then have to un-tell. The winner
-- is written by `accept_offer` below.
create or replace function public.match_booking(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  -- Mirrors PLATFORM_DEFAULTS in lib/constants.ts (offerTtlMinutes,
  -- searchWindowMinutes). A `platform_settings` read lands in Phase 6.
  v_offer_ttl_minutes   constant int := 15;
  v_search_window_min   constant int := 30;
  v_booking       public.bookings;
  v_round         int;
  v_attempt_base  int;
  v_offered       int := 0;
  v_first_pro     uuid;
  v_professional_ids jsonb := '[]'::jsonb;
  r               record;
  v_live          int;
  v_candidates    int;
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

  -- Any live offer means the round is still open: no top-up while it runs.
  -- The next broadcast happens only once every offer has been answered.
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

  -- Reassignment: a booking left `assigned` by a round that expired or was
  -- declined walks back into the search for a fresh broadcast.
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

  select count(*)::int into v_candidates from public.rank_candidates(p_booking_id);

  if v_candidates > 0 then
    v_round := v_booking.assignment_rounds + 1;

    select count(*)::int into v_attempt_base
      from public.booking_assignments where booking_id = p_booking_id;

    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'offers broadcast', true);

    -- searching -> assigned once for the whole round. No `professional_id`:
    -- the job is dispatched but unowned until somebody accepts it.
    update public.bookings
       set status = 'assigned',
           matched_at = now(),
           assignment_rounds = assignment_rounds + 1
     where id = p_booking_id and status = 'searching'
    returning * into v_booking;

    if v_booking.id is null then
      select * into v_booking from public.bookings where id = p_booking_id;
    end if;

    -- One offer per eligible professional, best-ranked first.
    for r in
      select professional_id, was_repeat, score
        from public.rank_candidates(p_booking_id)
    loop
      v_offered := v_offered + 1;
      if v_first_pro is null then
        v_first_pro := r.professional_id;
      end if;
      v_professional_ids := v_professional_ids || to_jsonb(r.professional_id);

      insert into public.booking_assignments
        (booking_id, professional_id, status, attempt_no, round_no,
         score, was_repeat, was_favourite, offered_at, expires_at)
      values
        (p_booking_id, r.professional_id, 'offered',
         v_attempt_base + v_offered, v_round,
         r.score, coalesce(r.was_repeat, false), false, now(),
         now() + make_interval(mins => v_offer_ttl_minutes));

      update public.professionals
         set total_offers = total_offers + 1
       where id = r.professional_id;
    end loop;

    return jsonb_build_object(
      'outcome', 'offered',
      'booking_id', p_booking_id,
      'offered_count', v_offered,
      'professional_ids', v_professional_ids,
      'professional_id', v_first_pro,
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
  'Matches one booking under the §9.4 advisory lock, broadcasting one ranked
   offer to *every* eligible professional (§9.1) rather than offering in rounds.
   Walks paid -> searching -> assigned, or assigned -> searching for a
   reassignment; the booking carries no professional_id until somebody accepts.
   Returns {outcome: offered|searching|exhausted|noop, ...}; `offered` carries
   offered_count and professional_ids, and `exhausted` means the search window
   closed with no candidate and the booking is now cancelled
   no_professional_available for the caller to refund.';

-- ── accept_offer: first accept wins, the rest are withdrawn ──
-- The compare-and-set is 0012's, with three additions broadcast requires:
--
--   1. It resolves the booking first and takes the same `assign:<booking_id>`
--      advisory lock `match_booking` and 0034's staff paths take, so an accept
--      and a broadcast serialise on one key instead of racing.
--   2. It withdraws every other live offer on the booking in the same
--      transaction, so the job leaves the other professionals' inboxes the
--      instant it is taken.
--   3. It writes the winner onto `bookings.professional_id`, which broadcast's
--      matcher deliberately leaves null.
--
-- Two accepts racing on different offers resolve cleanly: the lock serialises
-- them, the first accepts and withdraws the second's offer, and the second's
-- compare-and-set then matches nothing and returns null (the route's 409).
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
  v_booking_id uuid;
begin
  -- Resolve the booking before locking: the lock is on the booking, not the
  -- offer, so it is the same key the matcher and the staff paths hold.
  select booking_id into v_booking_id
    from public.booking_assignments
   where id = p_assignment_id
     and professional_id = p_professional_id;

  if v_booking_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('assign:' || v_booking_id::text)::bigint);

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

  -- The winner is in. Every other professional still holding an offer for this
  -- booking loses it now, so the job disappears from their inbox at once.
  update public.booking_assignments
     set status = 'withdrawn',
         responded_at = now()
   where booking_id = v_assignment.booking_id
     and id <> p_assignment_id
     and status = 'offered';

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
         professional_id = p_professional_id,
         accepted_at = now()
   where id = v_assignment.booking_id
   returning * into v_booking;

  update public.professionals
     set accepted_offers = accepted_offers + 1
   where id = p_professional_id;

  return v_assignment;
end $$;

comment on function public.accept_offer(uuid, uuid) is
  'Accepts an offer by compare-and-set (§24.8), under the §9.4 advisory lock.
   Returns the assignment on success, or NULL if the offer was not live (already
   answered, expired, a different professional, or withdrawn because somebody
   else accepted first). On success it withdraws every other live offer on the
   booking and writes the winner onto bookings.professional_id. Reserves the
   booking window through the professional_schedule exclusion constraint; an
   overlap surfaces as PROFESSIONAL_UNAVAILABLE (23P01).';

-- ── Grants ─────────────────────────────────────────────────
-- Unchanged from 0012/0032: these write the offer ledger and the booking's
-- state, so only the service role (Route Handlers, cron) may call them.
revoke all on function public.match_booking(uuid) from public, anon, authenticated;
revoke all on function public.accept_offer(uuid, uuid) from public, anon, authenticated;

grant execute on function public.match_booking(uuid) to service_role;
grant execute on function public.accept_offer(uuid, uuid) to service_role;
