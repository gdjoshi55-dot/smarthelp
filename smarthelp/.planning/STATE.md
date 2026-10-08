# SmartHelp — Project State

## Current Phase

Phase 3 — Payments, refunds & wallet. Plan:
[`phases/03-payments/03-PLAN.md`](phases/03-payments/03-PLAN.md).

**Wave A complete and gated** (typecheck/lint/build exit 0, pre-migration suite
645/36 green, `0014` already applied live, CheckoutForm opens real Razorpay
Checkout through `lib/paymentClient.ts`, `paid` reachable only from polled
status, docs written). **Wave B on disk, pre-migration green:** `0015` schema,
`lib/refundServer.ts`, `lib/walletServer.ts`, `POST/GET /api/refunds`, the
`refund.processed` webhook event, the cancel-of-paid auto-refund, and both test
files. What remains: 03-PLAN **Task B-GATE** (apply `0015`, unexcluded suite,
`npm run test:db` across all five live files, §31.1 exit-criteria hand-check)
and the `README.md` "Phase 3 complete" record.

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
- **`booking_assignments` and `assignment_status` are deferred to Phase 5.** They
  are declared in §24.9 beside `professional_schedule` but belong to the matching
  engine, and a table with no matching engine behind it can only ever hold rows
  nothing wrote. `favourites` is deferred from `0017` for the same reason.
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

- **A `localStorage` `addressId` naming a deleted row pins checkout to a 404.**
  Found while fixing the case beside it (quick task 261004-gh9, which gave a
  customer with *no* addresses a form and left this one alone). With the list
  empty and `addressId` still truthy, neither the new form nor the amber notice
  renders and Confirm stays enabled — `SavedAddressPicker` falls back to the
  default for display only, and never clears the selection. Pre-existing;
  unchanged. The fix reaches `BookingPanel` and `localStorage`.
- **`GET /api/availability` answers `VALIDATION_ERROR` (with a 422 status
  override) for an unresolvable locality**, where its own docstring and the plan
  both say `SERVICE_UNAVAILABLE`. A client branching on `code` therefore sees a
  different code for the same 422 that an uncovered *service* produces. Left as
  is, and documented in `docs/API.md`.
- **Nothing consumes `quoteToken` for payment.** It is issued, verified and stored
  on `bookings.quote_token`, which is the whole of §7.2's requirement; Phase 3 has
  to decide what a payment hand-off does with it.
- **There is no consolidated `bookingView`.** Detail pages assemble their payload
  from several queries. Correct, but more than one round trip per page.
- **Dead code**: `noContent`, `requireCapability`/`requireStaff`/`requireAdmin`
  (the capability table is enforced by the UI only), `isUuid`, `parsePaging`,
  `createRequestClient`, a byte-identical private `maskEmail` in `send-otp`, and
  `components/ui/ImageUpload.tsx` — unreferenced, and pointed at a `menu-images`
  bucket that belongs to SmartPOS and does not exist here.
- **`sign-in` returns the raw `['*']` capability list to a `super_admin`**, where
  `/api/auth/me` expands the wildcard. A client checking capabilities must handle
  the literal `'*'`.
- **Comment drift**: two code comments point at files that do not exist, and
  `lib/validation.ts`'s header claims it is safe to import from the browser when it
  is not. `0007`'s header says twenty services and there are twenty-three; its
  coverage comment says thirteen localities and there are twelve; `seed.sql`'s
  header says four demo users and creates five, and misspells
  `SMARTHELP_OWNER_LOGIN`. None of these change behaviour; all are wrong.
- **`vercel.json` declares eight cron paths** with no handlers behind them.
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
| 261007-vhn | Keep building smarthelp (Phase 3): Wave A finished and gated, Wave B schema/modules/routes/tests started | 2026-10-08 | (uncommitted) | [.planning/quick/261007-vhn-keep-building-smarthelp-phase](./quick/261007-vhn-keep-building-smarthelp-phase/) |


## Blockers/Concerns

- None outstanding. Migrations through `0028` are applied to the live project and
  `npm run test:db` passes against it (67 tests across 3 files).
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

Last activity: 2026-10-08 - Resumed and completed quick task 261007-vhn: Phase 3 Wave A finished (type mirror, CheckoutForm → paymentClient hand-off, Wave A docs) and gated — typecheck/lint/build exit 0, pre-migration suite 645 tests across 36 files (floor 629), `0014` confirmed already applied live so `db:migrate` was a no-op, unexcluded suite 635 and `test:db` 73 both green. Wave B started: `POST/GET /api/refunds` with the ₹1500 limit and server-side capability checks, the cancel-of-paid auto-refund closing the paid→cancelled money leak, `refund.processed` in the existing webhook, `test/routes.refunds.test.ts` (12 cases) and the live `test/db.wallet.test.ts`. `0015` deliberately NOT applied — that is 03-PLAN Task B-GATE, the next step. No git commits, no new dependencies, no refund UI (645 tests / 36 files green).

















