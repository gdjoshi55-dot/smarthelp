-- ============================================================
-- 0030_service_execution_fix.sql
--
-- Two corrections to `0029_service_execution.sql`, found by the Task C1
-- live-database test (`test/db.jobs.test.ts`). 0029 is already applied
-- and recorded in the SQL ledger, so a fresh file replaces the two
-- functions rather than rewriting an applied migration.
--
--   1. `verify_service_otp` compared the submitted code with
--      `encode(digest(p_code, 'sha256'), 'hex')`, but 0029 declared it
--      with `set search_path = public`. Supabase installs pgcrypto in
--      the `extensions` schema, so digest() was unresolvable and every
--      verification raised
--      'function digest(text, unknown) does not exist' — the whole
--      start-job flow was dead on arrival. 0001 already documents this
--      exact trap for `issue_otp`/`consume_otp` and names both schemas;
--      0030 does the same here.
--
--   2. `complete_job` updated the row without a status guard. The 0011
--      transition trigger returns early when `new.status` does not
--      change, so a re-complete of an already-`completed` booking
--      matched, bumped `professionals.completed_jobs` a second time and
--      rewrote `ended_at`. Only the earnings row was safe (it is UNIQUE
--      and inserted `on conflict do nothing`). Guarding the UPDATE with
--      `status <> 'completed'` makes the retry a no-op that returns NULL
--      while still letting the state machine raise ILLEGAL_TRANSITION
--      for any other illegal origin.
--
-- Idempotent: create-or-replace only; safe to re-run on a live project.
-- ============================================================

-- ── verify_service_otp (digest() lives in extensions) ──────
create or replace function public.verify_service_otp(
  p_booking_id   uuid,
  p_code         text,
  p_max_attempts int
) returns table (started_at timestamptz, ends_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_booking public.bookings;
  v_profile uuid;
begin
  select pr.profile_id into v_profile
    from public.professionals pr
    join public.bookings b on b.professional_id = pr.id
   where b.id = p_booking_id;

  perform set_config('app.transition_actor', coalesce(v_profile::text, ''), true);
  perform set_config('app.transition_actor_role', 'professional', true);
  perform set_config('app.transition_note', 'service OTP verified', true);

  -- Success: compare-and-set against the stored hash (the DB does the
  -- constant-time comparison), with expiry, attempt and lockout gates.
  update public.bookings b
     set status          = 'otp_verified',
         otp_verified_at = now(),
         started_at      = now(),
         ends_at         = now() + make_interval(mins => b.duration_minutes)
   where b.id = p_booking_id
     and b.status = 'arrived'
     and b.otp_hash = encode(digest(p_code, 'sha256'), 'hex')
     and b.otp_expires_at > now()
     and b.otp_attempts < p_max_attempts
     and (b.otp_locked_until is null or b.otp_locked_until <= now())
  returning * into v_booking;

  if not found then
    -- Failure: count the attempt and lock out at the cap. Only a genuine
    -- wrong/expired attempt at `arrived` counts; a booking in another
    -- state is not an OTP failure at all.
    update public.bookings b
       set otp_attempts = b.otp_attempts + 1,
           otp_locked_until = case
             when b.otp_attempts + 1 >= p_max_attempts
               then now() + interval '15 minutes'
             else b.otp_locked_until
           end
     where b.id = p_booking_id
       and b.status = 'arrived'
       and b.otp_hash is not null
       and b.otp_expires_at > now()
       and (b.otp_locked_until is null or b.otp_locked_until <= now());
    return;
  end if;

  -- otp_verified -> in_progress: the job is now running. A separate hop
  -- keeps booking_status_history honest (0011 allows in_progress only
  -- from otp_verified).
  update public.bookings
     set status = 'in_progress'
   where id = p_booking_id and status = 'otp_verified';

  return query select v_booking.started_at, v_booking.ends_at;
end $$;

comment on function public.verify_service_otp(uuid, text, int) is
  'Verifies the service code and starts the job: arrived -> otp_verified
   -> in_progress, stamping otp_verified_at/started_at/ends_at from the
   server clock. Zero rows means invalid, expired or locked — the caller
   answers one generic 403 (Pitfall 5). search_path includes `extensions`
   because pgcrypto''s digest() lives there (0030).';

-- ── complete_job ───────────────────────────────────────────
-- `in_progress -> completed`. Closes the schedule window, bumps the
-- counter and writes the pending earnings row (D4). The commission basis
-- is the frozen one (see 0021's header): net is the engine's
-- professionalGross, commission is the engine's commission, and
-- gross = net + commission. §7.5's 24-hour hold is `available_at`.
--
-- The `status <> 'completed'` guard (0030) makes a retry idempotent: the
-- same-status UPDATE would otherwise match and bump `completed_jobs`
-- again, because the 0011 trigger ignores a non-transition.
create or replace function public.complete_job(
  p_booking_id       uuid,
  p_professional_id  uuid,
  p_expected_version int
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking    public.bookings;
  v_profile    uuid;
  v_net        numeric(12,2);
  v_commission numeric(12,2);
begin
  select profile_id into v_profile
    from public.professionals where id = p_professional_id;

  perform set_config('app.transition_actor', coalesce(v_profile::text, ''), true);
  perform set_config('app.transition_actor_role', 'professional', true);
  perform set_config('app.transition_note', 'job completed', true);

  update public.bookings
     set status = 'completed',
         completed_at = now(),
         ended_at = coalesce(ended_at, now()),
         actual_duration_minutes = greatest(
           0,
           floor(extract(epoch from (coalesce(ended_at, now()) - started_at)) / 60)::int
         )
   where id = p_booking_id
     and professional_id = p_professional_id
     and version = p_expected_version
     and status <> 'completed'
  returning * into v_booking;

  if not found then
    return null;
  end if;

  update public.professional_schedule
     set status = 'completed'
   where booking_id = p_booking_id and status = 'reserved';

  update public.professionals
     set completed_jobs = completed_jobs + 1
   where id = p_professional_id;

  -- Frozen commission basis (see 0021): prefer the snapshot, fall back to
  -- the booking columns. net = professionalGross; gross = net + commission.
  v_net := coalesce(
    nullif(v_booking.pricing_snapshot->'totals'->>'professionalGross', '')::numeric,
    v_booking.professional_gross
  );
  v_commission := coalesce(
    nullif(v_booking.pricing_snapshot->'totals'->>'commission', '')::numeric,
    0
  );

  insert into public.professional_earnings
    (professional_id, booking_id, gross_amount, commission_pct,
     commission_amount, net_amount, status, available_at)
  values
    (p_professional_id, p_booking_id, v_net + v_commission,
     v_booking.commission_pct, v_commission, v_net,
     'pending', now() + interval '24 hours')
  on conflict (booking_id) do nothing;

  return v_booking;
end $$;

comment on function public.complete_job(uuid, uuid, int) is
  'Completes a job: in_progress -> completed, stamps ended_at and
   actual_duration_minutes from the server clock, closes the schedule
   window, bumps completed_jobs and inserts the pending earnings row
   (D4). NULL means the version was stale or the job was already
   completed (0030 guard).';

-- Re-assert the service-role-only surface. `create or replace` keeps the
-- existing ACL, but naming it here means 0030 is self-contained and the
-- revoke cannot drift from the function it protects.
revoke all on function public.verify_service_otp(uuid, text, int) from public, anon, authenticated;
revoke all on function public.complete_job(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.verify_service_otp(uuid, text, int) to service_role;
grant execute on function public.complete_job(uuid, uuid, int) to service_role;
