-- ============================================================
-- 0029_service_execution.sql
-- SmartHelp Phase 4: the job-execution write path.
--
-- Spec: §10.1 (service OTP), §10.4 (completion), §8.2/§8.3 (transitions),
--       §24.5 (KYC verdict), D3 (OTP lockout), D4 (earnings row)
-- Depends on: 0010/0011 (bookings + state machine), 0013 (schedule),
--             0017 (ratings precedent), 0021 (professional_earnings),
--             0024 (write_audit), 0005 (current professional guards).
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Phase 4 is the first phase that lets a professional *change* a booking
-- through the job flow: arrive, verify the service OTP, start, finish.
-- Every one of those is a security-definer function here, single-statement
-- in the 0028 style, so the state machine (0011) is the only thing that
-- decides legality and the actor is recorded in booking_status_history.
--
-- All six functions are service-role-only. The Route Handlers behind them
-- authenticate and authorise; these functions are the mechanism, not the
-- policy.
--
-- `write_audit` is deliberately NOT called from these functions: like the
-- Phase 3 RPCs, the *route* writes the audit row (lib/audit.ts), because
-- the reason and the request context live there. C1's no-show route does
-- exactly that.
--
-- TRANSITION SHAPE (0011 is the authority)
-- ----------------------------------------
--   accept_offer (0012): assigned -> accepted -> on_the_way
--   arrive_job:          on_the_way -> arrived
--   verify_service_otp:  arrived -> otp_verified -> in_progress
--   complete_job:        in_progress -> completed
--   no_show_job:         accepted|on_the_way|arrived|otp_verified|in_progress -> no_show
--
-- `accepted` and `otp_verified` are both transient by design: the accept
-- is also "I am on my way", and a verified code is also "the job has
-- started". Both hops are walked one legal step at a time so
-- booking_status_history records each.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── Lockout column (D3) ────────────────────────────────────
-- §10.1 fixes the attempt cap but not what happens after it. D3 chose a
-- timed lockout over a permanent one; this column is its only state.
alter table public.bookings
  add column if not exists otp_locked_until timestamptz;

comment on column public.bookings.otp_locked_until is
  'Set when otp_attempts reaches the cap (D3): verification is refused
   until this time passes. NULL means not locked.';

-- ── arrive_job ─────────────────────────────────────────────
-- `on_the_way -> arrived` only. The geofence itself is checked in the
-- route (D7) — this function trusts a route that has already decided and
-- stays a single versioned UPDATE (Pitfall 4). Zero rows means the
-- version moved; the trigger raises ILLEGAL_TRANSITION for a wrong state.
create or replace function public.arrive_job(
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
  perform set_config('app.transition_note', 'arrival confirmed', true);

  update public.bookings
     set status = 'arrived',
         arrived_at = now()
   where id = p_booking_id
     and professional_id = p_professional_id
     and version = p_expected_version
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.arrive_job(uuid, uuid, int) is
  'Moves on_the_way -> arrived and stamps arrived_at. The geofence is the
   route''s job (D7); this is a single versioned UPDATE. NULL means the
   version was stale; an illegal state raises ILLEGAL_TRANSITION.';

-- ── issue_service_otp ──────────────────────────────────────
-- Mints the service OTP. The route generates the code and passes only its
-- hash (the plaintext never reaches SQL). Legal only from `arrived`, and
-- only while otp_generations < otpMaxGenerations (3 in
-- lib/constants.ts; the route passes the ttl, this mirrors the ceiling).
create or replace function public.issue_service_otp(
  p_booking_id   uuid,
  p_code_hash    text,
  p_ttl_minutes  int
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  update public.bookings
     set otp_hash        = p_code_hash,
         otp_expires_at  = now() + make_interval(mins => p_ttl_minutes),
         otp_generations = otp_generations + 1,
         otp_attempts    = 0,
         otp_locked_until = null
   where id = p_booking_id
     and status = 'arrived'
     and otp_generations < 3
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.issue_service_otp(uuid, text, int) is
  'Mints a service code hash, only from `arrived` and only for the first
   three generations. NULL means not mintable (wrong state or cap
   reached); the route maps that to 409.';

-- ── verify_service_otp ─────────────────────────────────────
-- §10.1's own SQL, extended across the two-hop `arrived -> otp_verified ->
-- in_progress` path and with the D3 failure path in the same transaction.
-- The client always gets the same generic 403 for any failure (Pitfall 5);
-- the route logs which of invalid/expired/locked it was.
create or replace function public.verify_service_otp(
  p_booking_id   uuid,
  p_code         text,
  p_max_attempts int
) returns table (started_at timestamptz, ends_at timestamptz)
language plpgsql security definer set search_path = public as $$
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
   answers one generic 403 (Pitfall 5).';

-- ── complete_job ───────────────────────────────────────────
-- `in_progress -> completed`. Closes the schedule window, bumps the
-- counter and writes the pending earnings row (D4). The commission basis
-- is the frozen one (see 0021's header): net is the engine's
-- professionalGross, commission is the engine's commission, and
-- gross = net + commission. §7.5's 24-hour hold is `available_at`.
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
   (D4). NULL means the version was stale.';

-- ── no_show_job ────────────────────────────────────────────
-- Records a no-show. Reason is mandatory. Hard rule 2: this function
-- touches no refund and no wallet — a professional never cancels their
-- own job into a refund path; that resolution is ops' (Phase 5/6).
create or replace function public.no_show_job(
  p_booking_id       uuid,
  p_professional_id  uuid,
  p_reason           text
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
  v_profile uuid;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'NO_SHOW_REASON_REQUIRED' using errcode = 'check_violation';
  end if;

  select profile_id into v_profile
    from public.professionals where id = p_professional_id;

  perform set_config('app.transition_actor', coalesce(v_profile::text, ''), true);
  perform set_config('app.transition_actor_role', 'professional', true);
  perform set_config('app.transition_note', 'no-show: ' || p_reason, true);

  update public.bookings
     set status = 'no_show',
         notes = coalesce(notes, p_reason)
   where id = p_booking_id
     and professional_id = p_professional_id
  returning * into v_booking;

  if not found then
    return null;
  end if;

  -- Free the calendar: the window is released, not completed.
  update public.professional_schedule
     set status = 'released'
   where booking_id = p_booking_id and status in ('reserved', 'in_progress');

  update public.professionals
     set no_shows = no_shows + 1
   where id = p_professional_id;

  return v_booking;
end $$;

comment on function public.no_show_job(uuid, uuid, text) is
  'Marks a job no-show (reason mandatory). Releases the schedule window
   and bumps no_shows. Deliberately touches no refund or wallet (hard
   rule 2); NULL means the booking is not the caller''s. The illegal-state
   case raises ILLEGAL_TRANSITION from the 0011 trigger.';

-- ── kyc_document_decision ──────────────────────────────────
-- D2's roll-up. Applies the verdict to one document, then re-derives the
-- professional's verification_status from the required set:
--   * any required document `rejected`  => professional `rejected`
--   * all required documents `verified` => professional `verified`
--                                         (+ kyc_verified_at = now())
--   * otherwise                         => professional `submitted`
-- "Required" is the three-step stepper's documents (Identity / Address /
-- Selfie): aadhaar_front, address_proof, selfie. The list is local to
-- this function so Phase 6 can widen it without touching callers.
-- rejection_reason is left to the route (B1), which owns the free-text
-- note; this function only moves the verdict and the timestamps.
create or replace function public.kyc_document_decision(
  p_document_id uuid,
  p_verdict     public.verification_status,
  p_admin       uuid
) returns public.verification_status
language plpgsql security definer set search_path = public as $$
declare
  v_required  text[] := array['aadhaar_front','address_proof','selfie'];
  v_doc       public.professional_documents;
  v_rejected  int;
  v_verified  int;
  v_status    public.verification_status;
begin
  if p_verdict not in ('verified', 'rejected') then
    raise exception 'KYC_VERDICT_INVALID' using errcode = 'check_violation';
  end if;

  if p_verdict = 'verified' then
    update public.professional_documents
       set status = p_verdict,
           reviewed_by = p_admin,
           reviewed_at = now(),
           rejection_reason = null
     where id = p_document_id
    returning * into v_doc;
  else
    update public.professional_documents
       set status = p_verdict,
           reviewed_by = p_admin,
           reviewed_at = now()
     where id = p_document_id
    returning * into v_doc;
  end if;

  if not found then
    return null;
  end if;

  select count(*) filter (where status = 'rejected'),
         count(*) filter (where status = 'verified')
    into v_rejected, v_verified
    from public.professional_documents
   where professional_id = v_doc.professional_id
     and doc_type = any (v_required);

  if v_rejected > 0 then
    v_status := 'rejected';
  elsif v_verified = array_length(v_required, 1) then
    v_status := 'verified';
  else
    v_status := 'submitted';
  end if;

  update public.professionals
     set verification_status = v_status,
         kyc_verified_at = case
           when v_status = 'verified' then now()
           else kyc_verified_at
         end
   where id = v_doc.professional_id;

  return v_status;
end $$;

comment on function public.kyc_document_decision(uuid, public.verification_status, uuid) is
  'Applies a KYC verdict to one document and rolls the result up onto the
   professional (D2): any required document rejected => rejected; all
   required verified => verified + kyc_verified_at; otherwise submitted.
   Returns the resulting professional status, or NULL if the document
   does not exist.';

-- ── Grants ─────────────────────────────────────────────────
revoke all on function public.arrive_job(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.issue_service_otp(uuid, text, int) from public, anon, authenticated;
revoke all on function public.verify_service_otp(uuid, text, int) from public, anon, authenticated;
revoke all on function public.complete_job(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.no_show_job(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.kyc_document_decision(uuid, public.verification_status, uuid) from public, anon, authenticated;

grant execute on function public.arrive_job(uuid, uuid, int) to service_role;
grant execute on function public.issue_service_otp(uuid, text, int) to service_role;
grant execute on function public.verify_service_otp(uuid, text, int) to service_role;
grant execute on function public.complete_job(uuid, uuid, int) to service_role;
grant execute on function public.no_show_job(uuid, uuid, text) to service_role;
grant execute on function public.kyc_document_decision(uuid, public.verification_status, uuid) to service_role;

-- ── Column hardening (Pitfall 1: the verified otp_hash exposure) ──
-- `authenticated` held blanket SELECT on `bookings`, so a signed-in
-- customer reading their own booking through PostgREST could ask for
-- `otp_hash`. Revoke the table grant and re-grant every column except
-- `otp_hash`. The loop is used rather than a hand-written column list so
-- it cannot drift from the schema. Every Route Handler reads bookings
-- through the service role, so nothing the app does is affected.
--
-- [ASSUMED] standard Postgres column privileges. If a live project
-- refuses this form, the fallback is route-layer stripping only (already
-- done in lib/professionalServer.ts) plus a loud note here — never a
-- silent hole.
revoke select on public.bookings from authenticated;

do $$
declare
  c text;
begin
  for c in
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'bookings'
       and column_name <> 'otp_hash'
  loop
    execute format('grant select (%I) on public.bookings to authenticated', c);
  end loop;
end $$;
