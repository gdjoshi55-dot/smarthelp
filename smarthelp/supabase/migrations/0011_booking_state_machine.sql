-- ============================================================
-- 0011_booking_state_machine.sql
-- SmartHelp: the only thing that may write `bookings.status`.
--
-- §8.2 requires the transition table to be enforced twice: once
-- by the API guard, so the customer sees a sentence, and once by
-- Postgres, so that the guarantee does not depend on every future
-- caller remembering. This file is the second half, and it is the
-- half that matters.
--
-- Why a trigger and not application code:
--
--   A policy that let a browser session UPDATE `bookings` — or a
--   Route Handler written next year that forgets to call the
--   guard — can produce `refunded -> paid`. There is no test that
--   catches that, because the test would have to enumerate every
--   way to write the column. The trigger makes the answer a
--   property of the database instead of a property of the code.
--
-- It also writes `booking_status_history` itself, in the same
-- statement, so a hop cannot happen without leaving a trace and a
-- trace cannot be written without a hop.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §8.2
-- ============================================================

create or replace function public.enforce_booking_transition()
returns trigger
language plpgsql set search_path = public as $$
declare
  allowed text[];
  v_note  text;
  v_actor uuid;
  v_role  public.user_role;
begin
  -- Nothing to enforce on the way in: a booking is born `draft`.
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is not distinct from old.status then
    -- Not a transition. A reschedule, a cancellation fee or a note
    -- all update this row without moving it, and raising here would
    -- break every one of them.
    return new;
  end if;

  -- §8.2's table, read as "which states may legally become this
  -- one". Listed from NEW.status exactly as the specification
  -- writes it, so the two can be diffed by eye.
  allowed := case new.status
    when 'payment_pending'      then array['draft']
    when 'paid'                 then array['payment_pending']
    when 'searching'            then array['paid']
    when 'assigned'             then array['searching']
    when 'accepted'             then array['assigned']
    when 'on_the_way'           then array['accepted']
    when 'arrived'              then array['on_the_way']
    when 'otp_verified'         then array['arrived']
    when 'in_progress'          then array['otp_verified','extension_requested']
    when 'extension_requested'  then array['in_progress']
    when 'completed'            then array['in_progress']
    -- `paid..accepted -> cancelled` and `accepted..in_progress ->
    -- cancelled` from the table, flattened.
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
      old.status, new.status, old.id
      using errcode = 'check_violation',
            detail = format('{"from":"%s","to":"%s"}', old.status, new.status);
  end if;

  -- §8.2 takes the actor from `auth.uid()` and `auth.jwt()->>'role'`.
  -- That is null on every privileged write in this codebase: Route
  -- Handlers reach Postgres through the service-role client, so
  -- there is no customer JWT inside the database and the trail would
  -- be anonymous for exactly the events that matter — a
  -- cancellation, a refund, an ops override.
  --
  -- So the caller sets both as transaction-local settings, having
  -- already validated who they are, and the auth values are only a
  -- fallback for a direct browser write that somehow got a policy.
  v_note  := current_setting('app.transition_note', true);
  v_actor := nullif(current_setting('app.transition_actor', true), '')::uuid;
  v_role  := nullif(current_setting('app.transition_actor_role', true), '')::public.user_role;

  if v_actor is null then
    v_actor := auth.uid();
  end if;
  if v_role is null then
    v_role := nullif(auth.jwt() ->> 'role', '')::public.user_role;
  end if;

  insert into public.booking_status_history
    (booking_id, from_status, to_status, actor_id, actor_role, note)
  values
    (new.id, old.status, new.status, v_actor, v_role, v_note);

  return new;
end $$;

comment on function public.enforce_booking_transition() is
  'The §8.2 transition table, enforced in Postgres. Raises ILLEGAL_TRANSITION
   (check_violation, which the Route Handler maps to 409) for any move outside
   the legal set, and writes booking_status_history for every legal one. The
   application guard in lib/bookingServer.ts exists to produce a readable error;
   this trigger is what makes the state safe.';

drop trigger if exists trg_booking_transition on public.bookings;
create trigger trg_booking_transition
  before update of status on public.bookings
  for each row execute function public.enforce_booking_transition();

-- A second trigger, AFTER, to bump the version on every write —
-- not only on a status change. A reschedule that forgot to bump it
-- would let a second device reschedule from a window that has
-- already moved, which is the exact double-booking the lock exists
-- to prevent.
--
-- Kept separate from the status trigger so that "did the state
-- change?" and "did anything change?" stay two questions. Merging
-- them would mean a reschedule silently skips the version bump.
create or replace function public.bump_booking_version()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status
     or new.scheduled_start_at is distinct from old.scheduled_start_at
     or new.scheduled_end_at is distinct from old.scheduled_end_at
     or new.duration_minutes is distinct from old.duration_minutes
     or new.notes is distinct from old.notes then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_booking_version on public.bookings;
create trigger trg_booking_version
  before update on public.bookings
  for each row execute function public.bump_booking_version();

comment on function public.bump_booking_version() is
  'Optimistic-lock bump (§28.1). Only the fields a second device could race on
   move the version: a status change, a window change, a duration change or a
   note. A pure read-side UPDATE — touching updated_at — does not, so a no-op
   write cannot make a client''s held version stale for no reason.';

-- ── The history is append-only ─────────────────────────────
-- Same shape as audit_logs_are_immutable() in 0024, because a
-- status history somebody can edit is not one. audit_logs is
-- never cascaded away, so it can refuse every delete; this one
-- cannot, because `bookings.booking_id` is ON DELETE CASCADE and
-- the booking has to be removable.
--
-- The distinction the first version got wrong: the trigger fired
-- on the cascade too, so `delete from bookings` failed with
-- BOOKING_HISTORY_IMMUTABLE and no booking could ever be deleted.
--
-- Postgres runs a referential action from an AFTER trigger on the
-- parent, so by the time the child's BEFORE DELETE fires the parent
-- row is already gone. Testing for the parent's existence is
-- therefore exactly the discriminator wanted: cascade finds no
-- parent and is allowed, a hand-rolled `delete from
-- booking_status_history` finds one and is refused.
create or replace function public.booking_history_is_immutable()
returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- Every update is refused, full stop. Returning OLD here instead would make
    -- the trigger silently discard the change rather than report it: the caller
    -- sees no error, believes the note was rewritten, and the trail disagrees.
    -- A guard that quietly does nothing is worse than no guard, because it looks
    -- like it worked.
    raise exception 'BOOKING_HISTORY_IMMUTABLE' using errcode = 'insufficient_privilege',
      detail = '{"hint":"history rows are append-only; they go away only with the booking itself"}';
  end if;

  -- DELETE is refused unless it is the cascade from a dropped booking. Postgres
  -- fires the referential action from an AFTER trigger on the parent, so by the
  -- time this runs on the child the booking is already gone — which is the
  -- discriminator.
  if exists (select 1 from public.bookings where id = old.booking_id) then
    raise exception 'BOOKING_HISTORY_IMMUTABLE' using errcode = 'insufficient_privilege',
      detail = '{"hint":"history rows are append-only; they go away only with the booking itself"}';
  end if;

  return old;
end $$;

comment on function public.booking_history_is_immutable() is
  'Refuses edits and refuses a hand-rolled delete, but permits the cascade from a
   deleted booking — which is why the guard tests whether the parent row still
   exists rather than firing unconditionally. Dropping a booking takes its trail
   with it; rewriting or orphaning it is not allowed.';

drop trigger if exists trg_bsh_immutable on public.booking_status_history;
create trigger trg_bsh_immutable
  before update or delete on public.booking_status_history
  for each row execute function public.booking_history_is_immutable();

revoke all on function public.booking_history_is_immutable() from public, anon, authenticated;
