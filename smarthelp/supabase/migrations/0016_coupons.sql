-- ============================================================
-- 0016_coupons.sql
-- SmartHelp: coupons and the ledger of who used one where.
--
-- The design decision here is that `coupons.usage_count` is a
-- cache, never the truth. `coupon_usage` is the truth: one row
-- per booking that spent a coupon, and a unique index on
-- booking_id makes "one coupon per booking" a property of the
-- schema instead of a check the pricing engine has to remember
-- to run.
--
-- The alternative — a counter incremented on the coupons row —
-- makes the count a thing that can disagree with the rows it
-- summarises, and a discount that has been over-redeemed is the
-- kind of bug that shows up as money. A limit is then a read
-- under contention on a hot row, for no reason: the count is
-- already available as `select count(*)`.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.7
-- ============================================================

do $$ begin
  create type discount_type as enum ('percentage', 'fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.coupons (
  id                      uuid primary key default gen_random_uuid(),
  code                    text not null,
  description             text,
  discount_type           public.discount_type not null,
  discount_value          numeric(10,2) not null check (discount_value > 0),
  -- The cap that stops a 50% coupon being applied to a large
  -- booking. Only meaningful for percentages.
  max_discount            numeric(10,2),
  min_booking_amount      numeric(10,2) not null default 0,
  -- A belt-and-braces ceiling: no single coupon may take more than
  -- this share of the total even if max_discount is set higher.
  -- A marketing mistake in the coupon row must not be able to
  -- produce a negative payable.
  max_discount_pct_of_total numeric(5,2) not null default 40.00,
  valid_from              timestamptz not null default now(),
  valid_to                timestamptz,
  usage_limit             int,
  usage_count             int not null default 0 check (usage_count >= 0),
  per_user_limit          int not null default 1,
  -- Empty array means "all", which is what makes a sitewide coupon
  -- a row with two empty arrays rather than a join table.
  applicable_services     uuid[] not null default '{}',
  applicable_cities       uuid[] not null default '{}',
  first_time_only         boolean not null default false,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- A percentage discount with no cap can be set to 100 and
  -- produce a zero, or above 100 and produce a negative.
  constraint percentage_needs_cap
    check (discount_type <> 'percentage' or max_discount is not null),
  constraint percentage_is_sane
    check (discount_type <> 'percentage' or discount_value <= 100),
  constraint window_is_forward
    check (valid_to is null or valid_to > valid_from),
  constraint cap_is_usable
    check (max_discount is null or max_discount > 0),
  constraint counts_are_positive
    check (usage_limit is null or usage_limit > 0)
);

comment on column public.coupons.usage_count is
  'A denormalised count of coupon_usage rows, maintained by the booking Route
   Handler. It exists so the catalogue can render "3 of 10 left" without a
   correlated count on every listing, and it is NOT what enforces usage_limit —
   coupon_usage is. Treat a disagreement as a bug to report, not something to
   reconcile at read time.';

comment on column public.coupons.max_discount_pct_of_total is
  'The hard ceiling on any one coupon, independent of max_discount. A coupon
   misconfigured with max_discount above the total would otherwise drive the
   discount above the subtotal and the total negative, so this is the last check
   before the money stops making sense.';

-- Case-insensitive: a customer types the code, and "SAVE20" and "save20" being
-- different coupons is a support ticket rather than a feature.
create unique index if not exists uniq_coupons_code on public.coupons (upper(code));
create index if not exists idx_coupons_active
  on public.coupons (is_active, valid_from, valid_to);

drop trigger if exists trg_coupons_touch on public.coupons;
create trigger trg_coupons_touch before update on public.coupons
  for each row execute function public.touch_updated_at();

-- ── The ledger ─────────────────────────────────────────────
create table if not exists public.coupon_usage (
  id               uuid primary key default gen_random_uuid(),
  coupon_id        uuid not null references public.coupons(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  -- What this coupon was actually worth, after the cap. Storing the
  -- realised amount rather than re-deriving it from coupon_id means a
  -- later edit to the coupon cannot change what a past booking was
  -- actually charged.
  discount_amount  numeric(10,2) not null check (discount_amount > 0),
  used_at          timestamptz not null default now()
);

-- One coupon per booking. This is the whole reason the table exists:
-- a constraint, not an `if`.
create unique index if not exists uniq_coupon_usage_booking
  on public.coupon_usage (booking_id);
create index if not exists idx_coupon_usage_coupon
  on public.coupon_usage (coupon_id, customer_id);
-- Per-user limit is enforced by counting these rows for a customer.
create index if not exists idx_coupon_usage_customer
  on public.coupon_usage (customer_id, coupon_id, used_at desc);

comment on table public.coupon_usage is
  'Append-only. Row exists means the coupon was spent. A cancelled booking may
   release it, which is a deletion here — the discount stops counting because
   the ledger row went with the booking.';

-- ── RLS ────────────────────────────────────────────────────
-- A coupon is public information; its redemption history is not.
alter table public.coupons enable row level security;

do $$ begin
  create policy coupons_read_authenticated on public.coupons for select
    using (is_active);
exception when duplicate_object then null; end $$;

alter table public.coupon_usage enable row level security;

do $$ begin
  create policy coupon_usage_select_own on public.coupon_usage for select
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- No INSERT policy: a redemption is written by the booking Route
-- Handler in the same transaction as the booking. A client that
-- could insert here could mark a coupon as spent without a booking.
revoke all on public.coupon_usage from anon;
grant select on public.coupon_usage to authenticated;
grant select on public.coupons to anon, authenticated;