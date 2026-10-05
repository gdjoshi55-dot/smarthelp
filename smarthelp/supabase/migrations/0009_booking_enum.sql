-- ============================================================
-- 0009_booking_enum.sql
-- SmartHelp: the two enums a booking is made of.
--
-- Both are created in full, before the code that uses most of
-- them exists. That is deliberate and it is the opposite of
-- "add a value when you need it".
--
-- A Postgres enum's labels are stored inline in every row that
-- uses them, so adding one is an ALTER TYPE that rewrites the
-- table and takes an ACCESS EXCLUSIVE lock. On `bookings` that
-- is a table with a history row behind every row and a GiST
-- index — not something to do during a launch. Worse, a partial
-- enum makes the state machine incomplete in a way that is only
-- visible in the gaps: `cancelled -> refund_pending` looks legal
-- because both labels are there, and nothing says the money
-- path behind it does not exist yet.
--
-- So Phase 2 ships the whole 18-value enum and reaches four of
-- them. The unreached states are unreachable because no code
-- writes them, not because the database would refuse.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §8.1, §24.7
-- ============================================================

do $$ begin
  create type booking_type as enum ('instant', 'scheduled', 'recurring');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status as enum (
    'draft',                -- built in the client, not yet submitted
    'payment_pending',      -- payment order created, awaiting verification
    'paid',                 -- gateway signature / webhook verified
    'searching',            -- matching engine running, offers fanning out
    'assigned',             -- a professional holds an unexpired offer
    'accepted',             -- professional accepted the job
    'on_the_way',           -- professional started travelling
    'arrived',              -- at the address, awaiting OTP
    'otp_verified',         -- OTP consumed; immediately becomes in_progress
    'in_progress',          -- timer running
    'extension_requested',  -- customer asked for more time
    'completed',            -- professional ended the service
    'cancelled',            -- by customer, professional, ops or system
    'refund_pending',       -- cancellation with money to return
    'refunded',             -- refund completed at the gateway
    'disputed',             -- a support ticket flagged the booking
    'no_show',              -- nobody attended
    'closed'                -- rated / archived; terminal
  );
exception when duplicate_object then null; end $$;

comment on type public.booking_status is
  'The 18 states of §8.1. Legality of a move between two of them is not
   decided by this enum — it is decided by enforce_booking_transition() in
   0011, which is the only thing that may write `status`. Phase 2 reaches
   draft, payment_pending, cancelled and (via the seed) paid and in_progress;
   the rest become reachable as their phases land.';
