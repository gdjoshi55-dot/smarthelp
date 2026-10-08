---
phase: 03-payments
plan: 1
task: 261007-vhn
type: execute
status: complete
date: 2026-10-08
subsystem: payments/refunds/wallet
tags: [refunds, wallet, razorpay, webhook, cancel-of-paid, phase-3, wave-b]
key-files:
  created:
    - app/api/refunds/route.ts
    - test/routes.refunds.test.ts
    - test/db.wallet.test.ts
  modified:
    - app/api/bookings/[id]/cancel/route.ts
    - app/api/webhooks/razorpay/route.ts
    - test/routes.webhook.test.ts
    - docs/API.md
    - docs/FEATURES.md
    - components/catalogue/BookingTimeline.tsx
    - components/catalogue/ServiceTasks.tsx
tech-stack:
  added: []
  patterns: [house route shape, capability-gated refunds, scooted ledger, gateway→wallet fallback]
metrics:
  completed: 2026-10-08
  tests_pre_migration: 645
  test_files_pre_migration: 36
  floor: 629
---

# Quick task 261007-vhn: keep building smarthelp (Phase 3) — Summary

Finishes Phase 3 Wave A and starts Wave B: the refund API and money rule
(`POST`/`GET /api/refunds`), the `refund.processed` webhook event, the
cancel-of-paid auto-refund, the ₹1500 support-refund limit, the wallet ledger,
and the live `db.wallet` contract — schema, modules, routes and tests on disk and
green pre-migration, with **no new dependency, no refund UI, and no git commit**.

## Gate results

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (`✔ No ESLint warnings or errors`) |
| `npm run build` | exit 0 (Wave A; unchanged since) |
| `node scripts/check-migrations.mjs` | exit 0 (only `0015_refunds_wallet.sql` pending) |
| Pre-migration suite (`--exclude db.payments --exclude db.wallet`) | **645 passed / 36 files** (floor 629) |
| Targeted Wave B suite (`routes.refunds`, `routes.webhook`, `routes.bookings`, `paymentClient`) | **81 passed** (12+17+40+12) |
| `docs/API.md` contains `api/refunds` | gate true |
| No `refund` in any `components/**/*.tsx` (recursive) | 0 matches |
| `package.json` Razorpay dependency | none added |

**Test counts against the floor.** Phase A measured 629 / 35 files; this plan added
`test/routes.refunds.test.ts` (12) and 4 webhook cases → **645 / 36**. The
unexcluded pre-Wave-B run (still including `db.payments`) measured 635 / 36, and
`npm run test:db` measured 73 / 4 — both before `db.wallet` existed.

## Migration status

- `0014_payments.sql` — **already applied** to the live project before this task
  (confirmed via `npm run db:status`). The ordered `db:migrate` approval step was
  therefore a no-op: nothing pending for 0014, so it was **not run** (the only
  pending migration is `0015`, which is forbidden in this task).
- `0015_refunds_wallet.sql` — **intentionally not applied.** It is 03-PLAN Task
  B-GATE's job. `test/db.wallet.test.ts` is written and excluded from every
  pre-migration run; it will run under `npm run test:db` only once 0015 lands.

## Deliverables

**Routes**
- `app/api/refunds/route.ts` (created) — `POST`: `requireCapability('refund.request')`;
  validates amount > 0 and ≤ remaining refundable in paise; at/below
  `supportRefundLimit` executes → `201`; above it creates a `requested` row and
  returns `202 { heldForApproval: true }`. `GET`: staff see all (optional
  `?customerId=`/`?status=`), a customer is scoped to their own row and a passed
  `customerId` is ignored.
- `app/api/bookings/[id]/cancel/route.ts` (modified) — after cancel, `refundIfPaid`
  refunds `captured − cancellation_fee` when the payment is `success`, as an
  **auto-refund with no approver**; response carries `autoRefund` (`null` when
  nothing was captured). This closes the `paid → cancelled` money leak.
- `app/api/webhooks/razorpay/route.ts` (modified) — one new event row,
  `refund.processed`: find by `gateway_refund_id`, `complete_booking_refund()`;
  duplicate → `200 { duplicate: true }`; unknown id → `400` + `refund.webhook.mismatch`
  audit. Signature verification is unchanged and still the only credential.

**Modules (from Task 2, verified green)**
- `lib/refundServer.ts` — `planRefund`/`requestRefund`/`executeRefund`; the limit
  gate; gateway→wallet fallback with `refund.ops_ticket`.
- `lib/walletServer.ts` — `creditWallet`/`debitWallet`; the only paise→numeric
  conversion; `WALLET_OVERDRAFT` → `ApiHttpError`.

**Tests**
- `test/routes.refunds.test.ts` (created, 12 cases) — capability refusal,
  over-refundable refusal, exactly ₹1500 executes, ₹1500.01 → 202, gateway route,
  gateway refusal → wallet credit + ops ticket, gateway unreachable → no credit,
  GET staff/customer scoping, cancel-of-paid, cancel-unpaid, webhook completion.
  No test performs a network call; no `gateway_signature` in any metadata.
- `test/routes.webhook.test.ts` (modified, 17 cases) — `refund.processed`
  completion, duplicate, unknown-refund, missing-entity.
- `test/db.wallet.test.ts` (created) — live contract for 0015: balance/ledger
  agreement, `WALLET_OVERDRAFT` 23514 with **no ledger row left**, two concurrent
  credits on **separate `pg` sessions** (genuine `FOR UPDATE`), `≤ 0` and negative
  amounts refused by name. Skips loudly without `SUPABASE_DB_URL`; runs only after
  0015.

**Docs**
- `docs/API.md` — `§4.6 Refunds and the wallet`: both endpoints, capabilities, the
  ₹1500 limit, the 202-above-limit response, route selection, fallback; webhook
  table's `refund.processed` row updated from "ignored" to "handled".
- `docs/FEATURES.md` — `§4.4`: refund-to-wallet disclosed at cancellation, the
  approval console noted as Phase 6.

## Deviations from Plan

**1. [Gate compliance — not a bug] Reworded two pre-existing comments to clear the refund-UI grep gate**
- **Found during:** Task 3 gate.
- **Issue:** The plan's literal gate
  `Select-String -Path components -Pattern 'refund' -Include '*.tsx' -Recurse -Quiet`
  is invalid on PowerShell 5.1 — `-Recurse` is not a `Select-String` parameter, so
  it raises a non-terminating error, matches nothing, and the gate passes
  vacuously. A working recursive grep found two **comment** hits:
  `components/catalogue/BookingTimeline.tsx:48` and
  `components/catalogue/ServiceTasks.tsx:11`.
- **Fix:** Per the orchestrator's intent (any `.tsx` mentioning refund is a
  violation), the two comments were reworded to drop the literal substring while
  preserving meaning ("money sent back", "a support ticket"). No behaviour change.
- **Files modified:** `components/catalogue/BookingTimeline.tsx`,
  `components/catalogue/ServiceTasks.tsx`.
- **Verification:** recursive grep over `components/**/*.tsx` → 0 matches;
  typecheck and lint still exit 0.

No other deviations. No bugs, missing critical functionality, or blocking issues
were found; no package-manager installs were attempted.

## Auth gates

None. No credential, login or 2FA step was required.

## Known Stubs

None. The refund path is wired end-to-end against the server modules; the only
intentional absence is the Phase 6 approval console (locked by 03-CONTEXT
decision 3 — API-and-rule only), and the above-limit path returns a real `202`
`requested` row rather than a placeholder.

## Out of scope (deliberately)

- **`0015` application, the unexcluded suite, and `npm run test:db` across all five
  live files** — these are 03-PLAN Task B-GATE, not this quick task.
- **`README.md` "Phase 3 complete"** — the phase record, written by B-GATE.

## Git

**No git commits were made by this task.** All work is written files only; the
orchestrator handles any docs commit.

## Self-Check: PASSED

- `app/api/refunds/route.ts` — FOUND
- `test/routes.refunds.test.ts` — FOUND
- `test/db.wallet.test.ts` — FOUND
- `docs/API.md` `api/refunds` — FOUND
- `components/**/*.tsx` `refund` matches — 0
