-- ============================================================
-- 0040_notification_templates_seed.sql
-- SmartHelp Phase 7: seed one template per (code, channel) in the
-- §27.5 notification catalogue, in `en-IN`.
--
-- Spec: §27.4 (dispatch), §27.5 (catalogue), §24.11.
-- Depends on: 0038 (notification_templates).
--
-- WHY SEEDED, AND WHY `DO NOTHING`
-- --------------------------------
-- The dispatcher (lib/notifications.ts) resolves a template row before
-- it can render anything, so an empty table means "every notification
-- silently does not fire" — the exact failure the phase's exit criteria
-- name. These rows are the reference set.
--
-- The conflict clause is `do nothing`, not `do update`: these are start
-- -of-life defaults, and an admin who edits a body in the §25.10 editor
-- must not have their wording overwritten the next time migrations run.
-- A locale with no row falls back to the built-in default in code, so a
-- new locale never blocks a notification.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

insert into public.notification_templates (code, channel, locale, subject, body, variables)
values
  -- Auth
  ('OTP_LOGIN', 'sms', 'en-IN', null,
   'Your SmartHelp verification code is {{code}}. It expires in {{minutes}} minutes. Do not share it with anyone.',
   array['code', 'minutes']),

  -- Booking lifecycle
  ('BOOKING_CONFIRMED', 'sms', 'en-IN', null,
   'Booking confirmed: {{serviceName}} on {{date}} at {{time}}. Ref {{bookingId}}.',
   array['serviceName', 'date', 'time', 'bookingId']),
  ('BOOKING_CONFIRMED', 'push', 'en-IN', 'Booking confirmed',
   'Your {{serviceName}} on {{date}} at {{time}} is confirmed. We are finding you a professional.',
   array['serviceName', 'date', 'time']),
  ('BOOKING_CONFIRMED', 'email', 'en-IN', 'Your SmartHelp booking is confirmed',
   'Hi {{customerName}},' || chr(10) || chr(10) ||
   'Your booking for {{serviceName}} on {{date}} at {{time}} is confirmed. Booking reference: {{bookingId}}.' || chr(10) || chr(10) ||
   'We will let you know the moment a professional is on the way.' || chr(10) || chr(10) ||
   '— SmartHelp',
   array['customerName', 'serviceName', 'date', 'time', 'bookingId']),

  ('PRO_ASSIGNED', 'push', 'en-IN', 'Professional assigned',
   '{{proName}} has taken your {{serviceName}} booking for {{date}} at {{time}}.',
   array['proName', 'serviceName', 'date', 'time']),
  ('PRO_ASSIGNED', 'sms', 'en-IN', null,
   '{{proName}} will handle your {{serviceName}} booking on {{date}} at {{time}}.',
   array['proName', 'serviceName', 'date', 'time']),

  ('PRO_ACCEPTED', 'push', 'en-IN', 'Professional accepted',
   '{{proName}} accepted your {{serviceName}} booking for {{date}} at {{time}}.',
   array['proName', 'serviceName', 'date', 'time']),
  ('PRO_ACCEPTED', 'sms', 'en-IN', null,
   '{{proName}} accepted your {{serviceName}} booking for {{date}} at {{time}}.',
   array['proName', 'serviceName', 'date', 'time']),

  ('PRO_ON_THE_WAY', 'push', 'en-IN', 'Professional on the way',
   '{{proName}} is on the way. Estimated arrival in {{etaMinutes}} minutes.',
   array['proName', 'etaMinutes']),
  ('PRO_ON_THE_WAY', 'sms', 'en-IN', null,
   '{{proName}} is on the way to your address. ETA about {{etaMinutes}} minutes.',
   array['proName', 'etaMinutes']),

  ('PRO_ARRIVED', 'push', 'en-IN', 'Professional arrived',
   '{{proName}} has arrived. Share the start OTP when you are ready.',
   array['proName']),

  -- Service execution
  ('SERVICE_STARTED', 'push', 'en-IN', 'Service started',
   '{{serviceName}} has started. Scheduled to end at {{endsAt}}.',
   array['serviceName', 'endsAt']),
  ('SERVICE_ENDING_SOON', 'push', 'en-IN', 'Service ending soon',
   'Your {{serviceName}} ends in about {{minutes}} minutes.',
   array['serviceName', 'minutes']),
  ('SERVICE_COMPLETED', 'push', 'en-IN', 'Service completed',
   '{{serviceName}} is complete. Amount: {{amount}}.',
   array['serviceName', 'amount']),
  ('SERVICE_COMPLETED', 'email', 'en-IN', 'Your SmartHelp service is complete',
   'Hi {{customerName}},' || chr(10) || chr(10) ||
   'Your {{serviceName}} is complete. Amount charged: {{amount}}.' || chr(10) || chr(10) ||
   'Thank you for using SmartHelp.' || chr(10) || chr(10) || '— SmartHelp',
   array['customerName', 'serviceName', 'amount']),

  ('EXTENSION_REQUESTED', 'push', 'en-IN', 'More time requested',
   '{{customerName}} has asked for {{minutes}} more minutes.',
   array['customerName', 'minutes']),
  ('EXTENSION_ACCEPTED', 'push', 'en-IN', 'Extension accepted',
   '{{proName}} approved an extra {{minutes}} minutes.',
   array['proName', 'minutes']),
  ('EXTENSION_DECLINED', 'push', 'en-IN', 'Extension declined',
   '{{proName}} could not extend the booking.',
   array['proName']),

  -- Cancellation and money
  ('BOOKING_CANCELLED', 'push', 'en-IN', 'Booking cancelled',
   'Your {{serviceName}} booking on {{date}} at {{time}} was cancelled. {{reason}}',
   array['serviceName', 'date', 'time', 'reason']),
  ('BOOKING_CANCELLED', 'sms', 'en-IN', null,
   'Your {{serviceName}} booking on {{date}} at {{time}} was cancelled. {{reason}}',
   array['serviceName', 'date', 'time', 'reason']),

  ('REFUND_PROCESSED', 'push', 'en-IN', 'Refund processed',
   '{{amount}} has been refunded to {{destination}}.',
   array['amount', 'destination']),
  ('REFUND_PROCESSED', 'sms', 'en-IN', null,
   '{{amount}} has been refunded to {{destination}}.',
   array['amount', 'destination']),
  ('REFUND_PROCESSED', 'email', 'en-IN', 'Your SmartHelp refund is on its way',
   'Hi {{customerName}},' || chr(10) || chr(10) ||
   'We have processed a refund of {{amount}} to {{destination}}. Bank timelines may add a few working days.' || chr(10) || chr(10) ||
   '— SmartHelp',
   array['customerName', 'amount', 'destination']),

  -- Professional side
  ('NEW_OFFER', 'push', 'en-IN', 'New job near you',
   '{{serviceName}} in {{locality}}. Payout {{payout}}. First to accept wins.',
   array['serviceName', 'locality', 'payout']),
  ('OFFER_EXPIRING', 'push', 'en-IN', 'Job offer expiring',
   'Your offer lapses in {{seconds}} seconds.',
   array['seconds']),
  ('NEW_JOB_REMINDER', 'push', 'en-IN', 'Job starting soon',
   '{{serviceName}} starts in {{minutes}} minutes.',
   array['serviceName', 'minutes']),
  ('EARNING_CREATED', 'push', 'en-IN', 'Earning available',
   '{{amount}} is now available in your earnings.',
   array['amount']),
  ('EARNING_CREATED', 'sms', 'en-IN', null,
   '{{amount}} has been added to your available earnings.',
   array['amount']),
  ('PAYOUT_SENT', 'push', 'en-IN', 'Payout sent',
   'A payout of {{amount}} is on its way. Reference {{reference}}.',
   array['amount', 'reference']),
  ('PAYOUT_SENT', 'sms', 'en-IN', null,
   'Payout of {{amount}} sent. Reference {{reference}}.',
   array['amount', 'reference']),

  ('KYC_APPROVED', 'push', 'en-IN', 'Verification approved',
   'Welcome aboard, {{proName}}. Your documents are verified.',
   array['proName']),
  ('KYC_APPROVED', 'email', 'en-IN', 'You are verified on SmartHelp',
   'Hi {{proName}},' || chr(10) || chr(10) ||
   'Your documents are verified. You can now accept jobs on SmartHelp.' || chr(10) || chr(10) ||
   '— SmartHelp',
   array['proName']),
  ('KYC_REJECTED', 'push', 'en-IN', 'Verification needs attention',
   '{{proName}}, a document was not accepted. Reason: {{reason}}.',
   array['proName', 'reason']),
  ('KYC_REJECTED', 'email', 'en-IN', 'Action needed on your SmartHelp verification',
   'Hi {{proName}},' || chr(10) || chr(10) ||
   'We could not verify your documents. Reason: {{reason}}. Please re-upload from your profile.' || chr(10) || chr(10) ||
   '— SmartHelp',
   array['proName', 'reason']),

  -- Support and safety
  ('TICKET_UPDATE', 'push', 'en-IN', 'Support update',
   'There is an update on your ticket: {{ticketSubject}}.',
   array['ticketSubject']),
  ('TICKET_UPDATE', 'email', 'en-IN', 'Update on your SmartHelp ticket',
   'Hi,' || chr(10) || chr(10) ||
   'There is a new update on your ticket "{{ticketSubject}}". Open SmartHelp to read it.' || chr(10) || chr(10) ||
   '— SmartHelp',
   array['ticketSubject']),
  ('SAFETY_ALERT', 'push', 'en-IN', 'Safety alert',
   'A safety incident was recorded. Reference {{reference}}.',
   array['reference']),
  ('SAFETY_ALERT', 'sms', 'en-IN', null,
   'Safety incident recorded on SmartHelp. Reference {{reference}}.',
   array['reference']),

  -- Ratings
  ('RATING_REMINDER', 'push', 'en-IN', 'How did it go?',
   'Rate your {{serviceName}} with {{proName}} — it takes a few seconds.',
   array['serviceName', 'proName'])
on conflict (code, channel, locale) do nothing;
