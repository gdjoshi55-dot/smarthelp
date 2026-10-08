---
phase: 03-payments
plan: 1
type: execute
date: 2026-10-07
description: "Quick task — finish Phase 3 Wave A (CheckoutForm hand-off, Wave A docs, Wave A gate), then start Wave B (0015 refunds/wallet schema, refund/wallet server modules, refund routes and tests)."
requirements: [P3-ORDERS, P3-WEBHOOK, P3-VERIFY, P3-CRON, P3-REFUNDS, P3-WALLET]
wave: 1
depends_on: []
autonomous: false
files_modified:
  - lib/supabase.ts
  - supabase/schema.sql
  - components/catalogue/CheckoutForm.tsx
  - docs/API.md
  - docs/DATABASE.md
  - docs/FEATURES.md
  - supabase/migrations/0015_refunds_wallet.sql
  - lib/refundServer.ts
  - lib/walletServer.ts
  - lib/constants.ts
  - app/api/refunds/route.ts
  - app/api/webhooks/razorpay/route.ts
  - app/api/bookings/[id]/cancel/route.ts
  - test/routes.refunds.test.ts
  - test/db.payments.test.ts
  - test/db.wallet.test.ts
user_setup:
  - service: razorpay
    why: "Live end-to-end checkout and webhook verification are manual steps; the suite never touches the network (CONTEXT decision 1)."
    env_vars:
      - name: RAZORPAY_KEY_ID
        source: "Razorpay Dashboard -> Settings -> API keys"
      - name: RAZORPAY_KEY_SECRET
        source: "Razorpay Dashboard -> Settings -> API keys"
      - name: RAZORPAY_WEBHOOK_SECRET
        source: "Razorpay Dashboard -> Settings -> Webhooks -> secret for the payment.captured endpoint"
    dashboard_config:
      - task: "Webhook endpoint for payment.captured, payment.failed, refund.processed pointing at /api/webhooks/razorpay"
        location: "Razorpay Dashboard -> Settings -> Webhooks"

must_haves:
  truths:
    - "The checkout pay button calls lib/paymentClient.ts and opens real Razorpay Checkout with a real order id; `paid` is reachable only from a polled payments.status, never from the handler callback (CONTEXT specific idea, §12.1 hard rule)."
    - "npm run typecheck, npm run lint and npm run build all exit 0 with Wave A on disk — today typecheck FAILS because lib/supabase.ts has no payments types, so this is a real gate, not a formality."
    - "The pre-migration suite (both db files excluded) is green at ≥629 tests across 35 files — measured 2026-10-07, the floor for this task."
    - "docs/API.md documents create-order, verify, GET /api/payments/[id], the Razorpay webhook and the reconcile cron; docs/DATABASE.md has a payments section; docs/FEATURES.md describes the payment step."
    - "0015_refunds_wallet.sql ships apply_wallet_delta with both §12.4 amendments (balance_after written; overdraft checked under FOR UPDATE before the write) and the wallet_txn_no_update / wallet_txn_no_delete RLS blocks."
    - "POST /api/refunds refuses a caller without refund.request; a manual refund above the ₹1500 support_refund_limit with no approval row stays requested; an auto-refund of any size executes with no approver."
    - "Cancelling a booking whose payment is success creates and executes a refund for total_amount − cancellation_fee; a failed gateway refund credits the wallet and writes an ops-ticket audit row."
    - "No test performs a network call, no new npm dependency enters package.json, the signature stays HMAC-SHA256, and no git commit is made by any task."
  artifacts:
    - path: "lib/supabase.ts"
      provides: "payment_status/payment_method enums, the payments Row/Insert/Update triple, Payment type, confirm_booking_payment RPC type"
      exports: ["Payment"]
    - path: "components/catalogue/CheckoutForm.tsx"
      provides: "the real payment hand-off after POST /api/bookings succeeds"
      pattern: "createPaymentOrder|Razorpay"
    - path: "docs/API.md"
      provides: "endpoint reference for payments, webhook and cron (Wave A) and refunds (Wave B)"
      pattern: "payments/create-order"
    - path: "supabase/migrations/0015_refunds_wallet.sql"
      provides: "refunds, wallets, wallet_transactions, customers.wallet_id FK, apply_wallet_delta, get_or_create_wallet, record/complete_booking_refund, RLS"
      contains: "apply_wallet_delta"
    - path: "lib/refundServer.ts"
      provides: "requestRefund/executeRefund rules, the support_refund_limit gate, gateway→wallet fallback"
    - path: "lib/walletServer.ts"
      provides: "creditWallet/debitWallet — the only paise→numeric conversion for wallet amounts"
    - path: "app/api/refunds/route.ts"
      provides: "POST/GET /api/refunds with server-side capability checks"
      exports: ["GET", "POST"]
    - path: "test/routes.refunds.test.ts"
      provides: "capability refusal, limit boundary, auto-refund, wallet fallback, cancel-of-paid, refund.processed"
    - path: "test/db.wallet.test.ts"
      provides: "apply_wallet_delta against real Postgres — overdraft raises 23514 and leaves no ledger row"
  key_links:
    - from: "components/catalogue/CheckoutForm.tsx"
      to: "lib/paymentClient.ts"
      via: "createPaymentOrder after booking create, then window.Razorpay Checkout"
      pattern: "createPaymentOrder"
    - from: "app/api/webhooks/razorpay/route.ts"
      to: "lib/razorpaySignature.ts"
      via: "verifyRazorpaySignature over raw req.text() bytes before JSON.parse"
      pattern: "verifyRazorpaySignature\\("
    - from: "lib/refundServer.ts"
      to: "lib/walletServer.ts"
      via: "failed gateway refund falls back to creditWallet → apply_wallet_delta"
      pattern: "creditWallet"
    - from: "app/api/bookings/[id]/cancel/route.ts"
      to: "lib/refundServer.ts"
      via: "auto-refund of total_amount − cancellation_fee when payment status is success"
      pattern: "executeRefund|autoRefund"
---

> **No git commits.** Write files only; the orchestrator handles any docs commit.
> Every task below repeats this line — it is not optional and no task may add a
> commit step.

# Quick task — keep building smarthelp (Phase 3)

## Objective

Continue Phase 3 from where the disk actually is. Wave A's code exists but is
unfinished and unverified; Wave B has not started. This plan finishes Wave A
(verify-then-extend — do **not** rewrite the modules that already exist) and
starts Wave B, in three tasks.

**Ground truth this plan is built on (verified 2026-10-07, trust it over any
assumption):**

- Wave A files on disk, all untracked in git: `supabase/migrations/0014_payments.sql`,
  `lib/razorpaySignature.ts`, `lib/razorpayClient.ts`, `lib/paymentServer.ts`,
  `lib/paymentClient.ts`, `app/api/payments/{create-order,verify,[id]}/route.ts`,
  `app/api/webhooks/razorpay/route.ts`, `app/api/cron/reconcile-payments/route.ts`,
  and tests `razorpaySignature`, `gatewayClient`, `routes.payments`,
  `routes.webhook`, `routes.cron`, `paymentClient`, `db.payments`.
- **`npm run typecheck` currently FAILS**: `lib/supabase.ts` exports no `Payment`
  type and its `Schema['Tables']` has no `payments` entry, so the cron route and
  `payments/[id]` do not compile. `supabase/schema.sql` does not yet contain
  `0014` (`npm run db:schema` was never run after writing it).
- **The pre-migration suite is green: 629 tests in 35 files**
  (`npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"`,
  measured 2026-10-07). That number — not 03-PLAN's older 555 — is the floor for
  this task.
- Missing from Wave A: the type mirror, `docs/API.md` payments/webhook/cron
  entries, the `docs/DATABASE.md` payments section, the `docs/FEATURES.md`
  payment walkthrough, the `CheckoutForm.tsx → paymentClient` hand-off, and the
  Wave A gate itself.
- Wave B does not exist: no `0015_refunds_wallet.sql`, no `lib/refundServer.ts`,
  no `lib/walletServer.ts`, no `app/api/refunds/`, no `test/routes.refunds.test.ts`,
  no `test/db.wallet.test.ts`.
- `SUPABASE_DB_URL` **is** present in `.env.local`; the gate still checks and
  skips loudly rather than pretending if that changes.
- `STATE.md`'s "Current Phase 2" line predates Phase 3 — `03-PLAN.md` is the
  authority for scope.

**Locked decisions this plan honors (03-CONTEXT.md):** decision 1 — the signature
verifier stays a pure module with synthetic tests, SHA-256 not §12.1's SHA-512;
decision 3 — refund API and money rule, **no UI of any kind**; decision 4 — mock
the transport, not the logic (injectable `fetch`, zero network in the suite).
Plus: **no new npm dependency in this phase.** Where existing code already
implements these, verify it and extend — never reimplement it.

## Context

@.planning/STATE.md
@.planning/phases/03-payments/03-PLAN.md
@.planning/phases/03-payments/03-CONTEXT.md
@.planning/ROADMAP.md

## Tasks

<task type="auto">
  <name>Task 1: Finish Wave A — type mirror, CheckoutForm hand-off, Wave A docs, then the Wave A gate</name>
  <files>lib/supabase.ts, supabase/schema.sql, components/catalogue/CheckoutForm.tsx, docs/API.md, docs/DATABASE.md, docs/FEATURES.md, plus any Wave A file that fails typecheck/lint/tests</files>
  <action>**No git commits — write files only; the orchestrator handles any docs commit.**

Work in this order; each step verifies something that already exists before it
adds anything.

**1. Make typecheck pass (03-PLAN Task A1's unfinished remainder).** Read
`0014_payments.sql` and hand-maintain in `lib/supabase.ts`, in the existing
`Schema['Tables'][T]` shape: the `payment_status` and `payment_method` enum
unions, the `payments` `Row`/`Insert`/`Update` triple, `export type Payment =
Tables<'payments'>`, and the `confirm_booking_payment` entry in the function
types (the cron route calls `supabase.rpc('confirm_booking_payment', …)` and the
type error names it). Then run `npm run db:schema` so `supabase/schema.sql`
actually contains `0014` — §31.2 requires the migration to be *added to*
`schema.sql`, and today it is not. Re-run `npx tsc --noEmit` and fix every
remaining Wave A type error (the `payments/[id]` route's row-typing errors
should fall out of the new `Payment` type; if one does not, fix the route's
typing, not the type mirror).

**2. The CheckoutForm → paymentClient hand-off (03-PLAN Task A5's remainder).**
`lib/paymentClient.ts` already exists and exports `createPaymentOrder`,
`verifyPayment`, `fetchPayment` and `paymentDisplayState` — verify its tests
pass, then wire `components/catalogue/CheckoutForm.tsx`: after
`POST /api/bookings` succeeds, call `createPaymentOrder`, load
`https://checkout.razorpay.com/v1/checkout.js` and open
`new window.Razorpay({ key, order_id, handler })` with the key id the server
returned. The `handler` callback only fires `verifyPayment` and starts polling
`fetchPayment` — **the display state derived from the handler alone must never be
`paid`** (CONTEXT decision, §12.1's hard rule: `paid` comes only from a polled
`payments.status === 'success'`). A `402 PAYMENT_FAILED` from order-create
surfaces the server's message; loading, error, retry and an honest
"still confirming" timeout state are all present per §31.2. Every call carries
the caller's bearer token via `authorizationHeader()` from `lib/sessionHeaders.ts`
— the Phase 2 lesson where `credentials: 'include'` silently authenticated
nothing. No new component directory, no new npm package, no fake success state
anywhere.

**3. The Wave A docs.** In the house voice and house placement:
- `docs/API.md` — a payments section in the endpoint reference (§4.x, after
  §4.4 Bookings) covering `POST /api/payments/create-order` (required
  `Idempotency-Key`, `409 INVALID_STATE` when `quote_token` is null,
  `409 PRICE_CHANGED`, `402 PAYMENT_FAILED`), `POST /api/payments/verify`
  (reads only, writes nothing, `402 PAYMENT_NOT_VERIFIED`),
  `GET /api/payments/[id]` (ownership-checked), the Razorpay webhook route
  (signature-authenticated, the sole writer of `success`) and
  `GET /api/cron/reconcile-payments` (three-channel `CRON_SECRET` guard, 503
  when unset, both alert conditions). Each entry matches the route as built —
  read the route, do not document the plan's intention.
- `docs/DATABASE.md` — a `payments` section in the domain-section style, the
  inventory row, the RLS policy table (select-only, no INSERT/UPDATE policy, anon
  revoked, and *why*), and `confirm_booking_payment` in §8 beside `0028`'s write
  paths.
- `docs/FEATURES.md` — the payment step in the customer walkthrough: what the
  customer does, what the server does, what the webhook owns, what the cron owns,
  and that live end-to-end verification against Razorpay is a documented manual
  step in `docs/SETUP.md` (CONTEXT decision 1's accepted consequence — check that
  `docs/SETUP.md` subsection exists from A4; if it is missing, add it too).

**4. The Wave A gate — run these eight steps in this order and report each.**
The order is load-bearing: `vitest.config.ts` includes every `*.test.ts` under
`test/` with no db exclusion, so an unexcluded run before `0014` is applied fails
on `relation "public.payments" does not exist`.

  1. PRE-MIGRATION `npm run typecheck` — exit 0.
  2. PRE-MIGRATION `npm run lint` — exit 0.
  3. PRE-MIGRATION `npm run build` — exit 0.
  4. PRE-MIGRATION `node scripts/check-migrations.mjs` — dry-run passes.
  5. PRE-MIGRATION `npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"` — green at **≥629 tests across ≥35 files** (the measured 2026-10-07 floor; 03-PLAN's 555 is the older pre-Wave-A baseline). No `.only`, no new skips.
  6. **PAUSE FOR APPROVAL**, then POST-MIGRATION `npm run db:migrate` — applies `0014` to the live project. This writes to a live database; do not run it without the user's approval. **If `SUPABASE_DB_URL` is missing or unusable, say so loudly, skip steps 6–7 as SKIPPED — no live database, and stop there** — do not pretend the migration or the live suite ran.
  7. POST-MIGRATION `npx vitest run` with no exclusion — green, at or above 629 plus whatever `test/db.payments.test.ts` adds; this is where the payments isolation test actually runs.
  8. POST-MIGRATION `npm run test:db` — green, including `test/db.payments.test.ts`.

  Then confirm `git status` shows **no new commits**. If any step fails, stop and
  report the failing command's output rather than working around it. Wave B (Task
  2) starts only after this gate passes.

  **No git commits — write files only; the orchestrator handles any docs commit.**
  </action>
  <verify>
    <automated>npm run typecheck; npm run lint; npm run build; node scripts/check-migrations.mjs; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"; if (-not (Select-String -Path docs/API.md -Pattern 'payments/create-order' -Quiet)) { Write-Error 'docs/API.md: no create-order entry'; exit 1 }; if (-not (Select-String -Path docs/API.md -Pattern 'webhooks/razorpay' -Quiet)) { Write-Error 'docs/API.md: no webhook entry'; exit 1 }; if (-not (Select-String -Path docs/API.md -Pattern 'reconcile-payments' -Quiet)) { Write-Error 'docs/API.md: no cron entry'; exit 1 }; if (-not (Select-String -Path docs/DATABASE.md -Pattern 'confirm_booking_payment' -Quiet)) { Write-Error 'docs/DATABASE.md: no payments section'; exit 1 }; if (-not (Select-String -Path components/catalogue/CheckoutForm.tsx -Pattern 'createPaymentOrder' -Quiet)) { Write-Error 'CheckoutForm: not wired to paymentClient'; exit 1 }</automated>
    <human-check>The automated block is gate steps 1–5 (PRE-MIGRATION) plus the four docs/one wiring grep gates — each is a real `if (-not (Select-String … -Quiet)) { exit 1 }`, not a `-Quiet` print. Step 6 (`npm run db:migrate`) awaits your approval, then steps 7–8 (unexcluded suite ≥629, `npm run test:db`) run POST-MIGRATION. If `SUPABASE_DB_URL` is unavailable the executor skips 6–7 loudly with a SKIPPED note. Finally `git status` shows no commits.</human-check>
  </verify>
  <done>Typecheck, lint and build exit 0 with Wave A on disk; `supabase/schema.sql` contains `0014`; the pay button opens real Checkout through `paymentClient` and `paid` is reachable only from polled status; `docs/API.md`, `docs/DATABASE.md` and `docs/FEATURES.md` describe payments as built; the pre-migration suite is green at ≥629, `0014` is applied (or the skip is loudly recorded with no pretence), the unexcluded suite and `npm run test:db` are green; no git commits were made; Wave B is unblocked.</done>
</task>

<task type="auto">
  <name>Task 2: Wave B start — `0015_refunds_wallet.sql`, the type mirror, and the wallet/refund server modules</name>
  <files>supabase/migrations/0015_refunds_wallet.sql, supabase/schema.sql, lib/supabase.ts, docs/DATABASE.md, lib/constants.ts, lib/walletServer.ts, lib/refundServer.ts, test/db.payments.test.ts</files>
  <action>**No git commits — write files only; the orchestrator handles any docs commit.**
  Depends on Task 1's gate passing. This is 03-PLAN's Task B1 plus the two Wave B
  server modules — the schema-and-rules layer the routes in Task 3 build on. Do
  not touch route files in this task.

  **`0015_refunds_wallet.sql`** (the spec's own number, §23 — never renumber),
  header in the voice `0011`/`0028` use, carrying verbatim in substance the
  finding that **§12.4's `apply_wallet_delta` does not run against §24.9's
  schema**: amendment (1) `balance_after` is written because §24.9 declares it
  `NOT NULL` and §12.4's INSERT omits it — the spec's function raises
  `not-null violation` on its first call as written; amendment (2) the balance is
  read `FOR UPDATE` and checked before the write, because §12.4's
  `RAISE WALLET_OVERDRAFT` sits behind its own non-deferred `CHECK (balance >= 0)`
  and is unreachable there. Keep the column `CHECK` as the backstop.

  Then the schema exactly as §24.9 spells it: `refund_status`, `wallet_txn_type`;
  `refunds` (`route CHECK (route IN ('gateway','wallet','mixed'))`,
  `requested_by`/`processed_by`/`approved_by` → `profiles`,
  `uniq_active_refund_per_payment`); `wallets` (`balance numeric(12,2) DEFAULT 0
  CHECK (balance >= 0)`, `customer_id UNIQUE`); **`ALTER TABLE customers ADD
  COLUMN wallet_id uuid REFERENCES wallets(id)`** — the FK `docs/DATABASE.md`'s
  comment already promises ("FK added in 0015_refunds_wallet.sql"), so the
  comment stops being a lie; `wallet_transactions` (`amount CHECK (amount > 0)`,
  `balance_after NOT NULL`, `ref_type`/`ref_id`/`description`,
  `idx_wallet_txn_wallet`).

  Functions, all `security definer` / `revoke all … from public, anon,
  authenticated; grant execute … to service_role`, all setting the
  `app.transition_*` settings themselves where they touch booking status:
  - **`apply_wallet_delta(p_wallet, p_type, p_amount, p_ref, p_desc) RETURNS
    numeric`** implementing both amendments: `FOR UPDATE` pre-read → compute →
    `if v_new < 0 then raise exception 'WALLET_OVERDRAFT …' using errcode =
    'check_violation'` (same SQLSTATE as the constraint) → update `wallets` →
    insert the ledger row **including `balance_after = v_new`** → return. One
    transaction: the raise rolls back both writes. `p_amount` is strictly
    positive; direction is carried by `p_type`, never by a negative amount.
  - **`get_or_create_wallet(p_customer uuid)`** — one statement, because
    `wallets.customer_id UNIQUE` plus `customers.wallet_id` makes read-then-write
    a race; refund-to-wallet must work for a customer who never had a wallet.
  - **`record_booking_refund(...)`** — inserts the `refunds` row (`status
    'requested'`) and hops the booking to `refund_pending` **only when its status
    is `paid` or `cancelled`** (both legal predecessors per `0011`); an
    above-limit request nobody approved must not strand a booking in
    `refund_pending`.
  - **`complete_booking_refund(...)`** — refund → `completed` with
    `gateway_refund_id`/`completed_at`, booking `refund_pending → refunded`,
    `payments.refundable_amount` down and `status` to `partially_refunded` or
    `refunded`. This is what makes §8.2's two refund states reachable — Phase 2's
    plan promised exactly this.

  **RLS on `refunds`, `wallets`, `wallet_transactions`**, mirroring
  `0010:339-392` in the `do $$ … exception when duplicate_object` idiom: select
  policies only (`refunds` by `customer_id` for owner or
  `is_staff(['admin','super_admin','ops'])`; `wallets` by `customer_id`;
  `wallet_transactions` through the `exists (select 1 from wallets w where w.id =
  wallet_id and w.customer_id = current_customer_id())` shape of `0010:367`), no
  insert/update policy on any of them, plus §12.4's two outright blocks:
  `wallet_txn_no_update FOR UPDATE USING (false)` and `wallet_txn_no_delete FOR
  DELETE USING (false)`. `revoke all … from anon`; `grant select … to
  authenticated`. The comment says what `0010`'s says: RLS protects the browser
  and PostgREST, not the service-role path — which is why the refund routes still
  check capability themselves (Task 3).

  **Type mirror:** `lib/supabase.ts` gains `refund_status`, `wallet_txn_type` and
  the three table triples (+ any new function types), then `npm run db:schema` so
  `supabase/schema.sql` contains `0015`. **`docs/DATABASE.md`** gains the three
  tables, the RLS rows (including the two outright blocks) and the amended
  `apply_wallet_delta` with both amendments stated.

  **`lib/constants.ts`:** `PLATFORM_DEFAULTS.supportRefundLimit =
  Number(process.env.DEFAULT_SUPPORT_REFUND_LIMIT || 1500)` — rupees, the §12.3
  default, commented as the fallback because **`platform_settings` is a Phase 6
  table** (the exact pattern Phase 1 used for `instant_lead_minutes` and Phase 2
  for `maxBookingMinutes`). No arithmetic on the constant; `lib/money.ts`
  converts at the boundary.

  **`lib/walletServer.ts`** — `creditWallet(supabase, customerId, amountPaise,
  ref, description)` and `debitWallet(...)`: `get_or_create_wallet`, then
  `apply_wallet_delta` with `numericLiteral(paise)`, translating a `23514`
  carrying `WALLET_OVERDRAFT` into an `ApiHttpError`. The paise → `numeric`
  conversion happens here and nowhere else.

  **`lib/refundServer.ts`** — the rules, out of the Route Handler so the webhook
  and the cancel path share them: `requestRefund(...)` building the row
  (`reason_code`, `route` — `gateway` by default, `wallet` when the instrument is
  not refundable, `requested_by`); `withinLimit(amountPaise)`; **the approval
  rule — above `supportRefundLimit` a manual refund may be created but not
  executed** (stays `requested`, `approved_by` null; no path in this phase
  executes it, because §25.10's `POST /api/admin/refunds/:id/execute` is Phase
  6's endpoint); `executeRefund(...)` = `record_booking_refund` → gateway
  `createRefund` through the existing injectable client → on success
  `complete_booking_refund`; **on gateway failure, fall back to wallet credit via
  `creditWallet`, mark the refund `route='wallet'`/`completed`, and write an
  ops-ticket audit row** (`action: 'refund.ops_ticket'`, metadata carrying the
  failure reason) — §12.3's "never left with nothing". Capability constants for
  `refund.request` / `refund.execute` are read from `lib/roles.ts` — both checks
  are server-side (CONTEXT decision 3). **No component, no page, no `/admin`
  route — decision 3 locks API-and-rule only.**

  **`test/db.payments.test.ts`** — extend the existing §29.3 file (one file
  spans both waves deliberately): refunds and wallets isolation between the two
  customers, `wallet_transactions` invisible across customers, and the
  UPDATE/DELETE refusal asserted directly through the authenticated client
  expecting a policy error.

  **No new npm package.** The gateway transport already on disk is four `fetch`
  calls with an injectable fetch (CONTEXT decision 4) — use it as-is.
  **No git commits — write files only; the orchestrator handles any docs commit.**
  </action>
  <verify>
    <automated>npm run typecheck; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"; node scripts/check-migrations.mjs; if (-not (Select-String -Path supabase/migrations/0015_refunds_wallet.sql -Pattern 'apply_wallet_delta' -Quiet)) { Write-Error '0015 missing apply_wallet_delta'; exit 1 }; if (-not (Select-String -Path supabase/migrations/0015_refunds_wallet.sql -Pattern 'wallet_txn_no_update' -Quiet)) { Write-Error '0015 missing the outright ledger UPDATE block'; exit 1 }; if ((Select-String -Path package.json -Pattern '"(razorpay|@razorpay)' -Quiet)) { Write-Error 'a Razorpay package was added — forbidden in this phase'; exit 1 }</automated>
    <human-check>PRE-MIGRATION throughout: `npm run db:migrate` is NOT run here — `0015` is applied only at the Wave B gate (03-PLAN Task B-GATE), which remains a separate future step. The two db test files stay excluded because `vitest.config.ts` has no db exclusion and `refunds`/`wallets` do not exist until `0015` is applied; typecheck still compiles them. The last grep gate proves no npm dependency crept in.</human-check>
  </verify>
  <done>`0015_refunds_wallet.sql` exists with both amendments stated in its header, `apply_wallet_delta` writes `balance_after` and can raise `WALLET_OVERDRAFT` as a reachable error, `customers.wallet_id` has its FK, the three RLS blocks exist including the two outright ledger blocks, both refund RPCs are service-role-only; `lib/walletServer.ts`, `lib/refundServer.ts` and the `supportRefundLimit` constant exist with the Phase-6-fallback comment; the type mirror and `supabase/schema.sql` include `0015`; `docs/DATABASE.md` documents all of it; typecheck and the ≥629 excluded suite stay green; `package.json` is unchanged; no git commits.</done>
</task>

<task type="auto">
  <name>Task 3: Wave B routes and tests — `POST/GET /api/refunds`, `refund.processed`, the cancel-of-paid refund, and the live wallet test</name>
  <files>app/api/refunds/route.ts, app/api/webhooks/razorpay/route.ts, app/api/bookings/[id]/cancel/route.ts, test/routes.refunds.test.ts, test/db.wallet.test.ts, docs/API.md, docs/FEATURES.md</files>
  <action>**No git commits — write files only; the orchestrator handles any docs commit.**
  Depends on Task 2 — the schema, RPCs and server modules must exist first. This
  is 03-PLAN's Task B2 plus B3's live wallet test and docs; **no UI of any kind**
  (CONTEXT decision 3).

  **Routes, in the house shape throughout** (`handle()`, `requireAuth`,
  `requireCapability`, `created()`/`ok()`, `ApiHttpError`, `audit()`):

  | Route | Behaviour |
  |---|---|
  | `POST /api/refunds` | body `{ paymentId, amount, reasonCode, note }`; staff-only via `requireCapability('refund.request')`; auto-refund callers (system reasons) need no capability; validates amount `> 0` and `≤ refundable_amount` in paise through `lib/money.ts`; **above `supportRefundLimit` a manual request returns 202 `requested` and is not executed; at or below it, executes** |
  | `GET /api/refunds` | filters by status/booking/customer; a customer sees only their own (the `getPaymentForCaller` ownership shape — the service role bypasses RLS, so the route check is the one that protects server paths); staff see all |
  | webhook `refund.processed` | extend the **existing** Wave A webhook route with one event row: match on `gateway_refund_id`, then `complete_booking_refund`. The route already verifies the signature — the event table grows by one row; do not add a second webhook route |
  | `app/api/bookings/[id]/cancel/route.ts` | when the booking's payment status is `success`, create and execute a refund for `total_amount − cancellation_fee` (the §11.1 fee the route already wrote) as an **auto-refund with no approver** |

  That last row is not optional: once Wave A makes `paid` reachable,
  `paid → cancelled` is a live customer path that captures money and would
  produce no refund. Phase 2's plan promised *"`refund_pending` and `refunded`
  become reachable in Phase 3, where `payments` exists`"* — closing that leak is
  this phase's work.

  **`test/routes.refunds.test.ts`** covers, against `FakeSupabase` and the
  stubbed transport (CONTEXT decision 4 — **no network call**): `FORBIDDEN`
  without `refund.request`; the limit boundary at exactly `supportRefundLimit`
  and one paise over (₹1500 executes, ₹1500.01 without approval stays
  `requested`); an auto-refund of any size executing with no approver; the
  `route` selection (gateway vs wallet); the gateway-failure → wallet fallback
  with its `refund.ops_ticket` audit row; cancel-of-paid producing exactly one
  refund row for `total − fee`; `refund.processed` completing a refund and moving
  the booking to `refunded`; and `gateway_signature` never appearing in any
  recorded metadata.

  **`test/db.wallet.test.ts`** (live, runs under `npm run test:db` **only after
  `0015` is applied at the Wave B gate** — write it here, excluded from every
  pre-migration run, sequential like the other live files per `dbEnv.ts`'s
  `--no-file-parallelism` reason): credit then debit with `wallets.balance` and
  the newest `balance_after` agreeing to the paisa; a debit larger than the
  balance raising **`WALLET_OVERDRAFT` with SQLSTATE 23514 *and* leaving no
  `wallet_transactions` row behind** (the assertion that proves the rollback, not
  just the raise); two concurrent credits landing as the exact sum; `amount ≤ 0`
  refused by the column's own `CHECK`; a negative `p_amount` refused (the type
  carries the direction).

  **Docs:** `docs/API.md` gains the refunds section (both endpoints, their
  capabilities, the ₹1500 limit, the 202-above-limit response) in the same house
  style as Task 1's payments section. `docs/FEATURES.md` gains the refund half of
  the walkthrough, stating plainly that **refund-to-wallet is disclosed at
  cancellation time, not at refund time** (§12.3) and that Phase 6 will add the
  approval console on top of an endpoint that already refuses an unapproved
  large refund. `README.md`'s "Phase 3 complete" line and the full Wave B gate
  (applying `0015`, the unexcluded suite, `npm run test:db` across all five live
  files, the §31.1 exit-criteria hand-check) are **deliberately out of scope for
  this quick task** — they belong to 03-PLAN's Task B-GATE, which is the next
  step after this plan, not part of "start Wave B".

  **No git commits — write files only; the orchestrator handles any docs commit.**
  </action>
  <verify>
    <automated>npx vitest run test/routes.refunds.test.ts test/routes.webhook.test.ts test/routes.bookings.test.ts test/paymentClient.test.ts; npm run typecheck; npm run lint; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"; if (-not (Select-String -Path docs/API.md -Pattern 'api/refunds' -Quiet)) { Write-Error 'docs/API.md: no refunds section'; exit 1 }; if ((Select-String -Path components -Pattern 'refund' -Include '*.tsx' -Recurse -Quiet)) { Write-Error 'refund UI was built — decision 3 forbids it'; exit 1 }</automated>
    <human-check>PRE-MIGRATION throughout — `npm run db:migrate` is not run in this task; `0015` and the live wallet tests wait for 03-PLAN's Task B-GATE. The excluded suite is still ≥629 green (the new non-db tests only add to it), and the final grep is a real gate proving no refund component or page was created. No commits.</human-check>
  </verify>
  <done>Both refund endpoints exist with server-side capability checks; the ₹1500 limit refuses an unapproved large refund and executes a boundary-equal one; auto-refunds execute with no approver; the cancel-of-paid leak is closed with one refund row for `total − fee`; the gateway-failure wallet fallback and its ops audit work; `refund.processed` completes a refund through the existing verified webhook; `test/db.wallet.test.ts` carries all five live cases; `docs/API.md` and `docs/FEATURES.md` describe refunds as built; no UI exists for refunds; `package.json` unchanged; no git commits. Wave B's schema, modules, routes and tests are on disk and green pre-migration — B-GATE remains.</done>
</task>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|---|---|
| Razorpay → `/api/webhooks/razorpay` | Unauthenticated internet traffic whose only credential is the HMAC; raw body read before any parse |
| Browser → `/api/payments/*`, `/api/refunds` | An authenticated caller whose body must never supply an amount, and a staff member whose capability check is the only thing above the ₹1500 line |
| Route Handler → Postgres | Service role, which **bypasses RLS** — ownership and capability must be re-checked in the route |
| Cron platform → `/api/cron/reconcile-payments` | Scheduled traffic guarded only by `CRON_SECRET` |

## STRIDE Threat Register

| ID | Category | Component | Disposition | Mitigation |
|---|---|---|---|---|
| T-03-01 | Tampering | webhook payload | mitigate | `verifyRazorpaySignature` over exact `req.text()` bytes, SHA-256 + length-checked `timingSafeEqual`, before `JSON.parse`; invalid ⇒ 400, zero writes (03-CONTEXT decision 1; SHA-256 per Razorpay docs, not §12.1's SHA-512) |
| T-03-02 | Spoofing | missing/placeholder `RAZORPAY_WEBHOOK_SECRET` | mitigate | `isUsableWebhookSecret` runtime guard ⇒ clear `SERVICE_UNAVAILABLE`, fail closed |
| T-03-03 | Tampering | client-supplied amount | mitigate | Order amount from `bookings.total_amount` only; refund amount validated against `refundable_amount` in `lib/money.ts` paise maths; webhook compares paise to paise |
| T-03-05 | Information disclosure | cross-customer payment/refund/wallet reads | mitigate | RLS select policies on all four tables **plus** route-side ownership checks (service role bypasses RLS); `test/db.payments.test.ts` isolation, extended in Task 2 |
| T-03-06 | Elevation of privilege | refund above `support_refund_limit` | mitigate | `requireCapability('refund.request'/'refund.execute')` server-side; above-limit manual refunds stay `requested` with no execution path until Phase 6's approver endpoint |
| T-03-07 | DoS / abuse | unauthenticated cron | mitigate | Three-channel `CRON_SECRET` guard, 503 when unset (fail closed), 401 on mismatch |
| T-03-08 | Tampering | wallet ledger mutation | mitigate | Append-only: RLS `FOR UPDATE USING (false)` / `FOR DELETE USING (false)`; `balance` written only through `apply_wallet_delta` in one transaction |
| T-03-09 | Tampering | duplicate payment | mitigate | `withIdempotency(..., required: true)` + `uniq_payments_idem` backstop + the replay guard in `confirm_booking_payment` |
| T-03-SC | Tampering | npm installs | mitigate | **No packages installed in this phase**; Task 2's verify greps `package.json` to prove it; any `[ASSUMED]`/`[SUS]` install would require a blocking human checkpoint |
</threat_model>

<verification>
Per-task `<verify>` blocks are the gate: Task 1's eight ordered steps (with the
approval-paused `db:migrate` and the loud no-database skip), Task 2 and Task 3
PRE-MIGRATION (typecheck, lint, build, `check-migrations.mjs`, the excluded suite
at ≥629). The Wave B gate — applying `0015`, the unexcluded suite, `npm run
test:db` across all five live files, and the §31.1 hand-check — is 03-PLAN's
Task B-GATE and is explicitly not part of this quick task.

Every task states: **no git commits — write files only; the orchestrator handles
any docs commit.**
</verification>

<success_criteria>
- Wave A finished and gated: typecheck/lint/build green, pre-migration suite ≥629 green, `0014` applied (or the skip recorded loudly), post-migration suite and `npm run test:db` green, CheckoutForm opens real Checkout, all three Wave A docs updated.
- Wave B started: `0015` with both amendments, type mirror, `lib/walletServer.ts`, `lib/refundServer.ts`, both refund routes, the `refund.processed` event, the cancel-of-paid refund, `test/routes.refunds.test.ts` and `test/db.wallet.test.ts` all on disk and green pre-migration.
- Locked honored: SHA-256 pure verifier untouched, transport mocked not logic, **zero new npm dependencies**, **zero refund UI**, **zero git commits**.
- Remaining for the next run: 03-PLAN Task B-GATE and the phase record (README "Phase 3 complete").
</success_criteria>

<output>
Create `smarthelp/.planning/quick/261007-vhn-keep-building-smarthelp-phase/261007-vhn-SUMMARY.md` when done (write only — no commit; the orchestrator handles any docs commit), recording the gate results, the test counts against the 629 floor, and whether the `0014` migration step ran or was skipped loudly.
</output>
