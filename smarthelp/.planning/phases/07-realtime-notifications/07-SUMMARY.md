---
phase: 07-realtime-notifications
type: summary
date: 2026-10-14
status: complete
spec: §24.11, §24.16, §25.9, §25.10, §25.11, §27, §31.1 Phase 7
---

# Phase 7 — Realtime & notifications: summary

**Complete as of 2026-10-14.** Migrations `0038`–`0041` built and applied to the live
project (38 files, **39 applied, 0 outstanding**), the channels, chat, bell,
dispatcher, template editor and two reminder crons landed, and §31.1's exit criterion —
*status updates land in under a second; every catalogue notification fires* — is
hand-checked. The suite is **1030 tests across 67 files** (the floor when the phase
began: 954 / 61), `npm run test:db` is green across all ten live files (**117 tests**,
floor 104 / 9), and typecheck, lint and build exit 0.

## The migrations

Four migrations, in the order the ledger applies them:

- **`0038_chat_notifications.sql`** (D2, D3). The enum `notification_channel`
  (`in_app`/`push`/`email`/`sms`/`whatsapp`) and five tables: `chat_threads`
  (`booking_id` unique — one thread per booking), `chat_messages`
  (`kind` text/image/system, `body`, `image_path`, `read_at`),
  `notification_templates` (`(code, channel, locale)` unique, `subject`, `body`,
  `variables`, `is_active`), `notifications` (`recipient_id`, `channel`,
  `template_code`, `payload`, `title`/`body`, `status` queued/sent/failed/read,
  `error`, `booking_id`, `read_at`; indexes for the bell, the not-sent scan and
  per-booking history), and `notification_devices` (`(profile_id, token)` unique).
  Every table carries `touch_updated_at` where it has one and the tight RLS this
  project keeps drawing: **reads** recipient-/participant-scoped with a staff
  backstop, **writes** service-role only — `authenticated` gets `SELECT` and nothing
  else, `anon` gets no grant at all.
- **`0039_realtime_publication.sql`** (D4, §24.16, §27.1). Adds the six §27.1 source
  tables to `supabase_realtime` — `bookings`, `booking_assignments`, `chat_messages`,
  `notifications`, `professional_earnings`, `support_messages` — each behind a
  `pg_publication_tables` guard, because `ALTER PUBLICATION … ADD TABLE` is not
  idempotent. Realtime applies the same SELECT policies as REST, so this widens
  *delivery*, never *visibility*.
- **`0040_notification_templates_seed.sql`** (D2). 39 rows over `push`/`email`/`sms`
  at locale `en-IN`, `on conflict (code, channel, locale) do nothing`, covering all
  24 catalogue codes. **There are no `in_app` rows** — the dispatcher renders an
  `in_app` message from the `push` template, so every code gets a bell item without a
  duplicate seed (a live-DB test pins this invariant).
- **`0041_reminder_crons.sql`** (D5). `run_service_reminders()` and
  `run_rating_reminders()`, both `security definer set search_path = public`, both
  taking `pg_advisory_xact_lock(hashtext('cron:…')::bigint)` first, both returning
  `jsonb { sent }`, both **revoked from public/anon/authenticated and granted to
  `service_role` only**.

## The surface

- **`lib/notifications.ts` — the dispatcher, and the only writer of notification
  rows** (D1). `dispatch()` renders each channel's template, attempts delivery, and
  writes one row per channel in its final status; `notify()` is the fire-and-forget
  wrapper. It never throws (§28.4): a booking confirms whether or not the mail server
  is up, and a failed delivery is a `failed` row with a reason, not a silent drop.
  `render()` does `{{token}}` substitution, HTML-escaping email bodies, and falls back
  to a humanised code when a template is missing so a message never vanishes.
- **`lib/notificationServer.ts` / `lib/chatServer.ts`** — the bell/device/template
  model and the chat model (thread creation, participant checks, message posting).
- **`lib/notificationHooks.ts`** — the bridge from a booking event to the catalogue.
  One function per event, each wrapped in `quiet()` and calling `notify()`; a broken
  notification can never change the outcome of the action that fired it.
- **`lib/cronGuard.ts`** — the fail-closed `CRON_SECRET` check, now shared by all
  three crons (`reconcile-payments` refactored onto it, plus the two new ones).
- **Eight endpoints**: `GET /api/notifications`, `POST /api/notifications/[id]/read`,
  `POST /api/notifications/read-all` (documented addition), `POST|DELETE
  /api/notifications/push-token`, `GET /api/bookings/[id]/chat`,
  `GET|POST /api/chat/threads/[id]/messages`, `GET /api/admin/notification-templates`,
  `PUT /api/admin/notification-templates/[id]`.
- **The UI**: `hooks/use-realtime.ts` (`useBookingChannel`, `useProPresence`,
  `useNotifications`, `useChatChannel`), `components/notifications/{NotificationBell,
  NotificationList}.tsx`, `components/chat/{ChatThread,ChatBubble}.tsx`, and the
  template editor at `app/admin/notifications/page.tsx`. The bell mounts in
  `RoleShell` for every role.
- **`notification.manage`** — a new capability (`ALL_CAPABILITIES` +
  `CAPABILITIES.admin`), held by `admin`/`super_admin` only (D6). `ROLE_SECTIONS`
  already listed the `notifications` section; it now has a href.

## The gate

| Gate | Result |
|---|---|
| Migration gate | `0038`–`0041` applied to the live project — 38 files, **39 applied, 0 outstanding** |
| Exit criterion — status updates < 1 s; every catalogue notification fires | **hand-checked** (below) |
| Tier-4 chain | typecheck / lint / build exit 0 → `npm test` **1030 / 67 files, 0 failed** (floor 954 / 61) → `test:db` **117 / 10 files** (floor 104 / 9) → no code commits |
| Floors | Phase 6 landed at 954 / 104; Phase 7 lands at **1030 / 117** — 76 full-suite and 13 db tests above it |

### The one-second exit criterion, and the catalogue hand-check

**"Under a second" is a delivery property, and the phase is honest about which path
delivers it.** A `notifications` insert and a `chat_messages` insert each fire their
`me:{profileId}` / `chat:{threadId}` channel inside the request that writes the row,
so a subscribed browser sees the change with no poll in between. The **polling
floor** is 15 s (bell, chat, booking track) and 5 s (offers inbox) — so the worst
case when Realtime is unavailable is bounded and the product still works (D4). Both
halves are wired; neither is the only one.

**Every catalogue notification that has a trigger fires.** The dispatcher supports
all 24 §27.5 codes (each has a channel plan and seeded templates, asserted in
`test/notifications.test.ts`). Sixteen fire from a live trigger:

| Code | Trigger |
|---|---|
| `BOOKING_CONFIRMED` | payment verify, webhook, reconcile |
| `PRO_ACCEPTED` | offer accept |
| `PRO_ON_THE_WAY` | job on-the-way |
| `PRO_ARRIVED` | job arrive |
| `SERVICE_STARTED` | service OTP verified |
| `SERVICE_COMPLETED`, `EARNING_CREATED` | job complete (customer + pro) |
| `BOOKING_CANCELLED` | cancel (both parties) |
| `REFUND_PROCESSED` | admin refund execute |
| `NEW_OFFER` | matching fan-out (`onOffered`) |
| `KYC_APPROVED` / `KYC_REJECTED` | staff KYC decision |
| `TICKET_UPDATE` | support reply (non-internal) |
| `SERVICE_ENDING_SOON`, `NEW_JOB_REMINDER` | `run_service_reminders()` |
| `RATING_REMINDER` | `run_rating_reminders()` |

The remaining eight are **catalogue-only because their feature is not built** — they
are scoped out by D2, not forgotten, and the dispatcher is ready for them:
`PRO_ASSIGNED` (admin assign still leaves the offer for the pro to accept, so
`PRO_ACCEPTED` is the outcome the customer hears), `EXTENSION_REQUESTED` /
`EXTENSION_ACCEPTED` / `EXTENSION_DECLINED` (extensions not built),
`OFFER_EXPIRING` (no expiry countdown cron), `PAYOUT_SENT` (Phase 8),
`SAFETY_ALERT` (SOS, Phase 8), and `OTP_LOGIN` (SMS-only; phone OTP is unused and SMS
is intentionally unconfigured).

## The decisions, with reasons

Stated in full in `07-PLAN.md` (D1–D6).

- **D1 — `in_app` and `push` are real; `email` degrades honestly; `sms`/`whatsapp`
  are recorded.** `in_app`/`push` are `sent` because writing the row *is* the
  delivery. `email` is `failed` ("SMTP is not configured") with no `SMTP_*`; `sms`
  and `whatsapp` are `failed` ("no SMS provider configured"). The row says what
  happened, so no screen can claim a customer was told when the data disagrees.
- **D2 — templates are rows, seeded for the in-scope catalogue, with a fallback.**
  A message the catalogue can name always renders; a missing template is a humanised
  default, never a vanished notification. No `in_app` seed rows (rendered from
  `push`).
- **D3 — chat is booking-scoped and its thread is created lazily.** One thread per
  booking, only for a booking with both participants; participants read and post,
  staff read only; a stranger gets the same 404 as a booking that does not exist.
  Send is non-optimistic: await the server, then re-read.
- **D4 — Realtime is an optimisation, never a dependency.** Polling stays the
  baseline; a pushed signal triggers a re-fetch through a Route Handler rather than
  being trusted. Removing `hooks/use-realtime.ts` must not break a screen.
- **D5 — the reminder crons reuse the one guard and lock.** Both share
  `assertCronSecret` (fail-closed: unset secret is a 503, never an open run) and run
  the whole pass — advisory lock, idempotency guard, inserts — in one SQL
  transaction, because for a Realtime-only code the row *is* the delivery.
- **D6 — `notification.manage`, held by admin.** A template is what every customer
  reads, the same class of change as a role grant; adding a capability is additive
  and `super_admin` holds `'*'`.

## Deviations, with reasons

- **`read-all` is a documented addition.** §25.9 names only the per-id read; clearing
  a badge one request per row is a demo-only design, so `POST
  /api/notifications/read-all` complements it. Documented in `docs/API.md` §4.9.
- **`notification_devices` / the push-token route is a documented addition.** §25.9
  lists the endpoint but §24.11 has no table for the token, so `0038` adds one.
- **Hooks beyond the plan's list.** Wave C named nine events; the phase wires three
  more that the routes already own — `PRO_ON_THE_WAY`, `EARNING_CREATED` (with
  `SERVICE_COMPLETED`) and `TICKET_UPDATE`. `new offer` was wired through a new
  optional `onOffered` seam in `lib/matchingServer.ts`, so the engine stays unaware of
  notifications and its fake-database tests still pass.
- **The plan's "§5 cron" note was misplaced.** `docs/API.md` §5 is Idempotency; the
  cron reference lives in §4.5 (reconcile) and the new §4.9 (reminders). The docs
  were written to where the content belongs, not to the note.
- **`vercel.json` reconciles at `0 3 * * *`, not the spec's `*/30`.** The Phase 3
  decision stands; the two new schedules are `*/15` and `13 19 * * *`.
- **No source, test, migration or config file was committed by this phase.** The code
  working tree remains uncommitted for the branch owner.

## Deferred (recorded, not forgotten)

| Deferred | Why | Lands in |
|---|---|---|
| A real SMS/WhatsApp provider, FCM/APNs push | No provider configured; `.env.example` says so | later / ops |
| Live-tracking map + ETA computation (`pro:{id}` lat/lng) | §27.1 presence carries it; the surface is Snabbit parity | Phase 15 |
| SOS / `sos_incidents` (`SAFETY_ALERT`) | §31.1 puts it in growth | Phase 8 |
| `PAYOUT_SENT`, the payout dispatcher | Payouts are Phase 8 | Phase 8 |
| Recurring-plan notifications | Recurring is Phase 8 | Phase 8 |
| Extensions (`EXTENSION_*`) and `OFFER_EXPIRING` | The features and the expiry countdown are unbuilt | later wave |
| Chat media upload UI | `chat-media` bucket exists; the picker is polish | later wave |
| Analytics report pages | Deferred with Phase 6 reporting | Phase 8 |

## Deliberately out of scope

Referrals and SOS tables (§22/§24.12 — Phase 8), the payout dispatcher (Phase 8), and
any external push transport. **No new npm package** — Realtime uses the existing
`@supabase/supabase-js` and email uses the existing `nodemailer`.
