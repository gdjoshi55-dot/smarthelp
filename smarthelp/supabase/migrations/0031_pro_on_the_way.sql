-- ============================================================
-- 0031_pro_on_the_way.sql
-- SmartHelp: the missing first step of a job run.
--
-- The phase 4 execution chain reads `accepted -> on_the_way ->
-- arrived -> otp_verified -> in_progress -> completed`, but only the
-- last four hops had writers: `arrive_job` expects to start from
-- `on_the_way` (0029), and nothing ever set `on_the_way`. A
-- professional who accepted a job saw a sentence and no first button,
-- and the arrival/Otp/complete actions after it were unreachable.
--
-- This file adds the compare-and-set `start_journey`, the single
-- versioned `accepted -> on_the_way` hop, written in exactly the shape
-- `arrive_job` is: the caller is the Route Handler already validated
-- as the booking's professional, the trigger (0011) is the state
-- authority, and `version` is the optimistic lock.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §20.8, §8.2.
-- ============================================================

create or replace function public.start_journey(
  p_booking_id       uuid,
  p_professional_id  uuid,
  p_expected_version int
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
  v_profile uuid;
begin
  select profile_id into v_profile
    from public.professionals where id = p_professional_id;

  perform set_config('app.transition_actor', coalesce(v_profile::text, ''), true);
  perform set_config('app.transition_actor_role', 'professional', true);
  perform set_config('app.transition_note', 'on the way to the job', true);

  update public.bookings
     set status = 'on_the_way'
   where id = p_booking_id
     and professional_id = p_professional_id
     and version = p_expected_version
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.start_journey(uuid, uuid, int) is
  'Moves accepted -> on_the_way in one versioned UPDATE. NULL means the
   version was stale; a wrong state raises ILLEGAL_TRANSITION from the
   0011 trigger. The professional is already the booking''s assignee, so
   no geofence applies here - the address matters at arrival, not at
   departure.';

-- ── Grants ─────────────────────────────────────────────────
-- security definer: the EXECUTE grant belongs to the *caller*. Only the
-- service role (the Route Handler) may move a booking the professional
-- has already accepted.
revoke all on function public.start_journey(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.start_journey(uuid, uuid, int) to service_role;