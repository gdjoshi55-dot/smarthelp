-- ============================================================
-- 0039_realtime_publication.sql
-- SmartHelp Phase 7: put the tables §27.1 streams into Supabase
-- Realtime's publication.
--
-- Spec: §24.16 (realtime publication), §27.1 (channel map).
-- Depends on: 0010 (bookings), 0012 (booking_assignments),
--             0021 (professional_earnings), 0037 (support_messages),
--             0038 (chat_messages, notifications).
--
-- WHY THIS EXISTS
-- ---------------
-- Realtime only streams tables that are a member of the
-- `supabase_realtime` publication. The six tables below are the source
-- of every channel in §27.1; without this, `booking:{id}` and
-- `me:{profileId}` subscribe successfully and then never fire.
--
-- RLS APPLIES
-- -----------
-- A Realtime subscriber receives only rows its role may SELECT, judged
-- by the same policies REST uses. So this migration widens *delivery*,
-- never *visibility*: a customer still cannot see another customer's
-- booking or notification, because the SELECT policies in 0038 (and the
-- ones already on the booking tables) deny it.
--
-- IDEMPOTENT WHERE POSTGRES ALLOWS
-- --------------------------------
-- `ALTER PUBLICATION … ADD TABLE` is not itself idempotent — a second
-- run raises "table is already a member". Each add is therefore guarded
-- by a check against `pg_publication_tables`, and the publication itself
-- is created only if a project somehow lacks it (Supabase supplies it).
-- ============================================================

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
  tables text[] := array[
    'bookings',
    'booking_assignments',
    'chat_messages',
    'notifications',
    'professional_earnings',
    'support_messages'
  ];
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

comment on publication supabase_realtime is
  'Source tables for §27.1 channels: booking:{id}, offers:{proId},
   chat:{threadId}, ticket:{id}, me:{profileId}. Delivery only — RLS
   still decides which rows a subscriber may receive.';
