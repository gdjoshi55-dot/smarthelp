# Phase 7 — Realtime & notifications · Plan

**Status:** in progress.
**Exit criteria (§31.1):** *status updates land in under a second; every catalogue
notification fires.*
**Spec:** §27 (channels, presence, chat, dispatcher, polling fallback), §24.11
(`chat_threads` / `chat_messages` / `notification_templates` / `notifications`),
§24.16 (realtime publication), §25.9 (chat/notification endpoints), §25.11 (cron),
§25.10 (admin templates), §26.1 (auth), §31.1 Phase 7.

## What is already in place

- `profiles` (role/status), `customers`, `professionals`, `bookings`,
  `booking_assignments`, `professional_earnings`, `support_tickets` /
  `support_messages`, and the six storage buckets (including `chat-media`).
- The envelope (`handle`/`ok`/`created`/`ApiHttpError`), `requireAuth` /
  `requireCapability`, `lib/audit.ts`, the SMTP mailer inside `lib/otp.ts`, and the
  fail-closed cron guard in `app/api/cron/reconcile-payments/route.ts`.
- `ROLE_SECTIONS` already lists a `notifications` section for `admin` /
  `super_admin`; `ROLE_SECTIONS.customer` lists `support` and the profile page.

## What is missing

`chat_threads` / `chat_messages` / `notification_templates` / `notifications`, the
realtime publication, `lib/notifications.ts` (the dispatcher), the notification and
chat read models, the `/api/notifications`, `/api/chat/**` and admin-templates
routes, the two reminder crons, `hooks/use-realtime.ts`, and the UI (bell, list,
chat thread, templates editor).

## Decisions

### D1 — `in_app` and `email` are real channels; `sms`/`push`/`whatsapp` are recorded honestly (confidence: HIGH)

`.env.example` says it plainly: *"SMS is intentionally not configured."* There is
no FCM/APNs provider either. So:
- **`in_app`** — a `notifications` row plus the Realtime `me:{profileId}` insert
  (the browser's "push"). This is the channel the product actually uses today.
- **`email`** — Nodemailer over the existing `SMTP_*`, mirroring `deliverOtp`.
- **`push` / `sms` / `whatsapp`** — the rows are still written (the catalogue fires,
  the audit trail is complete), and the dispatcher attempts delivery through the
  generic `SMS_PROVIDER_URL` webhook when it is configured; with no provider it
  records `status='failed'` with `error='no provider configured'` rather than
  pretending. This is the same candour `.env.example` already keeps.

### D2 — Templates are rows, seeded for the whole catalogue (confidence: HIGH)

`notification_templates` (code, channel, locale, subject, body, variables) seeded
`en-IN` for every code in the §27.5 catalogue that is in scope. `render()` does
`{{token}}` substitution; email bodies are HTML-escaped before insertion. A missing
template is not fatal: `render()` falls back to a built-in default body so a
notification never silently vanishes.

### D3 — Chat is booking-scoped and its thread is created lazily (confidence: HIGH)

`chat_threads` is one-per-booking (`UNIQUE booking_id`). The thread is created on
first message or first read by a participant. Participants are the booking's
customer profile and the assigned professional's profile; an unassigned booking has
no chat yet. Staff may read a thread but only participants may post. System
messages (`kind='system'`) are written server-only.

### D4 — Realtime is an optimisation, never a dependency (confidence: HIGH)

Channels per §27.1 (`booking:{id}`, `pro:{id}` presence, `offers:{proId}`,
`chat:{threadId}`, `ticket:{id}`, `me:{profileId}`). RLS applies to Realtime exactly
as to REST. Polling fallbacks stay: `/api/bookings/:id/track` every 15 s, the offers
inbox every 5 s. `hooks/use-realtime.ts` is additive — removing it must not break a
screen.

### D5 — The reminder crons reuse the one cron guard and take an advisory lock (confidence: HIGH)

`/api/cron/service-reminders` (`*/15 * * * *`) and `/api/cron/rating-reminders`
(`13 19 * * *`) use the existing fail-closed `CRON_SECRET` guard, and each takes a
`pg_advisory_xact_lock` so a manual trigger cannot race the schedule. They dispatch
through the same `lib/notifications.ts` path as every other event.

### D6 — A `notification.manage` capability, held by admin (confidence: HIGH)

The template editor is admin-only. The capability table has no notification grant,
so one is added (`notification.manage`; `admin` holds it; `super_admin` by `'*'`).
`GET` templates is staff-readable; `PUT` requires the grant. Adding a capability is
additive and the wildcard already covers `super_admin`.

## Waves

### Wave A — schema, RLS, realtime publication, template seed

- **`0038_chat_notifications.sql`**: `chat_threads`, `chat_messages`,
  `notification_templates`, `notifications`, and `notification_devices` (backs
  `POST /api/notifications/push-token`, which §25.9 lists but §24.11 does not
  tabulate). Enums/checks per §24.11, indexes, `touch_updated_at` triggers, RLS
  (participant/recipient reads, staff reads, service-role writes), grants.
- **`0039_realtime_publication.sql`**: add `bookings`, `booking_assignments`,
  `chat_messages`, `notifications`, `professional_earnings`, `support_messages` to
  `supabase_realtime` — idempotently (guard against already-added).
- **`0040_notification_templates_seed.sql`**: seed the catalogue.

### Wave B — the app mirror

- **`lib/notifications.ts`**: the catalogue (`NotificationCode`), `render()`,
  `dispatch()` (writes `queued` rows, delivers in_app/email, records
  sent/failed), `notify()` convenience, `escapeHtml`.
- **`lib/notificationServer.ts`**: `listNotifications`, `unreadCount`,
  `markRead`, `registerDevice`, `listTemplates`, `upsertTemplate`.
- **`lib/chatServer.ts`**: `getOrCreateThread`, `getThread`, `listMessages`,
  `postMessage`, participant/authority checks.

### Wave C — endpoints and wiring

- `GET /api/notifications`, `POST /api/notifications/:id/read`,
  `POST /api/notifications/push-token`.
- `GET /api/bookings/:id/chat`, `GET|POST /api/chat/threads/:id/messages`.
- `GET /api/admin/notification-templates`, `PUT /api/admin/notification-templates/:id`.
- Wire `dispatch()` into the existing flows that §27.5 names and the code already
  owns: booking paid → `BOOKING_CONFIRMED`; accept → `PRO_ACCEPTED`; arrive →
  `PRO_ARRIVED`; start → `SERVICE_STARTED`; complete → `SERVICE_COMPLETED`;
  cancel → `BOOKING_CANCELLED`; refund executed → `REFUND_PROCESSED`; KYC decision
  → `KYC_APPROVED`/`KYC_REJECTED`; new offer → `NEW_OFFER`.

### Wave D — reminder crons

- `/api/cron/service-reminders` — "starting soon" / "ending soon" / "on the way".
- `/api/cron/rating-reminders` — nudge customers for today's completed bookings.
- `vercel.json` gains the two schedules.

### Wave E — UI

- `hooks/use-realtime.ts` (`useBookingChannel`, `useProPresence`, `useNotifications`).
- `components/notifications/NotificationBell.tsx`, `NotificationList.tsx`.
- `components/chat/ChatThread.tsx` + `ChatBubble.tsx`.
- `app/admin/notifications/page.tsx` (template editor).

### Wave F — docs and the phase gate

- `docs/API.md` §4.9 (notifications/chat/admin templates) + §5 cron + §4.8 note,
  `docs/FEATURES.md` §9, `docs/DATABASE.md` §15, `README.md` "at Phase 7".
- Tiered gate: typecheck / lint / build → `npm test` → `npm run test:db` → §27
  hand-check → `07-SUMMARY.md`, `STATE.md`, `ROADMAP.md`.

## Deferred (recorded, not forgotten)

| Deferred | Why | Lands in |
|---|---|---|
| A real SMS/WhatsApp provider, FCM/APNs push | No provider configured; `.env.example` says so | later / ops |
| Live-tracking map + ETA computation (§27.1 `pro:{id}` lat/lng) | Phase 15 (Snabbit parity) | Phase 15 |
| SOS / `sos_incidents` and referrals | §31.1 puts them in Phase 8 (growth) | Phase 8 |
| Recurring plan notifications | Recurring is Phase 8 | Phase 8 |
| Chat media upload UI | `chat-media` bucket exists; the picker is UI polish | later wave |

## Deliberately out of scope

Referrals and SOS tables (§22/§24.12 — Phase 8), the payout dispatcher (Phase 8),
and any external push transport. **No new npm package; Realtime uses the existing
`@supabase/supabase-js`; email uses the existing `nodemailer`.**
