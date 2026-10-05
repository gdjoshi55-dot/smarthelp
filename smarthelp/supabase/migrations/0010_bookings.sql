-- ============================================================
-- 0010_bookings.sql
-- SmartHelp: the booking itself, its line items, and the
-- trail of states it has been in.
--
-- A booking is three things at once and the table has to hold
-- all three without one of them corrupting the others:
--
--   1. What the customer agreed to. Frozen. `address_snapshot`
--      and `pricing_snapshot` exist so that a later edit to the
--      catalogue, or a correction to the address, cannot rewrite
--      what was agreed. That frozen copy is what a dispute is
--      argued from.
--   2. What it costs. Every money column is computed on the
--      server and never read from the client.
--   3. Where it is in its life. That is not this table's job —
--      0011 owns it, and this table only carries the timestamp
--      columns the individual states stamp.
--
-- Money columns are numeric(12,2) and rate columns are
-- numeric(5,4). Rates are stored as rates — 0.1800, not 18 —
-- because a column called `tax_rate` holding `18` invites
-- somebody to divide by 100 at the read site, and every one of
-- those sites is a place the tax can come out wrong.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.7, §8.1, §24.6
-- ============================================================

-- Declared here, as §24.7 places it in 0010, even though only
-- Phase 3 reads it. Same reasoning as the booking_status enum:
-- the alternative is a second migration that alters a type.
do $$ begin
  create type payment_purpose as enum ('booking', 'extension', 'wallet_topup', 'penalty');
exception when duplicate_object then null; end $$;

-- ── The booking number ─────────────────────────────────────
-- SH-20260926-00124. §24.7 shows a per-day counter restarting at
-- 1 each morning. Implementing that needs a per-day row and a
-- lock to make two simultaneous first-bookings agree, which is a
-- table and a contention point in exchange for cosmetics on a
-- label nobody parses. One global sequence rendered per day
-- gives the same shape, never collides (the unique constraint is
-- the real guarantee) and cannot deadlock at midnight.
create sequence if not exists public.booking_number_seq;

create or replace function public.next_booking_number(p_at timestamptz default now())
returns text
language plpgsql set search_path = public as $$
declare
  n bigint;
begin
  n := nextval('public.booking_number_seq');
  -- Rendered in the booking's own city zone, not the server's:
  -- a booking made at 00:10 IST is the 26th in India even when
  -- the database is configured for UTC.
  return 'SH-' || to_char(p_at at time zone 'Asia/Kolkata', 'YYYYMMDD') || '-' || lpad(n::text, 5, '0');
end $$;

comment on function public.next_booking_number(timestamptz) is
  'Renders the §24.7 booking number from one global sequence, so the suffix is
   unique without a per-day counter row. The date part is rendered in
   Asia/Kolkata because that is the city the booking is in; the sequence is
   global so the number is never ambiguous.';

-- ── bookings ───────────────────────────────────────────────
create table if not exists public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  booking_number      text not null unique,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  professional_id     uuid references public.professionals(id) on delete set null,
  address_id          uuid not null references public.addresses(id) on delete restrict,
  -- Frozen at creation. The dispute evidence (§24.7): an address
  -- corrected or renamed later must not rewrite what the
  -- professional was told to turn up at.
  address_snapshot    jsonb not null,
  locality_id         uuid references public.localities(id) on delete set null,
  city_id             uuid references public.cities(id) on delete set null,

  booking_type        public.booking_type not null,
  status              public.booking_status not null default 'draft',
  -- Optimistic lock (§28.1). Every mutation is
  -- `update … where id = $1 and version = $n`; zero rows
  -- affected is STALE_VERSION, never a silent overwrite. Two
  -- devices rescheduling the same booking produce one winner and
  -- one conflict, not two bookings.
  version             int not null default 1,

  scheduled_start_at  timestamptz,
  scheduled_end_at    timestamptz,
  duration_minutes    int not null check (duration_minutes > 0),
  extended_minutes    int not null default 0,

  -- Money. Computed on the server, frozen at creation (§7.1).
  subtotal            numeric(12,2) not null default 0,
  platform_fee        numeric(12,2) not null default 0,
  discount            numeric(12,2) not null default 0,
  discount_code       text,
  tax                 numeric(12,2) not null default 0,
  tax_rate            numeric(5,4)  not null default 0,
  total_amount        numeric(12,2) not null default 0,
  professional_gross  numeric(12,2) not null default 0,
  commission_pct      numeric(5,4)  not null default 0,
  currency            char(3) not null default 'INR',
  quote_token         text,
  -- Every rule that was applied, in the order it was applied,
  -- with the value of each rule's parameters. §24.7 calls this
  -- "for audit" and that is exactly its job: when a customer
  -- disputes a price six weeks later, the question is what the
  -- engine saw, and a single stored total cannot answer it.
  pricing_snapshot    jsonb not null default '{}'::jsonb,

  -- Service execution. Written by the professional app (Phase 4).
  otp_hash            text,
  otp_expires_at      timestamptz,
  otp_attempts        int not null default 0,
  otp_generations     int not null default 0,
  otp_verified_at     timestamptz,
  started_at          timestamptz,
  ends_at             timestamptz,
  ended_at            timestamptz,
  actual_duration_minutes int,

  -- Assignment and SLA. Phase 5.
  search_started_at   timestamptz,
  search_expires_at   timestamptz,
  matched_at          timestamptz,
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  eta_minutes         int,
  assignment_rounds   int not null default 0,

  -- Cancellation and resolution.
  cancelled_at        timestamptz,
  cancellation_reason_code text,
  cancellation_fee    numeric(12,2) not null default 0,
  completed_at        timestamptz,
  closed_at           timestamptz,
  notes               text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An instant booking is "as soon as we can", so a wall-clock
  -- start on it is a category error rather than a default.
  constraint instant_not_scheduled
    check (booking_type <> 'instant' or scheduled_start_at is null),
  -- Free money is a bug; a negative platform fee is a worse one.
  constraint money_non_negative
    check (subtotal >= 0 and platform_fee >= 0 and discount >= 0
           and tax >= 0 and total_amount >= 0 and professional_gross >= 0),
  -- A rate outside [0,1] means someone stored 18 where 0.18
  -- belongs, which is the mistake numeric(5,4) invites.
  constraint rates_are_rates
    check (tax_rate between 0 and 1 and commission_pct between 0 and 1),
  -- The window has to end after it starts, and a scheduled
  -- booking has to have one.
  constraint window_is_forward
    check (scheduled_start_at is null or scheduled_end_at is null
           or scheduled_end_at > scheduled_start_at),
  constraint scheduled_has_a_start
    check (booking_type = 'instant' or scheduled_start_at is not null)
);

comment on column public.bookings.address_snapshot is
  'The address row frozen at creation: label, type, line1, line2, area, city,
   state, pincode, lat, lng, landmark, access_notes and location_precision.
   A correction to `addresses` must not rewrite what a professional was told to
   turn up at, and this is what a dispute reads.';

comment on column public.bookings.pricing_snapshot is
  'The pricing engine''s full breakdown for this booking: the line inputs, every
   multiplier and coupon applied in order with its parameters, the rounding
   points, and the derived commission_amount and platform_revenue. Those two
   are stored here rather than as columns because they are arithmetic on
   columns that are already stored — a third column would be a second thing to
   drift. §24.7 does not list them as columns and this is where they live.';

comment on column public.bookings.quote_token is
  'The signed quote the customer confirmed, kept for the trail. It is NOT what
   enforces the price: the server re-derives the price on every create and
   compares (§7.2). A tampered amount is PRICE_CHANGED whether or not a token
   was presented.';

-- Indexes from §24.7. The Phase-5 ones are declared now rather
-- than later, because an index is cheap to add to an empty table
-- and expensive to add to a live one — and `create index` on
-- `bookings` blocks writes for as long as it runs.
create index if not exists idx_bookings_customer
  on public.bookings (customer_id, created_at desc);
create index if not exists idx_bookings_profession
  on public.bookings (professional_id, scheduled_start_at desc);
create index if not exists idx_bookings_status
  on public.bookings (status, created_at desc);
create index if not exists idx_bookings_upcoming
  on public.bookings (scheduled_start_at)
  where status in ('paid','searching','assigned','accepted');
create index if not exists idx_bookings_search_exp
  on public.bookings (search_expires_at) where status = 'searching';
create index if not exists idx_bookings_city_date
  on public.bookings (city_id, scheduled_start_at);
create index if not exists idx_bookings_number
  on public.bookings (booking_number text_pattern_ops);

-- §24.7 writes this as
--   point(address_snapshot->>'lng', address_snapshot->>'lat')
-- which does not compile: jsonb ->> yields text, and there is no
-- point(text, text). The casts are what the index needs, and the
-- GiST operator class comes from btree_gist, which 0002 already
-- installed for the same reason.
create index if not exists idx_bookings_geo
  on public.bookings using gist (
    point((address_snapshot->>'lng')::double precision,
          (address_snapshot->>'lat')::double precision)
  );

drop trigger if exists trg_bookings_touch on public.bookings;
create trigger trg_bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();

-- ── booking_items ──────────────────────────────────────────
-- One row per service on the booking. Every descriptive and money
-- column is a snapshot: `service_name` because the catalogue is
-- editable, `unit_price` because the price is, and
-- `scope_snapshot` because the included/excluded list a customer
-- agreed to is the thing a complaint is about.
create table if not exists public.booking_items (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  service_id       uuid not null references public.services(id) on delete restrict,
  service_name     text not null,
  duration_minutes int not null check (duration_minutes > 0),
  unit_price       numeric(10,2) not null,
  quantity         int not null default 1 check (quantity > 0),
  line_total       numeric(12,2) not null check (line_total >= 0),
  scope_snapshot   jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_booking_items_booking
  on public.booking_items (booking_id);
-- One service cannot appear twice on one booking. Two lines for
-- the same service mean the engine is wrong, and a constraint is
-- cheaper than finding out from a customer's total.
create unique index if not exists uniq_booking_service
  on public.booking_items (booking_id, service_id);

-- ── booking_status_history ─────────────────────────────────
create table if not exists public.booking_status_history (
  id          bigserial primary key,
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  from_status public.booking_status,
  to_status   public.booking_status not null,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_role  public.user_role,
  note        text,
  ip          inet,
  created_at  timestamptz not null default now()
);

create index if not exists idx_bsh_booking
  on public.booking_status_history (booking_id, created_at);
create index if not exists idx_bsh_actor
  on public.booking_status_history (actor_id, created_at desc);

comment on table public.booking_status_history is
  'Append-only. Rows are written by enforce_booking_transition() (0011) rather
   than by the Route Handler, so no route can forget and no route can forge a
   hop it did not make. 0011 also installs the immutability trigger: a history
   somebody can edit is not a history.';

-- ── Deferred from Phase 1, landing now ─────────────────────
-- §24.6 defines block_address_delete_with_future_bookings(), which
-- refuses to delete an address a live booking points at. It could
-- not be in 0008 because it names `bookings`, and a migration that
-- references a missing table fails to apply — so it lives here,
-- one file after the last table it needs.
create or replace function public.block_address_delete_with_future_bookings()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_count int;
  v_next  timestamptz;
  v_live  int;
begin
  select count(*),
         min(scheduled_start_at),
         count(*) filter (where status in
           ('draft','payment_pending','paid','searching','assigned','accepted',
            'on_the_way','arrived','otp_verified','in_progress','extension_requested'))
    into v_count, v_next, v_live
    from public.bookings
   where address_id = old.id
     and status <> 'closed';

  -- Every non-closed booking is counted, not only the upcoming ones, because
  -- `bookings.address_id` is ON DELETE RESTRICT (§24.7) and RESTRICT ignores
  -- status: any booking at all pins the address, so a narrower predicate here
  -- would just be handing some cases to the foreign key, and the foreign key's
  -- error is the raw constraint name. A cancelled booking can still be disputed
  -- or refunded, so it legitimately blocks too.
  if v_count > 0 then
    raise exception 'ADDRESS_IN_USE % %', v_count, coalesce(to_char(v_next, 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'unknown')
      using errcode = 'foreign_key_violation',
            detail = format('{"upcomingBookings":%s,"liveBookings":%s,"nextBookingAt":"%s"}',
                            v_count, v_live,
                            coalesce(to_char(v_next, 'YYYY-MM-DD"T"HH24:MI:SSOF'), ''));
  end if;

  return old;
end $$;

comment on function public.block_address_delete_with_future_bookings() is
  'Refuses to delete an address that any non-closed booking points at, and says how
   many and when. Until Phase 2 this was unreachable because nothing referenced an
   address; now a booking does, so the window is real and the guard is not optional.

   Note that this trigger cannot be the only thing standing in the way:
   bookings.address_id is ON DELETE RESTRICT, so a booking in `closed` still pins
   the address and this predicate lets the foreign key raise instead. That is
   intentional — the aggregate of a professional''s rating history and the refund
   trail both need an address that resolves — but it does mean an address a
   customer once booked to is not deletable. Worth revisiting as a product
   question; see the Phase 2 notes.';

drop trigger if exists trg_addresses_block_delete on public.addresses;
create trigger trg_addresses_block_delete before delete on public.addresses
  for each row execute function public.block_address_delete_with_future_bookings();

-- ── RLS ────────────────────────────────────────────────────
-- A booking is a customer's: their address, their money, their
-- professional's name and where they are. No anon grant at all,
-- for the same reason `addresses` has none.
--
-- `professional_id` is readable by that professional because the
-- professional app (Phase 4) needs their own job list, and the
-- alternative — a second table holding the same fact — would be
-- one more thing to keep in step.
alter table public.bookings enable row level security;

do $$ begin
  create policy bookings_select_own on public.bookings for select
    using (customer_id = public.current_customer_id()
           or professional_id = public.current_professional_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bookings_insert_own on public.bookings for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- Deliberately no UPDATE or DELETE policy.
--
-- `status` is owned by enforce_booking_transition() and `version`
-- by the optimistic lock; a policy that let a browser session write
-- either would hand out exactly the two things the state machine
-- exists to protect. Every legitimate write to `bookings` goes
-- through a Route Handler using the service role, which checks
-- ownership and bumps the version itself.
--
-- (The same reasoning applies to `booking_items` and
-- `booking_status_history`: they are written only as part of
-- creating a booking.)

alter table public.booking_items enable row level security;
do $$ begin
  create policy booking_items_select_own on public.booking_items for select
    using (exists (select 1 from public.bookings b
                    where b.id = booking_id
                      and b.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

alter table public.booking_status_history enable row level security;
do $$ begin
  create policy bsh_select_own on public.booking_status_history for select
    using (exists (select 1 from public.bookings b
                    where b.id = booking_id
                      and b.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

-- The transition trigger writes history as `SECURITY DEFINER`, so
-- it does not go through these policies — but a reader must still
-- not be able to forge one, hence no INSERT grant either.
revoke all on public.bookings from anon;
revoke all on public.booking_items from anon;
revoke all on public.booking_status_history from anon;

grant select on public.bookings to authenticated;
grant select, insert on public.booking_items to authenticated;
grant select on public.booking_status_history to authenticated;

grant execute on function public.next_booking_number(timestamptz) to service_role;
