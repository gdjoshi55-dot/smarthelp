# Phase 4: professional-app - Research

**Researched:** 2026-10-08
**Domain:** Professional (provider) application: KYC, availability, offer inbox, job execution (arrive → OTP → complete), professional-side routes on Next.js 14 App Router + Supabase
**Confidence:** MEDIUM-HIGH (stack/patterns/schema facts HIGH — verified in repo and spec text; four scope conflicts are MEDIUM and require discuss-phase decisions before planning)

<user_constraints>
## User Constraints (from CONTEXT.md)

**No `04-CONTEXT.md` exists** (`.planning/phases/04-professional-app/` was empty at research time), so there are no user-locked decisions, discretion areas, or deferred ideas to copy. The following orchestrator-provided hard rules apply with the same authority as locked decisions:

1. **Zero new npm dependencies.** Phase 4 must ship using only packages already in `package.json` (all needed libraries are already present — see Standard Stack).
2. **No refund UI in this phase.** Refunds are Phase 3/6 scope (webhook/cron already built; admin UI is Phase 6).
3. **Mocked transport only in tests.** No network calls from tests; route tests use the in-repo `FakeSupabase` harness, DB tests use `SUPABASE_DB_URL` (already set in `.env.local`).
4. **Never expose server secrets via `NEXT_PUBLIC_`** — service-role key and DB URL stay server-only (house rule, already enforced by `test/env-inlining.test.ts`).
5. **Shell conventions:** commands are documented for PowerShell/bash compatibility; no `&&` chaining inside single shell invocations (use numbered sequential steps instead).
6. **`./AGENTS.md` does not exist** — no project-level directives to enforce.
7. **No project skills directories** (`rules/*.md` absent) — no skill patterns to load.
</user_constraints>

## Summary

Phase 4 builds the entire professional-side product surface: KYC document upload + status screen, working hours / time-off / online toggle, the offers inbox (polling, §27.3), accept/decline with compare-and-swap, arrive (geofence), customer-shared 4-digit service OTP, server-authoritative service timer, completion (duration, schedule close, counters, earning row), plus the customer-facing `GET /api/bookings/:id/track` endpoint that Phase 2 deferred to this phase. The hard fact that shapes everything: **the schema is already 80–90% built for this phase**. `bookings` has all OTP/timer columns (0010), `professional_working_hours` / `professional_time_off` / `professional_schedule` + GiST exclusion exist (0005/0013), `professional_documents` + KYC guard triggers + storage bucket policies exist (0005/0025), transition machinery (`transition_booking`, `enforce_booking_transition`, `bump_booking_version`) exists (0011/0028), and the error catalogue (`OTP_INVALID/EXPIRED/LOCKED`, `ASSIGNMENT_TAKEN`, `PROFESSIONAL_UNAVAILABLE`, `ILLEGAL_TRANSITION`, `STALE_VERSION`) already exists in `lib/api.ts`. What is **missing** is: the `booking_assignments` table (`0012`, currently deferred to Phase 5 by STATE — this directly conflicts with Phase 4's "offers inbox" scope), every `/api/professionals/**` route (none exist), every `/professional/*` page except the shell home, service-execution RPCs (`arrive`/`verify_service_otp`/`complete`/`no-show`), the KYC verdict→`professionals.verification_status` roll-up (verified absent), a signed-upload-URL route, `professional_earnings`, and column-level hardening so `bookings.otp_hash` cannot be read through the existing `bookings_select_own` RLS policy (a real, verified exposure once OTPs go live).

Four scope conflicts need a discuss-phase decision before planning: (1) **who creates the offer** — Phase 5 owns `paid → searching` matching, yet Phase 4's exit criterion is "a verified professional can *take* and complete a job"; (2) **who flips KYC to `verified`** — Phase 6 owns the review UI, but Phase 4's scope says "verification workflow" and the exit criterion needs a verified pro; (3) **`professional_earnings`** — §10.4 makes the earning row part of *complete* (a Phase 4 verb) but the table is spec-reserved to Phase 8; (4) **extensions (§10.3)** — 02-PLAN assigned them to Phase 4, §31.1's Phase 4 row omits them. Each is written up in Open Questions with a recommendation and confidence level.

**Primary recommendation:** Build Phase 4 as the *job-execution spine* on the existing write-path doctrine — claim migration `0012_assignment_integrity.sql` (reversing the Phase-5 deferral explicitly) plus one new house-numbered migration for service-execution RPCs, mint the service OTP at transition-to-`arrived`, route every professional write through single-statement versioned RPCs in the `0028` style, keep all pro reads behind Route Handlers with field-filtered payloads (never `select('*')` to the browser), and gate each route with `requireAuth` + ownership tests using the `FakeSupabase` harness.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| KYC document upload (signed upload URL) | API / Backend | Browser (selects file, uploads to URL) | Path ownership, doc_type allow-list, size/MIME policy must be enforced server-side (§24.15, §26.4); bucket is private with no select policy |
| KYC verdict + roll-up to `professionals.verification_status` | API / Backend (service-role RPC) | Database (guard triggers in 0005) | `guard_professional_document_review()` blocks non-trusted verdict writes; roll-up must be one transaction |
| Working hours, time-off, online/offline toggle | API / Backend | Browser (renders + submits) | House rule: "No client component reads a table" (`docs/API.md` §6); even though RLS+grants permit direct access, all reads/writes go through Route Handlers |
| Offers inbox (list open offers) | API / Backend (read model) | Browser (5s poll, badge count) | Read model must strip customer address/phone pre-accept (§14.3); §27.3 specifies polling until Realtime (Phase 7) |
| Offer accept / decline (CAS) | API + Database | — | Compare-and-swap on `status='offered' AND expires_at > now()` + `uniq_active_assignment_per_booking` (§9.1, §28.1) — cannot live in the browser |
| Arrive (geofence check) | API / Backend | Browser (supplies device lat/lng) | Server-authoritative distance using `haversineKm` (`lib/geo.ts`); manual override with required reason (§20.8) is a server decision |
| Service OTP mint / verify / regenerate | API + Database | Browser (customer displays code, pro submits attempts) | Hash-only storage on `bookings.otp_hash`, constant-time comparison in SQL (§10.1); plaintext code never crosses to the professional's device (§14.3) |
| Service timer (started/ends/remaining) | API / Backend (timestamps) | Browser (renders `endsAt - serverNow`) | §22.3 / §10.2: never counted locally; payload carries `serverNow` for clock-skew correction |
| Completion (duration, schedule close, counters, earning) | API + Database | Browser (confirm button) | Single guarded write path; counter columns and `professional_schedule` lifecycle move in the same transaction (§10.4) |
| `GET /api/bookings/:id/track` | API / Backend | Browser (15s poll) | Cross-role read model (customer sees OTP only after `arrived`; professional/staff payloads strip `otp_hash`) |
| Bottom-nav badge / inbox red dot | Browser | — | Derived client-side from the inbox poll (§19.2); no server state |
| No-show / pro-side cancellation handling | API + Database | Browser (buttons + reason) | Legal transitions only via §8.2; fee/reassignment logic is Phase 5/6 |

## Standard Stack

> **No packages are installed in this phase.** Every library below is already in `package.json` [VERIFIED: package.json]. The zero-new-deps constraint is satisfiable because Phase 4 needs OTP UI, charts, storage and validation — all present.

### Core (already installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | ^14.2.5 | App Router server routes + pages for all three shells | Spec §21 target stack; byte-for-byte parity with SmartPOS conventions |
| react / react-dom | ^18.3.1 | UI for `/professional/*` pages | Same |
| @supabase/supabase-js | ^2.45.4 | `createServerClient()` service-role access, RPC calls, **Storage `createSignedUploadUrl`** (method verified present in installed `node_modules/@supabase/storage-js`) | House data layer; storage API ships in the same package — no extra dependency |
| typescript | ^5.5.3 | Type-safe route handlers + `lib/supabase.ts` database types | `npm run typecheck` is the first gate |
| vitest | ^2.1.1 | Unit + route tests + DB tests (`test/**`, `describeDb`) | Existing harness: `FakeSupabase` route pattern, `describeDb` live-DB pattern |
| input-otp | ^1.2.4 | 4-digit OTP display on the customer screen and OTP entry on the professional screen | Spec §18.6 explicitly assigns "Service OTP display + entry" to `input-otp`; already a dependency |
| tailwindcss + shadcn/radix primitives | ^3.4.6 + existing set | Screens per §20.7–20.10 | Spec §18: design-system parity is non-negotiable; components already exist |
| lucide-react | ^0.441.0 | Icons for job cards / status | Spec §18.6 |
| zustand | ^4.5.4 | Any professional-side store needs (mirrors customer shell) | House store pattern |
| recharts | ^2.12.7 | Earnings summary chart only if earnings UI is in scope (§20.9) | Already installed; use only if Q4 resolves "include earnings page" |

### Supporting (already installed)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| nodemailer | ^9.0.3 | Login OTP delivery only | **Not needed for service OTP** — §20.6 displays the code in-app; no SMS/email path |
| pg (dev) | ^8.23.0 | `test/db.*.test.ts` direct SQL against `SUPABASE_DB_URL` | DB-level tests (concurrency CAS, RPC behavior, RLS) |
| sonner / react-hot-toast | existing | Success/error toasts for accept/arrive/complete | House feedback pattern |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| House `lib/validation.ts` validators | zod / joi | Rejected: zero-new-deps rule + house pattern is hand-rolled allow-lists already covering uuid/lat/lng/enum/length |
| Route Handlers for everything | Direct PostgREST from pro browser client | Rejected: `docs/API.md` §6 states "No client component reads a table"; also exposes `bookings.otp_hash` (see Pitfall 1) |
| Playwright e2e for the accept→complete journey | Vitest route tests + DB tests + manual §30 smoke | Rejected for now: Playwright is not installed and cannot be added under zero-new-deps; e2e must be an explicitly documented deferral |
| `otp_requests` ledger (`issue_otp`/`consume_otp`, purpose `service_start`) | `bookings.otp_hash` columns (already created in 0010) | Rejected: ledger is keyed on `(target, purpose)` with no booking dimension; 0010 already shipped `otp_hash/otp_expires_at/otp_attempts/otp_generations/otp_verified_at` specifically for this (§24.7) |
| `platform_settings` rows for OTP params (§10.1) | `PLATFORM_DEFAULTS` in `lib/constants.ts` (env-overridable) | Required: **`platform_settings` table does not exist anywhere in the repo** (verified grep of all migrations + schema.sql) — see State of the Art |

**Installation:**

```bash
npm install   # nothing new to add — Phase 4 adds zero dependencies
```

**Version verification:** all versions above read from `package.json` and `node_modules` this session [VERIFIED: package.json, npm registry not consulted because no installs occur].

## Package Legitimacy Audit

**Not applicable — Phase 4 installs no external packages** (hard rule 1). No slopcheck run is required because the recommendation set is empty. If a future plan revision proposes any package (e.g., Playwright for e2e), it must first run the Package Legitimacy Gate and re-emit this section with a full table.

**Packages removed due to slopcheck [SLOP] verdict:** none (no candidates)
**Packages flagged as suspicious [SUS]:** none (no candidates)

## Architecture Patterns

### System Architecture Diagram

```
ENTRY POINTS
  Professional phone   ── /professional/* pages (AuthGuard + RoleShell, bearer session)
  Customer browser     ── /customer/bookings/[id] (live booking: stepper, OTP, timer)
  Admin console        ── POST /api/admin/professionals/:id/kyc/:docId/:decision
                         (Phase 4 ships the ENDPOINT only; the Phase-6 review UI
                          consumes it — same pattern Phase 3 used for refund APIs)
        │  Authorization: Bearer <session>   (lib/sessionHeaders.authorizationHeader)
        ▼
API TIER — Route Handlers (service-role client, ownership filters, house error envelope)
  /api/professionals/me/{working-hours | time-off | availability | kyc | jobs | location | earnings}
  /api/professionals/offers                       GET  (5s poll inbox, field-filtered)
  /api/professionals/offers/:id/{accept|decline}  POST (CAS accept → schedule window insert)
  /api/professionals/jobs/:id/{arrive|otp|complete|no-show}  POST (guarded RPCs)
  /api/bookings/:id/track                         GET  (15s poll: status, OTP-if-arrived,
                                                      serverNow, pro location if present)
  /api/bookings/:id/otp/regenerate                POST (max 3 = otp_generations, §25.6)
  /api/kyc-documents/upload-url                   POST (signed upload URL, path ownership)
        │  requireAuth / requireCapability / getBookingForCaller-analog ownership check
        ▼
DATABASE TIER — single guarded write paths (service role bypasses RLS ⇒ handler must filter)
  NEW RPCs:  verify_service_otp | arrive_job | complete_job | no_show_job
             (single statement + version/status guards, 0-rows ⇒ INVALID_STATE/OTP_INVALID)
  EXISTING:  transition_booking (0028) | enforce_booking_transition (0011)
             bump_booking_version | guard_professional_privileges /
             guard_professional_document_review (0005, security definer, search_path=public)
  CONSTRAINTS: uniq_active_assignment_per_booking (0012, NEW)
               professional_schedule GiST exclusion (0013, exists)
               bookings.version optimistic lock (0010, exists)
  RLS:       bookings_select_own (customer_id OR professional_id — see Pitfall 1: strips otp_hash)
             pro_docs_{select,insert,update}_own + KYC guard triggers (exists, 0005)
        ▼
STORAGE TIER — kyc-documents bucket (PRIVATE, no select policy, insert-own path policy)
  API mints signed UPLOAD URL ──► browser uploads bytes directly to storage
  API/admin route mints signed READ URL (admin review = Phase 6 screen, §20.13)

POLLING (no Supabase Realtime until Phase 7, §27.1):
  offers inbox every 5s (§27.3) | track + timer every 15s (§10.2, §27.3)
```

### Recommended Project Structure

```
app/
├── professional/
│   ├── page.tsx                    # EXISTS — shell home, availability card, earnings panel (§20.7)
│   ├── layout.tsx                  # NEW if needed — currently per-page AuthGuard pattern; follow existing
│   ├── jobs/page.tsx               # NEW — offers inbox + today's jobs (§19.1, red-dot badge §19.2)
│   ├── jobs/[id]/page.tsx          # NEW — navigate / arrive / OTP entry / timer / complete (§20.8)
│   ├── kyc/page.tsx                # NEW — KycStepper, per-step status, upload (§20.10)
│   ├── availability/page.tsx       # NEW — working hours, time off, online toggle (§19.1)
│   └── earnings/page.tsx           # NEW only if Q4 includes earnings (§20.9)
├── api/
│   ├── professionals/
│   │   ├── me/route.ts             # GET/PUT profile
│   │   ├── me/working-hours/       # GET/PUT
│   │   ├── me/time-off/            # POST/GET
│   │   ├── me/availability/        # POST (online/offline, is_available_today)
│   │   ├── me/kyc/                 # POST (submit docs), GET (status)
│   │   ├── me/jobs/                # GET (accepted jobs, today)
│   │   ├── me/location/            # POST (throttled 1/30s, §25.7)
│   │   ├── offers/route.ts         # GET inbox
│   │   ├── offers/[id]/accept/     # POST CAS
│   │   ├── offers/[id]/decline/    # POST
│   │   └── jobs/[id]/{arrive,otp,complete,no-show}/
│   ├── bookings/[id]/track/        # GET (Phase 2 deferral)
│   ├── bookings/[id]/otp/regenerate/  # POST (§25.6)
│   ├── kyc-documents/upload-url/   # POST (signed upload URL)
│   └── admin/professionals/[id]/kyc/[docId]/decision/  # POST, admin role (§25.10, endpoint only)
components/
├── professional/{OfferCard,JobCard,KycStepper,EarningsSummary}.tsx   # §18.6
├── booking/{OtpDisplay,OtpEntry,ServiceTimer}.tsx                    # §18.6
lib/
├── professionalServer.ts          # NEW — ownership analogs of bookingServer.ts
│                                  #   (requireBookingProfessional, getProJobsForCaller)
├── professionalClient.ts          # NEW — browser client; MUST send authorizationHeader on every verb
├── jobActions.ts / serviceOtp.ts  # NEW — mint/verify/expire helpers reusing lib/otp.ts generateOtpCode
└── (existing: status.ts, roles.ts, api.ts, validation.ts, geo.ts, constants.ts, audit.ts, idempotency.ts)
test/
├── routes.professionals.test.ts   # NEW — FakeSupabase route tests (see Validation Architecture)
├── routes.offers.test.ts          # NEW
├── routes.track.test.ts           # NEW or extend routes.bookings.test.ts
├── professionalClient.test.ts     # NEW — authorizationHeader on all verbs (Phase-2 lesson)
├── serviceOtp.test.ts             # NEW — pure mint/redact/expiry helpers
├── db.assignments.test.ts         # NEW — 50 concurrent accepts, expiry, overlap, RLS isolation
├── db.jobs.test.ts                # NEW — arrive/verify/complete/no-show RPCs + counters
└── db.rls.test.ts                 # EXTEND — kyc-documents policy assertions; fix flaky predicate (Wave 0)
supabase/migrations/
├── 0012_assignment_integrity.sql  # NEW — booking_assignments + unique active-assignment index (spec §24.8)
└── 0029_service_execution.sql     # NEW (house number) — service RPCs, KYC roll-up, otp_hash column grants,
                                   #   + professional_earnings if Q4 resolves "include"
```

### Pattern 1: Single guarded write path (the house doctrine)
**What:** Every job-state mutation is one Route Handler call → one Postgres RPC doing a single guarded `UPDATE ... WHERE id AND status AND version`, returning 0 rows as the refusal signal, with `booking_status_history` written inside the same transaction via transaction-local actor settings.
**When to use:** arrive, OTP verify, complete, no-show, offer accept, availability flips — every mutation in this phase.
**Example (existing analog):**
```typescript
// Source: lib/bookingServer.ts (verified this session)
// "It goes through transition_booking() (0028) rather than a table update because
//  the actor and note have to reach booking_status_history, and 0011's trigger reads
//  them from transaction-local settings. PostgREST cannot set those in the same
//  transaction as the update it accompanies."
// The write is versioned (§28.1): `where id and version` … the version VALUE is
// deliberately absent from the payload — bump_booking_version() owns the increment.
```
**New RPCs follow the same shape** (spec §10.1 gives the OTP one verbatim — see Code Examples).

### Pattern 2: Compare-and-swap offer accept
**What:** `UPDATE ... SET status='accepted' WHERE id=$1 AND status='offered' AND expires_at > now()`; 0 rows ⇒ 409 `ASSIGNMENT_TAKEN`; the `professional_schedule` window insert happens in the same transaction; `uniq_active_assignment_per_booking` is the structural belt-and-braces behind it (§28.1 hazard #1).
**When to use:** accept endpoint only — never an app-side "check then write".

### Pattern 3: Security-definer guards, `set search_path = public`
**What:** Privilege-critical writes guarded by `BEFORE UPDATE` triggers written as `security definer … search_path = public` that raise named errors (`KYC_REVIEW_FORBIDDEN`, `PROFESSIONAL_PRIVILEGE_CHANGE_FORBIDDEN`, `KYC_DOCUMENT_LOCKED`).
**When to use:** any new table that a browser session can touch gets the same treatment (0005 is the template). Note the KYC guards already exist and are complete — including "replacing a rejected document restarts review to `submitted`".

### Pattern 4: Route Handler ownership filter (service role bypasses RLS)
**What:** Authenticate first, then filter by owner id in the handler query, because `createServerClient()` bypasses RLS entirely — `getBookingForCaller` exists precisely because a prior route returned any booking by id.
**When to use:** every `/api/professionals/**` route. Add a `requireBookingProfessional`-analog; the existing helper's comment states outright: *"A professional is not staff: their own bookings are Phase 4's concern and this helper does not guess at them."* Phase 4 must extend the read model deliberately — and strip `otp_hash`.

### Pattern 5: Server-authoritative clock in the payload
**What:** Timer payloads carry `startedAt`, `endsAt`, `serverNow`, `remainingSeconds`; the client computes `endsAt - serverNow` and re-syncs `serverNow` each poll (§10.2, §22.3).
**When to use:** track endpoint, job detail page, any countdown.

### Pattern 6: Signed upload URL for the private KYC bucket
**What:** API mints `createSignedUploadUrl(path)` after validating `doc_type`, ownership and size/MIME (≤5MB, allow-list, §24.15/§26.4); browser uploads bytes directly; then inserts the `professional_documents` row with `status='submitted'` (the insert policy requires it).
**When to use:** KYC upload only in this phase. Never `getPublicUrl` (see Anti-Patterns).

### Anti-Patterns to Avoid
- **Direct table reads/writes from the pro browser client:** forbidden by `docs/API.md` §6 and it leaks `otp_hash` (Pitfall 1). All through Route Handlers.
- **`getPublicUrl` on `kyc-documents`:** the bucket has *no select policy* by design; `components/ui/ImageUpload.tsx` does exactly this for a SmartPOS bucket name (`menu-images`) and is dead code — do not "adapt" it, write the signed-URL route.
- **Two-step writes (annotate, then transition):** the 0028 comment documents why — partial state on the second step's failure. One RPC, one statement.
- **Local countdowns (`Date.now()` deltas):** forbidden by §22.3; use `serverNow`-anchored math.
- **`select('*')` into professional/staff payloads:** `getBookingById` does `select('*')` today — once OTPs are live that field must be excluded from every non-customer-facing payload, ideally also at the grant level (Schema & Migration Gaps).
- **Reading OTP parameters from `platform_settings`:** the table does not exist (verified). Use `PLATFORM_DEFAULTS` / env (pattern already in `lib/constants.ts`).
- **Assuming Realtime:** no `supabase.channel()` usage exists anywhere in the app; §27.1 is Phase 7. Offers poll at 5s, track at 15s (§27.3).
- **Hand-written status updates in route handlers:** `enforce_booking_transition` rejects illegal moves, but a handler that bypasses `transition_booking` also loses history + version discipline.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OTP generation / hashing / attempt counting | Custom crypto or plaintext storage | Spec §10.1 SQL (`digest($2,'sha256')`, attempts+lockout columns) + `generateOtpCode()` from `lib/otp.ts` | Constant-time comparison belongs in the DB; house module already encodes CSPRNG digit-draw rules; "never log the plaintext" is documented behavior |
| Geodesic distance for geofence | Haversine formula in the route | `haversineKm` in `lib/geo.ts` (already unit-tested in `geo.test.ts`) | Edge cases (polar, antimeridian) already handled |
| Booking status transitions | `if (status === ...)` chains in handlers | `lib/status.ts` `TRANSITIONS` + `transition_booking` RPC + 0011 trigger | One source of truth (principle #5); UI steppers derive from the same table |
| Optimistic locking | DIY version columns | `bookings.version` via guarded `WHERE version = $n` (§28.3) | Trigger owns the increment; double-bump bugs |
| Idempotent accept/complete/regenerate (pro actions are retried on flaky networks — §16 #4) | Homegrown dedupe | `lib/idempotency.ts` `withIdempotency` + `idempotency_keys` table | Already implemented with 23505 claim semantics (§28.2) |
| Signed upload URLs / object ACLs | Custom token signing | `supabase.storage.from('kyc-documents').createSignedUploadUrl(path)` (method verified in installed storage-js) | Bucket policies already written in 0025; custom crypto is forbidden (ASVS V6) |
| Input validation | Per-route ad-hoc parsing | `lib/validation.ts` (`uuid`, lat/lng bounds, `oneOf`, length caps) | Consistent error envelope; existing tests cover the validators |
| Audit trail for privileged decisions | `console.log` or bespoke table | `write_audit` RPC via `lib/audit.ts` | Principle #8; KYC decision and manual geofence override must be audited |
| Role/capability checks | Ad-hoc `if (auth.role !== ...)` | `requireAuth` / `requireCapability` (`lib/validation.ts`, `lib/roles.ts`) — **routes currently never call `requireCapability`** (verified: only its definition matches) | House capability table (`offer.accept`, `service.start`, `service.complete`, `availability.write`, `kyc.submit`) finally becomes load-bearing in this phase |
| Clock-skew-sensitive countdowns | Client-side timers | `serverNow`-anchored payload (§10.2) | Phones lie about time |
| Privacy filtering per-route | Trusting "we filtered it somewhere" | One field-filtered read model function for pro/staff booking payloads | §14.3: pro never sees phone/full address until accepted; `otp_hash` never crosses the wire |

**Key insight:** every item above has *already been built and tested* in Phases 1–3 for the customer side; Phase 4 is the same machinery pointed at the professional role. Hand-rolling any of it creates a second source of truth that the DB trigger will fight.

## Deferral Inventory (Phases 1–3 → Phase 4)

Full inventory of items handed to or conflicting with Phase 4, with sources.

| # | Item | Origin | Source (verified) | Status for Phase 4 |
|---|------|--------|-------------------|--------------------|
| 1 | **Professional-side availability editing** (working hours, time off, online toggle) | Phase 1 out-of-scope | `01-PLAN.md` Out-of-scope ("Professional-side availability editing (Phase 4)") | IN SCOPE — tables/policies exist (0005); routes + pages missing |
| 2 | **`GET /api/bookings/[id]/track`** (live view: status, pro location, ETA, OTP-if-arrived, serverNow) | Phase 2 deferral | `02-PLAN.md` (deferred endpoint list, ~line 308); spec §25.6 row | IN SCOPE — no route exists today (`app/api/bookings/[id]/` has no `track/`) |
| 3 | **OTP, service timer, extensions, completion** | Phase 2 out-of-scope | `02-PLAN.md` ~line 454 | IN SCOPE for OTP/timer/completion; **extensions contested** → Open Question Q5 |
| 4 | **Booking status progression beyond `paid`** | Phase 3 out-of-scope | `03-PLAN.md` Out-of-scope first bullet | IN SCOPE for `assigned → accepted → on_the_way → arrived → otp_verified → in_progress → completed`; **`paid → searching` matching kick-off remains Phase 5** → Q1 |
| 5 | **`booking_assignments` table + `assignment_status`** | STATE deferred to Phase 5 | `STATE.md` migration/deferral notes | **CONFLICT:** offers inbox (§25.7) and accept CAS (§9.1) need this table → Q1 recommends explicit reversal |
| 6 | **Migration `0012_assignment_integrity.sql`** | STATE reserved for Phase 5 | STATE.md migration-numbering rule | **CONFLICT** with #5 — taking `0012` in Phase 4 must be a recorded plan decision |
| 7 | **`professional_schedule` as slot-engine input** | Phase 2/3 note | DATABASE.md phase table ("slot input → Phase 5") | Phase 4 *writes* schedule rows (accept creates, complete closes) but does not read them for slot math — no conflict, note only |
| 8 | **`bookingView` read model** | STATE known issue | STATE.md carried-forward | NOT REQUIRED — track/inbox build small purpose-specific read models instead |
| 9 | **Support-role refund read-set** | Phase 3 carried forward | `03-CONTEXT.md` / `03-SUMMARY.md` | OUT (Phase 6) — consistent with hard rule 2 (no refund UI) |
| 10 | **KYC admin review screen** | ROADMAP | `ROADMAP.md` Phase 6 row; §31.1 Phase 6 "KYC review" | Screen = Phase 6; **verdict endpoint** needed in Phase 4 for the exit criterion → Q2 |
| 11 | **Realtime channels (offers, tracking)** | Spec | §27.1 (Phase 7) | NOT IN SCOPE — poll per §27.3 (5s inbox / 15s track) |
| 12 | **`/professional` home page copy bug**: "Availability and scheduling arrive in Phase 3" | Known defect | FEATURES.md ~line 515 | IN SCOPE — copy must say Phase 4 / be updated when availability ships |
| 13 | **Dead `components/ui/ImageUpload.tsx`** (SmartPOS `menu-images`, `getPublicUrl`) | Known dead code | FEATURES.md ~lines 544–545; API.md §6 | DO NOT REUSE — KYC upload is a new signed-URL route |
| 14 | **`requireCapability` never called by routes** | House observation | `lib/validation.ts:208` (definition only; zero route matches — verified) | OPPORTUNITY — Phase 4 pro routes are the first place capability checks should be enforced server-side |
| 15 | **`quoteToken` consumption** | Phase 3 open item | `03-RESEARCH.md` / `03-CONTEXT.md` | ALREADY RESOLVED in Phase 3 — not a Phase 4 item |
| 16 | **Earnings visibility** (home page earnings panel exists as shell) | Phase 1 shell | `app/professional/page.tsx` renders earnings panel stub | Depends on Q4 (`professional_earnings` table) |
| 17 | **Edge case §16 #20** (pro offline at `arrived`: hold 30 min then reassign) and **#15** (`next_job_late_min` penalty flag) | Spec edge cases | §16 rows #15, #20 | Reassignment leg + cron = Phase 5/§25.11 (crons "none belong to Phase 4"); `next_job_late_min` column does not exist (verified) → analytics Phase 9 → Q8 |

## Spec Sections Governing Phase 4

Authoritative source: `SmartHelp-Documentation.docx` → extracted text (`%TEMP%\SmartHelp-Documentation-extract.txt`), read this session.

| § | Governs | Phase-4 implication |
|---|---------|---------------------|
| §3.1–3.2 | Roles + capability matrix | Professional capabilities already encoded in `lib/roles.ts` (`offer.accept`, `service.start`, `service.complete`, `availability.write`, `kyc.submit`) |
| §8.1–8.2 | Status enum + legal transitions | `assigned → accepted → on_the_way → arrived → otp_verified → in_progress → completed`; enforced by 0011 trigger + `lib/status.ts` |
| §9.1 | Candidate query + **offer accept CAS SQL** (quoted in Code Examples) | Basis of `POST /api/professionals/offers/:id/accept` |
| §9.4 | `booking_assignments` partial unique index, advisory lock `assign:<booking_id>` | Index belongs in 0012; advisory lock is Phase 5's assignment engine (Q1) |
| §10.1 | OTP design: 4 digits, 10-min TTL, 3 attempts, 15-min lockout, hash-only `bookings.otp_hash`, regenerate max 3 (`otp_generations`), **verify SQL** | Core Phase 4; note spec-internal mint-timing inconsistency → Q3 |
| §10.2 | Service timer payload (`startedAt/endsAt/serverNow/remainingSeconds`), 15s poll, 15-min nudge, completion at 0 → pro confirms | Track/job pages render this payload; 30-min overrun cron is §25.11 → out |
| §10.3 | Extensions (30/60/90, `payment_purpose='extension'` exists) | **Contested scope** → Q5 |
| §10.4 | Completion side effects: `ended_at`, `actual_duration_minutes`, status `completed`, close schedule row, **insert `professional_earnings` (pending)**, notifications | Single RPC does all; earning table missing → Q4 |
| §11.2 | Professional cancellation, reassignment, no-show, late arrival | `POST /professionals/jobs/:id/no-show` endpoint in §25.7; reassignment itself = Phase 5 |
| §14.3 | Privacy: pro never sees customer phone/full address until accepted | Offers inbox read model must be field-filtered |
| §16 (§"Edge Cases") | #6 start without OTP ⇒ 403; #11 3 bad OTPs ⇒ 15-min lockout + notify; #15 overrun flags; #20 offline-at-arrived ⇒ hold 30 min ⇒ reassign | #6/#11 in scope via RPC guards; #15/#20 partially out → Q8 |
| §18.6 | Components to author: `OtpDisplay`, `OtpEntry`, `OfferCard`, `KycStepper`, `ServiceTimer`, `EarningsSummary`, `ImageUpload` | `input-otp ^1.2.4` is the specified OTP library (already installed) |
| §19.1–19.2 | Route map: `/professional` (home), `/professional/jobs`, `/professional/jobs/[id]`, `/professional/kyc`, `/professional/availability`, `/professional/earnings`; bottom nav with red-dot badge | Page structure for this phase |
| §20.6 | Customer live booking: stepper, **OTP display when `status = arrived` ("Expires in 09:41")**, timer, extension button | Confirms OTP mint-point must yield a live countdown at `arrived` (Q3) |
| §20.7 | Professional home: availability card, job list, earnings | Existing shell page is the anchor |
| §20.8 | Job detail: navigate (map link), geofence arrive + **manual long-press override with required reason**, OTP entry, complete | Geofence radius → Q7 (constant) |
| §20.9 | Earnings page | Depends on Q4 |
| §20.10 | KYC page: stepper, per-step status chips, upload to `kyc-documents` via signed URL, "can see status but never internal notes" | Pro-side KYC screen is Phase 4 |
| §20.13 | Admin KYC review screen | Phase 6 (Q2) |
| §22.2–22.3 | Data flow + **server-authoritative timer** | Pattern 5 |
| §24.5 | `professionals` columns + `professional_documents` + guards | Exists (0005) |
| §24.7 | `bookings` OTP columns (`otp_hash`, `otp_expires_at`, `otp_attempts`, `otp_generations`, `otp_verified_at`, timer stamps, `version`) | Exists (0010) — no migration needed for columns |
| §24.8 | **`0012_assignment_integrity.sql`** (`booking_assignments`, `0013` schedule) | 0013 shipped; 0012 free → Q1/numbering |
| §24.13 | Settings incl. OTP params | `platform_settings` never built → use `PLATFORM_DEFAULTS` (State of the Art) |
| §24.15 | Six buckets, **signed upload URLs, 5 MB KYC cap, MIME allow-list**, no select policy on `kyc-documents` | Bucket+policies exist (0025); upload-URL route missing |
| §25.2 | Error catalogue (`OTP_INVALID/EXPIRED/LOCKED`, `PROFESSIONAL_UNAVAILABLE`, `ASSIGNMENT_TAKEN`, `INVALID_STATE`, `STALE_VERSION`) | Codes already exist in `lib/api.ts` |
| §25.6 | Booking endpoints incl. `GET /:id/track`, `POST /:id/extend`, `POST /:id/otp/regenerate` | Track + regenerate are Phase 4; extend → Q5 |
| §25.7 | **All professional endpoints** (`/me/*`, offers accept/decline, arrive, otp, complete, no-show, location, earnings, payouts, kyc) | The route checklist for this phase |
| §25.10 | Admin endpoints incl. `POST /api/admin/professionals/:id/kyc/:docId/:decision`, manual assign | Decision endpoint Phase 4 (Q2); manual assign = Phase 6 |
| §25.11 | Cron jobs | **None belong to Phase 4** (explicit in prior research) — no new crons |
| §26.2–26.4 | Data at rest (KYC encrypted bucket, signed URLs), security checklist (no public bucket, rate limits, OTP never logged) | Security Domain below |
| §27.1, §27.3 | Realtime = Phase 7; **offers poll 5s, track poll 15s** | Polling implementation this phase |
| §28.1 | Six concurrency hazards (double assignment → unique index; lost update → version; search race → advisory lock) | Accept CAS + versioned RPCs |
| §29.2–29.4 | Mandatory tests: state machine walk, **50 concurrent accepts ⇒ one winner, two concurrent OTPs ⇒ one start**, RLS | Maps directly to `test/db.assignments.test.ts` / `db.jobs.test.ts` |
| §30 | Acceptance path steps involving pro flows | Phase-gate manual smoke |
| §31.1–31.2 | Phase row ("KYC upload, verification workflow, working hours, offers inbox, accept/decline, arrive, OTP, complete"; exit: "A verified professional can take and complete a job") + Definition of Done | The scope contract; deviations recorded in Open Questions |

## Schema & Migration Gaps

### Migration numbering (verified against `supabase/migrations/` directory)

**On disk:** `0000`–`0011` (incl. `0008a`), `0013`–`0017`, `0024`–`0028`.
**Free but spec-reserved:** `0012` (§24.8 `assignment_integrity`), `0018` (recurring), `0019` (support), `0020` (chat/notifications), `0021` (§24.12 `earnings_payouts`), `0022` (referrals/SOS), `0023` (§24.13 settings/pricing/policies).
**Next unreserved house number:** `0029`.

**Answers:**
- *What is the next migration number after `0015`?* — `0016` and `0017` were already consumed by Phase 2 (`0016_*.sql`, `0017_ratings.sql` diverging from spec's `0017_ratings_favourites.sql` by shipping the ratings half and deferring favourites — the established precedent for partial spec-file shipping).
- *What should Phase 4 use?* — **`0012_assignment_integrity.sql`** for the assignment table (its spec name and number, per STATE's "migration numbers are the specification's" rule) and **`0029_*.sql`** (house) for service-execution RPCs / KYC roll-up / column grants. Taking `0012` **explicitly reverses STATE's "booking_assignments deferred to Phase 5"** — the plan must record this as a decision (Q1).

### Gaps table

| Schema object | Status | Evidence | Action in Phase 4 |
|---------------|--------|----------|-------------------|
| `booking_assignments` + `uniq_active_assignment_per_booking` partial index (§9.4, §24.8) | **MISSING** | no `0012_*.sql`; not in `schema.sql` | Create in `0012` (Q1 decision) |
| Service-execution RPCs: `arrive_job`, `verify_service_otp`, `complete_job`, `no_show_job` | **MISSING** | only `create_booking`, `cancel_booking`, `transition_booking` exist (0028) | New migration `0029`; `transition_booking` only patches status+window fields and cannot stamp OTP/timer/counter side effects |
| `professional_earnings` table | **MISSING** | grep of all migrations + `schema.sql` = zero hits | Q4: land table now (partial `0021_earnings.sql` per the `0017_ratings` precedent) or defer payouts-only table to Phase 8 |
| KYC verdict → `professionals.verification_status` roll-up | **MISSING** | grep: no trigger/rule sets `verification_status` from `professional_documents` (only guard triggers in 0005) | Implement inside the decision RPC/route (Q2) |
| OTP/timer columns on `bookings` (`otp_hash`, `otp_expires_at`, `otp_attempts`, `otp_generations`, `otp_verified_at`, `arrived_at`, `started_at`, `ends_at`, `ended_at`, `actual_duration_minutes`, `version`) | EXISTS | `0010_bookings.sql` [VERIFIED] | None |
| `professional_working_hours`, `professional_time_off` (+ RLS + `grant … to authenticated`) | EXISTS | `0005` [VERIFIED] | None (routes only) |
| `professional_schedule` + GiST overlap exclusion | EXISTS | `0013`; covered by `db.booking.test.ts` overlap tests [VERIFIED] | None |
| KYC guard triggers (`guard_professional_privileges`, `guard_professional_document_review`) | EXISTS (complete, incl. re-upload restarts review) | `0005` [VERIFIED] | None |
| Storage: `kyc-documents` bucket, insert-own path policy, no select policy, admin delete | EXISTS | `0025_storage_policies.sql` + `db.rls.test.ts` bucket test [VERIFIED] | Signed upload-URL route only |
| `professionals.is_available_today`, `availability_status`, `current_lat/lng`, `location_updated_at`, `kyc_verified_at` | EXISTS | `0005` [VERIFIED] | None |
| Counter columns `professionals.total_offers / accepted_offers / completed_jobs` | EXISTS, **never written** | `0004`/`0005` [VERIFIED]; no writer code | Writers must move inside the accept/complete transactions (or triggers) |
| `bookings.otp_hash` readable through RLS | **EXPOSURE** | `grant select on public.bookings to authenticated` (0010:388) + `bookings_select_own` includes `professional_id = current_professional_id()` [VERIFIED] | Column-level hardening in `0029` + payload tests (Pitfall 1) |
| `arrival_radius_m` | **MISSING everywhere** | spec prose only; not in `schema.sql`, `platform_settings` absent | Q7: `PLATFORM_DEFAULTS`/env constant (recommended) |
| `platform_settings` (OTP params §10.1/§24.13, `extension_options_minutes`, `min_rating_threshold`) | **TABLE DOES NOT EXIST** | grep across all migrations + `schema.sql` = 0 hits [VERIFIED] | Use `lib/constants.ts` `PLATFORM_DEFAULTS` (`serviceOtpLength: 4`, `lateArrivalThresholdMin: 15`, `noShowAfterMin: 45`, `DEFAULT_EXTENSION_OPTIONS`) — pattern already established |
| `payment_purpose` includes `'extension'` | EXISTS | prior session verification [ASSUMED this session — re-grep if Q5 keeps extensions] | — |
| `next_job_late_min` (§16 #15) | MISSING | grep 0 hits | Defer to analytics phase (Q8) |
| `otp_requests` purpose allow-list | EXISTS: `login, staff_login, admin_mfa, signup, password_reset` (0001 + 0026) [VERIFIED] | — | Do **not** extend for service OTP (hash-on-booking design instead) |

## Common Pitfalls

### Pitfall 1: `bookings.otp_hash` is readable by any browser session that passes `bookings_select_own`
**What goes wrong:** once OTPs are live, the assigned professional (or the customer's own device via the anon/authenticated client) can `select('otp_hash')` directly — a SHA-256 of a 4-digit code is trivially brute-forced (10k candidates), letting a professional start the service timer without the customer's code.
**Why it happens:** 0010 grants `select` on **all columns** to `authenticated` and the row policy deliberately includes `professional_id = current_professional_id()` (the comment even says "the professional app (Phase 4) needs their own job list").
**How to avoid:** in `0029`, revoke blanket select and re-grant column-by-column excluding `otp_hash` (and ideally `otp_attempts/otp_generations` are harmless but unnecessary) [ASSUMED syntax: standard Postgres column privileges — confirm with `\dp+ bookings` at implementation]; additionally filter in every Route Handler payload and assert absence in tests.
**Warning signs:** any test asserting `"otp_hash" not in payload` failing; a pro page rendering a code the customer didn't share.

### Pitfall 2: New browser client forgets the `Authorization` header
**What goes wrong:** every route returns 401/403 in the running app while tests pass (tests inject tokens explicitly).
**Why it happens:** Phase 2 shipped 489 failing tests from exactly this class of bug; `bookingClient.test.ts` exists to prevent recurrence.
**How to avoid:** `lib/professionalClient.ts` must call `authorizationHeader()` from `lib/sessionHeaders.ts` on **every** verb, and `test/professionalClient.test.ts` mirrors `bookingClient.test.ts`.

### Pitfall 3: Status moved without the version/history discipline
**What goes wrong:** lost updates (two devices), missing `booking_status_history`, `enforce_booking_transition` bypassed via raw service-role `UPDATE`.
**How to avoid:** Pattern 1 — one RPC, `WHERE id AND status AND version`, 0 rows ⇒ `INVALID_STATE`/`STALE_VERSION`.

### Pitfall 4: Two-step writes (set `arrived_at` in one call, status in another)
**What goes wrong:** half-state (timestamp without status) that no transition guard can repair. The 0028 comment documents this exact failure mode (PostgREST cannot set transaction-local actor settings alongside the update).
**How to avoid:** `arrive_job` / `verify_service_otp` / `complete_job` each do everything in one transaction.

### Pitfall 5: OTP errors leaking which check failed
**What goes wrong:** distinguishing "expired" vs "wrong code" vs "locked" to the professional's client enables probing; spec §10.1 says "0 rows ⇒ distinguish in logs only; the client always sees 'Invalid or expired code'."
**How to avoid:** client-facing message is generic (one error code), details go to server logs/audit; attempts increment atomically inside the RPC.

### Pitfall 6: Stale offers block re-offers (no expiry sweeper in Phase 4)
**What goes wrong:** a booking left at `assigned` past `expires_at` never re-enters the candidate pool; `uniq_active_assignment_per_booking` then blocks new offers.
**Why it happens:** the expiry sweeper cron is §25.11 (not Phase 4).
**How to avoid:** lazy expiry — inbox query treats `expires_at <= now()` as expired and accept refuses it (`ASSIGNMENT_TAKEN`/`PROFESSIONAL_UNAVAILABLE`); optionally transition `assigned → searching` on read. Full sweeper remains Phase 5 (Q1).

### Pitfall 7: GiST exclusion errors surfacing as raw 23P01
**What goes wrong:** accept collides with an existing reserved window → Postgres `23P01` = 500 instead of `PROFESSIONAL_UNAVAILABLE`.
**How to avoid:** catch and map in the accept RPC/route; test with a deliberate overlap (see `db.booking.test.ts` overlap coverage as the model).

### Pitfall 8: Instant bookings have `scheduled_start_at IS NULL`
**What goes wrong:** schedule-window math (`starts_at = scheduled_start_at`) crashes or inserts NULLs for instant bookings (born `paid → searching`).
**How to avoid:** accept computes the window as `now()` when `scheduled_start_at IS NULL`.

### Pitfall 9: Counter drift
**What goes wrong:** `accepted_offers`/`completed_jobs` disagree with reality because they were updated in a different transaction than the status change (or not at all, as today).
**How to avoid:** move counters inside the same RPC (or a trigger keyed to the transition) — never client-side "best effort" updates.

### Pitfall 10: KYC via public URL or unvalidated path
**What goes wrong:** document leaks (bucket has no select policy by design) or arbitrary-path uploads.
**How to avoid:** signed upload URLs minted server-side with path prefix `{professional_id}/{doc_type}/…`, size ≤ 5 MB, MIME allow-list (§24.15/§26.4); test rejections.

### Pitfall 11: Professional self-verification
**What goes wrong:** a pro flips their own `status`/`verification_status`.
**Why it shouldn't happen:** `guard_professional_document_review` + `guard_professional_privileges` raise `KYC_REVIEW_FORBIDDEN`/`PROFESSIONAL_PRIVILEGE_CHANGE_FORBIDDEN` for non-trusted sessions [VERIFIED 0005] — **but** the decision route must still be admin-role gated and audited, and the roll-up must run as service role.
**How to avoid:** `requireCapability`/admin role + `write_audit` on the decision route; keep guards untouched.

### Pitfall 12: Polling hygiene and lifecycle races
**What goes wrong:** 5s/15s intervals leaking after unmount, updating unmounted components, or piling up across navigations.
**How to avoid:** `useEffect` with `clearInterval` cleanup + abort on in-flight fetches; test the hook/component logic if extracted.

### Pitfall 13: Broadened read models (`select('*')`) reaching pro/staff payloads
**What goes wrong:** `getBookingById` returns every column; extending it naively to professionals hands `otp_hash` (Pitfall 1) and customer PII (§14.3 forbids address/phone pre-accept).
**How to avoid:** explicit column lists in a dedicated pro read model; one function owns the strip list.

### Pitfall 14: Assuming a settings table exists
**What goes wrong:** queries to `platform_settings` fail at runtime (table absent, verified).
**How to avoid:** `PLATFORM_DEFAULTS` + env overrides only.

## Code Examples

Verified patterns from the repo and the spec (source on each):

### 1. Service OTP verification (spec's own SQL — the Phase 4 centerpiece)
```sql
-- Source: SmartHelp-Documentation §10.1 (extracted text, read this session)
-- The customer sees a 4-digit code; the professional types it in.
-- The hash is the only thing persisted, and comparison is constant-time via the DB.
UPDATE bookings
   SET status = 'otp_verified',
       otp_verified_at = now(),
       -- Server clock, always. The phone's clock is never consulted.
       started_at       = now(),
       ends_at          = now() + make_interval(mins => duration_minutes)
 WHERE id = $1
   AND status = 'arrived'
   AND otp_hash = encode(digest($2, 'sha256'), 'hex')
   AND otp_expires_at > now()
   AND otp_attempts < $3
 RETURNING started_at, ends_at;
-- 0 rows => distinguish in logs only; the client always sees "Invalid or expired code".
```
**Implementation note:** the attempt counter also needs an increment path (single RPC doing check+increment in one transaction), and 0 rows must map to `OTP_INVALID`/`OTP_EXPIRED`/`INVALID_STATE` in logs only (Pitfall 5).

### 2. Offer accept CAS (spec's own SQL)
```sql
-- Source: SmartHelp-Documentation §9.1 (extracted text)
-- Claim an offer atomically: the WHERE on status is the compare-and-swap.
UPDATE booking_assignments
   SET status = 'accepted', responded_at = now()
 WHERE id = $1 AND status = 'offered' AND expires_at > now()
 RETURNING *;
-- 0 rows => somebody else already took it. Client gets 409 ASSIGNMENT_TAKEN.
```
(Preceded by the partial unique index on `booking_id` where `status IN ('offered','accepted')` and `pg_advisory_xact_lock(hashtext('assign:'||$1))` — the lock is Phase 5 territory, the index + CAS are Phase 4.)

### 3. The house read-model/ownership gate
```typescript
// Source: lib/bookingServer.ts (verified this session)
export async function getBookingForCaller(id: string, customerId: string, role: UserRole) {
  const booking = await getBookingById(id)
  if (!booking) throw new ApiHttpError('NOT_FOUND', 'Booking not found', 404)
  if (booking.customer_id === customerId || STAFF_ROLES.includes(role)) return booking
  throw new ApiHttpError('FORBIDDEN', 'This booking belongs to another account.', 403)
}
// Doc comment: "A professional is not staff: their own bookings are Phase 4's concern
// and this helper does not guess at them."  → Phase 4 adds the professional analog
// deliberately (and without the select('*') column list — see Pitfall 1).
```

### 4. Guard trigger template for any new privileged column
```sql
-- Source: supabase/migrations/0005_professionals.sql (verified this session, abridged)
create or replace function public.guard_professional_document_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status or ... then
    if public.is_trusted_session() or auth.role() = 'service_role' or public.is_admin() then
      return new;
    end if;
    raise exception 'KYC_REVIEW_FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
```

### 5. Track/timer payload contract (spec)
```jsonc
// Source: SmartHelp-Documentation §10.2 (extracted text)
// GET /api/bookings/:id (fragment, polled every 15 s while in_progress)
{
  "status": "in_progress",
  "startedAt": "2026-09-26T12:32:00Z",
  "endsAt":    "2026-09-26T14:32:00Z",
  "serverNow": "2026-09-26T13:04:11Z",
  "remainingSeconds": 5270,
  "extendedMinutes": 30,
  "extensionAvailable": true
}
// The client renders: remaining = endsAt - serverNow (not Date.now() - startedAt).
```

### 6. Route-handler test harness (copy this shape)
```typescript
// Source: test/routes.addresses.test.ts:83-126 (verified this session)
const PROFILE = { id: USER_ID, role: 'customer', status: 'active', /* ... */ };
function build(overrides = {}) {
  return new FakeSupabase(
    { profiles: () => ({ data: PROFILE, error: null }), /* tables… */ },
    { write_audit: () => ({ data: null, error: null }) }          // rpcs…
  );
}
function request(url, init = {}) {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: init.token ? { 'content-type': 'application/json', authorization: `Bearer ${init.token}` } : { 'content-type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
// Professional variant: role: 'professional' in PROFILE, plus a professionals table stub.
```

### 7. Signed upload URL (KYC)
```typescript
// Method existence VERIFIED: string `createSignedUploadUrl` present in installed
// node_modules/@supabase/storage-js bundle. Call/response shape [ASSUMED] —
// confirm against https://supabase.com/docs/reference/javascript/storage-fileapi-create-signed-upload-url
// at implementation (page failed to load during research — too large).
const { data, error } = await supabase.storage.from('kyc-documents')
  .createSignedUploadUrl(`${professionalId}/${docType}/${filename}`);  // { signedUrl, token, path } [ASSUMED]
// browser then: uploadToSignedUrl(path, token, file) [ASSUMED]
```

### 8. Column-level hardening for `otp_hash` [ASSUMED — standard Postgres]
```sql
-- REVOKE SELECT ON public.bookings FROM authenticated;
-- GRANT SELECT (<every column except otp_hash>) ON public.bookings TO authenticated;
-- Verify with \dp+ public.bookings after applying; add a db.rls test asserting
-- otp_hash is invisible to a professional session.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Spec: OTP params in `platform_settings` (§10.1, §24.13) | Table never built; `PLATFORM_DEFAULTS` + env in `lib/constants.ts` | House pattern from Phase 1 | Phase 4 reads `serviceOtpLength: 4`, `lateArrivalThresholdMin: 15`, `noShowAfterMin: 45` — never queries settings |
| Spec: "OTP generated at booking creation time" (§10.1) | §20.6 wireframe shows the code only `when status = arrived` with a 10-min TTL countdown | Spec-internal inconsistency, unresolved | Drives Q3 (recommended mint-at-arrived) |
| Spec: 28 sequential migrations `0000–0027` | House shipped `0024–0028` with diverging contents; `0012`/`0018–0023` still free | Phases 2–3 | Phase 4 claims `0012` + `0029`; never renumber existing files |
| STATE: `booking_assignments` → Phase 5 | Phase 4 offers inbox needs it (§31.1) | Conflict identified 2026-10-08 | Q1 must resolve before planning |
| Capability checks as UI metadata only | `requireCapability` exists but no route calls it (verified) | — | Phase 4 pro routes should start enforcing server-side |
| `components/ui/ImageUpload.tsx` (`menu-images`, `getPublicUrl`) | Dead SmartPOS code; new signed-URL route for KYC | Phase 1 dead-code note | Do not adapt the dead component |
| Realtime (spec §27.1) | No `supabase.channel()` anywhere; polling per §27.3 | Phase 7 | Offers 5s / track 15s |
| Spec claim "47-table schema across 28 migrations" | Repo reality diverges in numbering/content | ongoing | Trust the filesystem, not the spec index |

**Deprecated/outdated:**
- `storage-js` has moved to the `supabase-js` monorepo (standalone repo README is a redirect) — irrelevant at runtime, but documentation lookups should use the monorepo or the reference pages [VERIFIED: raw.githubusercontent.com/supabase/storage-js README].
- Supabase reference doc pages failed to fetch during research (>5 MB) — API shapes for storage signed upload taken from installed bundle + training data (tagged [ASSUMED] where shape matters).

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` (file does not exist) → treated as **enabled**.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No new work (session auth exists) | Reuse `requireAuth`; service OTP is *authorization to start a job*, not authentication |
| V3 Session Management | No | Existing session handling untouched |
| V4 Access Control | **Yes** | `requireAuth` + `requireCapability` (`offer.accept`, `service.start`, `service.complete`, `availability.write`, `kyc.submit`) + per-route ownership filters (Pattern 4) + RLS + column-level grants; admin decision endpoint gated on admin role + `write_audit` |
| V5 Input Validation | **Yes** | House `lib/validation.ts` (`uuid`, lat/lng bounds, doc_type allow-list, reason length, enum `oneOf`) — no new validator dependency |
| V6 Cryptography | **Yes** | SHA-256 hashing via `digest($2,'sha256')` in Postgres (§10.1) and existing `lib/otp.ts` CSPRNG digit generation — **never hand-roll crypto**; no plaintext OTP ever logged (house docstring) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR: pro A acts on pro B's job/offer/KYC docs | Tampering | Ownership filter in handler + 403 tests per route; RLS as second layer; `guard_*` triggers as third |
| OTP brute force (§16 #11) | Elevation | `otp_attempts < 3` in SQL guard + 15-min lockout + generic client error + audit/ops signal |
| `otp_hash` disclosure via direct table read | Information Disclosure | Column-level revoke (Pitfall 1) + payload strip + test asserting absence |
| Professional self-starts without customer OTP (§16 #6) | Elevation | `status = 'arrived' AND hash match` single-statement guard; client gets 403 |
| Pro self-verifies KYC | Elevation | `guard_professional_document_review` raises `KYC_REVIEW_FORBIDDEN`; decision route is admin-role only; service-role roll-up |
| Status forging / illegal transition | Tampering | No UPDATE policy on `bookings` (0010 deliberately has none) + `enforce_booking_transition` |
| Double-accept of one offer (§28.1 #1) | Repudiation/DoS | CAS + `uniq_active_assignment_per_booking`; 50-concurrent test (§29.4) |
| KYC document leak (private bucket) | Information Disclosure | No select policy; signed upload/read URLs only; 5 MB + MIME allow-list; never `getPublicUrl` |
| Customer PII pre-acceptance (§14.3) | Information Disclosure | Field-filtered offers read model (no phone/full address until accepted) |
| Server secrets in client bundles | Information Disclosure | Zero `NEXT_PUBLIC_` for secrets; `test/env-inlining.test.ts` guards |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `createSignedUploadUrl(path)` returns `{ signedUrl, token, path }` and the browser completes with `uploadToSignedUrl(path, token, file)` | Code Examples #7 | Low — method presence verified in installed bundle; shape must be confirmed from reference docs at implementation (page unfetchable during research) |
| A2 | Column-level `REVOKE/GRANT SELECT (col list)` is the right mechanism to hide `otp_hash` from `authenticated` (standard Postgres) | Pitfall 1 / Schema gaps | Medium — alternative is payload-only filtering (weaker); verify with `\dp+ bookings` before relying |
| A3 | Spec §24.8's full `booking_assignments` DDL (read §9.1/§9.4 CAS + index fragments this session, not the §24.8 block in full) | Schema gaps | Medium — planner must read §24.8 verbatim before writing `0012` |
| A4 | DATABASE.md's Phase-4 "review screen" phrasing refers to (or is satisfied by) the *professional-side* KYC screen; admin review stays Phase 6 | Q2 | Medium — if it means the admin screen, scope shifts (still recommend endpoint-only in Phase 4 per ROADMAP) |
| A5 | `.env.local` contains SMTP vars (read in a prior session, not re-read this session); irrelevant to service OTP which is in-app displayed | Environment | Low |
| A6 | `payment_purpose` enum includes `'extension'` (prior-session verification; not re-grepped this session) | Q5 | Low — only matters if extensions stay in scope |
| A7 | Seeded `demo.pro@smarthelp.test` is `verification_status='verified'` with five verified documents (prior-session seed read) — lets Phase 4 demonstrate the exit criterion even before the decision endpoint exists | Q2 | Low — re-check `seed.sql` at planning time |

**If a table row is added later by the planner:** every `[ASSUMED]` inline tag above must be tracked here. Claims NOT in this table were verified by file reads/greps/test runs this session.

## Open Questions

Ordered by blocking severity. Confidence refers to the *recommendation*, not the facts.

### Q1 — Who creates the offer? (offer producer vs. Phase 5 matching) — **confidence: MEDIUM**
- **What we know:** §31.1 Phase 4 = "offers inbox, accept/decline" and exit = "a verified professional can *take* and complete a job". Phase 3's plan explicitly deferred "when matching starts" to Phase 5 (`03-PLAN.md`), STATE defers `booking_assignments`/`0012` to Phase 5, and nothing on disk can move `paid → searching` or create offers. Seed data has a booking born at `assigned` (insert bypasses the trigger) but **no `professional_schedule`/assignment rows**.
- **Options:** (a) Phase 4 claims `0012` + ships a *minimal* producer (on payment/slot: pick one eligible verified+online+available pro in range, create one offer with expiry; no ranking, no fan-out, no advisory lock — those stay Phase 5); (b) offers exist only as seed/demo data — exit criterion demonstrated on fixtures only; (c) manual ops assignment (§25.10) — Phase 6 endpoint, no UI.
- **Recommendation:** (a), with the minimal producer documented as temporary and Phase 5 replacing it with ranked fan-out + advisory locks + expiry sweeper + reassignment cascade. Lazy expiry in inbox/accept covers the missing sweeper (Pitfall 6).
- **If wrong:** (b) leaves the exit criterion unprovable in-product; (a) at worst duplicates ~30 lines Phase 5 rewrites.

### Q2 — Who flips KYC to `verified`? — **confidence: MEDIUM**
- **What we know:** "verification workflow" is in the Phase 4 row; ROADMAP gives "KYC review screens" to Phase 6; §25.10 defines `POST /api/admin/professionals/:id/kyc/:docId/:decision`; **no roll-up from doc verdicts to `professionals.verification_status` exists anywhere** (verified); guard triggers already allow service-role/admin verdict writes; seed pro is already `verified` (A7).
- **Recommendation:** Phase 4 ships the pro-side upload/submit/status screens **plus the admin-role decision endpoint with roll-up logic** (no admin UI) — exactly the Phase 3 pattern (refund API without UI). Phase 6 builds the review queue on the existing endpoint. Roll-up rule to define: all required doc types `verified` ⇒ `professionals.verification_status='verified'` + `kyc_verified_at=now()`; any `rejected` ⇒ `rejected`.
- **If wrong:** deferring the endpoint means the workflow stops at `submitted` and the exit criterion rests on seed data only.

### Q3 — OTP mint point + re-display after refresh — **confidence: MEDIUM**
- **What we know:** spec says "generated at booking creation" but also 10-min TTL (§10.1) and §20.6 shows the code with "Expires in 09:41" only `when status = arrived` (verified this session). Hash-only storage means the server cannot re-derive a code for later display. Columns support regeneration (`otp_generations`, max 3; §25.6 regenerate endpoint).
- **Options:** (a) mint at booking creation — contradicts TTL for future bookings; (b) mint at transition to `arrived` — matches wireframe + TTL; (c) mint at create AND re-mint at `arrived`.
- **Recommendation:** (b), with regeneration endpoint for expiry and plaintext returned **only in the mint response to the customer's session** (never re-readable: if the customer refreshes after expiry, they tap regenerate within the 3-generation cap). Document the deviation from "generated at creation" as an intentional resolution of a spec-internal inconsistency.
- **If wrong:** minimal churn — minting is one function call moved between two call sites.

### Q4 — Does `professional_earnings` land in Phase 4? — **confidence: MEDIUM**
- **What we know:** §10.4 makes the earning row part of *complete*; §25.7 exposes earnings/payouts; spec numbers the table under `0021_earnings_payouts.sql` (reserved for Phase 8); table absent (verified); partial-file precedent exists (`0017_ratings.sql` shipped without favourites); Phase 4 exit criterion does not require it; payouts/cron are Phase 8 regardless.
- **Recommendation:** land a minimal `professional_earnings` (booking_id, professional_id, gross, commission, net, status `pending`, created_at) written inside `complete_job`, as `0021_earnings.sql`; defer payout-run semantics to Phase 8. If discuss-phase wants the phase smaller: defer entirely and accept that `complete` writes no earning (gap documented for Phase 8).
- **If wrong:** low either way; the deciding factor is whether the earnings page (§20.9) ships this phase.

### Q5 — Are extensions (§10.3) in Phase 4? — **confidence: MEDIUM**
- **What we know:** `02-PLAN.md` assigned "OTP, timer, extensions, completion" to Phase 4; §31.1/ROADMAP's Phase 4 row **omits** extensions; extensions need pro accept/decline + a delta payment (`payment_purpose='extension'` exists, A6) + schedule-window extension.
- **Recommendation:** **defer extensions** (record as deliberate deferral to Phase 8 growth or Phase 5) — they are not needed for the exit criterion, and 02-PLAN's list conflicts with the phase contract in §31.1 (the contract wins). Keep `extensionAvailable: false` in timer payloads.
- **If wrong:** re-adding later is additive (endpoint + payment purpose + status loop already specified).

### Q6 — How much live tracking ships? — **confidence: LOW-MEDIUM**
- **What we know:** §25.6 track includes "pro location, ETA"; §25.7 has `POST /me/location` (1/30s); `professionals.current_lat/lng/location_updated_at` exist; Realtime is Phase 7; no ETA model exists anywhere (spec §? ETA not researched).
- **Recommendation:** Phase 4 ships `GET /track` with status/timeline/OTP-gated/serverNow + `proLocation` when present, and the throttled `POST /me/location` upsert; **defer ETA** (needs travel model) and mark `proLocation: null` acceptable. Real-time push stays Phase 7.
- **If wrong:** scope is additive; the endpoint's contract can grow fields without breaking Phase 2's deferral closure.

### Q7 — Where does the geofence radius live? — **confidence: HIGH**
- **What we know:** `arrival_radius_m` appears only in spec prose (lines ~719/2071/4091); absent from schema and settings (verified); `haversineKm` exists; §20.8 requires a manual long-press override with a required reason (audited).
- **Recommendation:** `PLATFORM_DEFAULTS` constant + `DEFAULT_ARRIVAL_RADIUS_M` env override (same pattern as `serviceOtpLength`); override writes `write_audit` with reason; unit-test with `haversineKm` fixtures.
- **If wrong:** near-zero risk; migrating to a settings row later is trivial.

### Q8 — Edge-case legs that need crons/analytics (#20 hold-then-reassign, #15 `next_job_late_min`) — **confidence: HIGH**
- **What we know:** §25.11 crons "none belong to Phase 4"; reassignment is Phase 5; `next_job_late_min` column absent (verified); analytics is Phase 9.
- **Recommendation:** Phase 4 implements the *detection* signals only (no-show/late thresholds via `lateArrivalThresholdMin`/`noShowAfterMin`, audit/ops log lines); explicitly defer the 30-min hold cron, reassignment, and penalty flags with pointers to Phases 5/9.
- **If wrong:** no impact on the exit criterion.

### Q9 — Is `0012` reclaiming sanctioned by the planner? — **confidence: MEDIUM** (coupled to Q1)
- **What we know:** STATE reserves `0012` for Phase 5; house rule says spec numbers are not renumberable, not un-reclaimable.
- **Recommendation:** if Q1=(a), Phase 4 files `0012_assignment_integrity.sql` and updates STATE's deferral line in the same commit; otherwise use only `0029`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | dev/build/test | ✓ | v24.13.1 | — |
| npm | scripts (`typecheck/lint/test/test:db/db:migrate`) | ✓ | 11.8.0 | — |
| Supabase DB via `SUPABASE_DB_URL` | `test:db`, `db:migrate`, live-DB concurrency tests | ✓ (in `.env.local`; probed this session) | live | — |
| ESLint config (`.eslintrc.json`) | `npm run lint` | ✓ | exit 0 verified (run is slow, >240 s observed) | — |
| `kyc-documents` bucket + policies | KYC upload | ✓ (0025; asserted by `db.rls.test.ts`) | — | — |
| `input-otp` | OTP display/entry | ✓ | ^1.2.4 | — |
| SMTP (`SMTP_*`) | Login OTP only | ✓ present [A5] | — | `lib/otp.ts` console fallback (dev only) |
| SMS provider | **Not required** — service OTP is displayed in-app (§20.6) | ✗ | — | n/a |
| Supabase Realtime | Phase 7 only | not used | — | polling per §27.3 |
| Playwright / e2e runner | journey test | ✗ (and cannot be installed — zero new deps) | — | route tests + DB tests + manual §30 smoke (documented deferral) |

**Missing dependencies with no fallback:** none that block execution.
**Missing dependencies with fallback:** e2e automation → route/DB tests + manual acceptance smoke.

## Phase Requirements (derived)

> No `.planning/REQUIREMENTS.md` exists and no requirement IDs were registered upstream. IDs below are **research-derived** for the Validation Architecture test map; the planner may renumber when formalizing.

<phase_requirements>

| ID | Description | Research Support |
|----|-------------|------------------|
| P4-01 | Professional can upload KYC documents via signed upload URL (≤5 MB, MIME allow-list, owned path) and submit for review | §20.10, §24.15, §26.4; 0005 insert policy requires `status='submitted'`; bucket exists (0025) |
| P4-02 | Admin-role KYC decision endpoint updates doc verdicts and rolls up `professionals.verification_status` (+ audit) | §25.10; guard triggers verified; roll-up verified missing (Q2) |
| P4-03 | Professional can set working hours, add time off, and toggle online (`availability_status` / `is_available_today`) through Route Handlers | 01-PLAN deferral; tables+grants exist (0005); API.md §6 |
| P4-04 | Offers inbox lists open offers (5s poll, field-filtered) ; accept is CAS (one winner), decline records reason and excludes pro | §25.7, §9.1, §14.3, §27.3, §29.4; needs `0012` (Q1) |
| P4-05 | `POST /professionals/jobs/:id/arrive` verifies geofence (haversine ≤ radius, audited manual override) and transitions to `arrived` | §20.8, §8.2; `lib/geo.ts`; radius constant (Q7) |
| P4-06 | Service OTP minted at `arrived` (hash-only), customer session displays code+countdown, professional submits attempts (3 ⇒ lockout), regenerate ≤3 | §10.1, §16 #6/#11, §20.6, §25.6; columns exist (0010) |
| P4-07 | Track endpoint returns server-authoritative timer payload (`startedAt/endsAt/serverNow/remainingSeconds`), polled 15s | 02-PLAN deferral, §10.2, §22.3, §25.6 |
| P4-08 | `complete` stamps `ended_at`/`actual_duration_minutes`, closes schedule window, bumps counters, (optionally) inserts earning, emits events | §10.4, §24.8 lifecycle, Q4 |
| P4-09 | No-show / pro-cancellation endpoints follow §8.2/§11.2 with reasons + audit; pro never self-cancels into a refund path (no refund UI — hard rule 2) | §11.2, §25.7 |
| P4-10 | `otp_hash` (and customer PII pre-accept) never appears in professional/staff payloads or browser-readable columns | §14.3, §10.1, Pitfall 1 |

</phase_requirements>

## Validation Architecture

> `.planning/config.json` does not exist → `workflow.nyquist_validation` absent → **validation is treated as ENABLED** and this section is mandatory input for `VALIDATION.md`.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.1 (`vitest.config.ts`: environment `node`, include `test/**/*.test.ts`, supabase env stubs at module scope) |
| Config file | `vitest.config.ts` — **exists**, no Wave-0 framework install needed |
| Quick run command | `npx vitest run <file>` |
| Full suite command | `npm test` (= `vitest run`, **includes** `db.*` files: 655 tests / 38 files observed 2026-10-08) |
| DB suite command | `npm run test:db` (= `vitest run test/db. --no-file-parallelism`: 77 tests / 5 files observed 2026-10-08) |
| Type check | `npm run typecheck` (`tsc --noEmit`) — exit 0 observed |
| Lint | `npm run lint` (`next lint`) — exit 0 observed; **slow (>240 s)** → assigned to merge/wave tier, not per-commit |
| Build | `npm run build` — not re-run at research time [ASSUMED green given typecheck+lint pass]; verify at first wave gate |

**Baselines (floors) as of 2026-10-08:**
- `npm test`: **655 tests / 38 files** — observed 654 passed + **1 known flaky failure** (see Wave 0 #1).
- `npm run test:db`: **77 passed / 5 files** (green).
- `npm run typecheck`: exit 0 (green). `npm run lint`: exit 0 (green).

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| P4-01 | signed upload URL: ownership, doc_type allow-list, size/MIME rejection, `status='submitted'` insert | unit (route, FakeSupabase) | `npx vitest run test/routes.professionals.test.ts` | ❌ Wave 0 |
| P4-02 | admin decision endpoint: 403 for non-admin, verdict write + roll-up to `verified`, audit row | unit (route) | `npx vitest run test/routes.kycDecision.test.ts` | ❌ Wave 0 |
| P4-03 | working-hours PUT / time-off POST / availability toggle: validate + ownership | unit (route) | `npx vitest run test/routes.professionals.test.ts` | ❌ Wave 0 |
| P4-04 | inbox field filtering; accept CAS single-winner under 50 concurrent; expired offer refused; decline records reason | unit + integration (live DB) | `npx vitest run test/routes.offers.test.ts` then `npx vitest run test/db.assignments.test.ts` | ❌ Wave 0 |
| P4-05 | geofence accept/reject + audited manual override; `on_the_way → arrived` legality | unit + live DB | `npx vitest run test/db.jobs.test.ts` | ❌ Wave 0 |
| P4-06 | OTP: mint at arrived (hash only), wrong/expired/locked → generic 403 + attempts increment, success sets `started_at/ends_at`, regenerate ≤3 | integration (live DB) + unit | `npx vitest run test/db.jobs.test.ts` + `npx vitest run test/serviceOtp.test.ts` | ❌ Wave 0 |
| P4-07 | track payload shape + `serverNow` math + OTP absent before `arrived` + `otp_hash` never serialized | unit (route) | `npx vitest run test/routes.track.test.ts` | ❌ Wave 0 |
| P4-08 | complete: duration math, schedule row closed, counters incremented, earning row (if Q4) | integration (live DB) | `npx vitest run test/db.jobs.test.ts` | ❌ Wave 0 |
| P4-09 | no-show legality + reason + audit; no refund side effects | unit + live DB | `npx vitest run test/db.jobs.test.ts` | ❌ Wave 0 |
| P4-10 | every pro route payload test asserts `otp_hash` absent; `professionalClient` sends Authorization on all verbs | unit | `npx vitest run test/routes.track.test.ts` + `npx vitest run test/professionalClient.test.ts` | ❌ Wave 0 |
| ALL | RLS on new tables (`booking_assignments`, `professional_earnings`) + `kyc-documents` no-public-policy | integration (live DB) | `npx vitest run test/db.rls.test.ts` | ✅ file exists — extend |
| Regression | state machine walk vs real trigger; existing suite stays green | integration | `npx vitest run test/status.test.ts` + full suites | ✅ |

### Sampling Rate

- **Per task commit (Tier 1):** `npm run typecheck` then `npx vitest run <files touched by this task>` — both must be green before commit.
- **Per wave merge (Tier 2):** `npm run typecheck` → `npm run lint` → `npm test` → `npm run test:db` (numbered chain below).
- **Migration-touching task (Tier 3):** `npm run typecheck` → `npm run db:migrate` → `npm run db:verify` → `npm run test:db`.
- **Phase gate:** Tier 2 chain plus `npm run build`, and **all floors green including the fixed `db.rls` predicate**; then `/gsd-verify-work` and the manual §30 smoke (OTP display on the customer screen, pro enters code, timer runs, complete) — manual because no e2e runner may be installed (zero-new-deps).
- **Manual-only (justification):** real file upload ≤5 MB against the live bucket and on-device geofence override — need a browser + live storage; document as human checkpoints rather than automated gates.

### Numbered command chains (run as sequential steps; no shell chaining)

**Tier 1 — per task:**
- Step 1 of 2: `npm run typecheck`
- Step 2 of 2: `npx vitest run <touched-test-file>`

**Tier 2 — per wave merge:**
- Step 1 of 4: `npm run typecheck`
- Step 2 of 4: `npm run lint`
- Step 3 of 4: `npm test`
- Step 4 of 4: `npm run test:db`

**Tier 3 — migration task:**
- Step 1 of 4: `npm run typecheck`
- Step 2 of 4: `npm run db:migrate`
- Step 3 of 4: `npm run db:verify`
- Step 4 of 4: `npm run test:db`

**Tier 4 — phase gate (run after Tier 2 passes):**
- Step 1 of 2: `npm run build`
- Step 2 of 2: `npm test` (confirm floors: ≥655 tests/38 files, 0 failed; db floor included since `db.*` runs inside `npm test`)

### Result mapping (identical shape for every tier)

```
Step command: <command from the chain above>
- PASS          : exit code 0 AND output shows the expected success line
                  (typecheck/lint: no error output; vitest: `Tests  <N> passed (<total>)`
                   with 0 failed and N ≥ floor; db:migrate/db:verify: exit 0)
- NO TESTS FOUND: vitest exits non-zero with `No test files found`
                  → treat as FAIL: the named test file is a Wave 0 gap and must be
                    created before the task may proceed (never "skip to green")
- FAIL          : any other non-zero exit, or vitest summary with ≥1 failed test
                  → stop the chain; fix before commit; do not continue to the next step
- FLOOR BREACH  : vitest passes but total < floor (655 full / 77 db)
                  → FAIL (a deleted or renamed test is a failure, not a shortcut)
```

### Wave 0 Gaps

1. **Fix the known flaky test** (pre-existing, blocks hard-fail gates): `test/db.rls.test.ts:141` — predicate `u.email like '%@smarthelp.test'` also matches transient fixture users created by `db.payments.test.ts` (`payments.isolation.b@…`) and `db.wallet.test.ts` (`wallet.ledger.*@…`), which insert `auth.users` **without** `auth.identities` rows → the "five demo accounts" assertion races them under `npm test` parallelism (observed red 654/655; passes 30/30 alone; `test:db` passes because alphabetical order + fixture purge align). Fix: narrow to `like 'demo.%@smarthelp.test'`. [VERIFIED this session by code inspection + isolated re-run]
2. `test/routes.professionals.test.ts` — FakeSupabase harness for P4-01/03/05 shells (copy `routes.addresses.test.ts` request/build shape).
3. `test/routes.kycDecision.test.ts` — P4-02 (or fold into #2 if small).
4. `test/routes.offers.test.ts` — P4-04 route-level CAS + field filtering.
5. `test/routes.track.test.ts` — P4-07/P4-10 payload assertions.
6. `test/professionalClient.test.ts` — Authorization header on every verb (Phase-2 regression class).
7. `test/serviceOtp.test.ts` — pure helpers (mint/redact/expiry math) around `lib/otp.ts` constants.
8. `test/db.assignments.test.ts` — live DB: 50 concurrent accepts ⇒ 1 winner (§29.4), expired offer refused, schedule overlap ⇒ `PROFESSIONAL_UNAVAILABLE`, RLS isolation (pro A cannot read pro B's offers).
9. `test/db.jobs.test.ts` — live DB: arrive/verify/complete/no-show happy + sad paths, attempts/lockout, counters, schedule close, earning row (if Q4), `otp_hash` invisible to `authenticated` (Pitfall 1 regression).
10. Extend `test/db.rls.test.ts` — storage assertions for `kyc-documents` (no public/read policy; insert confined to own path) if not already covered.
11. Framework install: **none** (Vitest present; no e2e runner may be added).

## Validation

**Fail-closed rules (these govern every gate above):**

1. Any non-zero exit in any tier step **stops the chain**; the next step does not run and the task does not commit.
2. `No test files found` is a **failure**, never a pass — it means a Wave 0 gap file is missing.
3. Test floors only **rise**; reducing 655/77 or deleting/skipping tests (`.skip`, `it.only`, weakened assertions) to go green is a gate violation. Skipped tests count as failures for floor purposes.
4. `npm run lint` and `npm run build` are never omitted at their tiers because they are slow; slowness is handled by tier assignment, not by skipping.
5. Migration tasks must pass Tier 3 **including `db:verify`** — a schema/seed drift fails closed even if unit tests pass.
6. The pre-existing `db.rls` flake (#1 above) may **not** be waved through after Wave 0 fixes it: from that point on, any failure of `db.rls.test.ts > seeded the five demo accounts as confirmed email logins` is a hard failure like any other.
7. Security assertions are gates too: a payload test that finds `otp_hash` in a professional/staff response fails the task (P4-10), as does a missing `authorizationHeader` in `professionalClient` tests (Pitfall 2).
8. If `SUPABASE_DB_URL` is unreachable, Tiers 2–4 **fail closed** (db files are part of `npm test`) — do not filter them out to produce a green run.

**Single test-name example (pass/fail mapping):**

```text
Command: npx vitest run test/db.assignments.test.ts
PASS →  ✓ database: offer accept is a CAS > exactly one of 50 concurrent accepts wins (exit 0, `Tests  12 passed (12)`)
FAIL →  ✗ database: offer accept is a CAS > exactly one of 50 concurrent accepts wins
        (AssertionError: expected 2 to be 1 — two acceptors won) — exit 1 → chain stops, no commit
```
