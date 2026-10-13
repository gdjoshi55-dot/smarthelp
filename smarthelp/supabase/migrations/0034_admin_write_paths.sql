-- ============================================================
-- 0034_admin_write_paths.sql
-- SmartHelp Phase 6: the two staff write paths that need to be
-- more than one statement.
--
-- Spec: §8.2 (transitions), §9.4 (the advisory lock), §11.1
--       (the cancellation fee), §20.12 (every action audited),
--       §22 (the admin booking actions), §31.1 (Phase 6).
-- Depends on: 0010/0011 (bookings + state machine), 0012
--       (booking_assignments), 0013 (professional_schedule),
--       0032 (the `assign:<id>` advisory lock and its shape).
--
-- WHY THESE ARE FUNCTIONS
-- -----------------------
-- Both are "change the booking's status and the rows around it at
-- once", which is exactly the argument 0028 makes: PostgREST cannot
-- run an UPDATE, an assignment withdrawal and a schedule release in
-- one transaction across three HTTP requests, and a half-applied
-- staff action is the kind of state a refund dispute is made of.
--
-- Neither decides whether a move is legal: 0011's trigger still
-- refuses anything outside §8.2, and these only set the actor
-- settings and write `status`. `admin_cancel_booking` reuses the
-- §11.1 fee the *route* computed (the ladder lives in
-- `lib/cancellation.ts`, not in SQL) — the function records it, it
-- does not calculate it.
--
-- Both take the same `assign:<booking_id>` advisory lock Phase 5's
-- `match_booking` takes, so a manual action and the matching sweeper
-- serialise on the same key instead of racing for the last offer.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── admin_cancel_booking ───────────────────────────────────
-- Cancel on behalf of ops, and clean up the professional's hold in
-- the same statement: the live offer/acceptance is withdrawn and the
-- reserved window released, so a cancelled booking does not pin a
-- professional's calendar. `cancel_booking` (0028) does neither — it
-- is the customer path, where no professional is usually assigned.
--
-- The fee is passed in, already computed by `quoteCancellation()`
-- over the booking's total; §11.1 is a ladder of percentages and the
-- arithmetic belongs in the tested TypeScript, not duplicated here.
create or replace function public.admin_cancel_booking(
  p_booking_id  uuid,
  p_reason_code text,
  p_fee         numeric,
  p_note        text,
  p_actor       uuid,
  p_actor_role  public.user_role
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  perform pg_advisory_xact_lock(hashtext('assign:' || p_booking_id::text)::bigint);

  -- Free whoever holds the booking. A live offer or acceptance becomes a
  -- tombstone (`withdrawn`), the same way a decline or expiry does; the
  -- reserved window is deleted outright because a cancelled booking has no
  -- window to keep.
  update public.booking_assignments
     set status = 'withdrawn',
         responded_at = now()
   where booking_id = p_booking_id
     and status in ('offered', 'accepted');

  delete from public.professional_schedule
   where booking_id = p_booking_id
     and status = 'reserved';

  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.bookings
     set status                   = 'cancelled',
         cancelled_at             = now(),
         cancellation_reason_code = p_reason_code,
         cancellation_fee         = coalesce(p_fee, 0)
   where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.admin_cancel_booking(uuid, text, numeric, text, uuid, public.user_role) is
  'Cancels a booking as a staff actor, recording the §11.1 fee the caller computed
   and withdrawing the holding professional in the same statement. The fee is not
   derived here — the ladder lives in lib/cancellation.ts. Returns NULL when the
   booking does not exist; an illegal cancel raises ILLEGAL_TRANSITION from 0011.';

-- ── admin_assign_booking ───────────────────────────────────
-- Put a chosen professional on a booking (or swap one out), walking
-- the §8.2 edges one legal hop at a time under the §9.4 lock. The
-- offer it writes is the ordinary `offered` row, so the professional
-- can accept it through the normal flow — this raises the chance, it
-- does not forge an acceptance.
--
-- Only a booking that has not started service can be assigned: from
-- `accepted` onwards somebody is already on the road, and swapping
-- them is a different operation (a cancellation, then a re-match),
-- not a reassignment.
create or replace function public.admin_assign_booking(
  p_booking_id        uuid,
  p_professional_id   uuid,
  p_offer_ttl_minutes int,
  p_note              text,
  p_actor             uuid,
  p_actor_role        public.user_role
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_booking       public.bookings;
  v_pro           public.professionals;
  v_attempt       int;
  v_round         int;
  v_assignment_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('assign:' || p_booking_id::text)::bigint);

  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into v_pro from public.professionals where id = p_professional_id;
  if v_pro.id is null then
    return jsonb_build_object('outcome', 'professional_not_found');
  end if;
  if v_pro.verification_status <> 'verified' then
    return jsonb_build_object('outcome', 'professional_unverified');
  end if;

  if v_booking.status not in ('paid', 'searching', 'assigned') then
    return jsonb_build_object('outcome', 'invalid_state', 'status', v_booking.status);
  end if;

  -- Free the current holder (if any) before offering to the chosen one.
  update public.booking_assignments
     set status = 'withdrawn',
         responded_at = now()
   where booking_id = p_booking_id
     and status in ('offered', 'accepted');

  delete from public.professional_schedule
   where booking_id = p_booking_id
     and status = 'reserved';

  -- paid -> searching, starting the SLA clock once.
  if v_booking.status = 'paid' then
    perform set_config('app.transition_actor', '', true);
    perform set_config('app.transition_actor_role', '', true);
    perform set_config('app.transition_note', 'manual assignment', true);

    update public.bookings
       set status            = 'searching',
           search_started_at = coalesce(search_started_at, now()),
           search_expires_at = coalesce(search_expires_at, now() + make_interval(mins => 30))
     where id = p_booking_id and status = 'paid'
    returning * into v_booking;

    if v_booking.id is null then
      select * into v_booking from public.bookings where id = p_booking_id;
    end if;
  end if;

  -- searching -> assigned, naming the ops actor; a booking already `assigned`
  -- keeps its status and only swaps the professional.
  if v_booking.status = 'searching' then
    perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
    perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
    perform set_config('app.transition_note', coalesce(p_note, 'manually assigned'), true);

    update public.bookings
       set status            = 'assigned',
           professional_id   = p_professional_id,
           matched_at        = coalesce(matched_at, now()),
           assignment_rounds = assignment_rounds + 1
     where id = p_booking_id and status = 'searching'
    returning * into v_booking;
  else
    update public.bookings
       set professional_id = p_professional_id,
           matched_at      = coalesce(matched_at, now())
     where id = p_booking_id
    returning * into v_booking;
  end if;

  if v_booking.id is null then
    select * into v_booking from public.bookings where id = p_booking_id;
  end if;

  select count(*)::int + 1 into v_attempt
    from public.booking_assignments where booking_id = p_booking_id;
  v_round := greatest(v_booking.assignment_rounds, 1);

  -- A professional can hold only one offer per booking ever (0012's
  -- uniq_prof_booking_offer), so a re-offer to the same person updates their
  -- tombstone back to `offered` rather than inserting a second row.
  insert into public.booking_assignments
    (booking_id, professional_id, status, attempt_no, round_no, offered_at, expires_at)
  values
    (p_booking_id, p_professional_id, 'offered', v_attempt, v_round, now(),
     now() + make_interval(mins => coalesce(p_offer_ttl_minutes, 15)))
  on conflict (professional_id, booking_id) do update
    set status         = 'offered',
        offered_at     = now(),
        expires_at     = excluded.expires_at,
        responded_at   = null,
        decline_reason = null
  returning id into v_assignment_id;

  update public.professionals
     set total_offers = total_offers + 1
   where id = p_professional_id;

  return jsonb_build_object(
    'outcome',         'assigned',
    'booking_id',      p_booking_id,
    'professional_id', p_professional_id,
    'assignment_id',   v_assignment_id
  );
end $$;

comment on function public.admin_assign_booking(uuid, uuid, int, text, uuid, public.user_role) is
  'Manually offers a booking to a chosen professional, or swaps the current one
   out, under the §9.4 advisory lock. Returns {outcome: assigned|not_found|
   professional_not_found|professional_unverified|invalid_state}. The offer is an
   ordinary `offered` row so the professional still accepts it normally; the
   booking is only reassignable before service has started.';

-- ── Grants ─────────────────────────────────────────────────
-- 0024/0028's rule verbatim: these write bookings and the offer ledger, so
-- only the service role (Route Handlers) may call them. The caller has
-- authenticated the staff member and checked the capability first.
revoke all on function public.admin_cancel_booking(uuid, text, numeric, text, uuid, public.user_role) from public, anon, authenticated;
revoke all on function public.admin_assign_booking(uuid, uuid, int, text, uuid, public.user_role) from public, anon, authenticated;

grant execute on function public.admin_cancel_booking(uuid, text, numeric, text, uuid, public.user_role) to service_role;
grant execute on function public.admin_assign_booking(uuid, uuid, int, text, uuid, public.user_role) to service_role;
