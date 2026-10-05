-- ============================================================
-- 0017_ratings.sql
-- SmartHelp: one review per completed booking.
--
-- A rating is the one table here that is mostly a claim about
-- something else — it asserts that a booking happened, that this
-- customer was in it, that this professional did it, and that it
-- finished. All four are checkable against `bookings`, so they
-- are checked in the database rather than in the Route Handler.
--
-- The reason is trust, not tidiness. If `customer_id` and
-- `professional_id` are whatever the caller passed, then anyone
-- with a booking id can rate any professional — and the rating
-- table is what every professional's public reputation is
-- computed from. That is a single-request path to a defamatory
-- review of an arbitrary person, so the invariant is a BEFORE
-- INSERT trigger rather than a line in a handler that a future
-- handler might not have.
--
-- §24.7 also declares `favourites` in this file. It is not here:
-- favourites are a Phase 5 feature and an empty table nobody
-- writes is a table that only makes the schema harder to read.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.7, §8.1
-- ============================================================

create table if not exists public.ratings (
  id               uuid primary key default gen_random_uuid(),
  -- UNIQUE does double duty: one review per booking (the edit path
  -- updates), and it makes a duplicate POST fail at the database
  -- rather than being deduped in application code.
  booking_id       uuid not null unique references public.bookings(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  overall          int not null check (overall between 1 and 5),
  professionalism  int check (professionalism between 1 and 5),
  quality          int check (quality between 1 and 5),
  punctuality      int check (punctuality between 1 and 5),
  behaviour        int check (behaviour between 1 and 5),
  cleanliness      int check (cleanliness between 1 and 5),
  comment          text check (char_length(comment) <= 1000),
  pro_response     text check (char_length(pro_response) <= 250),
  is_hidden        boolean not null default false,
  hidden_by        uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  responded_at     timestamptz
);

create index if not exists idx_ratings_pro
  on public.ratings (professional_id, created_at desc);
create index if not exists idx_ratings_cust
  on public.ratings (customer_id, created_at desc);
-- Moderation reads hidden rows; the public profile reads visible ones. Without
-- the partial index the moderation query scans every visible review too.
create index if not exists idx_ratings_hidden
  on public.ratings (professional_id, created_at desc) where is_hidden;

comment on table public.ratings is
  'Reviews. The public aggregate for a professional is computed over rows where
   is_hidden is false; hidden rows stay for moderation history rather than being
   deleted, so an admin action can be explained later. Only completed bookings
   may be rated — enforced by validate_rating_booking(), not by the API.';

-- ── The eligibility check ──────────────────────────────────
create or replace function public.validate_rating_booking()
returns trigger
language plpgsql set search_path = public as $$
declare
  b public.bookings%rowtype;
begin
  select * into b from public.bookings where id = new.booking_id;

  if not found then
    raise exception 'RATING_NO_SUCH_BOOKING' using errcode = 'foreign_key_violation';
  end if;

  -- The three things a rating asserts, each checked against the row
  -- that is supposed to prove it.
  if b.customer_id is distinct from new.customer_id then
    raise exception 'RATING_CUSTOMER_MISMATCH' using errcode = 'check_violation',
      detail = format('{"bookingCustomer":"%s"}', b.customer_id);
  end if;

  if b.professional_id is distinct from new.professional_id then
    raise exception 'RATING_PROFESSIONAL_MISMATCH' using errcode = 'check_violation',
      detail = format('{"bookingProfessional":"%s"}', b.professional_id);
  end if;

  -- §8.1: `closed` is reachable only from completed/refunded/no_show. A
  -- rating is the thing that normally closes a completed booking, so the gate
  -- is "has the service finished", not "is the booking closed" — otherwise
  -- there would be no way to ever rate anything.
  if b.status not in ('completed', 'closed') then
    raise exception 'RATING_NOT_ALLOWED %', b.status using errcode = 'check_violation',
      detail = format('{"bookingStatus":"%s"}', b.status);
  end if;

  new.professional_id := coalesce(b.professional_id, new.professional_id);
  return new;
end $$;

comment on function public.validate_rating_booking() is
  'Stops anyone rating a booking they were not part of, for a professional who
   did not do it, or for a service that has not finished. This is the trust
   boundary for the whole reputation system, so it lives in Postgres: a rating is
   what every professional''s public score is computed from, and application-level
   checks are only as strong as the least careful future caller.';

drop trigger if exists trg_rating_validate on public.ratings;
create trigger trg_rating_validate before insert on public.ratings
  for each row execute function public.validate_rating_booking();

-- Moderation must not be able to change who rated whom or what the scores were —
-- only whether the row is shown. Without this, an admin "hiding" a review could
-- quietly rewrite its contents on the way past.
--
-- DELETE is refused for a hand-rolled delete but permitted for the cascade from a
-- dropped booking, which is the same discrimination booking_status_is_immutable()
-- makes: Postgres fires the referential action from an AFTER trigger on the
-- parent, so by the time this fires on the child the booking is already gone.
create or replace function public.guard_rating_immutability()
returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.bookings where id = old.booking_id) then
      raise exception 'RATING_DELETE_FORBIDDEN'
        using errcode = 'insufficient_privilege',
              detail = '{"hint":"set is_hidden instead — a deleted review leaves a gap in the aggregate"}';
    end if;
    return old;
  end if;

  if new.booking_id        is distinct from old.booking_id
     or new.customer_id    is distinct from old.customer_id
     or new.professional_id is distinct from old.professional_id
     or new.overall         is distinct from old.overall
     or new.professionalism is distinct from old.professionalism
     or new.quality         is distinct from old.quality
     or new.punctuality     is distinct from old.punctuality
     or new.behaviour       is distinct from old.behaviour
     or new.cleanliness     is distinct from old.cleanliness
     or new.comment         is distinct from old.comment then
    raise exception 'RATING_IMMUTABLE' using errcode = 'insufficient_privilege',
      detail = '{"hint":"only is_hidden, hidden_by, pro_response and responded_at may change"}';
  end if;

  return new;
end $$;

comment on function public.guard_rating_immutability() is
  'Ratings are append-only in substance: moderation may hide a row but may not
   rewrite the scores, the comment, or who rated whom. Deletes are refused unless
   they are the cascade from a deleted booking — a review outlives its
   cancellation, and the aggregate for a professional is computed over visible
   rows, so a silent delete would leave a hole nobody can account for.';

drop trigger if exists trg_rating_guard on public.ratings;
create trigger trg_rating_guard before update or delete on public.ratings
  for each row execute function public.guard_rating_immutability();

-- ── RLS ────────────────────────────────────────────────────
-- Visible reviews are public — they are the reason the table
-- exists. Hidden ones are not, and the policy is what stops a
-- hidden review leaking through an open data view.
alter table public.ratings enable row level security;

do $$ begin
  create policy ratings_read_visible on public.ratings for select
    using (not is_hidden);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy ratings_insert_own on public.ratings for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

-- The professional can answer a review of their own work. Nothing
-- else about the row is writable by them — the guard trigger would
-- stop it anyway, but a policy that permits it is a trap for the
-- next reader.
do $$ begin
  create policy ratings_pro_respond on public.ratings for update
    using (professional_id = public.current_professional_id())
    with check (professional_id = public.current_professional_id());
exception when duplicate_object then null; end $$;

grant select on public.ratings to anon, authenticated;
grant insert on public.ratings to authenticated;
grant update (pro_response, responded_at) on public.ratings to authenticated;