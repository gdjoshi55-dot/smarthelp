-- ============================================================
-- 0015_refunds_wallet.sql
-- SmartHelp: money going back out — the refund rows, the wallet
-- ledger, and the two statements that move a booking from paid
-- to refunded.
--
-- Why this file exists
-- --------------------
-- Phase 3 took money in (0014) and made `paid` reachable. That
-- closes the other half of the same promise: once a customer can
-- pay, `paid -> cancelled` is a live path that captures real money
-- and must produce a refund, and Phase 2's plan said in as many
-- words that *"`refund_pending` and `refunded` become reachable in
-- Phase 3, where `payments` exists`"*. Nothing here is a new
-- feature — it is the other side of a ledger already written.
--
-- Three things only Postgres can answer are in this file, for the
-- same reason 0028's three functions are:
--
--   1. A refund that draws a payment below zero must be impossible,
--      not merely discouraged. `payments.refundable_amount` carries
--      a CHECK for it, and the function that draws it down re-checks
--      before writing, because the two are in different transactions.
--   2. A wallet balance and its ledger cannot disagree. Both writes
--      happen in one statement inside the caller's transaction, so a
--      failure rolls both back or neither.
--   3. A booking hops `paid/cancelled -> refund_pending -> refunded`
--      through the same `enforce_booking_transition()` every other
--      hop goes through. These functions set the actor settings and
--      write `status`; they do not decide whether a move is legal.
--
-- What it deliberately does not do: it does not talk to Razorpay.
-- The gateway is four `fetch` calls in `lib/razorpayClient.ts` with
-- an injectable transport, and a refund is created by
-- `lib/refundServer.ts` calling it. Nothing that leaves this process
-- belongs in a migration.
--
-- ── §12.4's `apply_wallet_delta` is reproduced with two amendments
-- ---------------------------------------------------------------
-- **(1)** `balance_after` is written because §24.9 declares it
-- `NOT NULL` and §12.4's INSERT omits it — the specification's
-- function does not run against the specification's schema; as
-- written it raises `not-null violation` on its first call.
--
-- **(2)** the balance is read under `FOR UPDATE` and checked before
-- the write, because §12.4's `RAISE WALLET_OVERDRAFT` sits behind
-- its own non-deferred `CHECK (balance >= 0)`, which fires first and
-- makes the named error unreachable.
--
-- The column `CHECK` stays: it is the backstop for any future path
-- that writes `wallets` without going through the function, and a
-- redundant constraint that fires first is a feature in a codebase
-- whose philosophy is that the database half is the one that
-- matters.
--
-- ── 0014's `refundable_amount` is seeded here, not there
-- -------------------------------------------------------
-- 0014 declares `refundable_amount ... not null default 0` and its
-- own comment says the refund path walks it down — but nothing ever
-- raised it. `confirm_booking_payment()` did not touch the column,
-- so every captured payment carried a remainder of zero: the CHECK
-- (`refundable_amount <= amount`) was satisfied by a remainder no
-- refund could be drawn from, and this file's
-- `complete_booking_refund()` would have been refused by it on the
-- first call. The remainder equals the charge at the moment the
-- charge succeeds, so that is where it is set. The function body
-- below supersedes 0014's — same signature, one extra assignment —
-- and a backfill raises the rows 0014 already captured.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §12.3, §12.4, §8.2, §24.9, §25.10
-- ============================================================

-- ── Enums ──────────────────────────────────────────────────
-- `refund_status` ships the whole ladder for the reason 0009
-- shipped the whole `booking_status`: adding a value later is an
-- ALTER TYPE that rewrites the table under an ACCESS EXCLUSIVE
-- lock. `approved`/`rejected` are Phase 6's approval console
-- (§25.10) writing into a table that already has a place for them;
-- `failed` is the terminal state for a refund neither the gateway
-- nor the wallet could take, which §12.3 says must never happen
-- silently.
do $$ begin
  create type public.refund_status as enum
    ('requested', 'approved', 'rejected', 'completed', 'failed');
exception when duplicate_object then null; end $$;

-- Two values, not five. Direction is the whole of what this column
-- is for — `apply_wallet_delta()` reads it as `credit` or "not
-- credit" — and *what* the movement was for is already carried by
-- `ref_type`/`ref_id`. A third value such as `refund` would make
-- direction ambiguous at exactly the point where an ambiguous
-- direction costs somebody money.
do $$ begin
  create type public.wallet_txn_type as enum ('credit', 'debit');
exception when duplicate_object then null; end $$;

-- ── wallets ────────────────────────────────────────────────
-- The balance is a *cache*; `wallet_transactions` is the truth.
-- That is why the column carries `CHECK (balance >= 0)` twice over
-- (the function pre-checks too) and why there is no UPDATE policy
-- on it below — a browser that could write its own balance could
-- write itself money.
create table if not exists public.wallets (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers(id) on delete cascade,
  balance     numeric(12,2) not null default 0 check (balance >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.wallets is
  'One row per customer who has ever held credit. balance is a cache of the
   wallet_transactions ledger, written only by apply_wallet_delta(); the ledger
   is the thing that is actually trusted.';

-- No touch trigger, deliberately. `apply_wallet_delta()` is the only writer that
-- changes a wallet and it sets `updated_at` itself; a trigger here would also
-- fire on `get_or_create_wallet()`'s conflict clause, which writes nothing —
-- an "updated" timestamp that moves when nothing moved is worse than one that
-- only moves for money.

-- ── customers.wallet_id ────────────────────────────────────
-- 0001 shipped the column with the comment `FK added in
-- 0015_refunds_wallet.sql` and no constraint. The column already
-- exists, so this adds the constraint the comment promises rather
-- than the column — which is what makes the comment stop lying.
-- Every existing row is NULL, so the addition cannot fail.
do $$ begin
  alter table public.customers
    add constraint customers_wallet_fk
    foreign key (wallet_id) references public.wallets(id);
exception when duplicate_object then null; end $$;

comment on column public.customers.wallet_id is
  'FK to the customer''s wallet, added in 0015_refunds_wallet.sql. Maintained by
   get_or_create_wallet(); NULL means the customer has never held credit.';

-- ── wallet_transactions ────────────────────────────────────
-- Append-only. `amount > 0` and `balance_after NOT NULL` are both
-- §24.9's, and together they are the property that makes the ledger
-- auditable: every row is a positive movement and the balance it
-- produced, so a reader can re-run the ledger and check it against
-- `wallets.balance` without trusting either one.
create table if not exists public.wallet_transactions (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references public.wallets(id) on delete cascade,
  type          public.wallet_txn_type not null,
  amount        numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2) not null,
  ref_type      text not null,
  ref_id        text,
  description   text not null,
  created_at    timestamptz not null default now()
);

comment on table public.wallet_transactions is
  'The wallet ledger, append-only: apply_wallet_delta() is the only writer, and
   the two policies below refuse an UPDATE and a DELETE outright (§12.4).';

create index if not exists idx_wallet_txn_wallet
  on public.wallet_transactions (wallet_id, created_at desc);

-- ── refunds ────────────────────────────────────────────────
-- One row per refund, however it is paid back — to the gateway
-- instrument or, when that instrument cannot take it, to the
-- wallet. `route` records which, because "the customer got their
-- money back" is two different facts when a dispute is opened
-- about it later.
--
-- `refundable_amount` on the payment is what bounds this: the
-- CHECK on `payments` and the pre-write guard in
-- `complete_booking_refund()` both refuse a draw that would take
-- the remainder below zero, so a double refund cannot be recorded
-- however many rows exist here.
create table if not exists public.refunds (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid not null references public.payments(id) on delete cascade,
  booking_id        uuid not null references public.bookings(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  amount            numeric(12,2) not null check (amount > 0),
  currency          char(3) not null default 'INR',
  status            public.refund_status not null default 'requested',
  route             text not null default 'gateway'
                    check (route in ('gateway', 'wallet', 'mixed')),
  reason_code       text not null,
  note              text,
  gateway_refund_id text,
  requested_by      uuid references public.profiles(id) on delete set null,
  processed_by      uuid references public.profiles(id) on delete set null,
  approved_by       uuid references public.profiles(id) on delete set null,
  requested_at      timestamptz not null default now(),
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.refunds is
  'One row per refund, created before the gateway is asked for it — the same
   row-first ordering createBookingOrder() uses — so a refund nobody can see is
   impossible. status moves to completed only through complete_booking_refund().';

comment on column public.refunds.gateway_refund_id is
  'the gateway''s own id for the refund, stored as soon as it answers; what the
   refund.processed webhook matches on';

-- One *active* refund per payment: `requested` and `approved` are the
-- in-flight states, and a partial refund after a completed one is a
-- legitimate second row — which is exactly why this index is partial
-- rather than unique on `payment_id` alone.
create unique index if not exists uniq_active_refund_per_payment
  on public.refunds (payment_id)
  where status in ('requested', 'approved');

create index if not exists idx_refunds_booking
  on public.refunds (booking_id, created_at desc);
create index if not exists idx_refunds_customer
  on public.refunds (customer_id, created_at desc);
-- The staff list screen filters on this first (§25.10).
create index if not exists idx_refunds_status
  on public.refunds (status, created_at desc);

drop trigger if exists trg_refunds_touch on public.refunds;
create trigger trg_refunds_touch before update on public.refunds
  for each row execute function public.touch_updated_at();

-- ── Row-level security ─────────────────────────────────────
-- Mirrors 0010:339-392 and 0014's block, including the shape of
-- what RLS does and does not cover: it protects the browser and
-- PostgREST, and nothing else. Route Handlers reach Postgres
-- through `createServerClient()` as the service role, which
-- bypasses RLS entirely — so `POST/GET /api/refunds` still has to
-- check capability and ownership itself (CONTEXT decision 3).
--
-- No INSERT and no UPDATE policy on `refunds` or `wallets`: the
-- service role is the only writer, and a browser that could insert
-- a refund could set `status = 'completed'` and hand itself money.
--
-- The staff set is ['admin','super_admin','ops'], the same three
-- 0014 settles on for `payments`, for the same reason: `ops` holds
-- `refund.execute` and cannot exercise it against a row it may not
-- read.
alter table public.refunds enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;

do $$ begin
  create policy refunds_select_own on public.refunds for select
    using (customer_id = public.current_customer_id()
           or public.is_staff(array['admin','super_admin','ops']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy wallets_select_own on public.wallets for select
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- The `exists` shape of 0010:367 (`booking_items_select_own`): a ledger row is
-- readable through the wallet it belongs to, not through an ownership column it
-- deliberately does not carry.
do $$ begin
  create policy wallet_txn_select_own on public.wallet_transactions for select
    using (exists (select 1 from public.wallets w
                    where w.id = wallet_id
                      and w.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

-- §12.4 verbatim: the ledger is append-only *in the database*, not merely in
-- the code that writes it. There is no INSERT policy either — `apply_wallet_delta()`
-- runs as `security definer`, and a browser that could insert a row could forge
-- a `balance_after`.
do $$ begin
  create policy wallet_txn_no_update on public.wallet_transactions for update
    using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy wallet_txn_no_delete on public.wallet_transactions for delete
    using (false);
exception when duplicate_object then null; end $$;

revoke all on public.refunds from anon;
revoke all on public.wallets from anon;
revoke all on public.wallet_transactions from anon;

grant select on public.refunds to authenticated;
grant select on public.wallets to authenticated;
grant select on public.wallet_transactions to authenticated;

-- ── get_or_create_wallet() ─────────────────────────────────
-- Refund-to-wallet has to work for a customer who has never had a
-- wallet, which makes this a *read then write* on the hottest path
-- in the file. It is one statement on purpose: `wallets.customer_id`
-- is UNIQUE and `customers.wallet_id` points at the row, so two
-- concurrent calls that each decided "no wallet yet" would produce
-- two rows for one customer or leave the FK dangling at whichever
-- one won.
--
-- `on conflict ... do update ... returning` is the shape that
-- returns the existing row from the conflict: `do nothing` returns
-- nothing, and a follow-up SELECT can miss a row a concurrent
-- transaction has inserted but not yet committed. The `set` clause
-- writes the value it already holds — a no-op that exists only to
-- make `returning` fire — which is also why `wallets` has no touch
-- trigger above.
--
-- `customers.wallet_id` is kept in step in the same transaction, so
-- the FK added above is never left pointing at nothing.
create or replace function public.get_or_create_wallet(p_customer uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_wallet uuid;
begin
  if p_customer is null then
    raise exception 'WALLET_CUSTOMER_REQUIRED' using errcode = 'not_null_violation';
  end if;

  insert into public.wallets (customer_id)
  values (p_customer)
  on conflict (customer_id) do update set customer_id = excluded.customer_id
  returning id into v_wallet;

  update public.customers
     set wallet_id = v_wallet
   where id = p_customer
     and wallet_id is distinct from v_wallet;

  return v_wallet;
end $$;

comment on function public.get_or_create_wallet(uuid) is
  'Returns the customer''s wallet, creating it if this is their first credit.
   One statement, because the UNIQUE on wallets.customer_id and customers.wallet_id
   make a read-then-write a race between two concurrent refunds.';

-- ── apply_wallet_delta() ───────────────────────────────────
-- §12.4, with the two amendments the header records. The order of
-- the four operations is the whole function:
--
--   1. refuse a non-positive amount   (named, not anonymous)
--   2. read the balance `FOR UPDATE`  (locks the row so the
--                                      read-then-write below cannot
--                                      lose an update)
--   3. compute, and refuse an overdraft *before* the write, so
--      `WALLET_OVERDRAFT` is reachable rather than being shadowed
--      by the column's own `CHECK (balance >= 0)`
--   4. write the balance, then the ledger row, including the
--      `balance_after` §12.4's INSERT forgot
--
-- All four are in the caller's transaction: the RAISE in step 3
-- rolls back nothing yet, and any failure after it rolls back both
-- writes. The balance and the ledger can never disagree.
--
-- `p_amount` is strictly positive. A debit is expressed by
-- `p_type`, never by a negative amount — `CHECK (amount > 0)` would
-- refuse one anyway, and a named refusal here beats an anonymous
-- constraint violation from a caller three frames away.
--
-- `p_ref` is `'type:id'`, split on the first colon: `refund:<uuid>`
-- or `topup:<uuid>`. Both halves are recorded because the ledger is
-- what a dispute is read against, and "a credit happened" without
-- "for which refund" is not evidence.
create or replace function public.apply_wallet_delta(
  p_wallet uuid,
  p_type   public.wallet_txn_type,
  p_amount numeric,
  p_ref    text,
  p_desc   text
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_cur numeric;
  v_new numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'WALLET_AMOUNT_NOT_POSITIVE amount=%', p_amount
      using errcode = 'check_violation';
  end if;

  if p_ref is null or split_part(p_ref, ':', 1) = '' then
    raise exception 'WALLET_REF_REQUIRED ref=%', p_ref
      using errcode = 'not_null_violation';
  end if;

  select balance into v_cur
    from public.wallets
   where id = p_wallet
     for update;

  if not found then
    raise exception 'WALLET_NOT_FOUND wallet=%', p_wallet
      using errcode = 'foreign_key_violation';
  end if;

  v_new := v_cur + case when p_type = 'credit' then p_amount else -p_amount end;

  -- Before the write, so the named error wins the race against the column's
  -- own non-deferred CHECK — which is amendment (2), and the reason the spec's
  -- version never says WALLET_OVERDRAFT out loud.
  if v_new < 0 then
    raise exception 'WALLET_OVERDRAFT wallet=% delta=% balance=%', p_wallet, p_amount, v_cur
      using errcode = 'check_violation';
  end if;

  update public.wallets
     set balance = v_new, updated_at = now()
   where id = p_wallet;

  insert into public.wallet_transactions
    (wallet_id, type, amount, balance_after, ref_type, ref_id, description)
  values
    (p_wallet, p_type, p_amount, v_new,
     split_part(p_ref, ':', 1),
     nullif(split_part(p_ref, ':', 2), ''),
     p_desc);

  return v_new;
end $$;

comment on function public.apply_wallet_delta(uuid, public.wallet_txn_type, numeric, text, text) is
  'Moves a wallet balance and writes its ledger row in one statement, or raises
   WALLET_OVERDRAFT (SQLSTATE 23514, the same code the column CHECK gives) before
   either write. p_amount is always positive: direction is p_type.';

-- ── record_booking_refund() ────────────────────────────────
-- The write path a refund *request* goes through when it is about to
-- be executed. Two things happen in one statement, for the reason
-- 0028's three functions exist:
--
--   1. the `refunds` row is inserted in `requested` — the row comes
--      before the gateway is asked, exactly as `createBookingOrder()`
--      writes the charge attempt before asking for an order;
--   2. the booking hops to `refund_pending`, but **only** from
--      `paid` or `cancelled`, the two states §8.2 names as legal
--      predecessors.
--
-- The guarded hop is the interesting half. A refund that is merely
-- requested — §12.3's above-limit request, which nobody has approved
-- and which Phase 6's console (§25.10) is what will approve — must
-- not leave a booking stuck in `refund_pending` behind a request
-- nobody intended to pay yet. So the hop happens here, where the
-- caller has already decided to execute, and `complete_booking_refund()`
-- finishes it. An above-limit request never reaches this function:
-- `lib/refundServer.ts`'s `requestRefund()` writes the row directly.
--
-- The remainder is re-checked here as well as in `complete_…`, because
-- the two are separate round trips and a row that can never complete
-- should not be created at all.
create or replace function public.record_booking_refund(
  p_payment_id   uuid,
  p_booking_id   uuid,
  p_amount       numeric,
  p_reason_code  text,
  p_route        text,
  p_note         text,
  p_requested_by uuid
) returns public.refunds
language plpgsql security definer set search_path = public as $$
declare
  v_refund     public.refunds;
  v_remainder  numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'REFUND_AMOUNT_NOT_POSITIVE amount=%', p_amount
      using errcode = 'check_violation';
  end if;

  select refundable_amount into v_remainder
    from public.payments
   where id = p_payment_id;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND payment=%', p_payment_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_amount > v_remainder then
    raise exception 'REFUND_EXCEEDS_REFUNDABLE payment=% amount=% refundable=%',
      p_payment_id, p_amount, v_remainder
      using errcode = 'check_violation';
  end if;

  -- Same reasoning as 0014: the actor is a *profile* or nothing, the role is
  -- read off that profile by whoever asks, and the note carries the provenance
  -- when this is an automatic refund with nobody to name.
  perform set_config('app.transition_actor', coalesce(p_requested_by::text, ''), true);
  perform set_config('app.transition_actor_role', '', true);
  perform set_config('app.transition_note', coalesce(p_note, 'refund requested'), true);

  insert into public.refunds
    (payment_id, booking_id, customer_id, amount, currency,
     status, route, reason_code, note, requested_by)
  select p_payment_id, p_booking_id, customer_id, p_amount, currency,
         'requested', p_route, p_reason_code, p_note, p_requested_by
    from public.payments
   where id = p_payment_id
  returning * into v_refund;

  update public.bookings
     set status = 'refund_pending'
   where id = p_booking_id
     and status in ('paid', 'cancelled');

  return v_refund;
end $$;

comment on function public.record_booking_refund(uuid, uuid, numeric, text, text, text, uuid) is
  'Inserts a refund row and hops the booking to refund_pending in one statement,
   but only from paid or cancelled: a request that is never executed must not
   strand a booking. Refuses an amount above payments.refundable_amount before
   the row exists.';

-- ── complete_booking_refund() ──────────────────────────────
-- The single writer of `refunds.status = 'completed'`, and the
-- thing that makes §8.2's two refund states reachable. Three
-- writes, one transaction:
--
--   1. the refund completes, with the gateway's id and the time;
--   2. the booking hops `refund_pending -> refunded`;
--   3. the payment's remainder comes down and its status becomes
--      `partially_refunded` or `refunded`.
--
-- Step 3's CASE reads `refundable_amount` at its *old* value on
-- purpose: every expression in a single UPDATE's SET list is
-- evaluated against the row as it was, so `refundable_amount =
-- p_amount` means "this draw empties it" — writing
-- `refundable_amount - p_amount = 0` there would be comparing the
-- new value to itself.
--
-- The replay guard is `status in ('requested','approved')`: a
-- re-delivered `refund.processed` webhook matches the row and
-- updates nothing, returning null rather than refunding twice.
create or replace function public.complete_booking_refund(
  p_refund_id         uuid,
  p_gateway_refund_id text,
  p_route             text,
  p_note              text,
  p_processed_by      uuid
) returns public.refunds
language plpgsql security definer set search_path = public as $$
declare
  v_refund   public.refunds;
  v_amount   numeric;
begin
  perform set_config('app.transition_actor', coalesce(p_processed_by::text, ''), true);
  perform set_config('app.transition_actor_role', '', true);
  perform set_config('app.transition_note', coalesce(p_note, 'refund completed'), true);

  update public.refunds
     set status            = 'completed',
         completed_at      = coalesce(completed_at, now()),
         gateway_refund_id = coalesce(p_gateway_refund_id, gateway_refund_id),
         route             = coalesce(p_route, route),
         processed_by      = coalesce(p_processed_by, processed_by),
         updated_at        = now()
   where id = p_refund_id
     and status in ('requested', 'approved')
  returning * into v_refund;

  if not found then
    return null;
  end if;

  v_amount := v_refund.amount;

  -- Only from refund_pending. `record_booking_refund()` hops conditionally, so
  -- a booking whose status was neither paid nor cancelled never entered this
  -- state; writing `refunded` over it directly would be the state machine
  -- being argued around rather than through.
  update public.bookings
     set status = 'refunded'
   where id = v_refund.booking_id
     and status = 'refund_pending';

  update public.payments
     set refundable_amount = refundable_amount - v_amount,
         status = case when refundable_amount = v_amount
                       then 'refunded'::public.payment_status
                       else 'partially_refunded'::public.payment_status end,
         updated_at = now()
   where id = v_refund.payment_id
     and status in ('success', 'partially_refunded')
     and refundable_amount >= v_amount;

  if not found then
    -- The refund row is already `completed` at this point, so the raise rolls
    -- the whole statement back: no half-refunded payment, no refund marked
    -- complete against money that never moved.
    raise exception 'REFUND_EXCEEDS_REFUNDABLE payment=% amount=%',
      v_refund.payment_id, v_amount
      using errcode = 'check_violation';
  end if;

  return v_refund;
end $$;

comment on function public.complete_booking_refund(uuid, text, text, text, uuid) is
  'Completes a refund, hops the booking to refunded and draws the payment''s
   remainder down in one transaction, or returns null when the refund was
   already completed — which is what the refund.processed webhook matches on.';

-- ── confirm_booking_payment(), superseding 0014's ──────────
-- Identical in every way to 0014's except for one assignment:
-- `refundable_amount = amount` on the capture. The header explains
-- why it is here rather than edited into 0014 (that file is already
-- applied, and a migration that changed under its own ledger would
-- stop meaning what the ledger says it means).
--
-- Everything else is deliberately untouched: same replay guard, same
-- cancelled-booking rule, same null actor.
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
         -- The whole remainder is available the moment the money is captured.
         -- Without this the column stays at its `default 0` forever and no
         -- refund can ever be drawn, which is the finding 0015's header records.
         refundable_amount   = amount,
         gateway_payment_id = p_gateway_payment_id,
         gateway_signature  = p_gateway_signature,
         captured_at        = coalesce(captured_at, now()),
         updated_at         = now()
   where id = p_payment_id
     and gateway_order_id = p_gateway_order_id
     and status in ('created', 'pending')
  returning * into v_payment;

  -- Checked before v_payment is touched: with no row matched, INTO leaves the
  -- record unassigned and a field reference on it raises rather than returning
  -- null.
  if not found then
    return null;
  end if;

  update public.bookings
     set status      = 'paid',
         quote_token = null
   where id = p_booking_id
     and status = 'payment_pending';

  return v_payment;
end $$;

comment on function public.confirm_booking_payment(uuid, text, uuid, text, text, text) is
  'Marks a payment success, seeds its refundable remainder and moves its booking
   to paid in one transaction, or returns null when the payment was already
   confirmed (the replay guard). Supersedes 0014''s body — see 0015''s header.';

-- ── Backfill ───────────────────────────────────────────────
-- 0014 already captured rows against a `refundable_amount` that was
-- never raised, and no refund path existed to have drawn it down, so
-- `refundable_amount = 0` on a `success` row can only mean "captured
-- before this file". Scoped to `success` on purpose: a payment that
-- has actually been refunded no longer has its full amount
-- refundable, and resetting it would hand a customer their money
-- twice.
update public.payments
   set refundable_amount = amount
 where status = 'success'
   and refundable_amount = 0
   and amount > 0;

-- ── Grants ─────────────────────────────────────────────────
-- 0024's note applies verbatim: `security definer` means the body runs with the
-- owner's rights, so the EXECUTE grant is what the *caller* needs. Every caller
-- here is a Route Handler holding the service role; nothing else may move money.
revoke all on function public.get_or_create_wallet(uuid)
  from public, anon, authenticated;
revoke all on function public.apply_wallet_delta(uuid, public.wallet_txn_type, numeric, text, text)
  from public, anon, authenticated;
revoke all on function public.record_booking_refund(uuid, uuid, numeric, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_booking_refund(uuid, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.confirm_booking_payment(uuid, text, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.get_or_create_wallet(uuid) to service_role;
grant execute on function public.apply_wallet_delta(uuid, public.wallet_txn_type, numeric, text, text) to service_role;
grant execute on function public.record_booking_refund(uuid, uuid, numeric, text, text, text, uuid) to service_role;
grant execute on function public.complete_booking_refund(uuid, text, text, text, uuid) to service_role;
grant execute on function public.confirm_booking_payment(uuid, text, uuid, text, text, text) to service_role;
