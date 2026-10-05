-- ============================================================
-- 0013_professional_schedule.sql
-- SmartHelp: reserved windows on a professional's calendar.
--
-- `professional_working_hours` (0005) says when someone is
-- generally willing to work; this says when they are actually
-- spoken for. A booking takes a window out of the calendar the
-- moment it is created, not when it is accepted or paid, because
-- by then the customer has already been told this professional is
-- available at that time and telling them otherwise afterwards is
-- the cancellation they would rather avoid.
--
-- The overlap guarantee is a GiST exclusion constraint rather
-- than application code that checks "is this window free?". An
-- availability check is a read followed by a write, and two
-- concurrent bookings for the same slot both read "free". The
-- constraint is atomic: the second insert simply fails, and the
-- application catches that and offers the next slot. Nothing has
-- to be trusted.
--
-- btree_gist comes from 0002, which installed it for
-- local/city/service_areas. `professional_id WITH =` needs it
-- because that operator class is otherwise text-only.
--
-- `booking_assignments` and `assignment_status` are also declared
-- in §24.9 but are deliberately NOT here — they belong to the
-- matching engine, and a table with no matching engine behind it
-- is a table that can only ever contain rows nothing wrote.
-- They land in 0012 with Phase 5.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.9
-- ============================================================

do $$ begin
  create type schedule_status as enum ('reserved', 'in_progress', 'completed', 'released');
exception when duplicate_object then null; end $$;

create table if not exists public.professional_schedule (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  -- Nullable: a block of time off does not belong to a booking.
  booking_id      uuid references public.bookings(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          public.schedule_status not null default 'reserved',
  created_at      timestamptz not null default now(),
  constraint valid_window check (ends_at > starts_at),
  -- A reserved window has to say whose booking it is. Without this, a
  -- cancelled booking's window could be released by a row that never
  -- had one, and the calendar would drift away from the bookings.
  constraint reserved_needs_booking
    check (status <> 'reserved' or booking_id is not null)
);

comment on table public.professional_schedule is
  'Time a professional has spoken for. `reserved` rows are created when a booking
   is created and released on cancellation; `released` rows are kept as the trail
   rather than deleted, so a later dispute can see that the slot did exist. The
   exclusion constraint is the double-booking guarantee and it is atomic — an
   availability check would not be.';

-- Overlapping live windows are structurally impossible.
--
-- The WHERE clause is what makes this survivable in production. Without it a
-- completed booking from last week would block the same slot forever, and the
-- calendar would be permanently full as soon as it had any history. Only the
-- two states that actually occupy time are excluded.
do $$ begin
  alter table public.professional_schedule
    add constraint professional_no_overlap exclude using gist (
      professional_id with =,
      tstzrange(starts_at, ends_at, '[)') with &&
    ) where (status in ('reserved', 'in_progress'));
exception when duplicate_object then null; end $$;

comment on constraint professional_no_overlap on public.professional_schedule is
  'The double-booking guarantee (§24.9). Two transactions reserving the same
   window cannot both win: the loser gets exclusion_violation (23P01), which
   lib/bookingServer.ts turns into the next available slot rather than a 500.';

create index if not exists idx_schedule_prof
  on public.professional_schedule (professional_id, starts_at);
create index if not exists idx_schedule_booking
  on public.professional_schedule (booking_id);

-- `professional_working_hours` answers "when could they work"; this answers
-- "when are they spoken for". Availability is the difference, and Phase 2 needs
-- both to tell a customer the truth about a slot.
create index if not exists idx_schedule_live
  on public.professional_schedule (professional_id, starts_at)
  where status in ('reserved', 'in_progress');

-- ── RLS ────────────────────────────────────────────────────
-- Readable by the professional it belongs to and by the customer
-- who booked it — a customer has to see that the slot they hold is
-- genuinely held.
--
-- Written only by the service role from the booking Route Handlers,
-- which create and release the window as part of the same
-- transaction as the booking itself. No INSERT policy: a row here
-- that no booking created is a row the exclusion constraint is
-- honouring while nothing occupies that time.
alter table public.professional_schedule enable row level security;

do $$ begin
  create policy schedule_select_related on public.professional_schedule for select
    using (professional_id = public.current_professional_id()
           or exists (select 1 from public.bookings b
                       where b.id = booking_id
                         and b.customer_id = public.current_customer_id()));
exception when duplicate_object then null; end $$;

revoke all on public.professional_schedule from anon;
grant select on public.professional_schedule to authenticated;