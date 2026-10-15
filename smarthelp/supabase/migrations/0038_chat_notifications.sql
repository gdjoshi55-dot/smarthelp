-- ============================================================
-- 0038_chat_notifications.sql
-- SmartHelp Phase 7: the chat thread, the notification bell and
-- the admin-editable template catalogue behind
-- `/admin/notifications` and the `me:{profileId}` Realtime channel.
--
-- Spec: §24.11 (chat_threads / chat_messages / notification_templates
--       / notifications), §27.1-27.5, §25.9, §31.1 (Phase 7).
-- Depends on: 0001 (profiles, current_customer_id, is_staff,
--             touch_updated_at), 0005 (professionals,
--             current_professional_id), 0010 (bookings),
--             0017 (customers already linked via 0001).
--
-- WHY THIS EXISTS
-- ---------------
-- §27 describes a product where "a status change lands in under a
-- second" and "every catalogue notification fires". The migrations
-- carry neither of the two halves of that: nothing stores a
-- conversation, and nothing stores an outbound message. The
-- comments in 0000/0001 forward-reference this file as
-- `0020_chat_notifications.sql`; the number here is `0038` because
-- the ledger is applied in filename order and a file numbered 0020
-- would sort behind ten migrations it is later than.
--
-- READ MODEL / WRITES
-- -------------------
-- Every write goes through the service role (D3): the routes re-check
-- authority themselves, and the policies below are the backstop. The
-- SELECT policies are not decoration — Supabase Realtime applies RLS
-- exactly as REST does (§24.16), so `notifications` and
-- `chat_messages` must be readable by the right caller for the
-- `me:{profileId}` and `chat:{threadId}` channels to deliver anything.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── notification_channel ───────────────────────────────────
-- Created whole, like the booking enums in 0009: the values a later
-- phase will deliver through are named now, so `sms` is a channel the
-- database already understands even while no SMS provider is wired
-- (`.env.example`: "SMS is intentionally not configured").
do $$ begin
  create type public.notification_channel as enum
    ('push', 'sms', 'email', 'in_app', 'whatsapp');
exception when duplicate_object then null; end $$;

comment on type public.notification_channel is
  '§24.11 delivery channels. All five are storable; only `in_app` and
   `email` have a live transport in Phase 7 (D1). The rest are recorded
   with status=failed and a reason rather than pretended.';

-- ── chat_threads ───────────────────────────────────────────
-- One thread per booking (UNIQUE booking_id). A thread cannot exist
-- before a professional is assigned, which is why both FKs are NOT NULL:
-- there is no "waiting for a pro" chat in the product.
create table if not exists public.chat_threads (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null unique references public.bookings(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  professional_id uuid not null references public.professionals(id) on delete cascade,
  last_message_at timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_chat_threads_customer
  on public.chat_threads (customer_id, last_message_at desc nulls last);
create index if not exists idx_chat_threads_professional
  on public.chat_threads (professional_id, last_message_at desc nulls last);

comment on table public.chat_threads is
  'The booking-scoped conversation (§24.11). Created lazily on first
   message or first read (D3); participants are the booking customer and
   the assigned professional. Staff may read, only participants may post.';

-- ── chat_messages ──────────────────────────────────────────
create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.chat_threads(id) on delete cascade,
  sender_id  uuid references public.profiles(id) on delete set null,
  kind       text not null default 'text'
             check (kind in ('text', 'image', 'system')),
  body       text,
  image_path text,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  -- A text message with no body is a bug, not an empty message. An image
  -- or system message may legitimately carry no body.
  constraint chat_messages_text_or_image
    check (kind <> 'text' or body is not null)
);

create index if not exists idx_chat_messages_thread
  on public.chat_messages (thread_id, created_at);

comment on column public.chat_messages.sender_id is
  'Null for a system message (kind=system), which only the server writes.';
comment on column public.chat_messages.image_path is
  'Object path in the `chat-media` bucket (created in 0000), not a URL —
   the read model signs it.';

-- ── notification_templates ─────────────────────────────────
create table if not exists public.notification_templates (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  channel    public.notification_channel not null,
  locale     text not null default 'en-IN',
  subject    text,
  body       text not null,
  variables  text[] not null default '{}',
  is_active  boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, channel, locale)
);

create index if not exists idx_notification_templates_code
  on public.notification_templates (code, is_active);

comment on column public.notification_templates.body is
  'Supports {{token}} placeholders (§27.4). The dispatcher substitutes
   from the notification payload; email bodies are HTML-escaped first.';

-- ── notifications ──────────────────────────────────────────
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  channel       public.notification_channel not null,
  template_code text not null,
  payload       jsonb not null default '{}'::jsonb,
  title         text,
  body          text,
  status        text not null default 'queued'
                check (status in ('queued', 'sent', 'failed', 'read')),
  error         text,
  booking_id    uuid references public.bookings(id) on delete cascade,
  read_at       timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_notifications_recipient
  on public.notifications (recipient_id, created_at desc);
create index if not exists idx_notifications_pending
  on public.notifications (status, created_at)
  where status = 'queued';
create index if not exists idx_notifications_booking
  on public.notifications (booking_id, created_at desc)
  where booking_id is not null;

comment on table public.notifications is
  'One row per (event, channel). `read` is a terminal success state for
   in_app and is a superset of `sent`; a failed row keeps its `error`.';

-- ── notification_devices ───────────────────────────────────
-- §25.9 names `POST /api/notifications/push-token` but §24.11 does not
-- tabulate a home for the token. This is that home (a documented
-- addition): without a provider the row is still the registry a later
-- FCM/APNs integration reads.
create table if not exists public.notification_devices (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  token        text not null,
  platform     text not null default 'web'
               check (platform in ('web', 'ios', 'android')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (profile_id, token)
);

create index if not exists idx_notification_devices_profile
  on public.notification_devices (profile_id);

comment on table public.notification_devices is
  'Push-token registry behind §25.9 `POST /api/notifications/push-token`.
   Not tabulated in §24.11; added so the endpoint has a home (D1).';

-- ── updated_at ─────────────────────────────────────────────
drop trigger if exists trg_notification_templates_touch
  on public.notification_templates;
create trigger trg_notification_templates_touch
  before update on public.notification_templates
  for each row execute function public.touch_updated_at();

-- ── Row level security ─────────────────────────────────────
alter table public.chat_threads           enable row level security;
alter table public.chat_messages          enable row level security;
alter table public.notification_templates enable row level security;
alter table public.notifications          enable row level security;
alter table public.notification_devices   enable row level security;

-- chat_threads: a participant reads their own threads; staff read all.
do $$ begin
  create policy chat_threads_read_participant on public.chat_threads for select
    using (
      customer_id = public.current_customer_id()
      or professional_id = public.current_professional_id()
      or public.is_staff(
        array['support','ops','admin','super_admin']::public.user_role[]
      )
    );
exception when duplicate_object then null; end $$;

-- chat_messages: readable when the parent thread is readable. The
-- subquery runs under the caller's RLS, so it inherits the thread policy.
do $$ begin
  create policy chat_messages_read_participant on public.chat_messages for select
    using (
      exists (select 1 from public.chat_threads t where t.id = thread_id)
    );
exception when duplicate_object then null; end $$;

-- notification_templates: staff read (the editor); writes are service-role.
do $$ begin
  create policy notification_templates_read_staff
    on public.notification_templates for select
    using (public.is_staff(
      array['support','ops','admin','super_admin']::public.user_role[]
    ));
exception when duplicate_object then null; end $$;

-- notifications: a recipient reads their own; staff read the console.
do $$ begin
  create policy notifications_read_own on public.notifications for select
    using (
      recipient_id = auth.uid()
      or public.is_staff(
        array['support','ops','admin','super_admin']::public.user_role[]
      )
    );
exception when duplicate_object then null; end $$;

-- notification_devices: strictly own rows.
do $$ begin
  create policy notification_devices_own on public.notification_devices for all
    using (profile_id = auth.uid())
    with check (profile_id = auth.uid());
exception when duplicate_object then null; end $$;

-- ── Grants ─────────────────────────────────────────────────
revoke all on public.chat_threads           from anon;
revoke all on public.chat_messages          from anon;
revoke all on public.notification_templates from anon;
revoke all on public.notifications          from anon;
revoke all on public.notification_devices   from anon;

grant select on public.chat_threads           to authenticated;
grant select on public.chat_messages          to authenticated;
grant select on public.notification_templates to authenticated;
grant select on public.notifications          to authenticated;
grant select, insert, update, delete on public.notification_devices to authenticated;

grant all on public.chat_threads           to service_role;
grant all on public.chat_messages          to service_role;
grant all on public.notification_templates to service_role;
grant all on public.notifications          to service_role;
grant all on public.notification_devices   to service_role;
