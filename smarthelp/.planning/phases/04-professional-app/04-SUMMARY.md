---
phase: 04-professional-app
type: summary
date: 2026-10-10
status: complete
requirements: [P4-01, P4-02, P4-03, P4-04, P4-05, P4-06, P4-07, P4-08, P4-09, P4-10]
---

# Phase 4 — Professional app: summary

**Complete as of 2026-10-10.** Four waves built, the Wave A schema-push gate
passed under human approval, and the phase gate (Task D1) closed with the Tier-4
chain green and the three manual verifications passed. The suite is **798 tests
across 46 files** (the floor when the phase began: 655 / 38), `npm run test:db`
is green across all seven live files (**96 tests**), and typecheck, lint and
build exit 0. Twenty-seven migration files, **28 applied, 0 outstanding**.

## The waves

**Wave A — foundation, availability, and the push.** `lib/professionalServer.ts`
(the ownership-checking server module and the one strip function),
`lib/professionalClient.ts` (the authenticated browser client), `lib/serviceOtp.ts`
(the OTP helpers), and the new `PLATFORM_DEFAULTS` constants; availability —
`PUT me/working-hours`, `POST me/time-off`, `PUT me/availability` (the online
toggle) plus the professional home-page repair; and migration `0012`
(`booking_assignments`, the `assignment_status` enum, the
`uniq_active_assignment_per_booking` partial unique index, and the
`accept_offer`/`decline_offer`/`sweep_new_bookings` CAS RPCs), `0021`
(`professional_earnings`), `0029` (the six service-execution RPCs), the
hand-maintained type mirror, and the `db.rls` flake fix. **Task A4 — the Wave A
gate — pushed the schema live with human approval.**

**Wave B — KYC, offers, and the arrive/OTP spine.** Signed upload URL +
submission + the admin KYC decision with the `verified` roll-up; the offers
inbox (field-filtered read, CAS accept, reasoned decline) and `me/jobs`; arrive
with the server-side geofence and the audited manual override; the OTP verify and
mint routes; and the job-detail screen. Migration `0030` landed here: it puts
`verify_service_otp` back on `search_path = public, extensions` (the `digest()`
call in `extensions` failed under `0029`'s `public`-only path) and guards
`complete_job` against a re-complete double-count.

**Wave C — completion and tracking.** `C1` the multi-effect `complete_job` /
`no_show_job` callers and their live job proofs; `C2` the track endpoint and the
customer's live booking screen, plus `bookings/[id]/otp/regenerate`.

**Wave D — documentation and the phase gate.** `docs/API.md` §4.7,
`docs/FEATURES.md` §6, `docs/DATABASE.md` §11 and `README.md`, then the Tier-4
chain and the three manual verifications.

## The gates

| Gate | Result |
|---|---|
| Wave A gate (Task A4) | typecheck / lint / build / `check-migrations.mjs` exit 0; `0012`, `0021`, `0029` applied to the live project with human approval (28 applied, 0 outstanding); no code commits |
| Phase gate (Task D1) | typecheck / lint / build exit 0 → `npm test` **798 / 46 files, 0 failed** (floor 655 / 38) → `test:db` **96 / 7 files** (floor 77 / 5) → §31.1 hand-check → no code commits |
| §31.1 exit criterion | **a verified professional can take and complete a job** — in-product: `sweep_new_bookings` offers a real paid booking, accept is CAS-clean under 50-way concurrency, arrive enforces the geofence, the OTP cycle runs hash-only, and complete stamps the duration, closes the schedule and writes the earning row ✓ |
| Manual verifications | live bucket upload ✓ · on-device geofence override ✓ · §30 end-to-end smoke ✓ |
| Floors | 04-PLAN's stated floor was 655 / 77; the phase lands at **798 / 96** — 143 full-suite and 19 db tests above it |

## Requirement coverage

| ID | Where |
|---|---|
| `P4-01` | `app/api/kyc-documents/upload-url`, `app/api/professionals/me/kyc`, the `kyc-documents` bucket; `test/routes.professionals.test.ts` |
| `P4-02` | `app/api/admin/professionals/[id]/kyc/[docId]/decision` + `kyc_document_decision`; `test/routes.kycDecision.test.ts` |
| `P4-03` | `me/working-hours`, `me/time-off`, `me/availability`; `test/routes.professionals.test.ts` |
| `P4-04` | `offers`, `offers/[id]/accept`, `offers/[id]/decline`, `0012` CAS; `test/routes.offers.test.ts` + `test/db.assignments.test.ts` |
| `P4-05` | `jobs/[id]/arrive`, `me/location`, `arrive_job`; `test/db.jobs.test.ts` |
| `P4-06` | `jobs/[id]/otp`, `bookings/[id]/otp/regenerate`, `lib/serviceOtp.ts`; `test/db.jobs.test.ts` + `test/serviceOtp.test.ts` |
| `P4-07` | `bookings/[id]/track`; `test/routes.track.test.ts` |
| `P4-08` | `jobs/[id]/complete`, `complete_job` → `professional_earnings`; `test/db.jobs.test.ts` |
| `P4-09` | `jobs/[id]/no-show`, `no_show_job`; `test/db.jobs.test.ts` |
| `P4-10` | the one strip function, the `otp_hash` column grant in `0029`, the stringified-body assertions; `test/routes.track.test.ts`, `test/routes.professionals.test.ts`, `test/db.rls.test.ts` |

## The nine decisions, with reasons

Stated in full in `04-PLAN.md` (D1–D9) and one line each in
`docs/FEATURES.md` §6.6. The load-bearing reasons:

- **`0012` was reclaimed because the exit criterion is unreachable without it**
  (D1). "A verified professional can take a job" needs an assignment row to take;
  nothing on disk creates one. What stays in Phase 5 is the *matching engine* —
  ranking, fan-out, advisory locks, the reassignment cascade — and the table is
  built to receive it unchanged.
- **OTP is minted lazily, customer-gated, at `arrived` (D3).** Hash-only storage
  means the code is unrecoverable, so minting on the professional's device would
  hand them the credential the customer is meant to hold. The plaintext lives only
  in the customer's regenerate route, generation-capped at three.
- **`0030` exists because `0029` failed silently-quietly.** `verify_service_otp`
  needed `extensions` on its `search_path` for `digest()`; the `complete_job`
  re-entry guard is the second half. `0029` is frozen; the fix is a new file.
- **No professional write touches money.** Complete inserts a *pending* earning;
  no-show touches neither refunds nor wallets; there is no extend endpoint and no
  refund action anywhere. `test/db.jobs.test.ts`'s absence-assertions make the
  agreement testable (D4, D8).
- **The admin KYC endpoint ships without a console** — Phase 3's own precedent
  (D2). The roll-up to `verified` is the piece that did not exist on disk.
- **Polling, not Realtime, and the clock, not the device** (D6). Every timer is
  `endsAt − serverNow`. Phase 7 replaces the transport, not the contracts.

## Deviations, with reasons

- **Two test-isolation flakes were fixed at the gate, not the product.** With the
  db suite now running in parallel under `npm test`, two live files collided:
  `db.assignments`' `makeOffer` bypassed `sweep_new_bookings` so
  `accepted_offers <= total_offers` drifted (now bumps `total_offers`, mirroring
  the RPC), and `db.jobs` reserved the same `2030-09-04 10:00` slot on the shared
  demo professional as `db.assignments` (moved to `2030-09-05`). Test-only; no
  product code touched.
- **`0030` is a post-`0029` fix file, not an edit.** The migration ledger skips
  already-recorded files, so `0029` is frozen and the `search_path` / re-complete
  fixes ship as `0030`.
- **No packages were installed** and `vercel.json` is unchanged (D9).
- **No source, test, migration or config file was committed by any Phase 4 task.**
  The code working tree remains uncommitted for the branch owner. The only Phase 4
  commits on the branch are the GSD orchestrator documentation commits (research,
  validation strategy, UI design contract).

## Manual verifications (performed at the phase gate)

- **Live bucket upload (P4-01):** a valid doc accepted, an oversized/wrong-MIME
  doc rejected, path confined to the owning professional.
- **On-device geofence override (P4-05):** arrive from outside the radius refused;
  the manual override with a reason accepted, with an audit row.
- **§30 end-to-end smoke (P4-06/07/08):** the OTP minted on the customer screen,
  entered by the professional, the timer driven from server truth, and the
  completion landing the earning row.

## Deliberately out of scope

Phase 5's ranked matching, offer fan-out, advisory locks, the real assignment
engine (replacing `sweep_new_bookings` whole), the expiry sweeper cron, the
reassignment cascade and the 30-minute hold, and the `professional_schedule`
availability *input* to slot math. Phase 6's KYC review-queue UI, manual
assignment and `platform_settings`. Phase 7's Realtime, presence and chat. Phase
8's extensions (`extensionAvailable` stays false), the earnings page and payouts,
wallet top-up, referrals, surge, invoices/PDF and the PWA. Phase 9's
`next_job_late_min` analytics. **No refund action, no new cron, no new package.**
