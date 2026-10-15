-- ============================================================
-- 0037_support_disputes.sql
-- SmartHelp Phase 6: the support ticket queue and the dispute
-- queue behind `/admin/support` and `/admin/disputes`.
--
-- Spec: §24 (support_tickets / support_messages / disputes), §20,
--       §25.10, §31.1 (Phase 6).
-- Depends on: 0001 (profiles, is_staff/is_admin, touch_updated_at),
--             0010 (bookings).
--
-- WHY THIS EXISTS
-- ---------------
-- §24 names three tables the console needs and the migrations have never
-- carried: `support_tickets` (the queue an agent works), `support_messages`
-- (the thread on one ticket) and `disputes` (a booking a customer or a
-- professional has contested). The comments in `0000_storage_buckets.sql`
-- already forward-reference this file as `0019_support.sql`; the number
-- here is `0037` because the migration ledger is applied in filename order
-- and every Phase 6 migration is chronological (0033-0036), so a file
-- numbered `0019` would sort behind work it is later than.
--
-- A ticket and a dispute are deliberately separate: a ticket is "help me",
-- a dispute is "I say this charge/outcome is wrong and I want it
-- adjudicated". A dispute can spawn a ticket; a ticket is not a dispute.
--
-- Read model: staff read all three; support tickets are written by any staff
-- member with `ticket.write`, disputes only by `ops`/`admin` holding
-- `dispute.resolve`. The console goes through the service role and re-checks
-- the capability itself (D3); the policies below are the backstop.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── support_tickets ────────────────────────────────────────
create table if not exists public.support_tickets (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid references public.bookings(id) on delete set null,
  raised_by    uuid references public.profiles(id) on delete set null,
  subject      text not null,
  category     text not null default 'general',
  priority     text not null default 'normal'
               check (priority in ('low', 'normal', 'high', 'urgent')),
  status       text not null default 'open'
               check (status in ('open', 'pending', 'resolved', 'closed')),
  assigned_to  uuid references public.profiles(id) on delete set null,
  resolution   text,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_support_tickets_status
  on public.support_tickets (status, created_at desc);
create index if not exists idx_support_tickets_assignee
  on public.support_tickets (assigned_to, created_at desc)
  where status in ('open', 'pending');
create index if not exists idx_support_tickets_booking
  on public.support_tickets (booking_id, created_at desc);

comment on table public.support_tickets is
  'The admin console support queue (§24). A ticket is "help me"; a dispute
   (§disputes) is "this charge/outcome is wrong". support_messages is the
   thread. Service-role writes only (D3); RLS is the backstop.';
comment on column public.support_tickets.resolution is
  'The closing note, set when status moves to resolved/closed. Kept separate
   from the message thread so "what was decided" is not buried in chat.';

-- ── support_messages ───────────────────────────────────────
create table if not exists public.support_messages (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid not null references public.support_tickets(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  body              text not null,
  -- An internal note is a staff-only message: it must never be projected to a
  -- customer even if the ticket is later exposed to the person who raised it.
  is_internal       boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists idx_support_messages_ticket
  on public.support_messages (ticket_id, created_at asc);

comment on column public.support_messages.is_internal is
  'Staff-only note. The read model must filter these out before a ticket is
   ever shown to the customer who raised it.';

-- ── disputes ───────────────────────────────────────────────
create table if not exists public.disputes (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references public.bookings(id) on delete cascade,
  raised_by    uuid references public.profiles(id) on delete set null,
  reason       text not null,
  description  text,
  status       text not null default 'open'
               check (status in ('open', 'investigating', 'resolved', 'rejected')),
  resolution   text,
  resolved_by  uuid references public.profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_disputes_status
  on public.disputes (status, created_at desc);
create index if not exists idx_disputes_booking
  on public.disputes (booking_id, created_at desc);

comment on table public.disputes is
  'A contested booking (§24, §25.10). Resolving it is `dispute.resolve`
   (ops/admin). Distinct from support_tickets: a dispute is an adjudication,
   not a help request.';

drop trigger if exists trg_support_tickets_touch on public.support_tickets;
create trigger trg_support_tickets_touch before update on public.support_tickets
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_disputes_touch on public.disputes;
create trigger trg_disputes_touch before update on public.disputes
  for each row execute function public.touch_updated_at();

-- ── Row level security ─────────────────────────────────────
alter table public.support_tickets  enable row level security;
alter table public.support_messages enable row level security;
alter table public.disputes         enable row level security;

-- Staff read the ticket queue and its threads. A customer or professional
-- cannot read even their own here: §24 routes that through a handler that
-- projects a safe view, and this table has no `current_customer_id` policy
-- by design.
do $$ begin
  create policy support_tickets_read_staff on public.support_tickets for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy support_tickets_write_staff on public.support_tickets for all
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ))
    with check (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy support_messages_read_staff on public.support_messages for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy support_messages_write_staff on public.support_messages for all
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ))
    with check (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

-- Disputes are read by all staff, but adjudicated only by ops/admin: the
-- resolve decision is `dispute.resolve`, and support does not hold it.
do $$ begin
  create policy disputes_read_staff on public.disputes for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy disputes_write_ops on public.disputes for all
    using (public.is_staff(array['ops','admin','super_admin']::public.user_role[]))
    with check (public.is_staff(array['ops','admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

revoke all on public.support_tickets  from anon;
revoke all on public.support_messages from anon;
revoke all on public.disputes         from anon;

grant select on public.support_tickets  to authenticated;
grant select on public.support_messages to authenticated;
grant select on public.disputes         to authenticated;

grant all on public.support_tickets  to service_role;
grant all on public.support_messages to service_role;
grant all on public.disputes         to service_role;
