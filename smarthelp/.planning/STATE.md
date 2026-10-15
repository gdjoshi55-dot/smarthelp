---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in_progress
last_updated: "2026-10-14T00:00:00.000Z"
last_activity: "2026-10-14 - **Phase 8 (Growth) started — Wave A (surge pricing) complete.** Wired the Phase-6 `resolveSurgeMultiplier` into the quote engine: `lib/pricing.ts` gains optional multipliers (`SURGE_MIN_FACTOR`/`SURGE_MAX_FACTOR`, `multipliers[]` on the breakdown, a `multiplier` snapshot rule, `PRICING_ENGINE_VERSION = 3`), `lib/bookingQuote.ts` gains `scheduledAt`, the pure `localWallClock(at)` and `resolveBookingMultipliers()` (highest factor across the booking's services, clamped to `min(2.00, surgeMaxFactor)`), the new `surgeMaxFactor` `platform_settings` key (default 1.50, `0043` seeds it), and the quote/create routes pass the scheduled start. Gates: typecheck/lint/build exit 0, `npm test` 1046/68 (was 1030/67), `npm run test:db` 117/10. Plan: `phases/08-growth/08-PLAN.md`. Waves B–G (wallet top-up UI, referrals, recurring, invoice PDF, PWA) remain."
progress:
  total_phases: 10
  completed_phases: 8
  total_plans: 7
  completed_plans: 7
  percent: 80
---

# SmartHelp — Project State

## Current Phase

Phase 8 — Growth. **In progress** (Waves A & B complete, started 2026-10-14). The
phase is a set of seven independent waves (see
[`phases/08-growth/08-PLAN.md`](phases/08-growth/08-PLAN.md)); the §31.1 exit
criteria are *recurring generates idempotently; surge is capped; the PWA
installs*.

**Wave A — surge pricing. Complete.** The Phase-6 pure resolver
`resolveSurgeMultiplier` (`lib/policyServer.ts`) was built but never called by
the engine. It is now wired in: `lib/pricing.ts` takes an optional
`multipliers[]`, applies each factor to the **subtotal** before the platform fee
and tax (per §7.1's normative formula — the spec's own illustrative JSON is
arithmetically inconsistent and the formula wins, D1), itemises every applied
factor as its own `multipliers[]` entry plus a `multiplier` snapshot rule, clamps
to the absolute `[0.50, 2.00]` and throws otherwise (D2), and bumps
`PRICING_ENGINE_VERSION` to 3. `lib/bookingQuote.ts` gains an optional
`scheduledAt`, the pure exported `localWallClock(at)` (Asia/Kolkata) and
`resolveBookingMultipliers()` — the highest factor across the booking's services,
clamped to `min(2.00, surgeMaxFactor)`, resolved against the scheduled wall
clock (D3). A new `platform_settings` key `surgeMaxFactor` (default **1.50**)
tightens the ceiling; migration `0043_surge_max_factor.sql` seeds it (idempotent,
applied live — 40 files, 40 applied). `POST /api/bookings/quote` accepts
`scheduledAt`; `POST /api/bookings` passes `scheduledStartAt`. An empty
`pricing_rules` table changes nothing — every prior quote and test is unchanged
(D4). Gates green: typecheck/lint/build exit 0, `npm test` **1046/68** (was
1030/67), `npm run test:db` **117/10** (the settings-count assertion moves 22 →
23). New tests: `test/surge.test.ts` (resolver specificity/tie/window/midnight-
wrap/validity + `localWallClock`), plus six surge cases in `test/pricing.test.ts`.

**Wave B — wallet. Complete.** `POST /api/wallet/redeem` (existing) spends
balance as a `debit` through `apply_wallet_delta`. `POST /api/wallet/topup` is
new and is the ops lever §2/§25.8 call for: v1 is **promo/ops credit only** (an
in-app card top-up is an explicit non-goal), so it is gated by a new
**`wallet.credit`** capability (granted to `ops`, `admin`, and `super_admin` via
`'*'`) and takes `{ customerId, amount, reason? }`, validating the customer
exists, crediting through `creditWallet` — the one ledger path — and auditing
the grant. Wiring redeem into the checkout/payment flow (a partial payment) is
deferred: a booking money-path change that no screen consumes yet (D5). No
customer UI is added; the wallet page still shows balance, ledger and refunds.
New tests: `test/routes.walletTopup.test.ts` (5) plus the `roles` table. Gates
green: typecheck/lint/build exit 0, `npm test` **1051/69** (was 1046/68),
`npm run test:db` **117/10**.

**Waves C–G:** C — favourites (done, `0042`); D — referrals
(`referrals` table, code validation at signup, both-sided reward); E — recurring
(`recurring_series` / `recurring_occurrences` +
`/api/cron/recurring-generate`); F — invoice PDF (`invoices` table; a JSON
receipt already exists at `GET /api/bookings/[id]/invoice`); G — PWA (manifest +
service worker).

Phase 7 — Realtime & notifications. **Complete.** Built and verified 2026-10-14.
Migrations `0038`–`0041` give the phase its schema: `chat_threads` / `chat_messages`,
`notification_templates`, `notifications` and `notification_devices` with the
`notification_channel` enum (`0038`); the six §27.1 source tables added to
`supabase_realtime` (`0039`); the 39-row `en-IN` template catalogue (`0040`, no
`in_app` rows — those render from `push`); and the two reminder functions
`run_service_reminders` / `run_rating_reminders`, `security definer`, advisory-locked,
service-role-only (`0041`). The surface is `lib/notifications.ts` (the dispatcher, and
**the only writer of notification rows**), `lib/notificationHooks.ts`,
`lib/notificationServer.ts` / `lib/chatServer.ts`, `lib/cronGuard.ts`, eight
endpoints (notifications, chat, push-token, admin templates), `hooks/use-realtime.ts`
and the bell/chat/template-editor UI. §31.1's exit criterion — *status updates land in
under a second; every catalogue notification fires* — is hand-checked: the pushed
channels deliver in-request with a bounded 15 s / 5 s polling floor, and 16 of the 24
catalogue codes fire from a live trigger (the other eight are catalogue-only because
their feature is unbuilt, scoped out by D2). Applied to the live project (38 files,
**39 applied, 0 outstanding**). typecheck/lint/build exit 0, `npm test` **1030/67**
(floor 954/61), `npm run test:db` **117/10** (floor 104/9). `README.md` now says "at
Phase 7", and `docs/API.md` §4.9, `docs/FEATURES.md` §9, `docs/DATABASE.md` §15 record
the phase. Plan and record:
[`phases/07-realtime-notifications/07-PLAN.md`](phases/07-realtime-notifications/07-PLAN.md),
[`07-SUMMARY.md`](phases/07-realtime-notifications/07-SUMMARY.md).

**Next:** Phase 8 — Growth, Waves D–G (see
[`phases/08-growth/08-PLAN.md`](phases/08-growth/08-PLAN.md) and
[`ROADMAP.md`](ROADMAP.md)).

Phase 6 — Admin console. **Complete.** Built and verified 2026-10-14.
Migrations `0033`–`0037` gave the console its tables: `platform_settings` (created
and seeded; read through `lib/settingsServer.ts`), the two staff write paths
(`admin_cancel_booking` / `admin_assign_booking`, `0034`, both under the `assign:`
advisory lock), `pricing_rules` and `cancellation_policies` (`0035`), broadcast
matching (`0036`, which re-creates `match_booking` / `accept_offer` to offer to the
whole ranked list and moves the double-assign guarantee to
`uniq_accepted_assignment_per_booking`), and `support_tickets` /
`support_messages` / `disputes` (`0037`). The surface is `lib/adminServer.ts` plus
~33 Route Handlers under `app/api/admin/**`, gated by the shared capability table —
`requireCapability()` is now live on every mutating route, and the staff allow-list
`['admin','ops','support','super_admin']` gates the reads. §31.1's exit criterion —
*ops can run the marketplace without a database console* — was hand-checked by
editing a price and a setting from the UI. Plan and record:
[`phases/06-admin-console/06-PLAN.md`](phases/06-admin-console/06-PLAN.md),
[`06-SUMMARY.md`](phases/06-admin-console/06-SUMMARY.md).

Phase 5 — Matching engine. **Complete.** Built and verified 2026-10-12.
`0032_matching_engine.sql` restores the spec's `assigned -> searching` edge and
adds four `security definer`, service-role-only functions —
`expire_stale_offers`, `rank_candidates`, `match_booking` (under an advisory lock)
and `run_matching_sweep` — and drops Phase 4's `sweep_new_bookings`. The app
mirror is `lib/matchingServer.ts` (the sweep and single-booking wrappers plus the
exhaustion refund), `refundCapturedBooking` extracted from the cancel route, the
`searchWindowMinutes` constant, and the offers/decline route rewiring. Both
§31.1 exit criteria are proven: **no double assignment under concurrency** (the
`test/db.matching.test.ts` race opens 20 connections against one booking and
exactly one offer results) and **an exhausted search auto-refunds** (the booking
reaches `cancelled` / `no_professional_available` and the captured payment is
refunded in full). (Phase 6's `0036` then switched the fan-out from rounds to a
broadcast.) Plan and record:
[`phases/05-matching-engine/05-PLAN.md`](phases/05-matching-engine/05-PLAN.md),
[`05-SUMMARY.md`](phases/05-matching-engine/05-SUMMARY.md).

Phase 4 — Professional app. **Complete.** D1 phase gate passed 2026-10-10: all
four waves built, the Wave A schema push (`0012`/`0021`/`0029`, plus the `0030`
fix) applied to the live project (28 applied, 0 outstanding), typecheck/lint/build
exit 0, `npm test` **798/46** (floor 655/38), `npm run test:db` **96/7** (floor
77/5), §31.1's exit criterion hand-checked, and the three manual verifications
(live bucket upload, on-device geofence override, §30 smoke) passed. `README.md`
said "at Phase 4", and `docs/API.md` §4.7, `docs/FEATURES.md` §6,
`docs/DATABASE.md` §11 recorded the phase. Plan and record:
[`phases/04-professional-app/04-PLAN.md`](phases/04-professional-app/04-PLAN.md),
[`04-SUMMARY.md`](phases/04-professional-app/04-SUMMARY.md).

Phase 3 — Payments, refunds & wallet. **Complete.** B-GATE passed 2026-10-08:
unexcluded suite 655/38, `npm run test:db` 77/5, §31.1's exit criteria
hand-checked — money in, money out, webhook sole authority, RLS on payments.
Plans and record in `phases/03-payments/`.

Phase 2 — Booking & pricing. **Substantially complete.** Plan:
[`phases/02-booking-pricing/02-PLAN.md`](phases/02-booking-pricing/02-PLAN.md).
One deliberate deferral carried forward: there is no consolidated `bookingView`
read model.

## Phases Completed

- Phase 0 — Foundation. Migrations 0000–0007 and 0024–0027, email + password
  sign-in, the OTP ledger, roles and capabilities. Built before the phase list was
  tracked; summarised in `README.md`.

- Phase 1 — Catalogue & availability. Migration 0008, locality resolution, the
  slot engine, nine endpoints, three public pages, `docs/`.

- Phase 2 — Booking & pricing. Migrations 0009–0013, 0016–0017, 0028, the pricing
  engine, the booking endpoints and pages — see "Phase 2 progress" below.

- Phase 3 — Payments, refunds & wallet. Migrations 0014–0015, Razorpay
  order/verify/webhook/reconcile, `confirm_booking_payment` as the single writer
  of `success`, the refund API with the ₹1500 limit, cancel-of-paid auto-refund,
  the wallet ledger with `apply_wallet_delta`, and the §31.1 exit criteria.
  Recorded 2026-10-08; plans and record in `phases/03-payments/`.

- Phase 4 — Professional app. Migrations `0012` (assignments), `0021` (earnings),
  `0029` (service execution) and `0030` (the `search_path` / re-complete fix), the
  professional server/client modules and OTP helpers, availability, the KYC flow
  end-to-end, the offers inbox, arrive/OTP/complete/no-show, the customer track
  endpoint, the professional console and the customer's live booking screen, and
  §31.1's exit criterion (take and complete a job). Recorded 2026-10-10; plan and
  record in `phases/04-professional-app/`.

- Phase 5 — Matching engine. Migration `0032` (the restored `assigned -> searching`
  edge; `expire_stale_offers`, `rank_candidates`, `match_booking`,
  `run_matching_sweep`; `sweep_new_bookings` dropped), `lib/matchingServer.ts`, the
  shared `refundCapturedBooking`, the `searchWindowMinutes` constant and the
  offers/decline route rewiring, and §31.1's exit criteria (no double assignment
  under concurrency; exhausted search auto-refunds). Recorded 2026-10-12; plan and
  record in `phases/05-matching-engine/`.

- Phase 6 — Admin console. Migrations `0033`–`0037` (`platform_settings`; the
  `admin_cancel_booking` / `admin_assign_booking` write paths; `pricing_rules` and
  `cancellation_policies`; broadcast matching, which re-creates `match_booking` /
  `accept_offer` and supersedes Phase 5's rounds; `support_tickets` /
  `support_messages` / `disputes`), `lib/adminServer.ts` and the ~33 admin Route
  Handlers, and §31.1's exit criterion (ops can run the marketplace without a
  database console). Recorded 2026-10-14; plan and record in
  `phases/06-admin-console/`.

- Phase 7 — Realtime & notifications. Migrations `0038`–`0041` (`chat_threads` /
  `chat_messages`, `notification_templates`, `notifications`, `notification_devices`;
  the `supabase_realtime` publication; the template seed; `run_service_reminders` /
  `run_rating_reminders`), `lib/notifications.ts` (the dispatcher),
  `lib/notificationHooks.ts`, the notification/chat read models and `lib/cronGuard.ts`,
  the eight notification/chat/template endpoints, `hooks/use-realtime.ts` and the
  bell/chat/template-editor UI, and §31.1's exit criteria (status updates land in under
  a second; every catalogue notification fires — 16 of 24 from a live trigger, the
  rest catalogue-only pending their feature). Recorded 2026-10-14; plan and record in
  `phases/07-realtime-notifications/`.

## Phase 2 progress

| Task | What it delivered | Status |
|---|---|---|
| Legacy reconciliation | `0008a` drops the pre-spec `bookings`/`coupons`/`coupon_redemptions` | done |
| Booking enums | `0009` — `booking_type`, the 18-label `booking_status` | done |
| `bookings` | `0010` — bookings, items, status history, RLS, booking numbers | done |
| State machine | `0011` — transition trigger, history writer, version bump | done |
| Schedule | `0013` — `professional_schedule` with the overlap exclusion | done |
| Coupons | `0016` — `coupons`, `coupon_usage` ledger | done |
| Ratings | `0017` — `ratings` with the eligibility trigger | done |
| Address guard | `block_address_delete_with_future_bookings()` (deferred from 0008) | done |
| Tests | `test/db.booking.test.ts`, `test/db.rls.test.ts`, `test/db.connection.test.ts` | done |
| Migration dry-run | `scripts/check-migrations.mjs` | done |
| Pricing | `lib/money.ts`, `lib/pricing.ts` | done |
| Booking services | `lib/bookingServer.ts` — `getBookingById`, `getBookingForCaller`, `transitionBooking` | done |
| Endpoints | `/api/bookings` — list, one, quote, create, cancel, reschedule, review, invoice | done |
| Saved-address picker | pass `addressId` from checkout (Phase 1 gap) | done |
| Quote token | §7.2's signed token — issued by quote, verified and stored by create | done |
| Atomic write paths | `0028` — `create_booking`, `cancel_booking`, `transition_booking` | done |
| Roles | customer capabilities in `lib/roles.ts` | done |
| Seed + docs | bookings in the demo data, `docs/API.md` §4.4, `DATABASE.md` §8, `FEATURES.md` §4 | done |

**489 tests, 25 files** — 422 need nothing but the code, 67 run against a live
database. Lint, typecheck and build are clean.

### The endpoints exist

`reschedule` no longer answers 409 on every request: it used to transition to
`draft`, which nothing may become, and now moves the window and status within
`RESCHEDULABLE_STATUSES` — one list in `lib/status.ts`, read by the route *and* the
detail page, so the UI cannot offer a reschedule the database will refuse. `cancel`
writes `cancellation_reason_code`, `cancelled_at` and the §11.1 fee, in one
statement.

## The pricing engine

`lib/money.ts` counts paise and never lets a fractional rupee into an
intermediate value; `lib/pricing.ts` is §7.1 evaluated in that arithmetic and
returns the breakdown, the two shares, and a `pricing_snapshot`.

- **§7.1 does not balance, and the engine departs from it deliberately.**
  `professional_gross = taxable - commission × taxable` pays a professional out
  of a `taxable` that already contains the platform fee, and `platform_revenue`
  then books the fee again. On ₹1000 with a ₹20 fee, a ₹100 coupon, 18% GST and
  20% commission the specification gives 736 + 370 = 1106 against a total of
  1086 — ₹20 out, scaling with the fee, so it is a structural error and not a
  rounding artefact. The engine charges the fee to the platform instead:
  `professional_gross = taxable - platform_fee - commission`, which reads as
  "the professional earns on the discounted service value, less commission" and
  never touches the fee or the tax, both of which the platform remits.

- **`assertBalanced()` throws if the two shares ever stop summing to the total**,
  so a rule added later that forgets a share fails a booking creation instead of
  quietly overpaying a professional.

- **A discount is apportioned across lines by largest remainder.** Flooring each
  line's share loses paise (₹10 over three equal lines is 999 paise, not 1000);
  rounding each share up overpays (three half-paiso shares each round to 2).
  Flooring and then handing out the leftover by largest fractional remainder,
  breaking ties on index, is exact — and the tie-break matters because the result
  is frozen into `pricing_snapshot` and must replay identically.

- **Two different scales for two similar-looking columns.** `tax_rate` and
  `commission_pct` are rates in [0,1]; `discount_value` for a percentage coupon
  and `max_discount_pct_of_total` are percents on a 0–100 scale. Conflating them
  is the easiest mistake in the file, so the conversion is written next to the
  comment that says which is which.

- **§7.1's floor guard is currently unreachable**, and the code says so. The
  guard allows a discount up to `subtotal + platformFee`, but
  `max_discount_pct_of_total` is clamped to 100% of the subtotal, which is
  strictly less. It stays as the thing that would stop `taxable` going negative
  if the ceiling were ever allowed above 100.

- **`parseNumeric()` throws rather than defaulting a broken value to zero.**
  PostgREST returns `numeric` as a JSON string; every money column on
  `bookings` is `not null`, so a null there is a wrong query, not an absent
  value, and zeroing it would create a booking worth nothing.

- **`pricing.test.ts` checks the engine against `priceForDuration()`** from the
  Phase 1 catalogue over a matrix of durations and duration-row overrides, so
  the display price and the invoiced price cannot drift the way `durationMinutes`
  drifted into `duration` in Phase 1.

## The Phase 2 database, and why it is shaped this way

The live project contained tables that no migration had ever created, built to an
older shape: `bookings` with paise `int` money, a 15-label status enum containing
`pending`, `quoted`, `en_route` and `awaiting_otp`, one `service_id` per booking,
and `coupons` with `kind`/`amount`/`min_subtotal`. All were empty. They were
dropped by `0008a` after checking they held no rows, and the specification's shape
was built in their place. `pricing_type` was **kept** — `services.pricing_type`
uses it, so dropping the enum to tidy up a dead table would have broken the live
catalogue.

- **The transition table is enforced twice, and the database half is the one that
  matters.** `enforce_booking_transition()` raises `ILLEGAL_TRANSITION` for any
  move outside §8.2 and writes `booking_status_history` for every legal one. The
  application guard exists to produce a readable error; the trigger is what makes
  the state safe, because a Route Handler written next year that forgets the
  guard cannot produce `refunded -> paid`.

- **The whole 18-value enum ships in Phase 2 while the code reaches four of its
  values.** A label added when it is first needed is an `ALTER TYPE` that
  rewrites `bookings` under an `ACCESS EXCLUSIVE` lock, on the one table with a
  history row behind every row. The unreached states are unreachable because
  nothing writes them, not because the database would refuse.

- **Actor identity is passed in, not read from `auth.uid()`.** §8.2 says to read
  the JWT, but every privileged write reaches Postgres through the service-role
  client, so `auth.uid()` is null precisely for the events that matter — a
  cancellation, a refund, an ops override. The caller sets `app.transition_actor`
  transaction-locally and the JWT remains a fallback.

- **Money is `numeric(12,2)` and rates are `numeric(5,4)`.** The scale is the
  guard: `numeric(5,2)` would hold `18.00` happily, and a tax rate stored as
  `18` instead of `0.18` survives to checkout, where the customer sees it.
  `tax_rate between 0 and 1` catches what does fit.

- **Double-booking is a GiST exclusion, not a check.** An availability check is a
  read followed by a write, and two customers booking the same professional at the
  same time both read "free". The constraint is atomic; the loser gets `23P01` and
  the server offers the next slot. The partial `where (status in
  ('reserved','in_progress'))` is what stops a completed window from blocking that
  slot forever.

- **A coupon is a ledger, not a counter.** `coupon_usage` has
  `unique (booking_id)`, so "one coupon per booking" is a property of the schema
  rather than a check the pricing engine must remember. `coupons.usage_count` is a
  cache for rendering "3 of 10 left" and is not what enforces `usage_limit`.

- **Ratings are gated in the database.** `validate_rating_booking()` checks the
  booking exists, belongs to that customer, was done by that professional, and has
  finished. A rating is what every professional's public score is computed from,
  so application-level checks would be only as strong as the least careful caller.

## Bugs the Phase 2 tests found

Written after the migrations and immediately wrong, which is what they were for.

- **The history trigger blocked the cascade from its own parent.** It raised on
  every delete, so `delete from bookings` failed with `BOOKING_HISTORY_IMMUTABLE`
  and no booking could ever be deleted. `audit_logs` never hits this because
  nothing cascades from it. Fixed by testing whether the parent row still exists:
  Postgres fires a referential action from an AFTER trigger on the parent, so a
  cascade finds no parent and a hand-rolled delete finds one.

- **`ratings` had the same bug**, so deleting a rated booking failed the same way.
  Fixed the same way.

- **The history trigger silently swallowed edits.** The DELETE branch returned
  `OLD` and the UPDATE branch fell through to it, so `update … set note = …` was
  discarded with no error. The caller would believe the note was rewritten. A
  guard that quietly does nothing is worse than none, because it looks like it
  worked.

- **A hand-written path table in the test was wrong in ten of twelve entries.**
  `paid` and `cancelled` omitted their own final state, so walks stopped a step
  short and the failure surfaced in an unrelated assertion. Replaced with
  `pathTo()`, derived from the one linear chain §8.2 defines.

## Decisions worth remembering from Phase 2

- **One global sequence for `booking_number`, not a per-day counter.** §24.7
  sketches `SH-20260926-00124` with a per-day counter, which needs a per-day row
  and a lock for two simultaneous first-bookings to agree on the suffix. One
  sequence gives the same shape and cannot collide; the unique constraint is the
  actual guarantee. The date part renders in `Asia/Kolkata`, because a booking made
  at 00:10 IST is the 26th in India even when the database is configured for UTC.

- **No `commission_amount` or `platform_revenue` column.** §24.7 does not list
  them, and both are arithmetic on `professional_gross` and `commission_pct`, which
  are stored. A third column would be a second thing to drift. They are derived
  and retained in `pricing_snapshot`.

- **The spec's geo index does not compile as written.** §24.7 says
  `point(address_snapshot->>'lng', …)`, but `jsonb ->> text` and there is no
  `point(text, text)`. Explicit `::double precision` casts, with `btree_gist`
  from `0002`.

- **`booking_assignments` and `assignment_status` are no longer deferred.** Phase 4
  reclaimed migration `0012` (D1 in `phases/04-professional-app/04-PLAN.md`): the
  offers inbox and the accept compare-and-set need the table, so `0012` now
  creates it with `uniq_active_assignment_per_booking`, the `accept_offer`/
  `decline_offer` CAS RPCs, and the minimal `sweep_new_bookings` producer. What
  stays in Phase 5 is the *matching engine* — ranking, fan-out, advisory locks and
  the reassignment cascade — and the table is built to receive it unchanged.
  `favourites` is still deferred from `0017`.

- **`booking_status_history` is append-only but not untouchable by cascade**, and
  the distinction is the parent-existence test described above.

## An open product question, not a defect

`bookings.address_id` is `ON DELETE RESTRICT` per §24.7, and `RESTRICT` ignores
status — so **an address somebody once booked to can never be deleted**, even for
a cancelled booking. The trigger in `0010` was widened to count every non-`closed`
booking precisely so those cases get "this address is used by 2 bookings" rather
than a raw constraint name; a `closed` booking still falls through to the foreign
key. Deleting the booking is the escape hatch, and the Route Handler will have to
do it in that order. Whether a customer should be able to retire an address that
only appears on cancelled bookings is worth deciding; the schema as specified says
no.

## Known issues carried forward

### Fixed during 261003-03, recorded because the reasoning matters

- **`transitionBooking`'s `actor` and `note` were accepted and discarded. — fixed by
  `0028`.** `0011` reads `app.transition_actor` and `app.transition_note` as
  transaction-local settings, and PostgREST cannot set those in the same transaction
  as the update, so every privileged write landed in `booking_status_history` with a
  null actor — the anonymity `0011`'s own comment calls "exactly the events that
  matter". Each of the three new functions sets both settings *itself* and then
  performs the writes that read them, in one statement.

- **Three PostgREST requests could not be one transaction. — fixed by `0028` too.**
  Creating a booking was a row, then its `booking_items`, then a status update, so a
  failure between any two left a booking with a total and nothing behind it.
  `create_booking` does all three; the test that proves it uses a duplicate
  `service_id` to make one line impossible and asserts the *booking count* is
  unchanged afterwards.

- **`POST /api/bookings/[id]/reschedule` answered 409 on every request.** See above.
- **Idempotency is now used**, by `POST /api/bookings`, with the validated body as
  the hash so whitespace cannot spend a customer's key.

- **The `/customer` "Browse services" button is disabled** with the title "Arrives
  in Phase 1", which was false — the catalogue is public and built.

### Still open

- ~~**A `localStorage` `addressId` naming a deleted row pins checkout to a 404.**~~
  — closed 2026-10-08: the picker now runs the pure decision in
  `components/catalogue/savedAddressSelection.ts` (20 cases in
  `test/savedAddressSelection.test.ts`) instead of its old display-only fallback.
  The same wiring fixes the report that found it — an address shown as selected
  while checkout said "Pick a saved address to continue." and kept Confirm off,
  because the location context never held the id the control displayed. The
  decision lands in a layout effect on the commit that delivers the list, so the
  amber notice never paints over an address about to be applied; `BookingPanel`
  is fixed by the same code path.

- **`GET /api/availability` answers `VALIDATION_ERROR` (with a 422 status
  override) for an unresolvable locality**, where its own docstring and the plan
  both say `SERVICE_UNAVAILABLE`. A client branching on `code` therefore sees a
  different code for the same 422 that an uncovered *service* produces. Left as
  is, and documented in `docs/API.md`.

- ~~**Nothing consumes `quoteToken` for payment.**~~ — closed by Phase 3:
  `create-order` asserts `bookings.quote_token IS NOT NULL` (presence gates
  payment, freshness does not) and `confirm_booking_payment` nulls it, making
  the token single-use across the payment lifecycle.

- **There is no consolidated `bookingView`.** Detail pages assemble their payload
  from several queries. Correct, but more than one round trip per page.

- **Dead code**: `noContent` and `createRequestClient` remain unreferenced. The rest
  of this list was resolved in Phase 6: `requireCapability` is now the write-gate on
  every mutating route, `isUuid`/`parsePaging` are used, `requireStaff`/`requireAdmin`
  were removed, `send-otp` imports `maskEmail` from `lib/authServer.ts`, and
  `components/ui/ImageUpload.tsx` was deleted.

- **`sign-in` returns the raw `['*']` capability list to a `super_admin`**, where
  `/api/auth/me` expands the wildcard. A client checking capabilities must handle
  the literal `'*'`.

- **Comment drift**: two code comments point at files that do not exist, and
  `lib/validation.ts`'s header claims it is safe to import from the browser when it
  is not. `0007`'s header says twenty services and there are twenty-three; its
  coverage comment says thirteen localities and there are twelve; `seed.sql`'s
  header says four demo users and creates five, and misspells
  `SMARTHELP_OWNER_LOGIN`. None of these change behaviour; all are wrong.

- ~~**`vercel.json` declares eight cron paths with no handlers**~~ — closed
  2026-10-08: it declared exactly one (`/api/cron/reconcile-payments`, every 30
  minutes, fail-closed on `CRON_SECRET`), with the other seven schedules living as
  prose in `docs/ARCHITECTURE.md` §7 until their phases build handlers. Phase 7
  added two of them (`/api/cron/service-reminders` `*/15`, `/api/cron/rating-reminders`
  `13 19 * * *`), so it now declares three, all behind the one fail-closed guard.

- **The migration ledger holds one filename that is not on disk** — `0009_bookings.sql`,
  from the legacy era. Harmless, because the ledger is only consulted for files
  that exist, but it is a record of a file nobody can read.

## The bug 489 tests could not see: no browser call was authenticated

Found by using the application, not by the suite. A signed-in customer opened
`/customer/bookings` and was told "Please sign in to continue."

- **`credentials: 'include'` is not authentication here.** `requireAuth` reads the
  `Authorization` header and nothing else. The Supabase browser client persists to
  `localStorage`, not to a cookie, so `credentials: 'include'` carries nothing the
  route can check — it is easy to write and believe the call is authenticated,
  because the page is visibly signed in. `lib/bookingClient.ts` did exactly that, on
  every booking read and write.

- **`SavedAddressPicker` had the same omission, and failed silently.** It sends
  `credentials: 'include'` with no token and returns quietly on a non-ok response,
  so checkout quietly showed no saved addresses. Nobody had reported that one; the
  bookings page just happened to shout about it first.

- **Every route test passed, because each builds its own `Request` with the header
  already attached.** The 40 tests in `routes.bookings.test.ts` prove the server
  accepts a bearer token. No test imported the module that failed to send one —
  `bookingClient.ts` had no test file at all.

- **`authorizationHeader()` now lives in `lib/sessionHeaders.ts`** and both callers
  import it, so a third client inherits it by importing rather than by remembering.
  The server side needed no change: signing in as the demo customer and calling the
  routes with a real token returned 353 bookings and 246 addresses.

- **The gap was the browser client's, so it is now tested as one.**
  `test/bookingClient.test.ts` asserts the header on all six verbs, that it is the
  caller's own token, that it is re-read per call so a rotated token is never stale,
  and that no session means *no header* rather than an empty one or a thrown error.
  `test/sessionHeaders.test.ts` covers the helper itself.

## Two bugs the tests found that were not about bookings

Both were in the harness, and both had been passing by luck.

- **The quote token's items came back in the wrong shape.** The canonical form signs
  each item as a positional triple, so the signature does not depend on key order —
  and verification handed that triple back as-is, so a caller's `item.serviceId` was
  `undefined`. Nothing noticed until the create route started *comparing* the
  claims against the request: every valid token then failed to agree with itself.
  Verification now rebuilds the items as objects and validates each field.

- **One dead connection failed every later test in a DB file.** The suite holds a
  single `pg` client for two minutes of sequential queries against a pooler that
  recycles idle connections; when the socket went, the transport error surfaced on
  each subsequent test and looked like a dozen unrelated booking failures. Rerunning
  made it green, which is the worst outcome — it teaches everyone to ignore the
  gate. `dbEnv.ts` now detects a dead socket and reconnects once, and
  `test/db.connection.test.ts` provokes the drop on purpose
  (`pg_terminate_backend(pg_backend_pid())`) so the recovery path is asserted rather
  than hoped for. It retries transport errors *only*: a `check_violation` is a real
  answer and is never retried.

- **`npm run test:db` listed its files explicitly**, so `db.connection.test.ts` was
  silently outside the gate. It is a filter now (`vitest run test/db.`) and the files
  run sequentially — three live-DB files in parallel against one remote link
  produced `fetch failed` and 5-second timeouts that had nothing to do with the code.

## Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 261003-01 | Continue building smarthelp phase 2 asap | 2026-10-03 | 97799f0 | [.planning/quick/261003-01-continue-smarthelp-phase2](./quick/261003-01-continue-smarthelp-phase2/) |
| 261003-02 | Detect and fix every error under smarthelp | 2026-10-03 | (this commit) | [.planning/quick/261003-02-smarthelp-error-fixes](./quick/261003-02-smarthelp-error-fixes/) |
| 261003-03 | Atomic booking writes, quote token, seed data, docs | 2026-10-03 | (uncommitted) | [.planning/quick/261003-03-atomic-booking-writes](./quick/261003-03-atomic-booking-writes/) |
| 261003-04 | Authenticated the browser client: `lib/sessionHeaders.ts` | 2026-10-03 | (uncommitted) | — |
| 261004-gh9 | Address creation at checkout: `lib/addressClient.ts`, `AddressForm.tsx` | 2026-10-04 | 3cad3b1-353b0be | [.planning/quick/261004-gh9-fix-logged-in-customer-booking-flow-brow](./quick/261004-gh9-fix-logged-in-customer-booking-flow-brow/) |
| 261007-vhn | Keep building smarthelp (Phase 3): Wave A finished and gated, Wave B schema/modules/routes/tests started | 2026-10-08 | 5c44539 (docs) | [.planning/quick/261007-vhn-keep-building-smarthelp-phase](./quick/261007-vhn-keep-building-smarthelp-phase/) |
| 261008-f2b | Phase 3 Task B-GATE: 0015 applied live, nine gate steps green, §31.1 exit criteria met, README Phase 3 record | 2026-10-08 | (docs commit) | [.planning/quick/261008-f2b-phase3-wave-b-gate](./quick/261008-f2b-phase3-wave-b-gate/) |

## Blockers/Concerns

- None outstanding. Migrations through `0037` are applied to the live project
  (34 files, 35 applied, 0 outstanding) and `npm run test:db` passes against it
  (104 tests across 9 files).

- The database tests need a migrated, seeded database and `SUPABASE_DB_URL`. Without
  one they skip loudly rather than passing quietly.

- `test/db.booking.test.ts` needs more than one customer and more than one
  professional to exist for the two rating-mismatch assertions; where only one
  exists, those tests clean up and return rather than failing.

- **`gsd-sdk` is broken in this environment** and could not write the quick-task
  artifacts: `Cannot find module
  'C:\Users\arush\AppData\Local\npm-cache\_npx\6bdcb3e009b8f3f6\node_modules\@opengsd\get-shit-done-redux\bin\gsd-sdk.js'`.
  The `261003-03` plan and summary were therefore written by hand, matching the
  directory layout the earlier two tasks use.

- **The working tree carries substantial pre-existing changes from outside this
  phase.** No commit was made for `261003-03`, because separating these files from
  whatever else is uncommitted is a decision for whoever owns the branch.

---

Last activity: 2026-10-14 - **Phase 8 (Growth) started — Wave A (surge pricing) complete.** The Phase-6 pure resolver `resolveSurgeMultiplier` (`lib/policyServer.ts`) was built but never called by the engine; it is now wired in. `lib/pricing.ts` gains optional `multipliers[]` (`SURGE_MIN_FACTOR`/`SURGE_MAX_FACTOR`, `MultiplierInput`/`AppliedMultiplier`, `multipliers[]` on the breakdown, a `multiplier` snapshot rule, `snapshot.totals.rawSubtotal`, `PRICING_ENGINE_VERSION = 3`); each factor scales the **subtotal** before the fee and tax (§7.1's normative formula — the spec's illustrative JSON is arithmetically inconsistent, D1), is itemised as its own line (§7.4), and is re-clamped inside the engine to `[0.50, 2.00]` (D2). `lib/bookingQuote.ts` gains `BookingQuoteRequest.scheduledAt`, the exported pure `localWallClock(at)` (Asia/Kolkata) and `resolveBookingMultipliers()` — the highest factor across the booking's services, clamped to `min(2.00, surgeMaxFactor)`, resolved against the scheduled wall clock (D3); `loadPricingSettings()` also returns `surgeMaxFactor`. New `platform_settings` key `surgeMaxFactor` (default 1.50) in `lib/constants.ts` and `lib/settingsServer.ts`; `supabase/migrations/0043_surge_max_factor.sql` seeds it (idempotent, applied live — 40 files, 40 applied). `POST /api/bookings/quote` accepts `scheduledAt`; `POST /api/bookings` passes `scheduledStartAt`. An empty `pricing_rules` table changes nothing (D4). Gates green — typecheck/lint/build exit 0, `npm test` **1046/68** (was 1030/67), `npm run test:db` **117/10** (the settings-count assertion moves 22 → 23). New `test/surge.test.ts` covers resolver specificity/tie/midnight-wrap/validity and `localWallClock`; `test/pricing.test.ts` gains six surge cases. Plan: `phases/08-growth/08-PLAN.md`. **Wave B (wallet) complete:** `POST /api/wallet/topup` is the v1 promo/ops credit lever (§2/§25.8 — in-app card top-up is a non-goal), gated by a new `wallet.credit` capability (ops/admin/owner) and writing through `creditWallet` + an audit entry; redeem stays as-is and its checkout wiring is deferred (D5). New `test/routes.walletTopup.test.ts` (5 tests) + the roles table; gates re-run green — typecheck/lint/build exit 0, `npm test` **1051/69** (was 1046/68), `npm run test:db` **117/10**. Waves D–G (referrals, recurring, invoice PDF, PWA) remain.
