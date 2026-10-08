-- ============================================================
-- 0014_payments.sql
-- SmartHelp: one row per charge attempt, and the one function
-- that is allowed to mark a booking paid.
--
-- Why this file exists
-- --------------------
-- Phase 3 takes money in. Everything else in this phase — the
-- create-order route, the webhook, the reconciliation cron — is
-- an HTTP shape around two facts this file has to make true:
--
--   1. A charge attempt is a *row*, written before the gateway
--      is asked for an order, so that an attempt nobody can see
--      is impossible. A gateway order with no row behind it is
--      invisible to reconciliation and to a refund; the row with
--      no `gateway_order_id` is merely incomplete and is exactly
--      what the cron looks for.
--   2. Marking a booking paid moves two tables. Doing it as two
--      PostgREST calls reproduces the partial-write bug 0028
--      exists to fix — a payment row reading `success` against a
--      booking still `payment_pending`, or the reverse. One
--      `security definer` function, one transaction, one caller
--      decides.
--
-- What it deliberately does not do: it does not talk to Razorpay.
-- The gateway is four `fetch` calls in `lib/razorpayClient.ts`
-- with an injectable transport; nothing that leaves this process
-- belongs in a migration, and nothing here assumes an amount in
-- anything but paise-priced rupees (`numeric(12,2)`).
--
-- Checked, not assumed: `payment_purpose` ships in 0010 per §24.7
-- (`0010_bookings.sql:33`); re-declaring it here would either
-- raise or mask a real duplicate, so this file only declares the
-- two enums it actually owns.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §12.1, §12.2, §24.9, §31.2
-- ============================================================

-- ── Enums ──────────────────────────────────────────────────
-- §12.1's six states. `partially_refunded` ships now even though
-- Wave B is the first writer, for the same reason 0009 shipped the
-- whole `booking_status` enum: adding a value later is an
-- ALTER TYPE that rewrites the table under an ACCESS EXCLUSIVE lock.
do $$ begin
  create type public.payment_status as enum
    ('created', 'pending', 'success', 'failed', 'refunded', 'partially_refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum
    ('card', 'upi', 'netbanking', 'wallet', 'emi', 'cod');
exception when duplicate_object then null; end $$;

-- ── payments ───────────────────────────────────────────────
-- One row per charge attempt. `booking_id` is nullable because
-- §12.4's `wallet_topup` (Phase 8) has no booking to point at,
-- but `purpose = 'booking'` without one is a row nobody can
-- reconcile, so the check below makes it impossible.
--
-- `refundable_amount` is what is left of this charge to refund,
-- not what has been refunded: it starts at 0 and Wave B's refund
-- path walks it down, so the CHECK is the backstop that stops a
-- double refund from over-drawing the original amount.
create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid references public.bookings(id) on delete cascade,
  customer_id        uuid not null references public.customers(id) on delete cascade,
  purpose            public.payment_purpose not null default 'booking',
  amount             numeric(12,2) not null check (amount > 0),
  currency           char(3) not null default 'INR',
  gateway            text not null default 'razorpay',
  gateway_order_id   text,
  gateway_payment_id text,
  -- §12.2: "evidence for disputes; never logged". The column is
  -- the evidence; lib/audit.ts redacts it so it cannot reach the
  -- audit trail by being put in a metadata object by accident.
  gateway_signature  text,
  status             public.payment_status not null default 'created',
  method             public.payment_method,
  refundable_amount  numeric(12,2) not null default 0
                       check (refundable_amount >= 0 and refundable_amount <= amount),
  failure_reason     text,
  -- The same value passed to withIdempotency() on create-order.
  -- The ledger is pruned by the §25.11 wallet-expiry cron; this
  -- column is what keeps "one booking, one payment" true after it
  -- is gone, which is why it carries its own unique index.
  idempotency_key    text,
  captured_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint payments_booking_required
    check (purpose <> 'booking' or booking_id is not null)
);

comment on table public.payments is
  'One row per charge attempt, written before the gateway is asked for an order.
   status is moved to success only by confirm_booking_payment(), which the webhook
   and the reconciliation cron both funnel through; no Route Handler writes it.';
comment on column public.payments.gateway_signature is
  'evidence for disputes; never logged';

-- ── Indexes ────────────────────────────────────────────────
-- Both uniques are partial on purpose: a webhook-created or
-- cron-created row has no order id and no idempotency key, and
-- two NULLs must not collide in a table that is expected to hold
-- exactly one such row per booking for a long time.
create unique index if not exists uniq_payments_gateway_order
  on public.payments (gateway, gateway_order_id)
  where gateway_order_id is not null;
create unique index if not exists uniq_payments_idem
  on public.payments (idempotency_key)
  where idempotency_key is not null;

-- The reconciliation cron reads this one directly: every pass is
-- `status in ('created','pending') and created_at < now() - '10 minutes'`.
create index if not exists idx_payments_status
  on public.payments (status, created_at desc);
create index if not exists idx_payments_booking
  on public.payments (booking_id);

drop trigger if exists trg_payments_touch on public.payments;
create trigger trg_payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

-- ── Row-level security ─────────────────────────────────────
-- Mirrors 0010:339-392. A customer reads their own, staff read
-- everything, and — unlike `bookings` — there is **no INSERT and
-- no UPDATE policy at all**, because a browser that could insert
-- a payment could set `status = 'success'` directly. The service
-- role is the only writer, which is why Task A3 adds
-- getPaymentForCaller(): RLS does not protect any server path,
-- since Route Handlers bypass it entirely.
--
-- The staff set is ['admin','super_admin','ops'] rather than the
-- ['admin','super_admin'] every policy in 0001-0024 uses, because
-- `ops` holds `refund.execute` and cannot exercise it against a
-- row it may not read. `support` holds `refund.request` and is
-- deliberately outside — a support agent can request a refund they
-- cannot see; recorded as an open question rather than widened here.
alter table public.payments enable row level security;

do $$ begin
  create policy payments_select_own on public.payments for select
    using (customer_id = public.current_customer_id()
           or public.is_staff(array['admin','super_admin','ops']::public.user_role[]));
exception when duplicate_object then null; end $$;

revoke all on public.payments from anon;
grant select on public.payments to authenticated;

-- ── confirm_booking_payment() ──────────────────────────────
-- The single writer of `payments.status = 'success'`. Three
-- callers — the webhook, the reconciliation cron, and (Phase 8)
-- a wallet top-up — funnel through it, because three writers with
-- three behaviours is how a booking ends up `paid` while its
-- payment says `pending`.
--
-- The replay guard is the `status in ('created','pending')` in the
-- WHERE clause: a second call with the same arguments updates zero
-- rows and returns null, so a re-delivered webhook does nothing
-- rather than re-confirming. Both writes are in the caller's
-- transaction; a failure rolls back both, which is the whole
-- reason this is a function and not two PostgREST calls.
--
-- The actor is deliberately null. A webhook has no profile to
-- name — `booking_status_history.actor_id` is nullable and
-- `public.user_role` has no `system` value, and adding one would
-- be an ALTER TYPE on a table with a history row behind every
-- row. The note carries the provenance instead.
create or replace function public.confirm_booking_payment(
  p_payment_id         uuid,
  p_gateway_order_id   text,
  p_booking_id         uuid,
  p_gateway_payment_id text,
  p_gateway_signature  text,
  p_note               text
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_payment public.payments;
begin
  perform set_config('app.transition_actor', '', true);
  perform set_config('app.transition_actor_role', '', true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.payments
     set status             = 'success',
         gateway_payment_id = p_gateway_payment_id,
         gateway_signature  = p_gateway_signature,
         captured_at        = coalesce(captured_at, now()),
         updated_at         = now()
   where id = p_payment_id
     and gateway_order_id = p_gateway_order_id
     and status in ('created', 'pending')
  returning * into v_payment;

  -- Checked before v_payment is touched: with no row matched,
  -- INTO leaves the record unassigned and a field reference on it
  -- raises rather than returning null.
  if not found then
    return null;
  end if;

  -- The booking moves only if it is still waiting for the money.
  -- A booking cancelled while the charge was in flight stays
  -- cancelled: the payment is marked success because the money
  -- did arrive, and it is now a refund somebody owes rather than
  -- a job that should start. `quote_token` is nulled here, making
  -- the token single-use across the payment lifecycle.
  update public.bookings
     set status      = 'paid',
         quote_token = null
   where id = p_booking_id
     and status = 'payment_pending';

  return v_payment;
end $$;

comment on function public.confirm_booking_payment(uuid, text, uuid, text, text, text) is
  'Marks a payment success and its booking paid in one transaction, or returns null
   when the payment was already confirmed (the replay guard). Called by the Razorpay
   webhook and by GET /api/cron/reconcile-payments — both gated on gateway truth.';

-- ── Grants ─────────────────────────────────────────────────
-- 0024's note applies verbatim: `security definer` means the body
-- runs with the owner's rights, so the EXECUTE grant is what the
-- caller is given, and service_role is the caller here.
revoke all on function public.confirm_booking_payment(uuid, text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.confirm_booking_payment(uuid, text, uuid, text, text, text)
  to service_role;
