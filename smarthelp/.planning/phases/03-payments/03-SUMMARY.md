---
phase: 03-payments
type: summary
date: 2026-10-08
status: complete
requirements: [P3-ORDERS, P3-WEBHOOK, P3-VERIFY, P3-CRON, P3-REFUNDS, P3-WALLET]
---

# Phase 3 — Payments, refunds & wallet: summary

**Complete as of 2026-10-08.** Both waves built, both gates passed, §31.1's exit
criteria hand-checked against the running code. The suite is **655 tests across
38 files** (baseline when the phase began: 555), `npm run test:db` is green
across all five live files (77 tests), and typecheck, lint and build exit 0.

## The waves

**Wave A — money in.** `0014_payments.sql` (payments with `uniq_payments_idem`,
select-only RLS, `confirm_booking_payment` as the single writer of `success`),
the pure SHA-256 signature verifier, the injectable gateway transport,
`POST /api/payments/create-order` (Idempotency-Key required, `409 INVALID_STATE`
when the quote token is absent, `409 PRICE_CHANGED`, `402 PAYMENT_FAILED`),
`POST /api/payments/verify` (read-only, `402 PAYMENT_NOT_VERIFIED`),
`GET /api/payments/[id]` (ownership-checked), the webhook route (raw-body
HMAC before any parse — the sole credential and the sole authority), and
`GET /api/cron/reconcile-payments` (three-channel `CRON_SECRET` guard, 503
fail-closed, two alert conditions, all three resolutions funnelled through
`confirm_booking_payment`). The client opens real Razorpay Checkout and derives
`paid` only from a polled `payments.status` — never from the handler callback.

**Wave B — money out.** `0015_refunds_wallet.sql` carrying both mandated
amendments to §12.4 (`balance_after` written; the balance read `FOR UPDATE` and
checked before the write, so `WALLET_OVERDRAFT` is reachable instead of sitting
behind a non-deferred `CHECK`), `refunds` / `wallets` / `wallet_transactions`
with select-only RLS and the two outright ledger blocks,
`customers.wallet_id`, the RPC pair `record_booking_refund` /
`complete_booking_refund` (which makes §8.2's `refund_pending` → `refunded`
reachable), `lib/walletServer.ts` (the only paise → `numeric` conversion),
`lib/refundServer.ts` (the ₹1500 `supportRefundLimit` gate, gateway → wallet
fallback with the `refund.ops_ticket` audit row), `POST/GET /api/refunds`,
the `refund.processed` webhook event, and the cancel-of-paid auto-refund that
closes the `paid → cancelled` money leak for `total_amount − cancellation_fee`.

## The gates

| Gate | Result |
|---|---|
| Wave A gate (inside quick task 261007-vhn) | typecheck / lint / build / `check-migrations.mjs` exit 0; pre-migration suite **645 / 36 files** (floor 629); `0014` already live — `db:migrate` was a no-op; unexcluded 635/36, `test:db` 73/4 |
| Wave B gate (03-PLAN Task B-GATE, quick task 261008-f2b) | all nine steps green: typecheck / lint / build exit 0 → excluded suite **645 / 36** → `db:status` showed exactly `0015` pending → applied (24 applied, 0 outstanding) → unexcluded **655 / 38 files, 0 failed** → `test:db` **77 / 5 files** → §31.1 hand-check → no code commits |
| §31.1 exit criteria | **money in** (order → webhook → `paid`) ✓ · **money out** (refund to gateway or wallet) ✓ · **webhook sole authority** — zero client-reachable writers of `success` in `app/` + `lib/`; exactly two `.rpc('confirm_booking_payment')` call sites (webhook, cron); `/api/payments/verify` is SELECT-only ✓ · **RLS on `payments`, `refunds`, `wallets`, `wallet_transactions`** — each covered by a live isolation test ✓ |
| Floors | 03-PLAN's stated floor was 555; the phase lands at **655 / 38** — 100 tests above it |

Live verification of `test/db.payments.test.ts` (6 cases, all four tables
isolated across two customers, anon revoked) and `test/db.wallet.test.ts`
(4 cases: overdraft raises `23514` and leaves **no** ledger row, two concurrent
credits on separate sessions sum exactly) ran for the first time at the B-GATE,
against the migrated live project.

## Requirement coverage

| ID | Where |
|---|---|
| `P3-ORDERS` | `app/api/payments/create-order`, `lib/paymentServer.ts`, `lib/razorpayClient.ts` |
| `P3-WEBHOOK` | `app/api/webhooks/razorpay`, `lib/razorpaySignature.ts` (SHA-256, raw bytes, `timingSafeEqual`) |
| `P3-VERIFY` | `app/api/payments/verify`, `app/api/payments/[id]`, `lib/paymentClient.ts` |
| `P3-CRON` | `app/api/cron/reconcile-payments`, `vercel.json` (exactly one cron) |
| `P3-REFUNDS` | `app/api/refunds`, `lib/refundServer.ts`, cancel-of-paid auto-refund, `refund.processed` |
| `P3-WALLET` | `0015_refunds_wallet.sql`, `lib/walletServer.ts`, `test/db.wallet.test.ts` |

## Deviations, with reasons

- **SHA-256, not §12.1's SHA-512.** Razorpay's own docs define the signature as
  HMAC-SHA256; implementing the spec literally would pass every synthetic test
  and fail every real delivery. Locked by 03-CONTEXT decision 1.
- **A test was made robust at the gate, not the product.** The first post-migration
  run failed one Phase 2 assertion (`db.booking`'s global `bookings`-count
  rollback check) because `db.payments` inserts bookings in parallel — a race no
  run had exercised before. The assertion is now scoped to the test's own fresh
  address. Test-only; no product code touched.
- **`vercel.json` was still at eight crons when B-GATE passed**, because quick
  task 261006-01's claimed emptying never persisted. Closed after the gate: it
  now declares exactly one cron (A6's requirement), and the other seven
  schedules are prose in `docs/ARCHITECTURE.md` §7 until their phases build
  handlers. The stale ARCHITECTURE known-issues entries were corrected with it.
- **Docs commits exist, though 03-PLAN says "no git commits of any kind".** The
  GSD quick-task workflow mandates an orchestrator docs commit (`5c44539`,
  `cefb69b`) covering `.planning/` artifacts, `README.md` and this file. **No
  source, test, migration or config file has been committed by any Phase 3
  task** — the entire working tree of code remains uncommitted for the branch
  owner, as the plan required of its tasks.
- **Live end-to-end checkout against Razorpay is a documented manual step**
  (`docs/SETUP.md`), not a test — CONTEXT decision 1 keeps the suite off the
  network; the transport is injectable and every test stubs it.

## Deliberately out of scope

Everything Phase 5 (matching kick-off after `paid`, exhausted-search
auto-refund), Phase 6 (`POST /api/admin/refunds/:id/execute`, the second
approver, `platform_settings`, any screen reading the payments tables — the
`supportRefundLimit` fallback stands in until then), Phase 7 (payment/refund
notifications), Phase 8 (wallet top-up as a product feature, invoice PDFs) and
§12.5 invoice row generation. **No refund UI exists** — API and database rule
only (CONTEXT decision 3). An abandoned `payment_pending` booking is marked
failed at the payment, never at the booking, and is left for the customer or
Phase 6 ops.

## Carried forward

- The `support` role holds `refund.request` but sits outside the
  `['admin','super_admin','ops']` staff read-set on `payments`/`refunds` — a
  support agent can request a refund they cannot read. Worth one line when
  Phase 6's console decides its read policies.
- The live Razorpay end-to-end run (Dashboard webhook configured, a real
  test-mode payment captured, `refund.processed` delivered) remains the manual
  acceptance step in `docs/SETUP.md`.
