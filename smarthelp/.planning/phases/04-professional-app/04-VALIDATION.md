---
phase: 4
slug: professional-app
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-10-08
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `04-RESEARCH.md` § "Validation Architecture" (2026-10-08).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.1.1 (node environment) |
| **Config file** | `vitest.config.ts` — exists; include `test/**/*.test.ts`; no Wave 0 install needed |
| **Quick run command** | `npx vitest run <file>` |
| **Full suite command** | `npm test` (= `vitest run`, includes `db.*`; baseline 655 tests / 38 files) |
| **DB suite command** | `npm run test:db` (= `vitest run test/db. --no-file-parallelism`; baseline 77 tests / 5 files) |
| **Type check** | `npm run typecheck` (baseline exit 0) |
| **Lint** | `npm run lint` (baseline exit 0; **slow >240 s** — wave tier only, never per-commit) |
| **Estimated runtime** | typecheck ~40 s · quick run ~10 s · full suite ~120 s · lint >240 s |

**Floors (2026-10-08):** `npm test` ≥ 655 tests / 38 files, 0 failed · `npm run test:db` = 77 passed · typecheck exit 0 · lint exit 0. A passing run with total < floor = **FLOOR BREACH → FAIL** (deleted/renamed tests are failures, not shortcuts).

---

## Sampling Rate

- **Per task commit (Tier 1):** `npm run typecheck`, then `npx vitest run <touched-test-file>` — both green before commit.
- **After every plan wave (Tier 2):** `npm run typecheck` → `npm run lint` → `npm test` → `npm run test:db` (sequential, no shell chaining).
- **Migration-touching task (Tier 3):** `npm run typecheck` → `npm run db:migrate` → `npm run db:verify` → `npm run test:db`.
- **Phase gate (Tier 4):** Tier 2 chain green, then `npm run build` → `npm test` (floors green including fixed `db.rls` predicate), then `/gsd-verify-work` + manual §30 smoke.
- **Before `/gsd-verify-work`:** Full suite must be green.
- **Max feedback latency:** ~120 s (typecheck + touched tests); lint only at wave tier.

### Result mapping (every tier)

- **PASS:** exit 0 and vitest shows `Tests N passed` with 0 failed and N ≥ floor.
- **NO TESTS FOUND:** vitest exits non-zero with `No test files found` → **FAIL**; the named test file is a Wave 0 gap to create first.
- **FAIL:** any other non-zero exit or ≥1 failed test → stop the chain, fix before commit.
- **FLOOR BREACH:** passes but total < floor (655 full / 77 db) → FAIL.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| P4-01 | TBD | 0 | Signed upload URL: ownership, doc_type allow-list, size/MIME rejection, `status='submitted'` insert | T-4-xx | Path confined to owning pro; anon has no policy | unit (route, FakeSupabase) | `npx vitest run test/routes.professionals.test.ts` | ❌ W0 | ⬜ pending |
| P4-02 | TBD | 0 | Admin KYC decision: 403 non-admin, verdict write + roll-up to `verified`, audit row | T-4-xx | Server-side admin capability only | unit (route) | `npx vitest run test/routes.kycDecision.test.ts` | ❌ W0 | ⬜ pending |
| P4-03 | TBD | 0 | Working hours PUT / time-off POST / availability toggle: validate + ownership | — | Ownership checked server-side | unit (route) | `npx vitest run test/routes.professionals.test.ts` | ❌ W0 | ⬜ pending |
| P4-04 | TBD | 1 | Inbox field filtering; accept CAS single-winner under 50 concurrent; expired offer refused; decline records reason | T-4-xx | No cross-pro offer visibility; one winner enforced in DB | unit + integration (live DB) | `npx vitest run test/routes.offers.test.ts` then `npx vitest run test/db.assignments.test.ts` | ❌ W0 | ⬜ pending |
| P4-05 | TBD | 1 | Geofence accept/reject + audited manual override; `on_the_way → arrived` legality | T-4-xx | Server-side haversine; override audited | unit + live DB | `npx vitest run test/db.jobs.test.ts` | ❌ W0 | ⬜ pending |
| P4-06 | TBD | 1 | OTP: mint at arrived (hash only), wrong/expired/locked → generic 403 + attempts, success sets `started_at/ends_at`, regenerate ≤3 | T-4-xx | `otp_hash` never serialized; lockout server-enforced | integration (live DB) + unit | `npx vitest run test/db.jobs.test.ts` + `npx vitest run test/serviceOtp.test.ts` | ❌ W0 | ⬜ pending |
| P4-07 | TBD | 1 | Track payload: `startedAt/endsAt/serverNow/remainingSeconds`; OTP absent before `arrived` | T-4-xx | Server-authoritative timer; no `otp_hash` in payload | unit (route) | `npx vitest run test/routes.track.test.ts` | ❌ W0 | ⬜ pending |
| P4-08 | TBD | 2 | Complete: duration math, schedule row closed, counters incremented, earning row (if Q4) | — | No self-service refund side effects | integration (live DB) | `npx vitest run test/db.jobs.test.ts` | ❌ W0 | ⬜ pending |
| P4-09 | TBD | 2 | No-show / pro-cancellation legality + reason + audit; no refund side effects | T-4-xx | Pro never self-cancels into a refund path (hard rule) | unit + live DB | `npx vitest run test/db.jobs.test.ts` | ❌ W0 | ⬜ pending |
| P4-10 | TBD | 0 | Every pro route payload test asserts `otp_hash` absent; `professionalClient` sends Authorization on all verbs | T-4-xx | Auth header on every verb; secrets never in client payload | unit | `npx vitest run test/routes.track.test.ts` + `npx vitest run test/professionalClient.test.ts` | ❌ W0 | ⬜ pending |
| ALL | TBD | 0 | RLS on `booking_assignments` / `professional_earnings`; `kyc-documents` no public policy | T-4-xx | Anon revoked; own-path insert only | integration (live DB) | `npx vitest run test/db.rls.test.ts` | ⚠️ exists — extend | ⬜ pending |
| REG | TBD | 2 | State-machine walk vs real trigger; existing suite stays green | — | Regression floor held | integration | `npx vitest run test/status.test.ts` + full suites | ✅ exists | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · Task IDs become `<plan>-T-NN` once the planner assigns plan/wave.*

---

## Wave 0 Requirements

- [ ] `test/db.rls.test.ts:141` — **fix known flaky predicate**: `u.email like '%@smarthelp.test'` also matches transient fixtures from `db.payments`/`db.wallet` (users without `auth.identities` rows); narrow to `like 'demo.%@smarthelp.test'`. (Pre-existing; observed 654/655 under parallel `npm test`, 30/30 alone.)
- [ ] `test/routes.professionals.test.ts` — FakeSupabase harness for P4-01/03/05 (copy request/build shape from `test/routes.addresses.test.ts`).
- [ ] `test/routes.kycDecision.test.ts` — P4-02 (or folded into the above if small).
- [ ] `test/routes.offers.test.ts` — P4-04 route-level CAS + field filtering.
- [ ] `test/routes.track.test.ts` — P4-07/P4-10 payload assertions.
- [ ] `test/professionalClient.test.ts` — Authorization header on every verb (Phase-2 regression class).
- [ ] `test/serviceOtp.test.ts` — pure helpers (mint/redact/expiry math) around `lib/otp.ts`.
- [ ] `test/db.assignments.test.ts` — live DB: 50 concurrent accepts → 1 winner, expired offer refused, schedule overlap → `PROFESSIONAL_UNAVAILABLE`, cross-pro RLS isolation.
- [ ] `test/db.jobs.test.ts` — live DB: arrive/verify/complete/no-show happy + sad paths, attempts/lockout, counters, schedule close, earning row, `otp_hash` invisible to `authenticated`.
- [ ] `test/db.rls.test.ts` — extend with `kyc-documents` storage assertions (no public/read policy; insert confined to own path).
- [ ] Framework install: **none** (Vitest present; **no e2e runner may be added** — zero-new-deps hard rule).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real file upload ≤5 MB against the live `kyc-documents` bucket | P4-01 | Needs browser + live storage; no e2e runner allowed | Log in as a pro, upload a valid doc and an oversized/wrong-MIME doc; confirm accepted/rejected and path ownership |
| On-device geofence manual override | P4-05 | Needs real GPS coordinates in a browser | Start a job, arrive from outside radius → refused; use override → accepted + audit row |
| §30 end-to-end smoke (OTP display on customer screen, pro enters code, timer runs, complete) | P4-06/07/08 | Multi-role browser flow, no e2e runner | Manual walkthrough at phase gate |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120 s (Tier 1)
- [ ] `nyquist_compliant: true` set in frontmatter (after planner assigns task IDs and checker approves)

**Approval:** pending
