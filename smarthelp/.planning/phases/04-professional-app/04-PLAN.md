---
phase: 4
slug: professional-app
plan: 04
type: execute
date: 2026-10-08
description: "KYC upload + admin verdict endpoint, working hours / time-off / online toggle, offers inbox with CAS accept, arrive with geofence, service OTP, complete, no-show, and the customer track endpoint — four waves, each ending in a verified gate, with one blocking schema push."
requirements: [P4-01, P4-02, P4-03, P4-04, P4-05, P4-06, P4-07, P4-08, P4-09, P4-10]
wave: 1
depends_on: []
autonomous: false
files_modified:
  - supabase/migrations/0012_assignment_integrity.sql
  - supabase/migrations/0021_earnings.sql
  - supabase/migrations/0029_service_execution.sql
  - supabase/schema.sql
  - lib/professionalServer.ts
  - lib/professionalClient.ts
  - lib/serviceOtp.ts
  - lib/bookingClient.ts
  - lib/constants.ts
  - lib/supabase.ts
  - app/api/professionals/me/working-hours/route.ts
  - app/api/professionals/me/time-off/route.ts
  - app/api/professionals/me/availability/route.ts
  - app/api/professionals/me/kyc/route.ts
  - app/api/professionals/me/jobs/route.ts
  - app/api/professionals/me/location/route.ts
  - app/api/professionals/offers/route.ts
  - app/api/professionals/offers/[id]/accept/route.ts
  - app/api/professionals/offers/[id]/decline/route.ts
  - app/api/professionals/jobs/[id]/arrive/route.ts
  - app/api/professionals/jobs/[id]/otp/route.ts
  - app/api/professionals/jobs/[id]/complete/route.ts
  - app/api/professionals/jobs/[id]/no-show/route.ts
  - app/api/kyc-documents/upload-url/route.ts
  - app/api/admin/professionals/[id]/kyc/[docId]/decision/route.ts
  - app/api/bookings/[id]/track/route.ts
  - app/api/bookings/[id]/otp/regenerate/route.ts
  - app/professional/page.tsx
  - app/professional/availability/page.tsx
  - app/professional/kyc/page.tsx
  - app/professional/jobs/page.tsx
  - app/professional/jobs/[id]/page.tsx
  - app/customer/bookings/[id]/page.tsx
  - components/auth/RoleShell.tsx
  - components/professional/OfferCard.tsx
  - components/professional/JobCard.tsx
  - components/professional/KycStepper.tsx
  - components/booking/OtpEntry.tsx
  - components/booking/OtpDisplay.tsx
  - components/booking/ServiceTimer.tsx
  - test/professionalClient.test.ts
  - test/serviceOtp.test.ts
  - test/routes.professionals.test.ts
  - test/routes.kycDecision.test.ts
  - test/routes.offers.test.ts
  - test/routes.track.test.ts
  - test/db.assignments.test.ts
  - test/db.jobs.test.ts
  - test/db.rls.test.ts
  - docs/API.md
  - docs/FEATURES.md
  - docs/DATABASE.md
  - README.md
  - .planning/STATE.md

must_haves:
  truths:
    - "A professional with submitted KYC documents sees their per-document status, and an admin-role decision on the last required document flips professionals.verification_status to 'verified' with an audit row — no UI beyond the pro-side screen ships this phase."
    - "A verified professional sets working hours, blocks a day of time off, and toggles online/offline; the online toggle is the gate the minimal offer producer reads."
    - "A paid booking with no active assignment gets exactly one offer to exactly one eligible professional (verified, online, not on time off, schedule free), with a TTL; the professional sees it in a 5-second-polled inbox field-filtered to locality level."
    - "Two professionals accepting the same offer concurrently produce exactly one winner; the loser gets 409 ASSIGNMENT_TAKEN and the partial unique index is what enforces it."
    - "Declining records the reason, and the declining professional is excluded from re-offers of that booking."
    - "Arrive is refused outside the geofence radius unless a manual override with a required reason is supplied, and every override writes an audit row."
    - "The service OTP exists only as bookings.otp_hash; the plaintext is generated server-side, returned exactly once to the customer's session at mint/regenerate, is never re-readable, and never appears in any professional or staff payload."
    - "Three wrong OTP submissions lock the code out; wrong, expired and locked all present the same generic 403 to the professional."
    - "A verified OTP sets started_at and ends_at from the server clock in one statement; the customer's track payload carries serverNow so the timer never trusts the device clock."
    - "complete stamps ended_at and actual_duration_minutes, closes the professional_schedule window, bumps the professional's counters, and inserts a pending professional_earnings row — all in one RPC."
    - "A professional-initiated no-show or cancellation records a reason and an audit row and touches no refund or wallet path."
    - "The suite is green at 655 tests or more, npm run test:db at 77 or more including the new live-db files, and typecheck, lint and build are clean."
  artifacts:
    - path: "supabase/migrations/0012_assignment_integrity.sql"
      provides: "booking_assignments, assignment_status enum, uniq_active_assignment_per_booking, accept_offer/decline_offer CAS RPCs, sweep_new_bookings minimal producer, RLS"
      contains: "uniq_active_assignment_per_booking"
    - path: "supabase/migrations/0021_earnings.sql"
      provides: "professional_earnings table + RLS (partial spec-file ship, 0017 precedent)"
      contains: "professional_earnings"
    - path: "supabase/migrations/0029_service_execution.sql"
      provides: "arrive_job, issue/verify service OTP RPCs, complete_job, no_show_job, kyc roll-up, otp column hardening grants"
      contains: "verify_service_otp"
    - path: "lib/professionalServer.ts"
      provides: "requireProfessional, requireVerifiedProfessional, getProBookingForCaller, PRO_JOB_COLUMNS and the single strip function that owns every pro/staff booking payload"
    - path: "lib/professionalClient.ts"
      provides: "the browser client for every /api/professionals/** verb, Authorization header on all of them"
    - path: "lib/serviceOtp.ts"
      provides: "mint/redact/expiry/lockout pure helpers over PLATFORM_DEFAULTS constants"
      exports: ["generateServiceOtp", "hashServiceOtp", "redactOtpForLog"]
    - path: "app/api/professionals/offers/route.ts"
      provides: "field-filtered inbox read; invokes sweep_new_bookings server-side; lazy expiry"
      exports: ["GET"]
    - path: "app/api/bookings/[id]/track/route.ts"
      provides: "server-authoritative timer payload closing Phase 2's deferral"
      exports: ["GET"]
    - path: "app/api/bookings/[id]/otp/regenerate/route.ts"
      provides: "customer-only OTP mint (generation 1) and regenerate (≤3), plaintext returned once"
      exports: ["POST"]
    - path: "app/professional/jobs/[id]/page.tsx"
      provides: "the phone-first job flow: confirm arrival, OTP entry, timer, complete, no-show"
    - path: "test/db.assignments.test.ts"
      provides: "50-concurrent-accept single-winner proof, expired-offer refusal, cross-pro isolation"
    - path: "test/db.jobs.test.ts"
      provides: "arrive/verify/complete/no-show happy and sad paths against real Postgres"
  key_links:
    - from: "app/api/professionals/offers/route.ts"
      to: "supabase.rpc('sweep_new_bookings')"
      via: "server-side invocation at the top of the inbox read (Q1 minimal producer, Phase 5 replaces)"
      pattern: "sweep_new_bookings"
    - from: "app/api/professionals/offers/[id]/accept/route.ts"
      to: "supabase.rpc('accept_offer')"
      via: "CAS UPDATE WHERE status='offered' AND expires_at > now(); 0 rows → 409 ASSIGNMENT_TAKEN"
      pattern: "accept_offer"
    - from: "app/api/professionals/jobs/[id]/arrive/route.ts"
      to: "lib/geo.ts haversineKm"
      via: "server-side geofence check before arrive_job; override reason audited"
      pattern: "haversineKm"
    - from: "app/api/bookings/[id]/otp/regenerate/route.ts"
      to: "lib/serviceOtp.ts"
      via: "generate + hash in the route, hash-only persistence through issue_service_otp, plaintext returned once to the customer session"
      pattern: "generateServiceOtp|hashServiceOtp"
    - from: "app/api/professionals/jobs/[id]/otp/route.ts"
      to: "supabase.rpc('verify_service_otp')"
      via: "single-statement check+increment; 0 rows → generic 403, detail in logs only"
      pattern: "verify_service_otp"
    - from: "lib/professionalServer.ts"
      to: "bookings.otp_hash / customer PII"
      via: "the one strip function; never select('*') in any pro route (Pitfall 13, P4-10)"
      pattern: "PRO_JOB_COLUMNS|stripProBooking"
    - from: "app/api/bookings/[id]/track/route.ts"
      to: "lib/professionalServer.ts strip function"
      via: "same payload discipline; otp_hash never serialized (P4-10)"
      pattern: "strip"
    - from: "test/routes.track.test.ts"
      to: "app/api/bookings/[id]/track/route.ts"
      via: "asserts JSON.stringify(body) never contains 'otp_hash' (P4-10 regression pin)"
      pattern: "not\\.toContain\\('otp_hash'\\)"
---

> **No git commits.** The user has forbidden commits for this session (STATE.md;
> `gsd-sdk` commit tooling is broken and the working tree carries pre-existing
> uncommitted changes). No task below contains a commit step, and none may be added.

# Phase 4 — Professional app · Plan

## Goal

**"A verified professional can take and complete a job."** That is the §31.1
Phase 4 exit criterion, verbatim, and every task below is measured against it.

Scope from the same row, also verbatim: *KYC upload, verification workflow,
working hours, offers inbox, accept/decline, arrive, OTP, complete.* Those map to
the ten requirement IDs in the frontmatter (`P4-01` … `P4-10`), derived in
`04-RESEARCH.md` § Phase Requirements from §19–§27 of the specification.

## Where this phase starts from

Already in place, from Phases 0–3 — and this is the phase's defining fact: **the
schema is 80–90% built.**

- **`0005`** — `professionals` (with `verification_status`, `availability_status`,
  `is_available_today`, `current_lat/lng/location_updated_at`, counters),
  `professional_working_hours`, `professional_time_off`, `professional_documents`,
  the KYC guard triggers (`guard_professional_document_review`), and the grants
  every availability route needs. **No migration work for availability.**
- **`0010`/`0011`** — `bookings` carries every OTP/timer column this phase uses
  (`otp_hash`, `otp_expires_at`, `otp_attempts`, `otp_generations`,
  `otp_verified_at`, `started_at`, `ends_at`, `ended_at`,
  `actual_duration_minutes`), the 18-value `booking_status` enum, and
  `enforce_booking_transition()` whose transition table decides which hops the
  RPCs below may legally perform.
- **`0013`** — `professional_schedule` with the GiST exclusion
  `EXCLUDE USING gist (professional_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status IN ('reserved','in_progress'))`
  — accept writes a `reserved` row, complete closes it; the exclusion is the
  overlap backstop behind `PROFESSIONAL_UNAVAILABLE`.
- **`0025`** — the private `kyc-documents` bucket and its policies (asserted by
  `test/db.rls.test.ts` today).
- **`0028`** — `create_booking`/`cancel_booking`/`transition_booking`: the
  `security definer`, service-role-only, single-statement, `app.transition_*`
  pattern every Phase 4 RPC copies, and `write_audit` with `redact()`.
- **`lib/bookingServer.ts`** — `getBookingForCaller()` and its own doc comment:
  *"A professional is not staff: their own bookings are Phase 4's concern and
  this helper does not guess at them."* `lib/professionalServer.ts` is the
  deliberate analog.
- **`lib/geo.ts`** — `haversineKm` already exists (Q7).
- **`lib/api.ts`** — the error catalogue already contains `OTP_INVALID`,
  `OTP_EXPIRED`, `OTP_LOCKED`, `ASSIGNMENT_TAKEN`, `PROFESSIONAL_UNAVAILABLE`,
  `ILLEGAL_TRANSITION`, `STALE_VERSION`. Nothing invents error codes.
- **`lib/otp.ts`** + `input-otp` — login OTP helpers and the shadcn OTP primitive;
  the service OTP reuses both.
- **The house envelope** — `handle(req, 'name', …)`, `requireAuth(req, roles)`,
  `ok`/`validationError`, `FakeSupabase` + `test/routes.addresses.test.ts` as the
  route-test shape, `dbEnv.ts` for live-db files.

Not in place, and needed: `booking_assignments` (`0012`, reserved to Phase 5 —
decision D1 below reverses that), `professional_earnings`, every
`/api/professionals/**` route, the service-execution RPCs, the KYC roll-up, the
track endpoint, every `/professional/*` page but the shell home, and the tests
that prove all of it.

**The baseline the phase must not break: 655 tests in 38 files, all green
(2026-10-08), `npm run test:db` 77 tests in 5 files, typecheck, lint and build
clean.** Lint is slow (>240 s) — wave tier only, never per-task.

### How this phase is cut

Four waves, three of them ending in a gate. Wave A lays the shared modules,
availability, and **all three migrations**, then stops at a **blocking schema
push** (`npm run db:migrate` writes to the live project; it happens exactly once,
in the Wave A gate, with human approval — the Phase 3 precedent). Waves B and C
build the job-execution spine on top of the applied schema; Wave D is docs plus
the phase gate. **Every command in this plan is labelled PRE-PUSH or POST-PUSH;
that label, not the order a reader prefers, decides which form of the test
commands to run.** After the Wave A push, the new live-db files
(`test/db.assignments.test.ts`, `test/db.jobs.test.ts`) run under
`npm run test:db` with no exclusions anywhere.

### Nine decisions, made now

These resolve `04-RESEARCH.md`'s open questions Q1–Q9. They are recorded here —
not left for the executor — because each one changes what the tasks below build.

- **D1 (=Q1a + Q9) — `0012` is reclaimed, and a minimal offer producer ships.**
  Phase 4 files `0012_assignment_integrity.sql` (its spec name and number;
  spec numbers are the specification's, and the house rule is that they are not
  re-numberable, not un-reclaimable), explicitly reversing STATE.md's
  "booking_assignments deferred to Phase 5" — the deferral line is updated in the
  same task. A `sweep_new_bookings()` RPC picks **one** eligible professional
  (verified, online, not on time off, schedule free, service-area match), creates
  **one** offer with `expires_at = now() + offerTtlMinutes`, and is invoked
  server-side at the top of `GET /api/professionals/offers`. No ranking, no
  fan-out, no advisory lock, no sweeper cron — Phase 5 replaces this producer
  whole. Lazy expiry (inbox read and accept refuse/mark offers past their TTL)
  covers the absent sweeper (Pitfall 6).
- **D2 (=Q2) — the admin KYC decision endpoint ships; the admin UI does not.**
  `POST /api/admin/professionals/:id/kyc/:docId/decision` plus the
  verdict→`verification_status` roll-up RPC land in Phase 4 (Phase 3's refund
  pattern: API without UI). Phase 6 builds the review queue on the existing
  endpoint. Roll-up rule: all required doc types `verified` ⇒
  `professionals.verification_status='verified'`, `kyc_verified_at=now()`; any
  `rejected` ⇒ `rejected`.
- **D3 (=Q3) — OTP is minted lazily, customer-gated, at `arrived`.** Hash-only
  storage means the server can never re-derive a code, so the plaintext exists
  exactly once — in the response of `POST /api/bookings/:id/otp/regenerate`,
  called by the **customer's** session (generation 1 is the first mint; max 3
  generations via `otp_generations`; the client caches the code in
  `sessionStorage` for the session). The professional's arrive route never sees
  a plaintext code. This resolves the spec-internal inconsistency ("generated at
  booking creation" vs the 10-minute TTL and the §20.6 "only when status =
  arrived" wireframe) deliberately: mint-at-creation is impossible for a booking
  hours away from its slot, and the deviation is recorded, not hidden.
- **D4 (=Q4) — `professional_earnings` lands as a partial `0021_earnings.sql`.**
  `complete_job` inserts a pending earning row (booking, professional, gross,
  commission, net — money arithmetic through `lib/money.ts`'s conventions and the
  existing commission basis; read STATE.md's earnings notes before writing the
  SQL). Payout runs, the payouts table, and the cron stay Phase 8. The
  `0017_ratings.sql` precedent (ship the ratings half, defer favourites) is the
  licence for the partial file. The `/professional/earnings` **page** does not
  ship; the home-page earnings panel stays prose (UI-SPEC OQ-1/OQ-3).
- **D5 (=Q5) — extensions are deferred.** §31.1's Phase 4 row omits them; the
  contract wins over 02-PLAN's earlier list. Timer payloads carry
  `extensionAvailable: false`. Re-adding later is additive.
- **D6 (=Q6) — tracking ships status/timeline/OTP-gated-timer/`serverNow`/`proLocation`;
  ETA does not.** `GET /api/bookings/:id/track` returns `proLocation` from
  `professionals.current_lat/lng` when present and `null` otherwise; the
  throttled `POST /api/professionals/me/location` (1 write / 30 s per client)
  feeds it. No travel model exists, so no ETA number is ever invented. Realtime
  push stays Phase 7; the phase polls.
- **D7 (=Q7) — the geofence radius is a `PLATFORM_DEFAULTS` constant.**
  `DEFAULT_ARRIVAL_RADIUS_M` env override, default 100 m, same pattern as every
  other constant (Pitfall 14: no settings-table query). Manual override requires
  a reason and writes `write_audit`.
- **D8 (=Q8) — edge-case legs ship detection signals only.** No-show/late
  thresholds live in `PLATFORM_DEFAULTS`; the 30-minute hold cron,
  reassignment, and `next_job_late_min` penalties stay Phases 5/9
  ("crons: none belong to Phase 4" is explicit in the spec's own research).
- **D9 — no new npm packages, no new crons, no refund UI, no `NEXT_PUBLIC_`
  secrets.** `vercel.json` is untouched. Zero-install means the Package
  Legitimacy Gate never triggers; `T-4-SC` below stays a standing assertion.

## Tasks

### Wave A — foundation, availability, migrations, and the push

Closing: `P4-03`, the shared-module half of `P4-10`, and every schema object the
later waves stand on.

<task type="auto" tdd="true">
  <name>Task A1 — the shared server module, the browser client, and the OTP helpers</name>
  <files>lib/professionalServer.ts, lib/professionalClient.ts, lib/serviceOtp.ts, lib/constants.ts, test/professionalClient.test.ts, test/serviceOtp.test.ts</files>
  <behavior>
    - `requireProfessional` accepts a professional token, refuses a customer with 403, refuses anonymous with 401 — mirroring `requireCustomer` exactly.
    - Every export of `lib/professionalClient.ts` attaches `authorization: Bearer …`; a single test iterates every export and fails if one verb omits the header (Pitfall 2 regression pin).
    - `generateServiceOtp()` returns exactly `serviceOtpLength` digits; `redactOtpForLog('1234')` never contains `1234`; expiry/lockout math is pure and unit-tested.
  </behavior>
  <action>
    Three modules and two test files. No routes, no pages, no migrations — this
    task exists so every later task imports a finished contract instead of
    inventing one.

    `lib/constants.ts` first (smallest, everything imports it): extend
    `PLATFORM_DEFAULTS` with the phase's constants, each with its env-override
    sibling in the existing style — `offerTtlMinutes` (default 15),
    `serviceOtpLength` (4), `otpTtlMinutes` (10), `otpMaxAttempts` (3),
    `otpLockoutMinutes` (15), `otpMaxGenerations` (3), `defaultArrivalRadiusM`
    (env `DEFAULT_ARRIVAL_RADIUS_M`, default 100 — D7), `lateArrivalThresholdMin`,
    `noShowAfterMin` (D8). No settings-table queries anywhere (Pitfall 14).

    `lib/serviceOtp.ts`: pure helpers over those constants — `generateServiceOtp()`
    (delegating to `lib/otp.ts`'s generator), `hashServiceOtp(code)` (SHA-256 hex,
    the form `0010`'s `otp_hash` and the spec's verify SQL expect),
    `redactOtpForLog(code)` (the "never log the plaintext" guard), `otpIsExpired(expiresAt, serverNow)`,
    `otpIsLocked(lockedUntil, serverNow)`, `otpAttemptsExhausted(attempts)`.
    Nothing here touches the database or `Date.now()` in a way the tests cannot
    inject — expiry math takes `serverNow` as a parameter (server-authoritative
    clock, Interaction Contract 2).

    `lib/professionalServer.ts`, modelled on `lib/bookingServer.ts` (read it in
    full first — `04-PATTERNS.md` L65-128 carries the excerpt and the doc-comment
    hand-off). Export surface, fixed now:
    `requireProfessional(req)` (`.from('professionals')`, role `professional`);
    `requireVerifiedProfessional(req)` (same, then refuses
    `verification_status !== 'verified'` with the verification-gate error the UI
    banner renders — Interaction Contract 11); `getProBookingForCaller(id, professionalId, role)`
    (ownership the customer analog does, professional side);
    `PRO_JOB_COLUMNS` — the explicit column list, **never `select('*')`** — and
    `stripProBooking(booking, stage)` — **the one function that owns every
    pro/staff booking payload** (Pitfall 13): always strips `otp_hash`; strips
    customer phone and full address when `stage === 'offered'` (§14.3,
    Interaction Contract 6); keeps locality/area and first name only. Update
    `lib/bookingServer.ts`'s doc comment to point at the new module so the
    "Phase 4's concern" hand-off is closed, not left dangling.

    `lib/professionalClient.ts`, modelled on `lib/bookingClient.ts` (and read
    `test/bookingClient.test.ts` first — it exists precisely because 489 green
    tests never imported the module that was broken). One export per §25.7 verb
    this phase ships: `fetchWorkingHours`, `saveWorkingHours`, `fetchTimeOff`,
    `addTimeOff`, `deleteTimeOff`, `fetchAvailability`, `setAvailability`,
    `fetchKyc`, `fetchJobs`, `fetchOffers`, `acceptOffer(id)`,
    `declineOffer(id, reason)`, `arriveJob(id, { lat, lng, overrideReason })`,
    `verifyServiceOtp(id, code)`, `completeJob(id)`, `reportNoShow(id, reason)`,
    `postLocation({ lat, lng })`. Every one goes through the same
    authenticated-fetch helper; the Authorization header is not a per-verb
    decision.

    `test/professionalClient.test.ts`: the two cases `04-PATTERNS.md` L592-611
    specifies — one case per verb asserting the bearer token, and the
    "every export" loop that makes a future forgotten header a red test rather
    than a production 401. Plus network-error and no-session cases copied from
    the `bookingClient` analog.

    `test/serviceOtp.test.ts`: digit-count over 200 draws, RNG sanity (all ten
    digits seen — the `test/otp.test.ts` birthday-problem comment explains why),
    explicit-length honouring, expiry math at the boundary, lockout math, and
    the redaction invariant (`redactOtpForLog` output must not contain the input
    code as a substring).
  </behavior>
  <verify>
    <automated>npx vitest run test/professionalClient.test.ts test/serviceOtp.test.ts; npm run typecheck</automated>
  </verify>
  <done>The three modules exist with the export surfaces above; both test files are green; `lib/constants.ts` carries the nine new defaults; no route, page or migration has been touched; and every later task in this plan can import these names without defining them.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A2 — availability: working hours, time off, the online toggle, and the home-page repair</name>
  <files>app/api/professionals/me/working-hours/route.ts, app/api/professionals/me/time-off/route.ts, app/api/professionals/me/availability/route.ts, app/professional/availability/page.tsx, app/professional/page.tsx, test/routes.professionals.test.ts</files>
  <behavior>
    - `PUT /me/working-hours` rejects a body whose windows overlap or fall outside 00:00–24:00, and refuses to write for another professional's row.
    - `POST /me/time-off` refuses a date already blocked (409), and a professional cannot read or delete another's time off.
    - `POST /me/availability` flips `availability_status` between `online` and `offline` server-side; the toggle is the only optimistic UI in the phase (Interaction Contract 4).
    - `/professional` no longer claims availability "arrives in Phase 3".
  </behavior>
  <action>
    The three routes are CRUD clones of
    `app/api/customers/me/addresses/route.ts` (`04-PATTERNS.md` L177-237 carries
    the shape and the rename table): same `handle(req, 'professionals.…', …)`
    envelope, same `requireAuth(req, ['professional'])`, same explicit column
    lists, same ownership filter — professional A can never read or write
    professional B's hours or time off. The tables, grants and the GiST overlap
    machinery already exist from `0005`; these routes are the first writers and
    must surface the database's overlap refusal as `PROFESSIONAL_UNAVAILABLE`
    (Pitfall 7: never let a raw `23P01` reach the client).

    `test/routes.professionals.test.ts` is **created here** — the Wave-0 harness
    `04-VALIDATION.md` requires — by copying the request/build/mock shape from
    `test/routes.addresses.test.ts` (Code Example #6, `04-PATTERNS.md` L546-588):
    `FakeSupabase` with a professional `PROFILE`, a `professionals` table stub,
    the `request()` helper with Bearer token, and the 401/403/404-zero-writes
    idioms. Populate it with the availability cases first; later waves append
    KYC and arrive/OTP cases to this same file.

    `app/professional/availability/page.tsx`: `AuthGuard role="professional"`
    inside `RoleShell` (the frame every new professional page uses), the online
    `Switch` with label ("Go online" / "Go offline"), a weekly working-hours
    editor saved through "Save hours", and the time-off list with the
    "No time off booked" `EmptyState` and add-date flow, using the exact copy
    rows from `04-UI-SPEC.md`'s Copywriting Contract. Toast on save
    ("Hours saved."), field errors 12 px `text-red-600` with `aria-invalid`.

    `app/professional/page.tsx` (modify): fix the Phase-3 copy bug at L119 —
    "Availability and scheduling arrive in Phase 3" — by wiring the card to the
    real `GET /me/availability` state with links into the new page. **Only the
    availability half of the home repair happens here**; today's-jobs-from-API
    (L112-116) waits for Task B2, which owns the `me/jobs` route — editing this
    file twice in one wave would be a conflict, editing it once per wave is not.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.professionals.test.ts; npm run typecheck</automated>
  </verify>
  <done>The three routes exist, ownership- and validation-tested in the new harness file; `/professional/availability` renders and mutates real state through the client module; the home page's availability card tells the truth; and `test/routes.professionals.test.ts` is the shared harness the KYC and OTP tasks will append to.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A3 — migrations 0012, 0021, 0029, the type mirror, and the RLS flake fix</name>
  <files>supabase/migrations/0012_assignment_integrity.sql, supabase/migrations/0021_earnings.sql, supabase/migrations/0029_service_execution.sql, supabase/schema.sql, lib/supabase.ts, test/db.rls.test.ts, .planning/STATE.md</files>
  <behavior>
    - `0012` creates `booking_assignments` with the partial unique index that makes double-acceptance impossible, plus `accept_offer`/`decline_offer` CAS RPCs and the `sweep_new_bookings` minimal producer (D1).
    - `0021` creates `professional_earnings` with select-only RLS and no anon access (partial ship, D4).
    - `0029` creates `arrive_job`, `issue_service_otp`, `verify_service_otp`, `complete_job`, `no_show_job`, and the KYC roll-up — all `security definer`, all service-role-only, all single-statement in the `0028` style — and revokes blanket column access to `bookings.otp_hash`.
    - `npm run db:schema` output matches disk, and `lib/supabase.ts` gains the new tables' type triples.
    - The known `db.rls` flake at line 141 is gone.
  </behavior>
  <action>
    **Read spec §24.8 verbatim before writing `0012`** — Assumption A3 in
    `04-RESEARCH.md` records that research only read the §9.1/§9.4 fragments, and
    the table's column list is not invented here. Then, in house voice with a
    WHY header (why this file exists, that it reverses STATE's Phase-5 deferral
    per D1, what it deliberately does not do — no advisory lock, no fan-out, no
    sweeper; those are Phase 5's):

    `0012_assignment_integrity.sql` — the `assignment_status` enum
    (`offered`, `accepted`, `declined`, `expired`, `cancelled` — confirm each
    value against §24.8; the spec is the source), the `booking_assignments`
    table (§24.8 columns verbatim), and the index that is the phase's
    concurrency guarantee:
    `create unique index if not exists uniq_active_assignment_per_booking on public.booking_assignments (booking_id) where status in ('offered','accepted');`
    (syntax analog: `0001_core_identity.sql:57`). RLS: professional selects own
    rows, anon revoked, **no browser write policy** — the service role writes
    through the RPCs only. Then two RPCs in the `0028` template
    (`security definer`, `set search_path = public`, `app.transition_*` settings,
    comment on every function, revoke-all-then-grant-service-role):
    `accept_offer(p_assignment_id uuid, p_professional_id uuid)` — the spec's own
    CAS (`WHERE id = $1 AND professional_id = $2 AND status = 'offered' AND expires_at > now() RETURNING *`; zero rows ⇒ the caller answers 409
    `ASSIGNMENT_TAKEN` or `PROFESSIONAL_UNAVAILABLE` by re-reading) — which also
    inserts the `reserved` `professional_schedule` window (the GiST exclusion is
    the overlap backstop; map its `23P01` to `PROFESSIONAL_UNAVAILABLE`, Pitfall
    7) and flips the booking `assigned → on_the_way`-ready per the `0011`
    transition table; and `decline_offer(p_assignment_id uuid, p_professional_id uuid, p_reason text)`
    — records the reason and the exclusion (D1). Plus `sweep_new_bookings()`:
    for each `paid` booking with no active assignment, pick one eligible
    professional (verified, online, not on time off for the window, no clashing
    schedule row, service-area match) and insert one offer with
    `expires_at = now() + (PLATFORM_DEFAULTS offer TTL minutes)`. ~30 lines, no
    ranking — the header says in one sentence that Phase 5 replaces this
    function whole.

    `0021_earnings.sql` — `professional_earnings` (booking FK unique,
    professional FK, `gross/commission/net numeric(12,2)`, `status` default
    `'pending'`, timestamps), select-only RLS for the owning professional plus
    staff, anon revoked. Partial-file rationale in the header, citing
    `0017_ratings.sql` as the precedent (D4).

    `0029_service_execution.sql` — five RPCs plus the KYC roll-up, each in the
    `cancel_booking` template (`04-PATTERNS.md` L497-529):
    `arrive_job(p_booking_id, p_professional_id, p_expected_version)` —
    `on_the_way → arrived` only, sets `arrived_at`, bumps version (single
    statement; Pitfall 4); the geofence itself is checked in the route (D7), the
    RPC trusts a route that has already decided; `issue_service_otp(p_booking_id, p_code_hash, p_ttl_minutes)`
    — only from `arrived`, only while `otp_generations < otpMaxGenerations`,
    writes `otp_hash`/`otp_expires_at`, increments `otp_generations`;
    `verify_service_otp(p_booking_id, p_code, p_max_attempts)` — the spec's own
    SQL (`04-RESEARCH.md` Code Example #1) extended with the attempt increment
    in the same transaction and the lockout column (add
    `otp_locked_until timestamptz` to `bookings` in this file if it does not
    exist — an `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, commented as the D3
    lockout's home); zero rows ⇒ the caller logs `OTP_INVALID`/`OTP_EXPIRED`/
    `OTP_LOCKED` and the **client always receives the same generic 403**
    (Pitfall 5); success sets `status='otp_verified'`, `otp_verified_at`,
    `started_at = now()`, `ends_at = now() + duration_minutes` — server clock,
    one statement; `complete_job(p_booking_id, p_professional_id, p_expected_version)`
    — `completed`, `ended_at`, `actual_duration_minutes` from `started_at`,
    closes the schedule row (`reserved → completed`), bumps the professional's
    completed-jobs counters, and inserts the pending `professional_earnings`
    row (D4 — money via the `numeric(12,2)` conventions `lib/money.ts` already
    bridges; read STATE.md's earnings notes for the commission basis before
    writing the arithmetic); `no_show_job(p_booking_id, p_professional_id, p_reason)`
    — read the `0010` enum and the `0011` transition table first and use only
    legal values; reason mandatory; `write_audit` on every call; **the function
    must not touch refunds or wallets** (hard rule 2 — a professional never
    self-cancels into a refund path); `kyc_document_decision(p_document_id, p_verdict, p_admin)`
    — the D2 roll-up: verdict on the document, then all-required-`verified` ⇒
    `professionals.verification_status='verified'` + `kyc_verified_at=now()`,
    any-`rejected` ⇒ `rejected`, audit row naming the admin.

    Column hardening in the same file (Pitfall 1, the verified exposure):
    revoke blanket `select` on `bookings` from `authenticated` and re-grant
    **every column except `otp_hash`** (Code Example #8; `[ASSUMED]` standard
    Postgres behaviour, verified live by the db.rls assertion below — if the
    column-grant form fails on the live project, fall back to a `view`-free
    route-layer strip only and say so loudly in the migration header rather
    than shipping a silent hole).

    `lib/supabase.ts`: `assignment_status`, the
    `Row/Insert/Update` triples for `booking_assignments` and
    `professional_earnings`, and the `otp_locked_until` addition to the
    `bookings` triple, hand-maintained in the existing shape. Then
    `npm run db:schema` so `supabase/schema.sql` matches disk.

    `test/db.rls.test.ts` (modify): fix the known Wave-0 flake first — line 141's
    predicate `u.email like '%@smarthelp.test'` also matches transient fixtures
    from `db.payments`/`db.wallet`; narrow it to `like 'demo.%@smarthelp.test'`
    (`04-VALIDATION.md` Wave-0 checklist item 1). The new policy assertions for
    `booking_assignments`, `professional_earnings`, the `kyc-documents` bucket
    and the `otp_hash` column privilege are **not** written here — they land
    with the tasks that exercise their subjects (B2 and C1), because a policy
    assertion written before its policy exists is a guess.

    `.planning/STATE.md` (modify): update the "booking_assignments and
    assignment_status are deferred to Phase 5" bullet — D1 reversed it; the
    line now says Phase 4 reclaimed `0012` with the minimal producer and points
    at this plan. One bullet, no restructure.
  </behavior>
  <verify>
    <automated>node scripts/check-migrations.mjs; npm run typecheck; npx vitest run test/db.rls.test.ts</automated>
    <human-check>PRE-PUSH — `db:migrate` is NOT run here. The three migration files exist and dry-run cleanly; the live project is unchanged until the Wave A gate (Task A4) applies them with approval.</human-check>
  </verify>
  <done>All three migrations exist with WHY headers recording D1/D3/D4 and the §24.8 verbatim check; the RPC grant blocks are service-role-only; `otp_hash` is column-revoked; `lib/supabase.ts` and `schema.sql` are rebuilt; the flake fix is in; STATE's deferral line is corrected; and the live database is still untouched.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task A4 — Wave A gate: the schema push</name>
  <files>(no files created; runs the gate commands in order)</files>
  <what-built>Everything in Tasks A1–A3, verified as a whole, and — with approval — the three migrations applied to the live Supabase project exactly once.</what-built>
  <how-to-verify>
    **PRE-PUSH steps, run in order, all must be green before the checkpoint is offered:**

    1. `npm run typecheck` — exit 0.
    2. `npm run lint` — exit 0. Slow (>240 s); this is its only scheduled run in Wave A.
    3. `npm run build` — exit 0.
    4. `node scripts/check-migrations.mjs` — dry-run of the outstanding migrations; one transaction, always rolled back.
    5. `npx vitest run --exclude "test/db.assignments.test.ts" --exclude "test/db.jobs.test.ts"` — the full suite with the two not-yet-created live-db files held out (they arrive in Waves B/C and cannot pass until `0012`/`0029` exist). Green at the 655 floor; `test/db.rls.test.ts` runs here and must already pass with the flake fix.

    **Then this checkpoint pauses for approval. On approval, POST-PUSH steps:**

    6. `npm run db:migrate` — applies `0012`, `0021`, `0029` to the live project. **This is the phase's one write to the live database and the reason the plan is not autonomous.**
    7. `npm run db:verify` — schema matches disk.
    8. `npm test` — no exclusions; green, ≥655 tests.
    9. `npm run test:db` — green, ≥77 tests, `db.rls.test.ts` including its storage assertions against the real bucket.

    If any PRE-PUSH step fails, fix before offering the checkpoint. If step 6 fails mid-apply, stop and report — do not re-run blindly.
  </how-to-verify>
  <resume-signal>Type "approved" to apply the migrations, or describe the failure to fix first.</resume-signal>
</task>

### Wave B — KYC, offers, and the arrive/OTP spine

Closing: `P4-01`, `P4-02`, `P4-04`, `P4-05` (arrive), `P4-06` (route layer), and
the shared-module half of `P4-10`. **Wave B does not start until the Wave A gate
is passed.**

<task type="auto" tdd="true">
  <name>Task B1 — KYC end-to-end: signed upload, submission, admin verdict with roll-up, and the professional's verification screen</name>
  <files>app/api/kyc-documents/upload-url/route.ts, app/api/professionals/me/kyc/route.ts, app/api/admin/professionals/[id]/kyc/[docId]/decision/route.ts, components/professional/KycStepper.tsx, app/professional/kyc/page.tsx, test/routes.professionals.test.ts, test/routes.kycDecision.test.ts</files>
  <behavior>
    - The upload-url route confines every path to `${professionalId}/${docType}/${filename}` with `docType` on a three-value allow-list (`identity`, `address`, `selfie` — match the `0005` doc-type enum), and refuses for a professional whose token does not own the path (Pitfall 10).
    - `POST /me/kyc` inserts the `status='submitted'` row the `0005` insert policy requires; anon has no policy to attempt.
    - The admin decision route 403s a non-admin, writes the verdict through the service role (the guard triggers permit exactly this), calls the `0029` roll-up RPC, and audits — a customer token gets 403 with zero writes.
    - The KYC page never renders internal reviewer notes (§20.10).
  </behavior>
  <action>
    Three routes, two components, two test files — the KYC vertical slice.
    Append to `test/routes.professionals.test.ts` (the P4-01 cases per
    `04-VALIDATION.md`'s map — this file is the designated home, so there is no
    deviation to record): the harness already exists from A2.

    `app/api/kyc-documents/upload-url/route.ts` — `POST`, professional-only via
    `requireProfessional`; body `{ docType, filename }`; `docType` allow-list;
    path built server-side as `${professionalId}/${docType}/${filename}` (never
    taken from the body — Pitfall 10); `supabase.storage.from('kyc-documents').createSignedUploadUrl(path)`
    (Code Example #7; the call/response shape is `[ASSUMED]` — the method's
    existence is verified in the installed bundle, so the first test pins the
    real shape; if it differs, adapt the route, not the storage policy). The
    route returns the signed URL + token + path; the browser completes the
    upload with `uploadToSignedUrl`. Size/MIME rejection is **client-side
    pre-check plus route-level declaration check** (≤5 MB; images + PDF) — the
    signed URL cannot enforce bytes, and the bucket policy is the backstop;
    say so in the route's comment rather than pretending otherwise.

    `app/api/professionals/me/kyc/route.ts` — `GET` (documents + roll-up status
    for the calling professional) and `POST` (submit: the `status='submitted'`
    row). Both `requireProfessional`; explicit column lists; the payload never
    includes reviewer notes.

    `app/api/admin/professionals/[id]/kyc/[docId]/decision/route.ts` — `POST`,
    `requireAuth(req, ['admin','super_admin','ops'])` (the staff set every
    existing staff policy uses), body `{ verdict: 'verified'|'rejected', note? }`;
    service-role write to `professional_documents` (guard triggers allow it),
    then `kyc_document_decision` RPC for the roll-up, then `write_audit`.
    No UI — Phase 6 builds the queue on this endpoint (D2, Phase 3's
    API-without-UI pattern). `test/routes.kycDecision.test.ts` (new): 403 for a
    customer token with `expect(fake.writesTo('professional_documents')).toHaveLength(0)`,
    happy path asserting the RPC call and the audit call, invalid verdict → 422.

    `components/professional/KycStepper.tsx` — three steps (Identity / Address /
    Selfie) with per-step status chips reusing `VERIFICATION_COPY` tones from
    `app/professional/page.tsx:18-44`; "never show internal notes" enforced by
    simply having no field for them.

    `app/professional/kyc/page.tsx` — `AuthGuard` + `RoleShell`; the amber
    verification banner (reuse the shipped pattern verbatim for `submitted`/
    `rejected` gates — Interaction Contract 10-11); per-document upload flow per
    Interaction 9: client pre-check (≤5 MB, MIME) → signed-URL upload →
    `status='submitted'` row; the "Upload documents" / "Submit for review" CTAs
    and the "Replace this document?" confirmation dialog, all with the exact
    copy from the UI-SPEC Copywriting Contract.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.professionals.test.ts test/routes.kycDecision.test.ts; npm run typecheck</automated>
  </verify>
  <done>All three routes exist with the behaviours above; the admin endpoint flips a real professional to `verified` through the roll-up RPC; both test files are green; `/professional/kyc` uploads, submits and renders per-document status through the stepper; and no payload contains a reviewer note.</done>
</task>

<task type="auto" tdd="true">
  <name>Task B2 — offers: the inbox read, CAS accept, reasoned decline, the jobs page, and the live assignment proofs</name>
  <files>app/api/professionals/offers/route.ts, app/api/professionals/offers/[id]/accept/route.ts, app/api/professionals/offers/[id]/decline/route.ts, app/api/professionals/me/jobs/route.ts, components/professional/OfferCard.tsx, components/professional/JobCard.tsx, components/auth/RoleShell.tsx, app/professional/jobs/page.tsx, app/professional/page.tsx, test/routes.offers.test.ts, test/db.assignments.test.ts, test/db.rls.test.ts</files>
  <behavior>
    - The inbox response for an open offer contains service name, window, locality/area, quoted price and `expiresAt` — and never a phone number, full address, or customer name beyond first name (§14.3, Interaction Contract 6).
    - An offer past its TTL is refused at read and at accept (lazy expiry, Pitfall 6), and `sweep_new_bookings` has run at the top of the inbox read.
    - `accept_offer` under 50 concurrent calls yields exactly one `accepted` row; the forty-nine losers get 409.
    - A professional whose token is not the offer's owner gets 404 with zero writes on both accept and decline.
    - `db.rls` proves anon can select nothing from `booking_assignments`.
  </behavior>
  <action>
    The offers vertical slice: four routes, three components, one shell edit,
    three test files. **The strip discipline is not re-decided here** — every
    payload goes through `stripProBooking`/`PRO_JOB_COLUMNS` from
    `lib/professionalServer.ts` (A1); Pitfall 13 exists because each route
    inventing its own list is how `otp_hash` leaks.

    `GET /api/professionals/offers` — `requireVerifiedProfessional` (an
    unverified pro sees the KYC gate, not the inbox — Interaction Contract 11);
    invoke `sweep_new_bookings()` server-side first (D1); lazy-expire the
    caller's stale offers (`offered` past `expires_at` → `expired`); select the
    caller's open offers through the explicit column list; the response fields
    are exactly the OfferCard contract (UI-SPEC OQ-4): service name, date/time
    window, locality (area only), quoted price, countdown to `expiresAt`.

    `POST /api/professionals/offers/[id]/accept` — `getProBookingForCaller`-
    style ownership (404 for another pro's offer, zero writes), then the
    `accept_offer` RPC; map its outcomes: success → 200 with the now-revealed
    job (address + phone unlock at accept, Interaction Contract 6);
    `ASSIGNMENT_TAKEN` → 409; `PROFESSIONAL_UNAVAILABLE` (GiST collision) →
    409; stale version → 409 `STALE_VERSION`. Never let `23P01` escape
    (Pitfall 7).

    `POST /api/professionals/offers/[id]/decline` — `decline_offer` RPC with the
    required reason; the response removes the card from the inbox (the UI does
    the auto-remove with the "just accepted by someone else" family of copy —
    no modal).

    `GET /api/professionals/me/jobs` — the professional's accepted/active jobs,
    owner-filtered, `stripProBooking(…, 'accepted')` (address now included).
    This is the route the home page has been waiting for since A2.

    `components/professional/OfferCard.tsx` / `JobCard.tsx` — built from the
    shipped catalogue-card primitives; the Accept CTA is the visual anchor,
    Decline is ghost/outline **not red** (Copywriting Contract); countdown is a
    meta line, never competing with the CTA; status chips via
    `statusPresentation` only.

    `components/auth/RoleShell.tsx` (modify) — the red-dot badge on the **Jobs**
    nav item (Interaction Contract 3): `h-2 w-2 rounded-full bg-red-600`,
    `aria-label="N open offers"`, count client-derived from the 5 s poll with
    `aria-live="polite"` on the count — not on the poll. `SECTION_LABELS`
    already has the labels; this is a badge slot, not a nav rewrite (UI-SPEC
    OQ-2: RoleShell wins over §19.2's bottom nav).

    `app/professional/jobs/page.tsx` — offers inbox (5 s poll per Interaction
    Contract 1: `clearInterval` cleanup, abort in-flight, skip overlapping
    ticks, pause on `document.hidden`, refresh on visibility return) plus
    today's accepted jobs from `me/jobs`; both empty states with the exact
    UI-SPEC copy; the 409 copy paths (taken / overlap / stale) auto-remove the
    card and toast, never modal.

    `app/professional/page.tsx` (modify, second and final touch) — wire L112-116
    today's jobs from `me/jobs` (A2 fixed the availability half).

    `test/routes.offers.test.ts` (new, FakeSupabase): field filtering (the
    payload for an open offer must not contain phone/full-address keys —
    assert with `not.toContain` on the stringified body), lazy expiry refusal,
    accept success calling the RPC, accept collision → 409, decline records the
    reason, cross-pro 404 with `writesTo` empty. Every payload test carries the
    P4-10 line: `expect(JSON.stringify(json)).not.toContain('otp_hash')`.

    `test/db.assignments.test.ts` (new, live — runs under `npm run test:db`
    only, post-push): 50 concurrent `accept_offer` calls ⇒ exactly one winner
    (`DB_TIMEOUT = 60_000`, `professionalOf` fixture from `db.booking.test.ts`);
    expired offer refused; schedule overlap ⇒ `PROFESSIONAL_UNAVAILABLE`;
    cross-pro isolation. Behaviour assertions only, never schema inspection —
    copy `db.booking.test.ts`'s doc-comment stance.

    `test/db.rls.test.ts` (modify, final touch) — the `booking_assignments`
    and `professional_earnings` policies, the `kyc-documents` no-public-policy
    assertions, and the `otp_hash` column-privilege check (`authenticated`
    selects the booking but the select errors/omits on `otp_hash` — this is the
    A3 hardening's proof, and if it fails, the A3 fallback plan is triggered
    loudly, not quietly).
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.offers.test.ts; npm run test:db -- --no-file-parallelism test/db.assignments.test.ts test/db.rls.test.ts; npm run typecheck</automated>
  </verify>
  <done>The inbox polls and field-filters; accept is CAS-clean under 50-way concurrency against real Postgres; decline records a reason; the jobs page, cards and nav dot render per the UI-SPEC contracts; the home page's jobs card is live; and the RLS file proves the new tables' policies plus the `otp_hash` column revocation.</done>
</task>

<task type="auto" tdd="true">
  <name>Task B3 — arrive with geofence, the OTP verify and mint routes, and the job-detail screen</name>
  <files>app/api/professionals/jobs/[id]/arrive/route.ts, app/api/professionals/jobs/[id]/otp/route.ts, app/api/bookings/[id]/otp/regenerate/route.ts, components/booking/OtpEntry.tsx, components/booking/ServiceTimer.tsx, app/professional/jobs/[id]/page.tsx, test/routes.professionals.test.ts</files>
  <behavior>
    - `arrive` computes haversine distance server-side from the submitted coordinates; outside `defaultArrivalRadiusM` it refuses unless `overrideReason` is present, and every override writes an audit row with the reason (D7).
    - The professional's OTP route calls `verify_service_otp`; wrong, expired and locked each return the same generic 403 — the response body never distinguishes them (Pitfall 5).
    - The customer-only mint/regenerate route 403s a professional token; generation 1 mints, generation 4 (the 4th call) refuses; the plaintext appears in this response and nowhere else, is never logged (`redactOtpForLog`), and is never re-readable.
    - The job-detail page offers no action the state machine forbids (Interaction Contract 5).
  </behavior>
  <action>
    Three routes, two components, one page, appends to the shared harness file.

    `POST /api/professionals/jobs/[id]/arrive` — `requireVerifiedProfessional`;
    ownership via `getProBookingForCaller`; read `{ lat, lng, overrideReason? }`;
    distance via `haversineKm` against the booking's address coordinates; pass
    or refuse; on the manual-override path, `write_audit` with the reason
    **before** the RPC (an unaudited override is the threat, not the override);
    then `arrive_job` with the expected version. Map `ILLEGAL_TRANSITION` →
    409, stale version → 409 `STALE_VERSION`.

    `POST /api/professionals/jobs/[id]/otp` — `requireVerifiedProfessional`;
    ownership; body `{ code }` (4 digits, validated); call
    `verify_service_otp`; success → the booking now `otp_verified` with
    `started_at`/`ends_at` set (the response carries them so the timer starts
    from server truth); any failure → one generic 403
    ("Invalid or expired code…"), with `OTP_INVALID`/`OTP_EXPIRED`/`OTP_LOCKED`
    logged server-side only. **This route never sees or returns a plaintext
    mint** — that is the customer's (D3).

    `POST /api/bookings/[id]/otp/regenerate` — **customer-only**
    (`requireAuth(req, ['customer'])`, ownership through the customer side of
    `getBookingForCaller`): requires `status === 'arrived'`; checks
    `otp_generations < otpMaxGenerations`; generates via
    `generateServiceOtp()`, hashes via `hashServiceOtp()`, persists the hash
    through `issue_service_otp`; returns `{ code, expiresAt }` — the single
    plaintext moment of the code's life (D3). The client caches it in
    `sessionStorage`; a refresh after expiry re-calls this route (cap 3 → the
    helper-text copy at the cap). Logging anywhere near this route uses
    `redactOtpForLog` or nothing.

    `components/booking/OtpEntry.tsx` — 4-digit `InputOTP`, `inputMode="numeric"`,
    auto-submit on the 4th digit, wrong code clears slots and refocuses slot 1,
    never prefilled, disabled until 4 digits ("Start job" CTA state —
    Interaction Contract 7).

    `components/booking/ServiceTimer.tsx` — renders `remaining = endsAt −
    serverNow` re-anchored from each 15 s poll, `tabular-nums`, `mm:ss`; at zero
    shows the "Time's up" state with Complete emphasised; `Date.now()` deltas
    forbidden (Interaction Contract 2).

    `app/professional/jobs/[id]/page.tsx` — the phone-first job flow
    (`04-PATTERNS.md` L362-398, the customer booking-detail analog): status
    badge from `statusPresentation`, customer info revealed post-accept, a
    Navigate link, and the state-derived primary CTA — **Confirm arrival**
    (geofence pass or the manual-override dialog with required reason),
    **Start job** (OtpEntry, disabled until 4 digits). Complete and no-show
    buttons do **not** ship here — Task C1 owns the completed/no-show half of
    this page; building buttons whose routes do not exist yet is how a page
    lies about what it will do. The amber verification gate disables every
    action with helper text (Interaction Contract 11). Append the arrive/OTP
    route cases to `test/routes.professionals.test.ts`: geofence refuse/pass,
    override audits (assert `write_audit` called with the reason), generic-403
    uniformity (two different failure causes ⇒ byte-identical response bodies),
    mint-route professional-token → 403, mint 4th-generation → 409, and the
    standing P4-10 `otp_hash` stringified-body assertion.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.professionals.test.ts; npm run typecheck</automated>
  </verify>
  <done>Arrive enforces the geofence with audited overrides; the professional verifies an OTP through one generic 403; the customer mints/regenerates the code exactly ≤3 times with the plaintext returned once; the job-detail page walks `on_the_way → arrived → otp_verified` through server responses only; and the harness file carries all the new assertions.</done>
</task>

### Wave C — completion and tracking

Closing: `P4-05` (completion side), `P4-07`, `P4-08`, `P4-09`, and the track
half of `P4-10`.

<task type="auto" tdd="true">
  <name>Task C1 — complete and no-show: the multi-effect RPC callers and the live job proofs</name>
  <files>app/api/professionals/jobs/[id]/complete/route.ts, app/api/professionals/jobs/[id]/no-show/route.ts, app/professional/jobs/[id]/page.tsx, test/db.jobs.test.ts</files>
  <behavior>
    - `complete` moves the booking to `completed` with `ended_at`/`actual_duration_minutes` from the server clock, closes the schedule window, bumps counters, and leaves exactly one pending `professional_earnings` row — one RPC, one statement (Pitfalls 4/9).
    - `no-show` requires a reason, writes an audit row, and performs zero refund or wallet writes (hard rule 2).
    - `test/db.jobs.test.ts` walks arrive → verify → complete and arrive → no-show against real Postgres, including attempts/lockout and the `otp_hash`-invisible-to-`authenticated` regression.
  </behavior>
  <action>
    Two routes, the second half of the job-detail page, and the phase's main
    live-DB test file.

    `POST /api/professionals/jobs/[id]/complete` — ownership; expected version;
    `complete_job` RPC (A3); success returns the finished booking with its
    earning summary; `ILLEGAL_TRANSITION`/`STALE_VERSION` → 409. The UI's
    "Complete job" is enabled at timer zero or early-with-confirmation
    (Interaction Contract: destructive-confirm family).

    `POST /api/professionals/jobs/[id]/no-show` — ownership; body
    `{ reason }` required (422 without); `no_show_job` RPC; the route's comment
    states in one line why no refund path exists here (hard rule 2, D8).

    `app/professional/jobs/[id]/page.tsx` (modify, final touch) — the
    `in_progress` and terminal states: **Complete job** CTA with the
    ServiceTimer, and the no-show/cancel action behind the existing
    `ConfirmationDialog` with the required-reason select, danger tone, exact
    confirmation copy from the UI-SPEC ("Cancel this job? — The customer will be
    notified…"). The stepper may not offer an action the `0011` table forbids
    (Interaction Contract 5) — derive buttons from status, not from hope.

    `test/db.jobs.test.ts` (new, live — `npm run test:db` only, post-push; copy
    the `db.booking.test.ts` harness: `describeDb`, `dbUrl` skip, `closeDb`,
    `DB_TIMEOUT = 60_000`, `professionalOf`): the happy path (offer → accept →
    arrive → mint/verify → complete: assert `completed`, `ended_at` and
    `actual_duration_minutes` set, schedule row closed, counters incremented,
    one pending earning row with the right arithmetic); the sad paths (wrong
    OTP three times ⇒ locked; expired ⇒ refused; complete before `otp_verified`
    ⇒ refused; double-complete ⇒ refused); no-show with reason succeeds, audit
    row exists, and **no `refunds`/`wallets`/`wallet_transactions` row was
    written** (the negative assertion is the hard-rule proof); and the Pitfall-1
    regression: an `authenticated` client selecting its own booking cannot see
    `otp_hash`.
  </behavior>
  <verify>
    <automated>npm run test:db -- --no-file-parallelism test/db.jobs.test.ts; npx vitest run test/routes.offers.test.ts; npm run typecheck</automated>
  </verify>
  <done>Complete and no-show routes exist and are exercised against real Postgres; the job-detail page walks every state to `completed`/`no_show` through server responses; the earning row and schedule close are proven; the refund-free no-show is proven by absence; and the OTP lockout cycle is proven end-to-end at the RPC layer.</done>
</task>

<task type="auto" tdd="true">
  <name>Task C2 — the track endpoint and the customer's live booking screen</name>
  <files>app/api/bookings/[id]/track/route.ts, lib/bookingClient.ts, components/booking/OtpDisplay.tsx, app/customer/bookings/[id]/page.tsx, test/routes.track.test.ts</files>
  <behavior>
    - The track payload for an `in_progress` booking carries `startedAt`, `endsAt`, `serverNow`, `remainingSeconds` computed from the server clock, `extensionAvailable: false` (D5), and `proLocation` as coordinates-or-null (D6) — never an invented ETA.
    - Before `arrived`, the payload has no OTP block at all; at `arrived`, it carries `otpExpiresAt` for the customer and **never a code** (the code lives only in mint responses and `sessionStorage`, D3).
    - A professional caller can read the track payload for their own booking; a third party gets 404; `otp_hash` never appears in any response body (P4-10).
    - The customer's booking page renders the OtpDisplay card only at `arrived` and the timer from `serverNow`, polled at 15 s with the full Interaction Contract-1 hygiene.
  </behavior>
  <action>
    The last vertical slice, closing Phase 2's track deferral.

    `GET /api/bookings/[id]/track` — customers and the owning professional
    (`getBookingForCaller` extended for the professional caller, or composed
    with `getProBookingForCaller` — whichever keeps one ownership function, not
    two disagreeing ones). Payload, field-filtered through the shared strip
    function: status, a compact timeline, `startedAt`/`endsAt`/`serverNow`/
    `remainingSeconds` (when `in_progress`; Code Example #5 is the contract),
    `extensionAvailable: false`, `extendedMinutes: 0` (D5 — the field ships
    false, so the client's render path is already correct when Phase 8 fills
    it), `proLocation` from `professionals.current_lat/lng` when
    `location_updated_at` is fresh, else `null` (D6), and — customer caller
    only, `arrived` only — `otpExpiresAt` (never `code`, never `otp_hash`).
    `serverNow` is computed in the handler; the device clock is never consulted.

    `lib/bookingClient.ts` (modify) — one `getBookingTrack(id)` verb in the
    existing authenticated-fetch style; the customer page uses it, not an
    inline `fetch` (a second fetch idiom is a second source of truth).

    `components/booking/OtpDisplay.tsx` — the customer half of D3: at `arrived`,
    render the cached code from `sessionStorage` at 24 px
    `tabular-nums` with the "Expires in mm:ss" countdown from `otpExpiresAt −
    serverNow`; on expiry (or cold cache) the **Get a new code** CTA calls the
    regenerate route; at the generation cap, the CTA disables with the
    UI-SPEC helper text ("New code limit reached — ask support."). The card
    states in one line that the professional needs this code — plain second-
    person Indian English, "verification" not "KYC".

    `app/customer/bookings/[id]/page.tsx` (modify) — add the OtpDisplay card at
    `arrived`; drive the status ladder and the `in_progress` ServiceTimer from
    the 15 s track poll (same hygiene as the offers inbox: cleanup, abort,
    visibility pause); the existing page's booking fetch stays; refund badges
    may display (they come from `lib/status.ts`) but **no refund action or copy
    ships** (hard rule).

    `test/routes.track.test.ts` (new, FakeSupabase): payload shape (all five
    timer fields present when `in_progress`), `remainingSeconds` computed from
    the injected `serverNow`/`endsAt` (not device time), `otpExpiresAt` absent
    before `arrived` and present after, `proLocation` null-when-unset,
    third-party 404 with zero side effects, professional-owner 200, and the two
    P4-10 assertions: `JSON.stringify(body)` contains neither `'otp_hash'` nor
    the literal code value when one is minted in the fixture.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.track.test.ts; npm run typecheck</automated>
  </verify>
  <done>The track endpoint closes Phase 2's deferral with a server-authoritative payload; the customer's booking page shows the OTP card and the live timer per the Interaction Contracts; the regenerate cap is enforced client-visible; and the track payload is proven free of `otp_hash` and of any plaintext code.</done>
</task>

### Wave D — documentation and the phase gate

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task D1 — docs, and the phase gate (Tier 4 + the §30 smoke)</name>
  <files>docs/API.md, docs/FEATURES.md, docs/DATABASE.md, README.md</files>
  <what-built>The full phase, documented in the four house docs, then verified as a whole: the Tier-4 chain, and the three manual verifications `04-VALIDATION.md` reserves for a human (real file upload against the live bucket, on-device geofence override, and the §30 end-to-end smoke).</what-built>
  <how-to-verify>
    **Docs first (automated check is that they exist and match disk):**

    1. `docs/API.md` — every route this phase added, with method, path, auth shape and error codes: the three availability routes, the KYC trio (pro upload-url/submit + admin decision), the offers trio, `me/jobs`, `me/location`, the four job verbs, track, and OTP regenerate.
    2. `docs/DATABASE.md` — `0012`/`0021`/`0029`: tables, enums, the partial unique index, every RPC with its grant block, and the `otp_hash` column-revocation paragraph (including the fallback note if the column-grant form had to be adapted).
    3. `docs/FEATURES.md` — the professional app as built: KYC, availability, inbox, job execution; the nine decisions (D1–D9) each get one honest line, especially "extensions deferred" and "earnings page deferred".
    4. `README.md` — phase count and test floors updated.

    **Then the Tier-4 chain, in order:**

    5. `npm run typecheck` — exit 0.
    6. `npm run lint` — exit 0.
    7. `npm run build` — exit 0.
    8. `npm test` — green, ≥ the 655 floor **plus** every test this phase added (the floor is a floor, not a target; a deleted or renamed test is a failure).
    9. `npm run test:db` — green, ≥ the 77 floor plus `db.assignments` and `db.jobs`.

    **Then this checkpoint pauses for the three manual verifications** (`04-VALIDATION.md` Manual-Only table — no e2e runner may be installed, so these are honestly human):

    a. **KYC upload (P4-01):** log in as a professional, upload a valid doc and an oversized/wrong-MIME doc to the live `kyc-documents` bucket; confirm accepted/rejected and that the storage path is `${professionalId}/${docType}/…`.
    b. **Geofence override (P4-05):** start a job, attempt arrive from outside the radius → refused; use the manual override with a reason → accepted, with an audit row.
    c. **§30 end-to-end smoke (P4-06/07/08):** the full walk — mint the OTP on the customer screen, professional enters it, timer runs from server truth, complete lands the earning row.
  </how-to-verify>
  <resume-signal>Type "approved" when the chain is green and the three manual verifications pass, or name the failing step.</resume-signal>
</task>

## Decisions worth remembering

The nine decisions (D1–D9) are stated in full above the tasks; these are the
load-bearing *reasons*, kept where the next phase's planner will look:

- **`0012` was reclaimed because the exit criterion is unreachable without it.**
  "A verified professional can *take* a job" needs an assignment row to take;
  nothing on disk creates one. The alternative — demonstrating the criterion on
  seed fixtures — was rejected as unprovable in-product. The minimal `sweep_new_bookings`
  producer is ~30 lines Phase 5 will delete; documenting it as temporary in the
  migration header is the honesty the situation requires.
- **The OTP's single plaintext moment is a customer route, not the arrive route.**
  Hash-only storage is correct (the spec's own verify SQL compares hashes), and
  it means the code can never be re-derived — so the mint had to live behind the
  customer's session (`sessionStorage` + regenerate-within-3). If the arrive
  route minted and returned the code, the professional would receive the secret
  the professional is supposed to prove the customer knows. The spec's
  "generated at booking creation" is internally inconsistent with its own
  10-minute TTL and its own arrived-only wireframe; D3 resolves it toward the
  wireframe and records the deviation.
- **`otp_hash` is revoked at the column level, and a live test is the proof.**
  `0010`'s row policy deliberately includes `professional_id = current_professional_id()`
  — correct for the job list — while granting `select` on *all* columns, which
  would let any authenticated professional read every booking's OTP hash once
  OTPs are live. The column grant in `0029` plus the `db.jobs`/`db.rls`
  assertions are one mechanism with two witnesses; the fallback (route-layer
  strip only) is written into the migration header because a plan that cannot
  fail loudly will fail quietly.
- **No professional write touches money.** Complete inserts a *pending* earning;
  no-show touches neither refunds nor wallets; there is no extend endpoint and
  no refund action anywhere. The hard rules and §31.1's phase contract agree,
  and `test/db.jobs.test.ts`'s absence-assertions make the agreement testable.
- **The admin KYC endpoint ships without a console** — Phase 3's own precedent
  (refund API, no UI). The roll-up RPC is the piece that did not exist anywhere
  on disk; Phase 6's review screens will thank it.
- **Polling, not Realtime, and the clock, not the device.** Every interval has
  cleanup/abort/visibility hygiene; every timer is `endsAt − serverNow`. Phase
  7 replaces the transport, not the contracts.

## Threat model

### Trust boundaries

| Boundary | Description |
|---|---|
| Browser (professional) → `/api/professionals/**` | An authenticated professional whose every write must be ownership-checked in the route — the service role bypasses RLS |
| Browser (customer) → `/api/bookings/:id/otp/regenerate` | The only route that ever holds a plaintext OTP; customer-only, generation-capped, never logged |
| Browser (admin) → `/api/admin/professionals/:id/kyc/:docId/decision` | Staff capability check is the only thing between a verdict and a marketplace-wide trust flip |
| Browser → `kyc-documents` signed upload URL | An internet-reachable URL whose path confinement is the only tenant boundary |
| Route Handler → Postgres | Service role, which **bypasses RLS** — ownership must be re-checked in the route, and every payload goes through the one strip function |

### STRIDE threat register

| ID | Category | Component | Disposition | Mitigation |
|---|---|---|---|---|
| T-4-01 | Information disclosure | `bookings.otp_hash` via `bookings_select_own` | mitigate | Column-level revoke + re-grant without `otp_hash` in `0029`; one strip function owns every pro/staff payload; proven by `db.jobs` + `db.rls` assertions and the P4-10 stringified-body pin in every payload test |
| T-4-02 | Information disclosure | plaintext OTP leakage | mitigate | Mint exists only in the customer regenerate response (D3); `redactOtpForLog` guards every log site; professional payloads never carry a code; track carries `otpExpiresAt`, never `code` |
| T-4-03 | Elevation of privilege | OTP error oracle (which check failed) | mitigate | Wrong/expired/locked return byte-identical generic 403s; the failing branch is logged server-side only (Pitfall 5); lockout enforced in `verify_service_otp`, not the client |
| T-4-04 | Tampering | double job acceptance | mitigate | `uniq_active_assignment_per_booking` partial unique index + CAS `accept_offer`; 50-way concurrency proven in `db.assignments`; the advisory lock stays Phase 5's (D1) |
| T-4-05 | Tampering / spoofing | arrive geofence bypass | mitigate | Haversine computed server-side; override requires a reason and writes `write_audit` before the RPC (D7); `arrive_job` is version-guarded, single-statement |
| T-4-06 | Elevation of privilege | self-verification (professional flips own `verification_status`) | mitigate | Verdicts only through the admin route's service-role write + `kyc_document_decision` RPC; the `0005` guard trigger refuses non-trusted sessions; no professional-writable policy exists (Pitfall 11) |
| T-4-07 | Tampering | KYC path escape (uploading another professional's slot, or into a public path) | mitigate | Path built server-side from the authenticated professional's id + allow-listed docType; bucket has no public policy (asserted in `db.rls`); signed URL is the only write channel (Pitfall 10) |
| T-4-08 | Repudiation | no-show / cancellation without provenance | mitigate | Mandatory reason + `write_audit` on every `no_show_job` call; transition history rows carry the actor via `app.transition_*` |
| T-4-09 | Tampering | cross-professional offer/job reads | mitigate | `requireProfessional` + ownership 404 with zero writes (asserted via `writesTo` in the route tests); RLS select-own policies as defence-in-depth on the tables |
| T-4-SC | Tampering | npm installs | mitigate | **No packages are installed in this phase** (hard rule 1; `input-otp`, `recharts`, storage-js all pre-installed); slopcheck still applies to any install a task might otherwise introduce, and a blocking human checkpoint is required for any `[ASSUMED]`/`[SUS]` package |

## Verification

The Wave A gate (A4) and the phase gate (D1) are the two blocking checkpoints.
**Every command is labelled with its side of the schema push** — before A4
applies `0012`/`0021`/`0029`, the not-yet-created live-db files cannot exist and
the not-yet-applied schema cannot pass them:

```bash
# --- PRE-PUSH: what every task's <verify> runs, and gate steps 1-5 ---
npm run typecheck
npm run lint                      # slow >240 s — wave tier only (A4, D1)
npm run build
node scripts/check-migrations.mjs # dry-run, always rolled back
npx vitest run --exclude "test/db.assignments.test.ts" --exclude "test/db.jobs.test.ts"
                                  # green at the 655 floor; the two future
                                  # live-db files are excluded BY NAME, not by hope

# --- PUSH-ONLY: gate step 6, awaits human approval, writes to the live project ---
npm run db:migrate

# --- POST-PUSH: gate steps 7-9 (A4) and 5-9 (D1); also Wave B/C per-task verifies ---
npm run db:verify
npm test                          # no exclusion: green, >= 655 floor + phase additions
npm run test:db                   # >= 77 floor; db.assignments and db.jobs live here
```

Per-task verification is the targeted `npx vitest run <file>` in each `<verify>`
block, so a failure names the task that caused it. The floors are asserted only
in the two gates; no task before a gate claims them. `test/routes.*` files run
under plain `npx vitest run` at every stage (FakeSupabase, no schema needed).

## Success criteria

- **§31.1 exit criterion:** a verified professional can take and complete a job
  — in-product, not on fixtures: the minimal producer offers a real paid booking
  to a real eligible professional, accept is CAS-clean under concurrency, arrive
  enforces the geofence, the OTP cycle runs hash-only end-to-end, and complete
  stamps the duration, closes the schedule, and writes the earning row.
- All ten requirement IDs (`P4-01` … `P4-10`) have at least one task that
  addresses them, and each task's `<done>` names what it delivered.
- The suite is green at **655 tests or more** (plus every test this phase adds),
  `npm run test:db` at **77 or more** plus the two new live-db files, with
  typecheck, lint and build clean.
- `test/db.jobs.test.ts` proves a professional no-show writes no refund or
  wallet row (hard rule 2).
- No test in the suite performs a network call; no `NEXT_PUBLIC_` secret exists;
  `vercel.json` is unchanged; **zero packages were installed**.
- The three manual verifications (live bucket upload, on-device override, §30
  smoke) pass at the phase gate.
- **No git commits were made.**

## Out of scope

- **Phase 5** — ranked matching, offer fan-out, advisory locks, the real
  assignment engine (replacing `sweep_new_bookings` whole), the expiry sweeper
  cron, the reassignment cascade and the 30-minute hold (D8), and the
  `professional_schedule` availability *input* to slot math.
- **Phase 6** — the admin console: KYC review queue UI (the endpoint it needs
  ships here, D2), manual assignment, and `platform_settings` (all constants
  remain `PLATFORM_DEFAULTS` + env, D7/Pitfall 14).
- **Phase 7** — Realtime channels, presence, chat, the notification dispatcher;
  this phase polls and says so.
- **Phase 8** — extensions (D5; `extensionAvailable` stays false), the earnings
  page and `EarningsSummary` (D4; the table lands, the payouts do not),
  wallet top-up, referrals, surge, invoices/PDF, the PWA bottom nav (OQ-2).
- **Phase 9** — `next_job_late_min` analytics and penalty flags (D8).
- **Any refund UI, any new cron, any npm install, any git commit.**

## Output

Create `.planning/phases/04-professional-app/04-SUMMARY.md` when the phase is
done, recording the two gates, the test counts against the 655/77 baselines,
the three manual-verification results, and any deviation from this plan with its
reason — the way `03-SUMMARY.md` reads.
