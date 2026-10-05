-- ============================================================
-- 0009a_drop_legacy_booking_schema.sql
-- SmartHelp: remove a pre-spec bookings schema that no
-- migration ever created.
--
-- The live project carries tables that are in none of
-- supabase/migrations/. They were built outside the migration
-- system, and they disagree with the specification on almost
-- every column:
--
--   bookings            status is a 15-label enum with
--                       `pending`, `quoted`, `en_route` and
--                       `awaiting_otp` — none of which §8.1 has.
--                       Money is `int` paise, not `numeric(12,2)`.
--                       One `service_id` per booking, so a cart of
--                       three services has nowhere to live.
--                       `starts_at`/`ends_at` instead of
--                       `scheduled_start_at`/`scheduled_end_at`.
--   coupons             `kind`/`amount`/`min_subtotal`, against
--                       §24.7's `discount_type`/`discount_value`/
--                       `min_booking_amount`.
--   coupon_redemptions  against §24.7's `coupon_usage`.
--
-- Leaving them would mean creating the specification's tables
-- beside them under different names, and every later file would
-- have to remember which one it meant. A schema with two answers
-- to "what is a booking" is a schema where the wrong one gets
-- used.
--
-- All three are empty, and this migration refuses to run if that
-- ever stops being true — see the guard below. Nothing else in
-- public depends on them; the probe that established this is in
-- the Phase 2 notes.
--
-- `pricing_type` is deliberately KEPT. The legacy `bookings`
-- table used it, but so does `services.pricing_type`, which is
-- migration-owned and in live use — dropping the enum to tidy up
-- a dead table would break the catalogue.
--
-- Idempotent: safe to re-run, and safe on a project that never
-- had the legacy schema at all.
-- Spec: §24.7
-- ============================================================

-- ── Refuse to destroy data ─────────────────────────────────
-- If someone has somehow started using these tables, the correct
-- outcome is a failed migration and a human reading this, not a
-- silent drop. An empty table is indistinguishable from a table
-- nobody has touched yet, and the cost of being wrong here is
-- somebody's bookings.
--
-- Written with EXECUTE rather than three static counts because a
-- static `select count(*) from public.bookings` is a parse-time
-- reference to a table that may not be there — this file has to be
-- re-runnable on a project that never had the legacy schema at all,
-- and on this one after it has already run once. `to_regclass`
-- answers the question without naming a relation.
do $$
declare
  v_n      bigint := 0;
  v_present text[];
  t        text;
begin
  select coalesce(array_agg(u.name), '{}')
    into v_present
    from unnest(array['bookings', 'coupons', 'coupon_redemptions']) as u(name)
   where to_regclass('public.' || u.name) is not null;

  foreach t in array v_present loop
    execute format('select count(*) from public.%I', t) into v_n;
    -- Assigned, not accumulated: the loop reports the first table that has
    -- data, which is the one a human needs to go and export.
    exit when v_n > 0;
  end loop;

  if v_n > 0 then
    raise exception
      'LEGACY_BOOKING_DATA_PRESENT: % row(s) found in % . '
      'Migrating this data to the §24.7 shape is manual work — stop and export it first.',
      v_n, array_to_string(v_present, ', ')
      using errcode = 'check_violation';
  end if;
end $$;

-- Triggers and policies travel with their tables, so there is nothing to drop
-- separately. Order matters in one place: sync_coupon_usage() is wired to
-- trg_coupon_usage on coupon_redemptions, and a function cannot be dropped while
-- a trigger depends on it. Dropping the child table first takes the trigger with
-- it, which frees the function — so the legacy coupon counters go before the
-- legacy coupon tables, not after.
--
-- coupons goes before bookings: coupon_redemptions holds FKs into both, and
-- dropping the parents first would need CASCADE, which is the thing to avoid
-- having to say.
drop table if exists public.coupon_redemptions;
drop table if exists public.coupons;
drop table if exists public.bookings;

drop function if exists public.sync_coupon_usage();

-- Now nothing references the legacy enum, so it can go without
-- CASCADE — and CASCADE here would silently drop anything else
-- that had picked up the type, which is exactly the failure this
-- file is trying to avoid.
drop type if exists public.booking_status;