# SmartHelp — Roadmap

The phase list is the one in the build specification, §31.1, unchanged. This file
records which of those phases the repository has actually reached.

## Vision

A service marketplace for home services. Customers find a bookable service at
their address, see real slots, pay a fixed price, and track the job from booking
to completion. Professionals take jobs. Staff run the marketplace.

## Phases

| # | Phase | Scope | Exit criteria | Status |
|---|---|---|---|---|
| 0 | Foundation | Next.js scaffold, design tokens, `AuthContext`, roles, migrations 0001–0007, seed, buckets | Login works for every role; RLS verified; a professional and a service exist | done |
| 1 | Catalogue & availability | Public landing, catalogue, service detail, `GET /api/availability`, addresses, geolocation | Customer can find a bookable service at their address and see real slots | done |
| 2 | Booking & pricing | Quote engine, booking create, cancel/reschedule, coupons, invoice stub, `bookings` state machine | Bookings can be created and cancelled end-to-end with correct money maths | **complete** (payment consumption of the quote token is Phase 3) |
| 3 | Payments | Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation cron | Real money in, real money out; the webhook is the sole authority; RLS on payments | planned |
| 4 | Professional app | KYC upload, verification workflow, working hours, offers inbox, accept/decline, arrive, OTP, complete | A verified professional can take and complete a job | planned |
| 5 | Matching engine | Candidate ranking, offer fan-out, advisory locks, reassignment cascade, search sweeper | No double assignment under concurrency; exhausted search auto-refunds | planned |
| 6 | Admin console | Dashboard, bookings, KYC review, services, pricing, payments, coupons, disputes, support, audit, settings | Ops can run the marketplace without a database console | planned |
| 7 | Realtime & notifications | Channels, presence, chat, notification dispatcher, templates, reminders | Status updates land in under a second; every catalogue notification fires | planned |
| 8 | Growth & advanced | Recurring, wallet top-up, referrals, favourites, surge, invoices/PDF, PWA | Recurring generates idempotently; surge is capped; the PWA installs | planned |
| 9 | Hardening & launch | Security review, RLS audit, load test, accessibility pass, legal pages, runbook | Critical acceptance path green; no open P1/P2 security findings | planned |

## Phase status detail

### Phase 0 — Foundation (complete)

Built before the phase list was tracked. Migrations 0000–0007 and 0024–0027, the
email + password sign-in flows, the OTP ledger, the role/capability table, and
162 tests. See `README.md`.

### Phase 1 — Catalogue & availability (complete)

Plan: [`01-catalogue-availability/01-PLAN.md`](01-catalogue-availability/01-PLAN.md).

The catalogue schema was already in place from Phase 0 (0002–0007: cities,
localities, categories, services, tasks, images, keywords, service areas,
durations, and the seed). Phase 1 added the product surface on top:

- `addresses` (0008) and the locality resolution that turns a typed or geolocated
  address into the `(locality, service)` pair everything else gates on.
- The public endpoints: `/api/landing`, `/api/service-categories`,
  `/api/services`, `/api/services/[slug]`, `/api/availability`,
  `/api/availability/estimate`.
- Address CRUD for a signed-in customer.
- The three public pages: `/`, `/services`, `/services/[slug]`.
- `docs/DATABASE.md`, `docs/API.md`, `docs/FEATURES.md`, `docs/ARCHITECTURE.md`.

273 tests, 15 files. Two defects were found and fixed while closing the phase: a
client/server query-parameter mismatch that made the duration picker inert, and the
absence of any address-isolation test against a real database. See
[STATE.md](STATE.md).

### Deferrals from Phase 1

| Deferred | Why | Lands in |
|---|---|---|
| `block_address_delete_with_future_bookings()` | **Built.** It needed `bookings`, which now exists | — |
| `professional_schedule` overlap term in slot availability | §9.1 lists "not already reserved" as an input. The table is created with `bookings` | Phase 5 |
| Service-level aggregate rating on catalogue cards | `ratings` rows are written when a booking is reviewed | Phase 2 |
| Checkout and payment behind the service-detail CTA | `/customer/checkout` is Phase 2; the CTA routes to a real destination instead of a dead button | Phase 2 |
| `platform_settings` rows (`instant_lead_minutes`, `max_booking_minutes`) | Read from `lib/constants.ts` defaults until the table lands | Phase 6 |
