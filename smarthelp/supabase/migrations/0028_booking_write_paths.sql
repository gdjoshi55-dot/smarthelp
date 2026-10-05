-- ============================================================
-- 0028_booking_write_paths.sql
-- SmartHelp: booking creation and cancellation as single statements.
--
-- Why this file exists
-- --------------------
-- 0011 made `bookings.status` safe: only the transition table may
-- move it, and every hop writes `booking_status_history`. It says
-- nothing about the rows *around* a status change, and the Route
-- Handlers were assembling a booking out of three separate
-- PostgREST requests:
--
--   1. INSERT bookings            (status draft)
--   2. INSERT booking_items
--   3. UPDATE bookings SET status = 'payment_pending'
--
-- A failure between 2 and 3 leaves a priced row with nothing
-- itemised behind it and nothing in the timeline, and no rollback
-- reaches across three HTTP requests. It is not a hypothetical:
-- `booking_items` has a unique index on (booking_id, service_id),
-- so a retry of a create whose items insert had actually landed
-- fails on that index and leaves the orphan behind permanently.
--
-- The second gap was the actor. 0011's trigger reads
-- `app.transition_actor`, `app.transition_actor_role` and
-- `app.transition_note` as *transaction-local* settings, and
-- PostgREST cannot set them in the same transaction as the update
-- it accompanies — `set_config` needs a third request, and a third
-- request is not the transaction it looks like. So
-- `transitionBooking(bookingId, to, actor, note)` passed an actor
-- that was dropped on the floor, and the trail said `system` for a
-- customer's cancellation.
--
-- Both need a statement that can do more than one thing at once,
-- which means a function. These three are `security definer` and
-- executable by `service_role` only, for the same reason 0024's are:
-- the caller is the Route Handler, which has already authenticated
-- the person and priced the booking, and nothing else may call them.
--
-- The state machine is untouched. These functions do not decide
-- whether a move is legal — they set the actor settings and then
-- write `status`, and 0011's trigger still refuses anything
-- outside §8.2. An illegal transition still raises ILLEGAL_TRANSITION
-- and the Route Handler still answers 409.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §8.2, §25.6, §28.1
-- ============================================================

-- ── Create ─────────────────────────────────────────────────
-- The whole booking: the row, its item lines, and the
-- `draft -> payment_pending` hop, in one statement.
--
-- `p_money` carries the pricing columns as text literals because
-- they come out of `toBookingMoneyColumns()` already rendered for
-- numeric; spelling each one as a parameter would mean adding a
-- parameter every time the pricing engine grows a column. The
-- function reads named keys out of it and nothing else, so an
-- unexpected key is a no-op rather than a hole.
create or replace function public.create_booking(
  p_customer_id        uuid,
  p_address_id         uuid,
  p_locality_id        uuid,
  p_address_snapshot   jsonb,
  p_booking_type       public.booking_type,
  p_duration_minutes   int,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at   timestamptz,
  p_notes              text,
  p_money              jsonb,
  p_discount_code      text,
  p_pricing_snapshot   jsonb,
  p_quote_token        text,
  p_items              jsonb,
  p_actor              uuid,
  p_actor_role         public.user_role
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
  v_item    jsonb;
begin
  -- Set before the write so the history row the trigger writes for
  -- the `draft -> payment_pending` hop names the customer who asked
  -- for it. `true` is the transaction-local form: the setting dies
  -- with this transaction instead of being inherited by whatever
  -- pooled connection serves the next request.
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', 'booking created', true);

  insert into public.bookings (
    booking_number, customer_id, address_id, address_snapshot, locality_id,
    booking_type, duration_minutes, scheduled_start_at, scheduled_end_at,
    notes, subtotal, platform_fee, discount, discount_code, tax, tax_rate,
    total_amount, professional_gross, commission_pct, currency,
    pricing_snapshot, quote_token
  ) values (
    public.next_booking_number(), p_customer_id, p_address_id, p_address_snapshot,
    p_locality_id, p_booking_type, p_duration_minutes, p_scheduled_start_at,
    p_scheduled_end_at, p_notes,
    (p_money ->> 'subtotal')::numeric,
    (p_money ->> 'platform_fee')::numeric,
    (p_money ->> 'discount')::numeric,
    p_discount_code,
    (p_money ->> 'tax')::numeric,
    (p_money ->> 'tax_rate')::numeric,
    (p_money ->> 'total_amount')::numeric,
    (p_money ->> 'professional_gross')::numeric,
    (p_money ->> 'commission_pct')::numeric,
    coalesce(p_money ->> 'currency', 'INR')::char(3),
    coalesce(p_pricing_snapshot, '{}'::jsonb),
    p_quote_token
  )
  returning * into v_booking;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.booking_items (
      booking_id, service_id, service_name, duration_minutes, unit_price,
      quantity, line_total, scope_snapshot
    ) values (
      v_booking.id,
      (v_item ->> 'service_id')::uuid,
      v_item ->> 'service_name',
      (v_item ->> 'duration_minutes')::int,
      (v_item ->> 'unit_price')::numeric,
      coalesce((v_item ->> 'quantity')::int, 1),
      (v_item ->> 'line_total')::numeric,
      coalesce(v_item -> 'scope_snapshot', '[]'::jsonb)
    );
  end loop;

  -- §25.6: created bookings wait for payment, and Phase 2 takes no
  -- money. Phase 3 adds the payment row to this same function, which
  -- is the reason it is a function.
  update public.bookings
     set status = 'payment_pending'
   where id = v_booking.id
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.create_booking(uuid, uuid, uuid, jsonb, public.booking_type, int, timestamptz, timestamptz, text, jsonb, text, jsonb, text, jsonb, uuid, public.user_role) is
  'Writes a booking, its items and the draft -> payment_pending hop in one
   statement, so a partial booking cannot exist: there is no other request to
   interrupt between them. The status hop goes through enforce_booking_transition
   like any other, and booking_status_history names the actor passed here.';

-- ── Cancel ─────────────────────────────────────────────────
-- One UPDATE rather than an annotate-then-transition pair. The two
-- were separate requests, so a booking could read `cancelled` with
-- no fee and no reason recorded against it, or carry a fee with
-- nothing cancelled. Both are wrong in the way a refund dispute
-- notices.
--
-- Returns null when the version no longer matches, which the Route
-- Handler reports as STALE_VERSION. The legal-move question is not
-- answered here: the trigger refuses an illegal `status` write
-- whatever this function passes it.
create or replace function public.cancel_booking(
  p_booking_id   uuid,
  p_expected_version int,
  p_reason_code  text,
  p_fee          numeric,
  p_note         text,
  p_actor        uuid,
  p_actor_role   public.user_role
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.bookings
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancellation_reason_code = p_reason_code,
         cancellation_fee     = p_fee
   where id = p_booking_id
     and (p_expected_version is null or version = p_expected_version)
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.cancel_booking(uuid, int, text, numeric, text, uuid, public.user_role) is
  'Cancels a booking and records the reason and fee in the same statement, with the
   actor in booking_status_history. Returns null when the version has moved on, so
   the caller can answer STALE_VERSION rather than overwriting a change.';

-- ── The plain transition ───────────────────────────────────
-- Same shape as cancel_booking for every other move, so
-- `transitionBooking()` stops dropping its actor. `p_patch` is
-- limited to the columns a status change is allowed to carry: a
-- reschedule's new window, and nothing else. An unknown key is
-- ignored rather than written, because this runs with the owner's
-- rights.
create or replace function public.transition_booking(
  p_booking_id      uuid,
  p_to              public.booking_status,
  p_actor           uuid,
  p_actor_role      public.user_role,
  p_note            text,
  p_expected_version int,
  p_window_from     timestamptz,
  p_window_to       timestamptz
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.bookings
     set status             = p_to,
         scheduled_start_at  = coalesce(p_window_from, scheduled_start_at),
         scheduled_end_at    = coalesce(p_window_to, scheduled_end_at)
   where id = p_booking_id
     and (p_expected_version is null or version = p_expected_version)
  returning * into v_booking;

  return v_booking;
end $$;

comment on function public.transition_booking(uuid, public.booking_status, uuid, public.user_role, text, int, timestamptz, timestamptz) is
  'Moves a booking to a new status with the actor recorded in booking_status_history,
   optionally moving its window at the same time. The transition table is still what
   decides legality: an illegal move raises ILLEGAL_TRANSITION from
   enforce_booking_transition exactly as a direct write would.';

-- ── Grants ─────────────────────────────────────────────────
-- 0024's note applies verbatim: `security definer` means the body runs
-- with the owner's rights, so the EXECUTE grant is what the *caller*
-- needs. Anonymous and authenticated callers have no business
-- creating bookings, so they get none.
revoke all on function public.create_booking(uuid, uuid, uuid, jsonb, public.booking_type, int, timestamptz, timestamptz, text, jsonb, text, jsonb, text, jsonb, uuid, public.user_role) from public, anon, authenticated;
revoke all on function public.cancel_booking(uuid, int, text, numeric, text, uuid, public.user_role) from public, anon, authenticated;
revoke all on function public.transition_booking(uuid, public.booking_status, uuid, public.user_role, text, int, timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.create_booking(uuid, uuid, uuid, jsonb, public.booking_type, int, timestamptz, timestamptz, text, jsonb, text, jsonb, text, jsonb, uuid, public.user_role) to service_role;
grant execute on function public.cancel_booking(uuid, int, text, numeric, text, uuid, public.user_role) to service_role;
grant execute on function public.transition_booking(uuid, public.booking_status, uuid, public.user_role, text, int, timestamptz, timestamptz) to service_role;