-- 0041_reminder_crons.sql — the two §25.11 reminder passes (Phase 7, Wave D).
--
-- `/api/cron/service-reminders` (`*/15 * * * *`) and
-- `/api/cron/rating-reminders` (`13 19 * * *`) nudge people about bookings that
-- are about to start, about to end, or have just finished. Every code they
-- emit is a *Realtime-only* notification: `SERVICE_ENDING_SOON`,
-- `NEW_JOB_REMINDER` and `RATING_REMINDER` all fan out to `['in_app','push']`
-- (§27.5, `lib/notifications.ts`), and for those two channels *writing the row
-- is the delivery* — a subscribed browser receives it on `me:{profileId}`.
--
-- That is what lets the whole pass live here in one transaction:
--
--   * the `pg_advisory_xact_lock` (§28.1 "Cron overlap") is real mutual
--     exclusion rather than a lock held for a single pooled statement, because
--     the lock, the scan, the idempotency guard and the inserts are one
--     transaction;
--   * the idempotency guard (`not exists` a notification for the same code and
--     booking) is evaluated under that lock, so two overlapping passes cannot
--     both claim the same booking.
--
-- The event-driven notifications (`BOOKING_CONFIRMED`, `PRO_ACCEPTED`, …) still
-- go through `dispatch()` in `lib/notifications.ts`, which remains the single
-- writer for those. A reminder is the one class that is claimed atomically in
-- the database, because it has no email/SMS transport to call from Node and so
-- nothing that needs the dispatcher's per-channel error handling.
--
-- This is a documented narrowing of §27.4: the dispatcher's rendering logic is
-- mirrored here in the same `{{token}}` shape for the very small set of tokens
-- these three templates use (`serviceName`, `minutes`, `proName`).

-- ── service-reminders ──────────────────────────────────────
--
-- Two codes, both addressed to the professional on the job:
--   SERVICE_ENDING_SOON — an `in_progress` job whose `ends_at` is within 15 min.
--   NEW_JOB_REMINDER    — a job starting within 60 min (the "60 minute" nudge)
--                         and, separately, within 15 min (the "15 minute"
--                         nudge). The two windows are disjoint (the 60-minute
--                         window opens *after* 15 min remaining and closes at
--                         60), so a booking is reminded at most twice, once per
--                         window, and the second window is only ever reached if
--                         the first was not — a cron that missed the 60-minute
--                         pass still nudges at 15.
create or replace function public.run_service_reminders()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_booking    record;
  v_recipient  uuid;
  v_service    text;
  v_minutes    int;
  v_title      text;
  v_body       text;
  v_payload    jsonb;
  v_sent       int := 0;
begin
  -- §28.1: serialise against a manual trigger racing the schedule.
  perform pg_advisory_xact_lock(hashtext('cron:service-reminders')::bigint);

  -- ── SERVICE_ENDING_SOON (to the professional) ─────────────
  for v_booking in
    select b.id, b.professional_id, b.ends_at
      from public.bookings b
     where b.status = 'in_progress'
       and b.ends_at is not null
       and b.ends_at between now() and now() + interval '15 minutes'
       and not exists (
             select 1 from public.notifications n
              where n.template_code = 'SERVICE_ENDING_SOON'
                and n.booking_id = b.id
           )
  loop
    select p.profile_id into v_recipient
      from public.professionals p where p.id = v_booking.professional_id;
    if v_recipient is null then continue; end if;

    select coalesce(
             (select bi.service_name from public.booking_items bi
               where bi.booking_id = v_booking.id
               order by bi.created_at limit 1),
             'your service')
      into v_service;

    v_minutes := greatest(0, round(extract(epoch from (v_booking.ends_at - now())) / 60)::int);
    v_payload := jsonb_build_object('serviceName', v_service, 'minutes', v_minutes);

    select t.subject, t.body into v_title, v_body
      from public.notification_templates t
     where t.code = 'SERVICE_ENDING_SOON'
       and t.channel = 'push'
       and t.locale = 'en-IN'
       and t.is_active
     limit 1;
    v_body := replace(replace(coalesce(v_body, 'Service ending soon'),
                 '{{serviceName}}', v_service), '{{minutes}}', v_minutes::text);

    insert into public.notifications
      (recipient_id, channel, template_code, payload, title, body, status, booking_id, sent_at)
    select v_recipient, ch, 'SERVICE_ENDING_SOON', v_payload, v_title, v_body,
           'sent', v_booking.id, now()
      from unnest(array['in_app', 'push']::public.notification_channel[]) as ch;
    v_sent := v_sent + 1;
  end loop;

  -- ── NEW_JOB_REMINDER (to the professional) ────────────────
  for v_booking in
    select b.id, b.professional_id, b.scheduled_start_at,
           case when b.scheduled_start_at > now() + interval '15 minutes'
                then 60 else 15 end as window_minutes
      from public.bookings b
     where b.status in ('assigned', 'on_the_way', 'arrived')
       and b.scheduled_start_at is not null
       and b.scheduled_start_at between now() and now() + interval '60 minutes'
       and not exists (
             select 1 from public.notifications n
              where n.template_code = 'NEW_JOB_REMINDER'
                and n.booking_id = b.id
                and (n.payload ->> 'window') = (case
                      when b.scheduled_start_at > now() + interval '15 minutes'
                      then '60' else '15' end)
           )
  loop
    select p.profile_id into v_recipient
      from public.professionals p where p.id = v_booking.professional_id;
    if v_recipient is null then continue; end if;

    select coalesce(
             (select bi.service_name from public.booking_items bi
               where bi.booking_id = v_booking.id
               order by bi.created_at limit 1),
             'your service')
      into v_service;

    v_minutes := v_booking.window_minutes;
    v_payload := jsonb_build_object(
      'serviceName', v_service, 'minutes', v_minutes, 'window', v_minutes::text);

    select t.subject, t.body into v_title, v_body
      from public.notification_templates t
     where t.code = 'NEW_JOB_REMINDER'
       and t.channel = 'push'
       and t.locale = 'en-IN'
       and t.is_active
     limit 1;
    v_body := replace(replace(coalesce(v_body, 'Job starting soon'),
                 '{{serviceName}}', v_service), '{{minutes}}', v_minutes::text);

    insert into public.notifications
      (recipient_id, channel, template_code, payload, title, body, status, booking_id, sent_at)
    select v_recipient, ch, 'NEW_JOB_REMINDER', v_payload, v_title, v_body,
           'sent', v_booking.id, now()
      from unnest(array['in_app', 'push']::public.notification_channel[]) as ch;
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('sent', v_sent);
end $$;

comment on function public.run_service_reminders() is
  'The */15 reminder pass (§25.11): SERVICE_ENDING_SOON and NEW_JOB_REMINDER,
   addressed to the professional. Takes pg_advisory_xact_lock and is idempotent
   per (code, booking) — and per window for NEW_JOB_REMINDER — so overlapping
   passes cannot double-notify. Returns {sent: n}.';

-- ── rating-reminders ───────────────────────────────────────
--
-- RATING_REMINDER, addressed to the customer, for every booking that reached
-- `completed` today (Asia/Kolkata) and has not been rated. One nudge per
-- booking, guarded exactly like the service pass.
create or replace function public.run_rating_reminders()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_booking    record;
  v_recipient  uuid;
  v_service    text;
  v_pro_name   text;
  v_title      text;
  v_body       text;
  v_payload    jsonb;
  v_sent       int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('cron:rating-reminders')::bigint);

  for v_booking in
    select b.id, b.customer_id, b.professional_id
      from public.bookings b
     where b.status = 'completed'
       and b.completed_at is not null
       and (b.completed_at at time zone 'Asia/Kolkata')::date
           = (now() at time zone 'Asia/Kolkata')::date
       and not exists (
             select 1 from public.notifications n
              where n.template_code = 'RATING_REMINDER'
                and n.booking_id = b.id
           )
  loop
    select c.profile_id into v_recipient
      from public.customers c where c.id = v_booking.customer_id;
    if v_recipient is null then continue; end if;

    select coalesce(
             (select bi.service_name from public.booking_items bi
               where bi.booking_id = v_booking.id
               order by bi.created_at limit 1),
             'your service')
      into v_service;

    select p.full_name into v_pro_name
      from public.professionals pr
      join public.profiles p on p.id = pr.profile_id
     where pr.id = v_booking.professional_id;
    v_pro_name := coalesce(v_pro_name, 'your professional');

    v_payload := jsonb_build_object('serviceName', v_service, 'proName', v_pro_name);

    select t.subject, t.body into v_title, v_body
      from public.notification_templates t
     where t.code = 'RATING_REMINDER'
       and t.channel = 'push'
       and t.locale = 'en-IN'
       and t.is_active
     limit 1;
    v_body := replace(replace(coalesce(v_body, 'How did it go?'),
                 '{{serviceName}}', v_service), '{{proName}}', v_pro_name);

    insert into public.notifications
      (recipient_id, channel, template_code, payload, title, body, status, booking_id, sent_at)
    select v_recipient, ch, 'RATING_REMINDER', v_payload, v_title, v_body,
           'sent', v_booking.id, now()
      from unnest(array['in_app', 'push']::public.notification_channel[]) as ch;
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('sent', v_sent);
end $$;

comment on function public.run_rating_reminders() is
  'The 19:13 reminder pass (§25.11): RATING_REMINDER to the customer of every
   booking completed today. Takes pg_advisory_xact_lock and is idempotent per
   booking. Returns {sent: n}.';

-- ── Grants ─────────────────────────────────────────────────
-- security definer: the EXECUTE grant belongs to the caller. These write
-- notification rows, so anon and authenticated get nothing; only the service
-- role (the cron Route Handlers) may call them.
revoke all on function public.run_service_reminders() from public, anon, authenticated;
revoke all on function public.run_rating_reminders() from public, anon, authenticated;
grant execute on function public.run_service_reminders() to service_role;
grant execute on function public.run_rating_reminders() to service_role;
