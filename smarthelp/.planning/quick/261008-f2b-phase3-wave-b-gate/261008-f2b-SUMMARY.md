---
phase: 03-payments
plan: 1
task: 261008-f2b
type: execute
status: complete
date: 2026-10-08
subsystem: payments/gate
tags: [phase-3, gate, migration-0015, vitest, test-isolation, wallet, refunds, readme]
key-files:
  created: []
  modified:
    - README.md
tech-stack:
  added: []
  patterns: [address-scoped rollback assertions instead of global row counts in live-db tests]
metrics:
  started: 2026-10-08T12:20:00Z
  completed: 2026-10-08T13:45:00Z
  steps_passed: "9/9"
  tests_step4: 645
  test_files_step4: 36
  tests_step6: 655
  test_files_step6: 38
  tests_step7: 77
  test_files_step7: 5
requirements: [P3-ORDERS, P3-WEBHOOK, P3-VERIFY, P3-CRON, P3-REFUNDS, P3-WALLET]
---

# Quick task 261008-f2b: Phase 3 Task B-GATE — Summary

**All nine B-GATE steps green in order: `0015` applied live, unexcluded suite 655/38, `test:db` 77/5 green across all five live files, §31.1's four clauses confirmed with grep/code evidence, zero git commits — and the README now records the repository at Phase 3 with phases 0–3 done.**

## The nine B-GATE steps, in order

| # | Step | Command | Result |
|---|---|---|---|
| 1 | PRE-MIGRATION typecheck | `npm run typecheck` | ✅ exit 0 |
| 2 | PRE-MIGRATION lint | `npm run lint` | ✅ exit 0 — `✔ No ESLint warnings or errors` |
| 3 | PRE-MIGRATION build | `npm run build` | ✅ exit 0 — Next.js 14.2.35, 11/11 static pages, all routes compiled |
| 4 | PRE-MIGRATION excluded suite | `npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"` | ✅ **645 passed / 36 files** (floor ≥629/≥36), 0 failed, 191s. Re-run after the test fix (see Deviations) with identical counts. No `.only`/`.skip(` in `test/*.test.ts` |
| 5 | APPLY (approved) | `npm run db:status` → `npm run db:migrate` | ✅ guard: status listed **exactly `0015_refunds_wallet.sql` pending** (1 outstanding) → migrate: `ok 0015_refunds_wallet.sql`, **Applied 1 migration(s)**, every other file `skip`. Post-status: **0 outstanding, 24 applied** — 0015 recorded live |
| 6 | POST-MIGRATION unexcluded suite | `npx vitest run` | ✅ (after fix) **655 passed / 38 files, 0 failed**, 171s, exit 0. First attempt **failed** (1/655 — cross-file row-count race, reported verbatim, fixed by the orchestrator, then re-run green) |
| 7 | POST-MIGRATION `test:db` | `npm run test:db` | ✅ **77 passed / 5 files**, 0 failed, 152s — `db.booking`+`db.rls`+`db.connection` (67, incl. connection ×3), **`db.payments` ×6** and **`db.wallet` ×4** both executing for the first time in this gate |
| 8 | §31.1 exit-criteria hand-check | grep + code read | ✅ all four clauses confirmed — evidence below |
| 9 | No git commits | `git log` / `git diff` | ✅ HEAD still `5c44539 docs(quick-261007-vhn): …` throughout; this task made **zero commits**; `git status` shows only the intended uncommitted `README.md` edit and the docs artifacts for the orchestrator |

Order was load-bearing and respected: steps 1–4 passed **before** `db:migrate`; step 5 ran only after the pending-set guard confirmed `0015` alone; steps 6–7 ran only after 0015 was recorded live.

### Step 6's first attempt and the fix (deviation record)

The first unexcluded run failed with `AssertionError: expected '208' to be '207'` at
`test/db.booking.test.ts:267` — the `0028` rollback test asserted a **global**
`count(*) from public.bookings` was unchanged across its own body, while
`test/db.payments.test.ts:151` (`bookingPendingPayment`) inserts bookings in
parallel. This was the first time the two files had ever run concurrently against
the live database (step 4 excludes db.payments; `test:db` runs sequentially with
`--no-file-parallelism`). The gate stopped and reported the output verbatim rather
than re-running or talking past it. After the orchestrator's fix (below), step 6
re-ran green at 655/38.

## Migration record

- **`0015_refunds_wallet.sql` is applied to the live project.** Pending-set guard
  first: `db:status` showed `TODO 0015_refunds_wallet.sql` as the only outstanding
  file; `db:migrate` applied exactly that one (`ok 0015`, `Applied 1`,
  everything else `skip`); `db:status` after: **0 outstanding**. The wallet
  ledger, refunds, wallet RLS and the `confirm_booking_payment` amendment are
  live, not just on disk.
- No other migration applied. **No new npm dependency installed.**

## §31.1 exit-criteria hand-check (step 8) — verdicts

**Clause 1 — real money in (order → webhook → `paid`): ✅ CONFIRMED.**
- Order: `POST /api/payments/create-order` → `createBookingOrder()` inserts the
  payment row with `status: 'created'` (`lib/paymentServer.ts:180–190`) after
  requiring the booking be `payment_pending`
  (`app/api/payments/create-order/route.ts:122`).
- Webhook: `app/api/webhooks/razorpay/route.ts` — missing `x-razorpay-signature`
  → 400 (`:75–81`), HMAC mismatch → 400 (`:98–100`), then
  `supabase.rpc('confirm_booking_payment', …)` (`:280`).
- `confirm_booking_payment` (`supabase/migrations/0015_refunds_wallet.sql:612`)
  does both writes in **one transaction**: `payments → 'success'` guarded by
  `status in ('created','pending')` (replay updates zero rows and returns null)
  and `bookings → 'paid'` guarded by `status = 'payment_pending'`, quote token
  nulled. The route's own comment (`webhook/route.ts:53`): "Exactly two things,
  and only ever through `confirm_booking_payment()`".

**Clause 2 — real money out (refund executed): ✅ CONFIRMED.**
- `lib/refundServer.ts:244 executeRefund()` — row first (`record_booking_refund`),
  gateway second, gateway id persisted on the row *before* completion so a
  `refund.processed` webhook can match it (`:281–291`), then
  `complete_booking_refund` RPC (`:312`) → refund `completed`, booking `refunded`.
  A definite gateway refusal routes the same amount to the wallet and completes
  with `route='wallet'` (`:437`); an unreachable gateway credits nothing.
- Callers: `POST /api/refunds` (`app/api/refunds/route.ts:84`, capability-gated)
  and the cancel-of-paid auto-refund
  (`app/api/bookings/[id]/cancel/route.ts:153`).
- The webhook closes the loop: `refund.processed` → `complete_booking_refund`
  (`webhook/route.ts:445`) — the same function, not a second writer.
- Live proof: `test/db.wallet.test.ts` ×4 green under step 7, including the
  overdraft raising 23514 **with no ledger row left behind**.

**Clause 3 — webhook sole authority, no client-reachable path writes `success`: ✅ CONFIRMED (grep evidence).**
- Grep over `app/**/*.ts` + `lib/*.ts` for writes of `success`: **zero write
  sites** — every hit is a comment or the response envelope
  (`lib/api.ts` `success: true/false`), a UI tone, or a status *read*
  (`lib/paymentClient.ts:169` reads it to render).
- `.rpc('confirm_booking_payment')` under `app/`: **exactly two call sites** —
  `app/api/webhooks/razorpay/route.ts:280` and
  `app/api/cron/reconcile-payments/route.ts:172`. No third caller anywhere.
- `/api/payments/verify` (the one client-reachable payments writer-shaped route)
  is **read-only**: `.from('payments').select('*')` (`verify/route.ts:72–77`) and
  returns the status the webhook left (`:93`); docstring `:16–23` states it does
  not store `gateway_payment_id`, does not nudge `pending` to `success`, does not
  call `confirm_booking_payment`.
- Database belt-and-braces: `payments` has **no INSERT/UPDATE/DELETE policy** —
  only `payments_select_own` (`0014:144`) plus `revoke all … from anon`
  (`0014:149`); `confirm_booking_payment` is `revoke …/ grant execute … to
  service_role` only (`0015:690–697`), so a browser session cannot even call it.
- Both writers are gated on gateway truth: webhook on the HMAC header; the cron
  **fails closed** — no `CRON_SECRET` set → refuses to run
  (`cron/route.ts:92–96`), mismatch → 401 (`:106`).
- Live proof: `test/db.payments.test.ts` describe block
  **"confirm_booking_payment is the only writer of success"** — all 3 cases green
  in step 7.

**Clause 4 — RLS on payments: ✅ CONFIRMED from step 7's live results.**
- `db.payments.test.ts` 6/6 green, including
  "shows a customer their own payment, another customer nothing, and a visitor
  nothing" and "revokes anon outright rather than admitting it through a policy";
  schema side: `payments_select_own` + `revoke all on public.payments from anon`
  (`0014:144,149`), no write policies.
- Adjacent wallet RLS also live and green: `revoke all … from anon` on
  `wallets`/`wallet_transactions` (`0015:283–284`) and the
  `wallet_txn_no_update`/`wallet_txn_no_delete` refusal policies (`0015:273,278`).

## README Phase 3 record (Task 2)

Two regions changed, nothing else (`git diff README.md` confirms exactly these):

1. **Line 6 statement:** `**This repository is at Phase 1.**` →
   `**This repository is at Phase 3.**`; the sentence that follows now names what
   is built — schema, sign-in for every role, authorisation model, public
   catalogue, bookings and pricing, and the payments/refunds/wallet money paths —
   and what is not: the professional app, the matching engine, and the admin/ops
   dashboards, "role-gated placeholder shells". Lines 15–17 ("Nothing here has
   been deployed…") untouched and still accurate.
2. **Phase table:** the combined `3–9` row split into
   `| 3 | Payments | done |` and `| 4–9 | Professional app, matching, admin,
   realtime, growth, launch | planned |`; row 2 moved from `next` to `done`.
   Final states top to bottom: 0 `done`, 1 `done`, 2 `done`, 3 `done`, 4–9
   `planned`. All other Scope cells byte-identical.

Automated gate: all five plan assertions pass ("at Phase 3" present, row
`| 3 | Payments | done |` present, `| 4–9 | … | planned |` present, "at Phase 1"
absent, `| next |` absent). Voice kept plain and candid; no sales language; the
Scripts table's stale counts deliberately left for the docs pass, as the plan
directed.

## Deviations from Plan

**1. [Test-only robustness — diagnosed here, fixed by the orchestrator] Cross-file global row-count assertion in `test/db.booking.test.ts`**
- **Found during:** Task 1, step 6 (first attempt).
- **Issue:** `test/db.booking.test.ts:267` asserted a global
  `count(*) from public.bookings` was unchanged across its test body; running the
  unexcluded suite in parallel lets `db.payments.test.ts` insert a booking inside
  that window (observed `207 → 208`). Never seen before because step 4 excludes
  db.payments and `test:db` runs with `--no-file-parallelism`.
- **Fix (orchestrator, applied between runs):** the `const before` global count
  was removed; after the rejected `create_booking` the test now asserts
  `count(*) from bookings where address_id = '<this test's fresh address>' = 0`
  and the same scope for `booking_items` via join (`:270–279`), then deletes the
  address. `addressFor()` always inserts a fresh row, so the scope cannot collide
  with any other file's fixtures.
- **Files modified:** `test/db.booking.test.ts` — **test only; no product code was
  touched, no migration changed.**
- **Verification:** step 4 re-run green at 645/36 with the edited test; step 6
  then green at **655/38** (exit 0), previously-failing case passing.

No other deviations. No bugs, missing critical functionality, or blocking issues
in product code; no package-manager installs were attempted; `.planning/STATE.md`
and `.planning/ROADMAP.md` untouched.

## Issues Encountered

- The step-6 race above — stopped, reported verbatim with diagnosis, fixed
  test-only, re-gated. Nothing else.

## Git

**No git commits were made by this task.** HEAD at start and end:
`5c44539 docs(quick-261007-vhn): keep building smarthelp (Phase 3) - Wave A gated,
Wave B started`. The only working-tree changes this task introduced are
`README.md` (the Phase 3 record above) and this SUMMARY — both left uncommitted
for the orchestrator's docs commit, as instructed.

## Self-Check: PASSED

- SUMMARY rewritten at `.planning/quick/261008-f2b-phase3-wave-b-gate/261008-f2b-SUMMARY.md` — FOUND
- `0015` recorded live (`db:status`: 0 outstanding) — CONFIRMED
- Step 6 counts 655/38 and step 7 counts 77/5 — captured from passing runs
- README automated gate (5 assertions) — ALL PASS
- HEAD unchanged `5c44539` (no commits) — CONFIRMED
- `git diff README.md` touches only the two intended regions — CONFIRMED
