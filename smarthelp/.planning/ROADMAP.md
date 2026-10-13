# SmartHelp — Roadmap

The phase list is the one in the build specification, §31.1, unchanged. This file
records which of those phases the repository has actually reached.

## Vision

A service marketplace for home services. Customers find a bookable service at
their address, see real slots, pay a fixed price, and track the job from booking
to completion. Professionals take jobs. Staff run the marketplace.

From milestone v2.0 the product moves toward Snabbit's on-demand shape: instant
booking with auto-dispatch, an in-house trained Expert workforce, curated
verticals (House Help / Home Cook / Home Salon), hourly pricing from a low base,
service packs, recurring plans, live arrival tracking and a trust/refund
guarantee. The product remains a **web app** with email + password + emailed-OTP
auth, and safety features are out of scope for now. See
[Milestone v2.0 — Snabbit parity](#milestone-v20--snabbit-parity).

## Phases

| # | Phase | Scope | Exit criteria | Status |
|---|---|---|---|---|
| 0 | Foundation | Next.js scaffold, design tokens, `AuthContext`, roles, migrations 0001–0007, seed, buckets | Login works for every role; RLS verified; a professional and a service exist | done |
| 1 | Catalogue & availability | Public landing, catalogue, service detail, `GET /api/availability`, addresses, geolocation | Customer can find a bookable service at their address and see real slots | done |
| 2 | Booking & pricing | Quote engine, booking create, cancel/reschedule, coupons, invoice stub, `bookings` state machine | Bookings can be created and cancelled end-to-end with correct money maths | done |
| 3 | Payments | Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation cron | Real money in, real money out; the webhook is the sole authority; RLS on payments | **complete** (03-SUMMARY.md records the gates) |
| 4 | Professional app | KYC upload, verification workflow, working hours, offers inbox, accept/decline, arrive, OTP, complete | A verified professional can take and complete a job | **complete** (04-SUMMARY.md records the gates) |
| 5 | Matching engine | Candidate ranking, offer fan-out, advisory locks, reassignment cascade, search sweeper | No double assignment under concurrency; exhausted search auto-refunds | **complete** (05-SUMMARY.md records the gates) |
| 6 | Admin console | Dashboard, bookings, KYC review, services, pricing, payments, coupons, disputes, support, audit, settings | Ops can run the marketplace without a database console | planned |
| 7 | Realtime & notifications | Channels, presence, chat, notification dispatcher, templates, reminders | Status updates land in under a second; every catalogue notification fires | planned |
| 8 | Growth & advanced | Recurring, wallet top-up, referrals, favourites, surge, invoices/PDF, PWA | Recurring generates idempotently; surge is capped; the PWA installs | planned |
| 9 | Hardening & launch | Security review, RLS audit, load test, accessibility pass, legal pages, runbook | Critical acceptance path green; no open P1/P2 security findings | planned |

### Milestone v2.0 — Snabbit parity

The phases below align SmartHelp with Snabbit's product shape: instant on-demand
home help, a managed (in-house trained) Expert workforce, curated verticals
(House Help / Home Cook / Home Salon), hourly pricing from a low base, service
packs, recurring plans, live arrival tracking and a trust/refund guarantee.

**Explicitly out of scope for this milestone** (decided): the web app stays a web
app (no native iOS/Android build), and the existing email + password + emailed-OTP
authentication stays as-is (no phone-first login). Safety features (Kavach, SOS,
Safety Circle) are deferred and not built yet.

| # | Phase | Scope | Exit criteria | Status |
|---|---|---|---|---|
| 10 | Instant booking & dispatch | `instant` booking type, "book now" availability path, auto-assign nearest available Expert, ETA estimate, instant path bypasses the offers inbox | A customer books "now" and an Expert is auto-assigned with an arrival ETA, with no manual accept step | planned |
| 11 | Managed Expert model | In-house Expert onboarding, training-program records, 2-day conduct/safety curriculum, uniform/identity, quality scoring, uniform job standards | Every Expert is platform-trained and verified before their first booking; no open marketplace bidding for standard jobs | planned |
| 12 | Vertical catalogue & task bundles | House Help, Home Cook, Home Salon verticals; task bundles and multi-task single booking | A customer books several tasks under one vertical in one booking | planned |
| 13 | Hourly pricing, packs & surge | Hourly rate from a low base (₹99/hr), 30 min–4 hr durations, capped surge, prepaid service packs, no lock-ins, upfront price | Price is shown upfront as ₹/hr; packs are redeemable; surge is capped and disclosed | planned |
| 14 | Recurring & preferred Expert | Weekly/daily recurring plans, preferred-Expert pinning, idempotent plan-generated bookings | A recurring plan generates bookings idempotently and pins the same Expert where available | planned |
| 15 | Live tracking & trust | Expert en-route map/ETA, arrival OTP, ratings surfaced as trust badges, 3-hour refund guarantee, late/no-show policy | Customer watches the Expert arrive; the refund SLA and late policy are enforced | planned |

#### How the Snabbit phases relate to Phases 5–9

| Existing phase | Overlap with Snabbit parity |
|---|---|
| 5 — Matching engine | **Built** — the dispatch substrate for Phase 10 (ranking, advisory locks, reassignment, the sweeper). Phase 10 adds the *instant* entry path and auto-assign on top of it. |
| 7 — Realtime & notifications | Provides the transport for Phase 15's live tracking; Phase 15 adds the map/ETA surface and the arrival ETA computation. |
| 8 — Growth & advanced | Its recurring, surge and PWA bullets are superseded by Phases 13–14 (recurring, surge). Phase 8 keeps referrals, favourites, wallet top-up, invoice PDF; PWA remains optional and does **not** replace the web-app decision. |
| 9 — Hardening & launch | Unchanged; runs after the Snabbit-parity phases for the v2.0 launch. |

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
| `professional_schedule` overlap term in slot availability | §9.1 lists "not already reserved" as an input. The table is created with `bookings`; Phase 5's `rank_candidates` reads it for the *offer* path, but the customer-facing slot list (`lib/availability.ts`) still ignores it | a later Phase 5 wave |
| Service-level aggregate rating on catalogue cards | `ratings` rows are written when a booking is reviewed | Phase 2 |
| Checkout and payment behind the service-detail CTA | `/customer/checkout` is Phase 2; the CTA routes to a real destination instead of a dead button | Phase 2 |
| `platform_settings` rows (`instant_lead_minutes`, `max_booking_minutes`) | Read from `lib/constants.ts` defaults until the table lands | Phase 6 |

### Snabbit-parity phase detail

Each phase below lands on the existing foundations (booking state machine, slot
engine, payments/refunds/wallet, KYC, ratings, geo/serviceability) rather than a
rewrite. Where the existing data model already supports the capability, the phase
adds the product surface and the rules on top.

#### Phase 10 — Instant booking & dispatch

- Add an `instant` `booking_type` and a "book now" path that resolves the *next
  available* slot rather than the customer choosing a slot from the slot grid.
- `lib/availability.ts` gains an "instant" evaluator over the same input set;
  dispatch reuses Phase 5's ranking/fan-out instead of the manual offers inbox.
- Auto-assign the nearest available Expert for instant bookings; fall back to the
  offers inbox only when no Expert can be auto-assigned.
- ETA estimate stored on the booking and surfaced to the customer.

#### Phase 11 — Managed Expert model

- The professional lifecycle becomes an in-house one: onboarding, training
  completion (the 2-day conduct/safety program), and a `training_status` gate
  that blocks first booking until complete (the column already exists).
- Training records and uniform/identity as first-class fields; `public_professionals`
  reflects managed Experts, not an open applicant pool.
- Quality scoring feeds candidate ranking; standard jobs are assigned, not bid for.

#### Phase 12 — Vertical catalogue & task bundles

- Group `service_categories` into the three verticals: House Help, Home Cook,
  Home Salon (the last flagged coming-soon).
- Task bundles model "multiple tasks in one booking" using the existing
  `booking_items` and `service_tasks`.
- Catalogue and service-detail surfaces present the vertical framing.

#### Phase 13 — Hourly pricing, packs & surge

- Hourly display and billing from a low base, reusing `lib/money.ts` /
  `lib/pricing.ts`; the 30 min–4 hr duration range comes from `service_durations`.
- Surge as a capped multiplier with disclosure, written into `pricing_snapshot`.
- Prepaid service packs as a wallet-adjacent credit instrument (ledgered, not a
  counter), redeemable against bookings; no lock-ins.

#### Phase 14 — Recurring & preferred Expert

- Recurring plans (weekly/daily) that generate bookings idempotently, reusing the
  existing idempotency-key machinery.
- Preferred-Expert pinning: a plan attempts to assign the same Expert, falling
  back per Phase 10's dispatch rules.

#### Phase 15 — Live tracking & trust

- Expert en-route ETA on top of Phase 7's realtime channels; arrival OTP already
  exists (`service_otp`).
- Ratings (already modelled, with sub-scores) surfaced as trust badges on
  catalogue and Expert cards.
- A 3-hour refund guarantee for no-show / >30 min late / shortfall, and a
  late/no-show policy, expressed through the existing refund API and booking
  status machine.

#### Deferred from Snabbit parity

| Deferred | Why | Lands in |
|---|---|---|
| Native iOS/Android app | Decided: the product stays a web app | — (out of scope) |
| Phone-first OTP login | Decided: existing email + password + emailed OTP stays | — (out of scope) |
| Kavach, one-tap SOS, Safety Circle, police-led safety training | Explicitly excluded for now | future milestone |
