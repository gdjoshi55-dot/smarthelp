---
phase: 3
slug: payments
plan: 03
type: execute
date: 2026-10-06
description: "Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation cron — two waves (money in, money out), each ending in a full gate."
# ROADMAP.md carries no separate requirement IDs for any phase; the §31.1 / ROADMAP
# "Scope" column is the requirement list, so the six scope items are used as IDs.
requirements: [P3-ORDERS, P3-WEBHOOK, P3-VERIFY, P3-REFUNDS, P3-WALLET, P3-CRON]
wave: 1
depends_on: []
autonomous: false
files_modified:
  - supabase/migrations/0014_payments.sql
  - supabase/migrations/0015_refunds_wallet.sql
  - supabase/schema.sql
  - lib/razorpaySignature.ts
  - lib/razorpayClient.ts
  - lib/paymentServer.ts
  - lib/refundServer.ts
  - lib/walletServer.ts
  - lib/paymentClient.ts
  - lib/supabase.ts
  - lib/constants.ts
  - lib/audit.ts
  - app/api/payments/create-order/route.ts
  - app/api/payments/verify/route.ts
  - app/api/payments/[id]/route.ts
  - app/api/webhooks/razorpay/route.ts
  - app/api/refunds/route.ts
  - app/api/cron/reconcile-payments/route.ts
  - app/api/bookings/[id]/cancel/route.ts
  - components/catalogue/CheckoutForm.tsx
  - vercel.json
  - test/razorpaySignature.test.ts
  - test/gatewayClient.test.ts
  - test/routes.payments.test.ts
  - test/routes.webhook.test.ts
  - test/routes.refunds.test.ts
  - test/routes.cron.test.ts
  - test/paymentClient.test.ts
  - test/api.test.ts
  - test/db.payments.test.ts
  - test/db.wallet.test.ts
  - docs/ARCHITECTURE.md
  - docs/DATABASE.md
  - docs/API.md
  - docs/FEATURES.md
  - docs/SETUP.md
  - README.md
user_setup:
  - service: razorpay
    why: "Live end-to-end webhook verification is a manual step; the suite never touches the network."
    env_vars:
      - name: RAZORPAY_KEY_ID
        source: "Razorpay Dashboard -> Settings -> API keys"
      - name: RAZORPAY_KEY_SECRET
        source: "Razorpay Dashboard -> Settings -> API keys"
      - name: RAZORPAY_WEBHOOK_SECRET
        source: "Razorpay Dashboard -> Settings -> Webhooks -> secret for the payment.captured endpoint"
    dashboard_config:
      - task: "Create a webhook endpoint for payment.captured, payment.failed, refund.processed pointing at /api/webhooks/razorpay"
        location: "Razorpay Dashboard -> Settings -> Webhooks"

must_haves:
  truths:
    - "POST /api/payments/create-order refuses a booking whose bookings.quote_token is null with a re-quote instruction, and accepts one whose token is present but past its 15-minute exp — presence gates payment, freshness does not."
    - "The webhook route reads req.text() before any parse; a raw body whose bytes differ from its re-serialised JSON verifies, and the re-serialised form does not."
    - "A test in test/api.test.ts pins that handle() leaves the request body unread, so a future change to handle() fails the suite instead of silently breaking every webhook."
    - "POST /api/payments/verify with a valid HMAC-SHA256 signature writes nothing: payments.status and bookings.status are identical before and after."
    - "A replayed payment.captured against an already-success payment performs zero writes and records a duplicate audit entry."
    - "A webhook whose amount, currency or gateway_order_id disagrees with the payments row is rejected with no write."
    - "confirm_booking_payment moves a booking payment_pending -> paid and nulls quote_token in one statement; a second call with the same arguments updates zero rows."
    - "The webhook route never calls requireAuth — a signature-valid anonymous request is accepted, and an invalid signature is 400 with zero writes."
    - "A payment whose order never captures is marked failed with a failure_reason while its booking stays payment_pending."
    - "GET /api/cron/reconcile-payments answers 503 when CRON_SECRET is unset, 401 on a wrong secret, and accepts bearer, x-cron-secret and ?secret= when it is set."
    - "vercel.json declares exactly one cron, /api/cron/reconcile-payments at */30 * * * *."
    - "A wallet debit that would go negative raises WALLET_OVERDRAFT (SQLSTATE 23514) and leaves no wallet_transactions row behind."
    - "Every wallet_transactions row carries a balance_after equal to wallets.balance after that write."
    - "RLS refuses UPDATE and DELETE on wallet_transactions outright for authenticated and anon."
    - "Customer A cannot select customer B's payments, refunds, wallets or wallet_transactions through the anon or authenticated client."
    - "POST /api/refunds is refused for a caller without refund.request; a manual refund above 1500 with no approval row is refused; an auto-refund needs no approver."
    - "Cancelling a booking whose payment is success creates a refund row for the un-refunded remainder and executes it without an approver."
    - "No test in the suite performs a network call; the gateway client is exercised only through an injected fetch and the verifier only through synthetic secrets."
    - "The suite is green at 555 tests or more, and typecheck, lint and build are clean."
  artifacts:
    - path: "supabase/migrations/0014_payments.sql"
      provides: "payments table, payment_status/payment_method enums, confirm_booking_payment, RLS on payments"
      contains: "confirm_booking_payment"
    - path: "supabase/migrations/0015_refunds_wallet.sql"
      provides: "refunds, wallets, wallet_transactions, customers.wallet_id FK, apply_wallet_delta with both amendments, refund write-path RPCs"
      contains: "apply_wallet_delta"
    - path: "lib/razorpaySignature.ts"
      provides: "pure SHA-256 webhook signature verifier"
      exports: ["verifyRazorpaySignature"]
    - path: "lib/razorpayClient.ts"
      provides: "fetch-injectable Razorpay transport (orders + refunds)"
      exports: ["createRazorpayClient"]
    - path: "lib/paymentServer.ts"
      provides: "getPaymentForCaller, payment amount helpers, the create-order write path"
    - path: "lib/refundServer.ts"
      provides: "refund request/execute rules, the support_refund_limit gate, gateway->wallet fallback"
    - path: "app/api/webhooks/razorpay/route.ts"
      provides: "no client-reachable path writes payments.status='success'; the webhook and the gateway-reconciling cron are the only writers, both gated on gateway truth and both funnelling through confirm_booking_payment"
      exports: ["POST"]
    - path: "app/api/cron/reconcile-payments/route.ts"
      provides: "the phase's only cron, behind the CRON_SECRET guard"
      exports: ["GET"]
    - path: "test/db.payments.test.ts"
      provides: "§29.3 RLS isolation across payments, refunds, wallets, wallet_transactions"
    - path: "test/db.wallet.test.ts"
      provides: "apply_wallet_delta behaviour against real Postgres"
    - path: "vercel.json"
      provides: "exactly one cron declaration"
      contains: "reconcile-payments"
    - path: "docs/SETUP.md"
      provides: "the documented manual live-webhook verification step"
  key_links:
    - from: "app/api/webhooks/razorpay/route.ts"
      to: "lib/razorpaySignature.ts"
      via: "verifyRazorpaySignature(rawBody, secret, signature) called before JSON.parse"
      pattern: "verifyRazorpaySignature\\("
    - from: "app/api/webhooks/razorpay/route.ts"
      to: "supabase.rpc('confirm_booking_payment')"
      via: "single writer shared with the reconcile cron"
      pattern: "confirm_booking_payment"
    - from: "app/api/cron/reconcile-payments/route.ts"
      to: "lib/razorpayClient.ts"
      via: "fetchOrder through the injected transport"
      pattern: "fetchOrder\\("
    - from: "app/api/payments/create-order/route.ts"
      to: "lib/idempotency.ts"
      via: "withIdempotency({ operation: 'payments.create.order', required: true }) called inside the route handler"
      pattern: "withIdempotency"
    - from: "app/api/payments/create-order/route.ts"
      to: "bookings.quote_token"
      via: "presence assertion before an order is created (quoteToken consumption)"
      pattern: "quote_token"
    - from: "app/api/bookings/[id]/cancel/route.ts"
      to: "lib/refundServer.ts"
      via: "auto-refund of the remainder when the payment is success"
      pattern: "refundForCancelledBooking|autoRefund"
    - from: "lib/refundServer.ts"
      to: "lib/walletServer.ts"
      via: "failed gateway refund falls back to apply_wallet_delta credit"
      pattern: "apply_wallet_delta"
    - from: "test/razorpaySignature.test.ts"
      to: "lib/razorpaySignature.ts"
      via: "synthetic secrets, vectors computed inside the test"
      pattern: "createHmac"
---

> **No git commits.** The user has forbidden commits for this session. No task below
> contains a commit step, and none may be added.

# Phase 3 — Payments · Plan

## Goal

**"Real money in, real money out; the webhook is the sole authority; RLS on
payments."** That is the §31.1 Phase 3 exit criterion, verbatim, and every task
below is measured against it.

Scope from the same row, also verbatim: *Razorpay orders, webhook, verify,
refunds, wallet ledger, reconciliation cron.* Those six items are the requirement
IDs in the frontmatter (`P3-ORDERS`, `P3-WEBHOOK`, `P3-VERIFY`, `P3-REFUNDS`,
`P3-WALLET`, `P3-CRON`), because ROADMAP.md carries no separate requirement IDs
for any phase.

## Where this phase starts from

Already in place, from Phases 0, 1 and 2:

- **`0024_audit_idempotency.sql`** — `audit_logs`, `idempotency_keys`,
  `claim_idempotency_key()` / `complete_idempotency_key()`, and `write_audit`.
  The ledger `withIdempotency()` (`lib/idempotency.ts`) drives is applied and
  already used by `POST /api/bookings`.
- **`0009`/`0010`** — the 18-value `booking_status` enum, `bookings` with
  `numeric(12,2)` money, `quote_token text` (`0010:105`), `booking_number`, and
  `payment_purpose` **already declared at `0010:34`** inside a
  `do $$ … exception when duplicate_object` block — Phase 2 shipped it early
  because §24.7 puts it in `0010`.
- **`0011_booking_state_machine.sql`** — `enforce_booking_transition()` and its
  history writer. `when 'paid' then array['payment_pending']` (`0011:54`) makes
  the hop this phase performs legal, and `when 'cancelled' … 'payment_pending','paid' …`
  makes the cancel path this phase refunds legal too.
- **`0028_booking_write_paths.sql`** — `create_booking`, `cancel_booking`,
  `transition_booking`: the pattern of a `security definer`, `service_role`-only
  function that sets `app.transition_actor` / `app.transition_actor_role` /
  `app.transition_note` itself and then writes, in one statement. `create_booking`'s
  own comment anticipates this phase: *"Phase 3 adds the payment row to this same
  function, which is the reason it is a function."*
- **`lib/money.ts`** — integer paise on one side, `numeric(12,2)` on the other,
  `parseNumeric()` for the PostgREST string boundary and `numericLiteral()` for
  the column form. Nothing in this phase does arithmetic on money that is not
  already through these.
- **The house envelope** — `handle(req, 'name', …)`, `ApiHttpError`, `ok`,
  `created`, `validationError`, `audit(supabase, { … })` with `redact()`.
- **`lib/bookingServer.ts`** — `getBookingForCaller()` and
  `requireBookingCustomer()`, the ownership shape `getPaymentForCaller()` copies.
- **`test/helpers/fakeSupabase.ts`** and `test/helpers/dbEnv.ts` — route-level DB
  fakes and the live-DB client with its dead-socket reconnect.
- **Env vars** — `.env.example` already carries `NEXT_PUBLIC_RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and `CRON_SECRET`. All four
  values in `.env.local` are placeholders; that is why decision 1 exists.

Not in place, and needed: the `payments` schema and its writer, the gateway
transport, the three payment routes, the webhook, the reconciliation cron, the
refund and wallet schema, the refund routes, and the tests that prove all of it.

**The baseline the phase must not break: 555 tests in 29 files, all green
(measured 2026-10-06), typecheck, lint and build clean.**

### How this phase is cut

Per CONTEXT.md decision 2: **one phase, two verified waves.** Wave A is money in,
Wave B is money out. Each wave ends with a full gate — a checkpoint that runs
typecheck, lint, the build and the suite **pre-migration** (with the two new
live-db files excluded, because `vitest.config.ts` includes every `*.test.ts` under `test/`
with no db exclusion and those files cannot pass until the migration exists),
then — with approval — applies the migration to the live project, and only then
runs the full suite unexcluded at ≥555 tests plus `npm run test:db` against it.
Wave B does not start until Wave A's gate is passed. **Every command in this plan
is labelled PRE-MIGRATION or POST-MIGRATION; that label, not the order a reader
happens to prefer, decides which form of `npx vitest run` to run.**

Three findings in `03-RESEARCH.md` contradict the specification. They are binding,
and each is recorded in *Decisions worth remembering* below rather than silently
corrected: **the webhook signature is HMAC-SHA256, not §12.1's SHA-512**;
**`apply_wallet_delta` cannot ship verbatim**; **`handle()` does not consume the
body — a checked fact that must be pinned by a test**, because if it ever starts
to, every webhook in production silently fails signature verification while the
suite stays green.

## Tasks

### Wave A — money in

Closing: `P3-ORDERS`, `P3-WEBHOOK`, `P3-VERIFY`, `P3-CRON`, and the `quoteToken`
hand-off that STATE.md lists as Phase 2's first open item.

<task type="auto" tdd="true">
  <name>Task A1 — `0014_payments.sql` and the type mirror</name>
  <files>supabase/migrations/0014_payments.sql, supabase/schema.sql, lib/supabase.ts, docs/DATABASE.md, test/db.payments.test.ts</files>
  <behavior>
    - The migration applies idempotently on a live project that already has 0010/0011/0024/0028.
    - `confirm_booking_payment` called twice with the same arguments moves the booking once and returns null the second time.
    - Under the anon/authenticated client, customer A's `payments` row is invisible to customer B, and anon sees nothing.
  </behavior>
  <action>
    Write `0014_payments.sql` (the spec's own number, §23 — gaps 0012 and 0014–0023
    are reserved and nothing is renumbered) in the house voice: a header that says
    *why this file exists*, what it takes from §12.1/§12.2/§24.9, and what it
    deliberately does not do.

    **First, the check the plan owes §24.9:** `payment_purpose` is already declared
    in `0010_bookings.sql:34` (`do $$ … create type payment_purpose as enum
    ('booking','extension','wallet_topup','penalty'); … exception when
    duplicate_object then null; end $$`). `0014` must **not** re-declare it. Record
    the finding in the header in one sentence — "checked: `payment_purpose` ships
    in 0010 per §24.7; re-declaring it here would either raise or mask a real
    duplicate" — so the next reader does not repeat the check.

    Then, exactly as §24.9 spells them: `payment_status` (`created`, `pending`,
    `success`, `failed`, `refunded`, `partially_refunded`), `payment_method`
    (`card`, `upi`, `netbanking`, `wallet`, `emi`, `cod`), and the `payments`
    table — `amount numeric(12,2) CHECK (amount > 0)`, `currency char(3) DEFAULT
    'INR'`, `refundable_amount`, `gateway_signature` carrying §12.2's comment
    *"evidence for disputes; never logged"*, `failure_reason`, `captured_at`.
    All four indexes including the two partial uniques: `uniq_payments_gateway_order`
    on `(gateway, gateway_order_id)` and `uniq_payments_idem` on
    `(idempotency_key)` — the latter is the backstop that survives the ledger
    being pruned by the §25.11 `wallet-expiry` cron.

    **RLS on `payments`**, mirroring `0010:339-392` structure verbatim: `enable row
    level security`; a `do $$ … exception when duplicate_object` block creating
    `payments_select_own` using `customer_id = current_customer_id() or
    is_staff(array['admin','super_admin','ops'])` (the spec names nobody for this
    policy; `['admin','super_admin','ops']` deliberately extends the
    `['admin','super_admin']` set every existing staff policy in migrations
    0001–0024 uses — `0024_audit_idempotency.sql:168-169` among them — because
    `ops` holds `refund.execute`; and `support` holding `refund.request` but not a
    payments read is recorded as an open question in *Decisions worth
    remembering*); **no INSERT or UPDATE policy**, because the
    service role is the only writer and a browser must not be able to set
    `status`; `revoke all … from anon`; `grant select … to authenticated`. Say in
    a comment that RLS does not protect any server path — route handlers use the
    service role, which bypasses it — which is why Task A3 adds
    `getPaymentForCaller()`.

    **`confirm_booking_payment(p_payment_id uuid, p_gateway_order_id text,
    p_booking_id uuid, p_gateway_payment_id text, p_gateway_signature text, p_note
    text)`**, modelled on `0028`'s grant block: `security definer`, sets the three
    `app.transition_*` settings itself with a **null actor** and the note as the
    provenance (there is no profile to name for a webhook — `booking_status_history.actor_id`
    is nullable and `public.user_role` has no `system` value, so adding one would
    be an `ALTER TYPE` on the table with a history row behind every row), then in
    one statement: `UPDATE payments SET status='success', gateway_payment_id=…,
    gateway_signature=…, captured_at=now(), updated_at=now() WHERE id = $1 AND
    gateway_order_id = $2 AND status IN ('created','pending')` — the replay guard,
    a second call updates zero rows — and `UPDATE bookings SET status='paid',
    quote_token=null WHERE id = $3 AND status='payment_pending'`. Both writes are
    in the caller's transaction; a failure rolls back both, which is the whole
    reason this is a function and not two PostgREST calls (the partial-write bug
    `0028` exists to fix). Returns the payment row, or null when nothing moved.
    `revoke all … from public, anon, authenticated; grant execute … to service_role`.

    Also in this file: the `touch_updated_at` trigger on `payments` (`0010:217`
    shows the shape), and `idx_payments_status` on `(status, created_at DESC)`,
    which is the index the reconciliation cron reads directly.

    `lib/supabase.ts`: `payment_status`, `payment_method`, the
    `Row`/`Insert`/`Update` triple for `payments` and `export type Payment =
    Tables<'payments'>`, hand-maintained in the existing `Schema['Tables'][T]`
    shape. Then `npm run db:schema` so `supabase/schema.sql` matches disk —
    §31.2 requires the migration to be *added to* `supabase/schema.sql`.

    `docs/DATABASE.md` grows the `payments` section in the same task, including
    the RLS table and the reason there is no INSERT policy.

    `test/db.payments.test.ts` (live — it runs under `npm run test:db` at the
    Wave A gate, after `0014` is applied, and is excluded from every pre-migration
    `npx vitest run`) is written here because a
    migration without its isolation test is only half done per §31.2. It creates
    two customers, inserts a `payments` row for each through the service role, and
    asserts through the anon and authenticated clients: A cannot select B's row,
    anon selects nothing, and there is no write policy to attempt. The
    refunds/wallets/wallet_transactions half is added by Task B1 — name the file
    in the plan as **the** §29.3 isolation test for this phase.
  </behavior>
  <verify>
    <automated>npm run typecheck; npm run build; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"; node scripts/check-migrations.mjs</automated>
    <human-check>PRE-MIGRATION — every command in `<automated>` runs before `db:migrate`. The exclusion is required, not cosmetic: `vitest.config.ts:7` includes every `*.test.ts` under `test/` with no db exclusion and `SUPABASE_DB_URL` is present, so an unexcluded `npx vitest run` here would fail on `relation "public.payments" does not exist`. `npm run db:migrate` is **not** run in this task — it happens only inside the Wave A gate (Task A-GATE), and only after it does the unexcluded `npx vitest run` (≥555) and `npm run test:db` — which is where `test/db.payments.test.ts` really runs — become the commands to use.</human-check>
  </verify>
  <done>`0014_payments.sql` exists with a WHY header recording the `payment_purpose` finding; the table, enums, four indexes and `confirm_booking_payment` match §24.9; RLS on `payments` has a select policy, no insert/update policy, anon revoked; `lib/supabase.ts` and `supabase/schema.sql` are rebuilt; `docs/DATABASE.md` documents it; typecheck, build and the existing 555 tests are green, with `test/db.payments.test.ts` reserved for the gate, after `0014` is applied.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A2 — the two pure gateway modules: signature verifier and transport</name>
  <files>lib/razorpaySignature.ts, lib/razorpayClient.ts, test/razorpaySignature.test.ts, test/gatewayClient.test.ts</files>
  <behavior>
    - A signature computed over the exact raw bytes with a synthetic secret is accepted.
    - A tampered body, a wrong secret, an absent `x-razorpay-signature`, a non-hex signature and a wrong-length signature are each rejected — the last without `timingSafeEqual` throwing out of the function as a 500.
    - `createOrder` sends an integer paise amount and `currency: 'INR'` with Basic auth built from key id + secret; a non-2xx response surfaces as `PAYMENT_FAILED`.
    - No test opens a socket.
  </behavior>
  <action>
    Two modules, neither of which touches the database or a Route Handler, so they
    are built and tested together and are the first thing in Wave A that can fail
    on its own terms.

    **`lib/razorpaySignature.ts` — a pure verifier, SHA-256, and the spec is wrong
    about the algorithm.** §12.1 says *"verify HMAC-SHA512 over RAW body"*.
    Razorpay's own documentation says the `X-Razorpay-Signature` header is *"HMAC
    with SHA256 algorithm; with your webhook secret set as the key and the webhook
    request body as the message"*
    (<https://razorpay.com/docs/webhooks/validate-test>), and the sibling SmartPOS
    project independently got it right: its
    `app/api/webhooks/razorpay/route.ts:28` (one directory up from `smarthelp/`)
    calls `.createHmac('sha256', webhookSecret)`. Implementing SHA-512 would
    produce a verifier that passes every synthetic test and **fails every real
    delivery**, so the exit criterion "the webhook is the sole authority" would be
    false in production while the suite stayed green. Record the discrepancy in
    the module header with both citations — CONTEXT decision 1 locks *pure
    function, synthetic tests*; it does not lock the algorithm, and correcting it
    does not contradict a locked decision.

    Export `verifyRazorpaySignature(rawBody: string | Buffer, secret: string,
    signature: string | null): boolean` — no HTTP frame, no Supabase client, no
    `process.env` read inside it. Hex-decode the signature and compare with
    `crypto.timingSafeEqual` **only after a length check**, so a wrong-length
    input returns `false` instead of throwing. Also export
    `isUsableWebhookSecret(secret: string | undefined): boolean` — false for
    absent, empty, or a value matching `placeholder|REPLACE` — which is the
    runtime guard CONTEXT decision 1 asks for; the route calls it and answers a
    clear error rather than 500-ing on a `timingSafeEqual` length mismatch.

    Keep the two secrets apart in the header: the webhook uses
    `RAZORPAY_WEBHOOK_SECRET` over the raw body; `POST /api/payments/verify` uses
    `RAZORPAY_KEY_SECRET` over `order_id + '|' + payment_id`, also SHA-256
    (<https://razorpay.com/docs/developer-tools/integrations/standard-checkout>).
    Different keys, different messages — conflating them is the classic mistake.
    The verify-route half of that message construction belongs to Task A4; this
    module exports a `verifyCheckoutSignature(orderId, paymentId, secret,
    signature)` alongside, so both algorithms live in one testable file.

    **`lib/razorpayClient.ts` — a thin transport with an injectable `fetch`.**
    Export `createRazorpayClient({ keyId, keySecret, fetch? })` returning
    `createOrder({ amountPaise, receipt, notes })`, `fetchOrder(orderId)`,
    `listPaymentsForOrder(orderId)` and `createRefund({ paymentId, amountPaise,
    speed })`. Default `fetch` is `globalThis.fetch`; a test passes a stub. This
    is the seam that makes CONTEXT decision 4 (*mock the transport, not the logic*)
    true, and it is why no `razorpay` npm package is added: the SDK constructs its
    own request layer with no supported way to hand it a fake transport, and four
    endpoints do not justify it. **No new dependency enters `package.json` in this
    phase.**

    Mirror the sibling's request shape — `Authorization: Basic base64(keyId:keySecret)`,
    `POST https://api.razorpay.com/v1/orders`, body
    `{ amount: amountPaise, currency: 'INR', receipt, notes }` — where `amountPaise`
    is an **integer**, because Razorpay's smallest unit is paise and `lib/money.ts`
    already counts paise. The caller converts PostgREST's `numeric` string through
    `parseNumeric()` then `Math.round(… * 100)` at the boundary and never
    round-trips a paise integer back through `rupees()`. A non-2xx response
    becomes `ApiHttpError('PAYMENT_FAILED', …)` carrying Razorpay's
    `error.description` in `details` when present, so the route never invents a
    message the gateway already wrote.

    Tests: `test/razorpaySignature.test.ts` computes its vectors **in the test**
    with `createHmac('sha256', syntheticSecret)` — correct accepted, tampered body
    rejected, wrong secret rejected, missing header rejected, non-hex rejected,
    wrong-length rejected (asserting a `false`, not a throw) — and never contains
    a real secret. `test/gatewayClient.test.ts` asserts the URL, the auth header,
    the integer-paise body, and the three response shapes (order created, error
    body, refund created) against a stub that *is* the assertion.
  </behavior>
  <verify>
    <automated>npx vitest run test/razorpaySignature.test.ts test/gatewayClient.test.ts</automated>
  </verify>
  <done>Both modules export the functions named above; every signature case in CONTEXT decision 1 has a test; the client test proves paise integers and Basic auth without a network call; `package.json` is unchanged; the suite is still green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A3 — `POST /api/payments/create-order` and the quoteToken decision</name>
  <files>lib/paymentServer.ts, app/api/payments/create-order/route.ts, test/routes.payments.test.ts, docs/API.md</files>
  <behavior>
    - A request with no `Idempotency-Key` is refused with `VALIDATION_ERROR`.
    - A booking with `quote_token IS NULL` is refused with a re-quote instruction; a booking whose token is present but 40 minutes old is accepted.
    - Two concurrent creates with the same key produce one `payments` row; the second caller is replayed from the ledger.
    - An `expectedTotal` that disagrees with `bookings.total_amount` is `409 PRICE_CHANGED`; a client-supplied amount in the body is never read.
    - A second create with the same key after a ledger prune is caught by `uniq_payments_idem` and returns the existing row.
  </behavior>
  <action>
    `lib/paymentServer.ts` first, because the routes in A3 and A4 both need it:
    `getPaymentForCaller(id, customerId, role)` mirroring `getBookingForCaller`
    (`lib/bookingServer.ts:46`) — the route-side ownership check RLS cannot
    provide — plus `paymentAmountPaise(payment)` and
    `bookingAmountPaise(booking)` which do the `parseNumeric()` → `Math.round(×100)`
    conversion in exactly one place, so the amount the order is built from, the
    amount stored, and the amount the webhook compares are the same number by
    construction.

    `POST /api/payments/create-order` in the house shape: `handle(req,
    'payments.create.order', …)`, `requireAuth`, body
    `{ bookingId, expectedTotal? }`. Then `withIdempotency({ key:
    readIdempotencyKey(req), operation: 'payments.create.order',
    actorProfileId, payload, required: true, run })` — **§25.8 says
    Idempotency-Key required, so `required: true`**. Compose the two mechanisms
    rather than choosing: the ledger gives replay/conflict/in_flight and a
    byte-identical stored response; inside `run()`, the `payments` row is written
    with `idempotency_key = <the same key>`, and a `23505` on `uniq_payments_idem`
    is caught and answered by loading the existing row. The column is what keeps
    "one booking, one payment" true after the §25.11 `wallet-expiry` cron prunes
    the ledger.

    **`quoteToken` — consumed at `create-order`.** This is STATE.md's first open
    item and CONTEXT.md demands the decision be stated, not implied. The three
    options and why two lose:

    - *Re-verified at the webhook* is impossible: the token carries a 15-minute
      `exp` and a legitimate `payment.captured` routinely arrives later. Rejecting
      a real payment because a quote expired would directly violate "the webhook
      is the sole authority".
    - *Verified for freshness at `create-order`* fails for the same reason on any
      booking older than its TTL — a customer who abandons checkout and returns,
      or a scheduled booking paid the next morning. Freshness is the wrong
      property to gate money on.
    - *Deliberately deferred* is what STATE.md already called out as unacceptable:
      Phase 4 has no payment hand-off to attach it to.

    So: **presence is asserted, freshness is not.** `create-order` requires
    `bookings.quote_token IS NOT NULL` and refuses with `409 INVALID_STATE` and
    copy telling the client to re-quote and create a fresh booking when it is
    null. What is consumed is the attestation the Phase 2 create route stored —
    "this booking was priced by our engine from a signed quote" — and it makes the
    token load-bearing for the payment hand-off instead of a column nothing reads.
    A booking created without a token (Phase 2 deliberately tolerates that for a
    hand-rolled request) cannot be paid, which is the honest consequence: §7.2's
    chain is quote → token → booking → order, and a booking that skipped the quote
    has nothing for the payment to attest to; it can still be cancelled
    (`payment_pending → cancelled` is legal). The token is **nulled by the
    webhook** inside `confirm_booking_payment`, making it single-use across the
    payment lifecycle, and it is never cleared by `create-order` itself — a retry
    after an abandoned checkout must still find it there.

    `run()` then: load the booking for the caller, require
    `bookings.status = 'payment_pending'` (a paid or cancelled booking never gets
    a second order), compare `expectedTotal` to `bookings.total_amount` when the
    client sends one — mismatch is `409 PRICE_CHANGED` with the fresh total
    attached — and take the order amount **from `bookings.total_amount` only**.
    No price is re-derived here: the total was frozen at creation (§16, #19) and
    re-pricing after the customer confirmed would charge a figure they never
    agreed to. A client-sent amount field is ignored outright; say so in the
    docstring, because "the server owns the money" is the invariant
    `test/routes.bookings.test.ts` already guards from the other side.

    Write the `payments` row (`purpose 'booking'`, `gateway 'razorpay'`,
    `status 'created'`, `currency 'INR'`), then call
    `createRazorpayClient(...).createOrder({ amountPaise, receipt:
    booking.booking_number, notes: { bookingId } })`, then store
    `gateway_order_id` on the row. Insert-first-then-gateway is deliberate: a row
    with no `gateway_order_id` is a visible, reconcilable thing, whereas a
    gateway order with no row is an invisible one. If the gateway call fails, set
    `payments.status='failed'` with `failure_reason` and answer `402
    PAYMENT_FAILED` — a failed order-create leaves nothing for the reconciliation
    cron to compare. Respond `created()` with
    `{ paymentId, orderId, keyId, amount, currency }`; the client needs `keyId`
    for Checkout. Audit `payment.order.created` through `audit()` with `redact()`.

    `test/routes.payments.test.ts` opens here (the webhook half lands in A4),
    built on `FakeSupabase` exactly as `test/routes.bookings.test.ts:47` does:
    the six behaviours in `<behavior>` above, plus an audit assertion that
    `gateway_signature` never appears in any recorded metadata.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.payments.test.ts</automated>
  </verify>
  <done>The route answers 201 with a Razorpay order id for a `payment_pending` booking; a null `quote_token` is refused and a stale-but-present one is not; idempotency composes ledger and column; `docs/API.md` §4.5 documents the endpoint with its required header and `PRICE_CHANGED` case.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A4 — the webhook (sole authority), verify, payment read, and the manual live step</name>
  <files>app/api/webhooks/razorpay/route.ts, app/api/payments/verify/route.ts, app/api/payments/[id]/route.ts, lib/audit.ts, test/routes.webhook.test.ts, test/routes.payments.test.ts, test/api.test.ts, docs/API.md, docs/SETUP.md</files>
  <behavior>
    - A raw body whose bytes differ from its re-serialised JSON verifies; the re-serialised form does not — proving `req.text()` is the first read.
    - A test in `test/api.test.ts` asserts `handle()` passes a request through without consuming its body.
    - An invalid signature returns 400 with zero writes; a missing or placeholder `RAZORPAY_WEBHOOK_SECRET` returns the guard's clear error, not a 500.
    - A valid `payment.captured` calls `confirm_booking_payment` once with the right arguments; a replay performs zero writes and logs a duplicate.
    - An amount/currency/`gateway_order_id` mismatch is rejected with no write.
    - `POST /api/payments/verify` with a correct `razorpay_signature` leaves `payments.status` and `bookings.status` unchanged.
    - `GET /api/payments/[id]` refuses another customer's row.
  </behavior>
  <action>
    **`app/api/webhooks/razorpay/route.ts`** — the one route in the tree
    authenticated by something other than `requireAuth`. Say that in its
    docstring: Razorpay sends no bearer token, so its authority is the signature.
    The order of the first four statements is the whole design:

    `await req.text()` **inside** the `handle()` callback and before anything
    else; then read `x-razorpay-signature`; then the runtime guard —
    `isUsableWebhookSecret(process.env.RAZORPAY_WEBHOOK_SECRET)` false ⇒ a clear
    `SERVICE_UNAVAILABLE` explaining the secret is unset or still the placeholder,
    because the alternative is a 500 from `timingSafeEqual` or a silent rejection
    of every delivery; then `verifyRazorpaySignature(rawBody, secret, signature)`
    throwing `ApiHttpError('VALIDATION_ERROR', …, 400)` on `false`. **Only then**
    `JSON.parse(rawBody)`.

    Two facts to write down in the header, because both are load-bearing and
    neither is obvious:

    1. **`handle()` does not consume the body — checked, not assumed.**
       `lib/api.ts:132` reads exactly one thing off `req`: the `x-request-id`
       header. It never calls `req.json()`, `req.text()` or touches `req.body`,
       so the stream is intact when the callback starts. This is a *fact with a
       guard*: if a future `handle()` change reads the body, `req.text()` returns
       an empty string, every signature check in production fails, and the suite
       would stay green. So `test/api.test.ts`'s existing `describe('handle')`
       grows a case that hands `handle()` a request and asserts the callback can
       still read the exact body bytes — pinning the assumption where it lives.
       Never call `readJson()`/`req.json()` on this route before step one:
       `Request.body` is one-shot, and after `req.text()` a `JSON.parse` on the
       returned string costs nothing.
    2. **Read the secret at request time.** `vitest.config.ts` inlines only the
       four SupabASE vars; no `RAZORPAY_*` key is repo-wide, so tests supply
       `vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'test-webhook-secret')` and the
       runtime guard needs request-time reads anyway.

    Event handling: `payment.captured` ⇒ agreement check comparing **paise to
    paise** (`payload.payment.entity.amount` against `paymentAmountPaise(row)`,
    plus `currency` and `order_id` against `gateway_order_id`) with no decimal
    arithmetic on either side; mismatch ⇒ 400, zero writes, an
    `payment.webhook.mismatch` audit row. Match ⇒ one
    `supabase.rpc('confirm_booking_payment', { … note: 'payment confirmed by
    webhook (payment.captured, pay_…)' })`; a null return means the payment was
    already `success`, so log `payment.webhook.duplicate` and answer 200 — §30.1's
    "replay the webhook → no state change, no duplicate earning, logged as
    duplicate". `payment.failed` ⇒ `payments.status='failed'` with
    `failure_reason`, **and the booking stays `payment_pending`** (see
    *Decisions worth remembering*). Audit every path through `audit()` with
    `actorProfileId: null` — `write_audit` and `lib/audit.ts` both tolerate a null
    actor — and **add `gateway_signature` to `REDACTED_KEYS` in `lib/audit.ts`**
    in this task: §12.2 marks it "never logged" and the set does not contain it
    today, so one careless metadata object would leak dispute evidence into the
    audit trail.

    `runtime = 'nodejs'` as every route in the tree does.

    **`POST /api/payments/verify`** — UX only, and the hard rule makes that
    literal. Body `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`;
    HMAC-SHA256 over `orderId + '|' + paymentId` with `RAZORPAY_KEY_SECRET`
    through `verifyCheckoutSignature` from A2; failure is `402
    PAYMENT_NOT_VERIFIED`. On success it **reads** the payment's current status
    and returns `{ verified: true, status }` — it writes nothing at all. No
    `gateway_payment_id` store, no status nudge: no client-reachable path may
    write `success` (the webhook and the reconcile cron are the only writers, both
    gated on gateway truth and both funnelling through `confirm_booking_payment`),
    and a client path that writes anything is the spec violation CONTEXT's
    Specific Ideas ask a test to name.

    **`GET /api/payments/[id]`** — `getPaymentForCaller`, returning status,
    amount, `failure_reason` and timestamps. This is what the client polls while
    the webhook lands, so it must be cheap and it must refuse another customer's
    row even though RLS would also refuse it — the route check is the one that
    protects server-side paths, per the `routes.bookings.test.ts` header.

    Tests: `test/routes.webhook.test.ts` carries every row of `<behavior>` above,
    including the byte-level case (a body with irregular spacing/key order that a
    real gateway would send still verifies, and its `JSON.stringify` re-serialisation
    does not); `test/routes.payments.test.ts` gains the verify-never-writes and
    ownership cases; `test/api.test.ts` gains the `handle()` body guard. Secrets
    come from `vi.stubEnv`; no fixture holds a real one.

    **`docs/SETUP.md`** grows, under `## 6. Tests`, a subsection named
    `### Verifying the webhook against Razorpay by hand`: set
    `RAZORPAY_WEBHOOK_SECRET` from the dashboard, point the dashboard webhook at
    `/api/webhooks/razorpay`, trigger or replay a `payment.captured`, and confirm
    `payments.status` moves and the booking reaches `paid`. State plainly that
    **the automated suite never claims this** — it proves the algorithm with
    synthetic vectors and the authority through the route, and the agreement with
    the production key is this one manual step. That is CONTEXT decision 1's
    accepted consequence, written where the next person will find it.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.webhook.test.ts test/routes.payments.test.ts test/api.test.ts</automated>
  </verify>
  <done>The webhook verifies SHA-256 over the exact bytes, guards a missing/placeholder secret, writes `success` through one RPC and nothing else, and is idempotent on replay; verify writes nothing; the payment read is ownership-checked; `lib/audit.ts` redacts `gateway_signature`; `docs/API.md` and the `docs/SETUP.md` manual step are in place; all three test files are green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A5 — the client: open Checkout, and never claim "Paid" before the webhook</name>
  <files>lib/paymentClient.ts, components/catalogue/CheckoutForm.tsx, test/paymentClient.test.ts, docs/FEATURES.md</files>
  <behavior>
    - Every payment call carries the caller's own bearer token via `authorizationHeader()` from `lib/sessionHeaders.ts`.
    - The display state derived from a Razorpay handler callback alone is `confirming`, never `paid` — `paid` is reachable only from a polled `payments.status === 'success'`.
    - Polling gives up into a retryable state rather than spinning forever, and a `failed` payment says so.
  </behavior>
  <action>
    Phase 2's pay button creates the booking and then says what happens next,
    because there was no gateway. This task replaces that hand-off with the real
    one, and the reason it is in this plan rather than a later one is §31.2:
    *"client wired to the real endpoint — no placeholder buttons, no fake success
    states."* "Real money in" has to be reachable through the product, not only
    through curl.

    `lib/paymentClient.ts` — `createPaymentOrder(body)` (POST
    `/api/payments/create-order`), `verifyPayment(body)` (POST
    `/api/payments/verify`), `fetchPayment(id)` (GET `/api/payments/[id]`), and a
    pure `paymentDisplayState(status)` mapping `payments.status` to
    `'confirming' | 'paid' | 'failed'`. **Every call imports
    `authorizationHeader()` from `lib/sessionHeaders.ts`** — the Phase 2 lesson
    where a client that sent `credentials: 'include'` with no header was silently
    unauthenticated, and no route test could see it because each built its own
    `Request` with the header already attached.

    The pure mapping is the hard rule made testable. The Razorpay `handler`
    callback receives `{ razorpay_order_id, razorpay_payment_id,
    razorpay_signature }` and its only jobs are to fire `verifyPayment` and start
    polling `fetchPayment` — it never feeds a `paid` state directly. A late
    webhook therefore shows **"Confirming payment…"**, exactly as §12.1 requires,
    and the test that pins this feeds the handler payload alone into the display
    logic and asserts the result is not `paid`.

    Poll every ~2 s for a bounded number of attempts; success ⇒ refetch the
    booking and show it paid; `failed` ⇒ show the failure with a retry that
    creates a fresh order (the old payment row is already `failed`); timeout ⇒
    an honest "still confirming" state with a retry, never a spinner with no
    exit. Loading, error, success and retry are all present because §31.2 says
    they must be.

    `components/catalogue/CheckoutForm.tsx`: after `POST /api/bookings` succeeds,
    call `createPaymentOrder`, then load
    `https://checkout.razorpay.com/v1/checkout.js` and open
    `new window.Razorpay({ key: keyId, order_id: orderId, handler })` with
    `NEXT_PUBLIC_RAZORPAY_KEY_ID`. A gateway failure at order-create (`402
    PAYMENT_FAILED`) surfaces the server's message — never a fake success, never
    a dead control. No new component directory: the payment client lives in
    `lib/` beside `bookingClient.ts`, and the checkout form already owns this
    button.

    `test/paymentClient.test.ts` follows `test/bookingClient.test.ts` — the
    browser client is a tested unit, not a thing route tests happen to exercise:
    header present on all three verbs, header is the caller's own token, no
    session means no header, and the display-state cases above.
  </behavior>
  <verify>
    <automated>npx vitest run test/paymentClient.test.ts; npm run typecheck; npm run lint</automated>
    <human-check>The interactive Checkout flow is a manual smoke step (see docs/SETUP.md) — it needs live keys and cannot be claimed by the suite.</human-check>
  </verify>
  <done>The pay button opens real Razorpay Checkout with a real order id; the handler only verifies and refetches; `paid` is reachable solely from polled payment status; every call carries an auth header; the display-state test proves the hard rule; `docs/FEATURES.md` describes the payment step.</done>
</task>

<task type="auto" tdd="true">
  <name>Task A6 — `GET /api/cron/reconcile-payments` and `vercel.json`</name>
  <files>app/api/cron/reconcile-payments/route.ts, vercel.json, test/routes.cron.test.ts, docs/API.md, docs/ARCHITECTURE.md</files>
  <behavior>
    - With `CRON_SECRET` unset the route answers 503 (fail closed); with a wrong value it answers 401; with the right value it accepts all three channels in precedence order.
    - A stubbed gateway order in `paid` produces exactly one `confirm_booking_payment` call with the right arguments; `created` produces zero writes and a non-zero `stillPending`; a rejected fetch produces zero writes and `unreachable: 1`.
    - `unreachable > 0` and a `stillPending` row whose payment is older than the 60-minute stale threshold each write a `payment.reconcile.alert` audit row carrying `{ condition, count, oldest }`; a `stillPending` row between the 10-minute scan window and 60 minutes is counted and does not alert.
    - `vercel.json` contains exactly one cron path.
  </behavior>
  <action>
    **This is the phase's only cron** (§25.11). The other seven belong to Phases 5,
    7 and 8 and were removed from `vercel.json` by quick task 261006-01; their
    schedules live in `docs/ARCHITECTURE.md` §7 as prose. Add exactly one entry —
    `{"crons":[{"path":"/api/cron/reconcile-payments","schedule":"*/30 * * * *"}]}` —
    and nothing else. `vercel.json` is strict JSON; a comment in it fails to parse.

    The guard mirrors the spec's "exact SmartPOS guard"
    (`smartpos-main/app/api/cron/promotion-campaigns/route.ts:27-38`) — three
    channels in precedence: `Authorization: Bearer`, then `x-cron-secret`, then
    `?secret=` — **with one deliberate amendment: when `CRON_SECRET` is unset the
    route answers 503 instead of skipping the check.** SmartPOS's `if (cronSecret)
    { … }` fails open; SmartHelp has no cron route today and `vercel.json` is
    empty, so there is no existing behaviour to preserve and failing closed is a
    strengthening, not a change. Record the deviation in the route header.

    Scope: bookings at `payment_pending` whose `payments` row is `created` or
    `pending` and `payments.created_at < now() - interval '10 minutes'`
    (`idx_payments_status` serves it). Per row, one `fetchOrder(gateway_order_id)`
    through the injectable client, then one of three resolutions — and **all three
    funnels into the same writer the webhook uses**:

    | Gateway says | Resolution | Write |
    |---|---|---|
    | order `paid` / payment `captured` | success | `confirm_booking_payment`, audit `payment.reconciled` |
    | payment `failed` / order `expired` | failed | `payments.status='failed'`, `failure_reason`; **booking stays `payment_pending`** |
    | still `created`, or `partially_paid` | still pending | no write, counted |
    | unreachable / 5xx / rate-limited | non-outcome | **no write**, counted `unreachable`, audit `payment.reconcile.alert` |

    The fourth row is the one that matters: a reconciliation pass that wrote rows
    on a failed API call would be worse than no cron. `partially_paid` has no
    `payment_status` value (§12.1–12.5 are silent on it), so it is treated as
    still pending and left for the next pass.

    **Alerting covers two conditions, not one** — `03-RESEARCH.md:405` asks for
    `stillPending` beyond a second threshold *and* for `unreachable`, and this
    task implements both rather than the easier half.
    An alert fires when either (a) `unreachable > 0` for the pass, or (b) any
    `stillPending` row's payment is older than `RECONCILE_STALE_MINUTES` (60 — a
    second threshold above the 10-minute scan window, so a customer who simply has
    not paid yet never alerts while a payment stuck for an hour does). Each alert
    is an `audit_logs` row (`action: 'payment.reconcile.alert'`, metadata
    `{ condition: 'unreachable' | 'stillPending', count, oldest }`) plus a
    `console.warn` with the request id — `lib/audit.ts` is the house's "make it
    loud" channel and `write_audit` tolerates a null actor; inventing a
    notification channel for a phase that owns none is out of scope. A
    `stillPending` row between 10 and 60 minutes is counted in the response and
    does not alert.

    Answer `{ resolved, failed, stillPending, unreachable }` with `ok()`. Export
    `GET` (Vercel crons invoke with GET); no `requireAuth`, only the guard.

    `test/routes.cron.test.ts` asserts the guard's three channels, the 401 on a
    wrong value, the 503 on an unset secret, the resolution mapping against a
    per-row stubbed fetch, and both alert conditions (unreachable fires;
    stillPending fires only past 60 minutes). `docs/ARCHITECTURE.md` §7's
    reconciliation row changes from "scheduled, not built" to a link at the route;
    `docs/API.md` documents the endpoint, its guard and its alert condition.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.cron.test.ts; node -e "const v=require('./vercel.json'); if(!v.crons||v.crons.length!==1||v.crons[0].path!=='/api/cron/reconcile-payments'||v.crons[0].schedule!=='*/30 * * * *') { console.error('vercel.json crons wrong'); process.exit(1); } console.log('vercel.json: one cron, correct path and schedule');"</automated>
  </verify>
  <done>The cron exists behind a fail-closed three-channel guard, resolves through the same RPC as the webhook, never writes on a gateway error, alerts on `unreachable` and on a `stillPending` payment older than 60 minutes, and `vercel.json` declares exactly it.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task A-GATE — Wave A gate</name>
  <files>no files modified — this task runs the gate over Task A1–A6's output</files>
  <action>Run the eight checks in `<how-to-verify>` **in that order** — the order is load-bearing, not a preference — and report each result. Steps 1–4 are PRE-MIGRATION and fully automated: typecheck, lint, the build, then the full suite with the two not-yet-applied live-db files excluded. Step 5, `npm run db:migrate`, **only after the user approves it** (it writes to the live project). Steps 6–7 are POST-MIGRATION: the full suite with no exclusion (this is where the ≥555 floor is asserted) and then `npm run test:db`. Step 8 confirms no commits. Do not start any Wave B task until this gate passes, and do not commit anything — the user has forbidden commits for this session. If any step fails, stop and report the failing command's output rather than working around it.</action>
  <what-built>The whole money-in path: `0014`, the gateway modules, create-order with the quoteToken decision, the webhook as sole authority, verify, the payment read, the checkout client, and the reconciliation cron.</what-built>
  <how-to-verify>
    1. **PRE-MIGRATION** `npm run typecheck` — no output, exit 0.
    2. **PRE-MIGRATION** `npm run lint` — exit 0.
    3. **PRE-MIGRATION** `npm run build` — exit 0.
    4. **PRE-MIGRATION** `npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"` — green. The exclusion is mandatory: `vitest.config.ts:7` includes every `*.test.ts` under `test/` with no db exclusion, so without it this step fails on `relation "public.payments" does not exist` before `0014` has been applied. No test may be skipped or `.only`'d.
    5. **GATE, AWAITING APPROVAL** Apply the migration to the live project: `npm run db:migrate` — **this writes to a live database and is the one step of this gate that waits for your approval.** It applies `0014_payments.sql`; `npm run db:status` lists it afterwards.
    6. **POST-MIGRATION** `npx vitest run` — no exclusion now — **green, at or above 555 tests** (baseline measured 2026-10-06: 555 in 29 files; the new files add to it, none may be skipped or `.only`'d). This, not step 4, is where the ≥555 floor is asserted.
    7. **POST-MIGRATION** `npm run test:db` — green, including the new `test/db.payments.test.ts` (payments isolation between two customers, anon sees nothing).
    8. Confirm `git status` shows **no commits** — nothing in this phase commits.
  </how-to-verify>
  <verify>
    <automated>npm run typecheck; npm run lint; npm run build; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"</automated>
    <human-check>Steps 1–4 are the PRE-MIGRATION automated block above, run in that order. Then `npm run db:migrate` applies 0014 to the live project and awaits approval; POST-MIGRATION `npx vitest run` (no exclusion, ≥555 tests) and `npm run test:db` run green; `git status` confirms no commits were made.</human-check>
  </verify>
  <done>All eight checks pass in order: typecheck, lint, build, the excluded pre-migration suite green, migration 0014 applied to the live project, the unexcluded post-migration suite green at ≥555 tests across 29+ files, `test:db` green including `test/db.payments.test.ts`, and no commits on the branch. Wave B is unblocked.</done>
  <resume-signal>Type "approved" if all eight pass (or report which step failed, with its output). Wave B does not start until this gate is passed.</resume-signal>
</task>

### Wave B — money out

Closing: `P3-REFUNDS`, `P3-WALLET`, and the RLS half of the exit criterion for
the three remaining tables. Depends on Task A-GATE.

<task type="auto" tdd="true">
  <name>Task B1 — `0015_refunds_wallet.sql` with the two mandated amendments</name>
  <files>supabase/migrations/0015_refunds_wallet.sql, supabase/schema.sql, lib/supabase.ts, docs/DATABASE.md, test/db.payments.test.ts</files>
  <behavior>
    - The migration applies idempotently on a project that already has 0014.
    - `apply_wallet_delta` runs its first credit without a `not-null violation`.
    - Under the authenticated client, customer A cannot select customer B's refunds, wallets or wallet_transactions, and both UPDATE and DELETE on `wallet_transactions` are refused outright.
  </behavior>
  <action>
    `0015_refunds_wallet.sql` (the spec's number, §23) with a header in the voice
    `0011` and `0028` already use. The header must carry, verbatim in substance,
    the finding that **§12.4's `apply_wallet_delta` does not run against §24.9's
    schema**:

    > §12.4's `apply_wallet_delta` is reproduced with two amendments.
    > **(1)** `balance_after` is written because §24.9 declares it `NOT NULL` and
    > §12.4's INSERT omits it — the specification's function does not run against
    > the specification's schema; as written it raises `not-null violation` on its
    > first call. **(2)** the balance is read under `FOR UPDATE` and checked
    > before the write, because §12.4's `RAISE WALLET_OVERDRAFT` sits behind its
    > own non-deferred `CHECK (balance >= 0)`, which fires first and makes the
    > named error unreachable.

    Then the schema exactly as §24.9 spells it: `refund_status`, `wallet_txn_type`;
    `refunds` with `route CHECK (route IN ('gateway','wallet','mixed'))`,
    `requested_by`/`processed_by`/`approved_by` referencing `profiles`, and
    `uniq_active_refund_per_payment` (one active refund per payment); `wallets`
    with `balance numeric(12,2) DEFAULT 0 CHECK (balance >= 0)`; the
    **`ALTER TABLE customers ADD COLUMN wallet_id uuid REFERENCES wallets(id)`**
    that `docs/DATABASE.md` already promises in a comment ("FK added in
    0015_refunds_wallet.sql") — the comment stops being a lie here; and
    `wallet_transactions` with `amount CHECK (amount > 0)`, `balance_after NOT
    NULL`, `ref_type`/`ref_id`/`description`, and `idx_wallet_txn_wallet`.

    **`apply_wallet_delta(p_wallet uuid, p_type wallet_txn_type, p_amount numeric,
    p_ref text, p_desc text) RETURNS numeric`** implementing both amendments:
    `select balance into v_cur from wallets where id = p_wallet for update`; compute
    `v_new`; **if `v_new < 0 then raise exception 'WALLET_OVERDRAFT …' using
    errcode = 'check_violation'`** (same SQLSTATE as the constraint, so nothing
    already handling `check_violation` is surprised, and `WALLET_OVERDRAFT` is
    now reachable); then update `wallets.balance = v_new, updated_at = now()`;
    then insert the ledger row **including `balance_after = v_new`**; return
    `v_new`. Both writes are in the caller's transaction, so the `RAISE` rolls
    back both and the ledger and the cache can never disagree. `p_amount` is
    **strictly positive** — a debit is expressed by `type`, never by a negative
    amount, because `CHECK (amount > 0)` would refuse one anyway. Keep the
    `CHECK (balance >= 0)` on the column: it is the backstop for any future path
    that writes `wallets` without going through the function, and a redundant
    constraint that fires first is a feature in a codebase whose philosophy is
    that the database half is the one that matters.

    Also here: **`get_or_create_wallet(p_customer uuid)`** (`security definer`,
    service-role only) — refund-to-wallet must work for a customer who has never
    had a wallet, and `wallets.customer_id UNIQUE` plus `customers.wallet_id`
    means the create has to be one statement rather than a read-then-write race.

    And the two refund write paths, modelled on `0028` and `confirm_booking_payment`,
    both `security definer` / `service_role`-only, both setting the actor
    settings themselves:

    - **`record_booking_refund(...)`** — inserts the `refunds` row (`status
      'requested'`) and, in the same statement, hops the booking to
      `refund_pending` **only when its status is `paid` or `cancelled`** (both
      legal predecessors per `0011`). A refund merely *requested* above the
      approval limit does not hop — that row stays `requested` for Phase 6's
      second approver, and a booking stuck in `refund_pending` behind a request
      nobody approved would be worse than one that still reads `cancelled`.
    - **`complete_booking_refund(...)`** — sets the refund `completed` with
      `gateway_refund_id`/`completed_at`, moves the booking `refund_pending →
      refunded`, and updates `payments`: `refundable_amount` down by the refund,
      `status` to `partially_refunded` or `refunded`. This is what makes §8.2's
      two refund states reachable — Phase 2's plan promised *"refund_pending and
      refunded become reachable in Phase 3, where payments exists"*, and this is
      the keeping of that promise.

    **RLS on `refunds`, `wallets`, `wallet_transactions`**, mirroring `0010:339-392`
    and §12.4: select policies in the `do $$ … exception when duplicate_object`
    idiom (`refunds` by `customer_id` for owner or `is_staff(['admin','super_admin','ops'])`;
    `wallets` by `customer_id`; `wallet_transactions` through the
    `exists (select 1 from wallets w where w.id = wallet_id and w.customer_id =
    current_customer_id())` shape of `0010:367`), **no insert/update policy on
    any of them**, and §12.4's two outright blocks:
    `wallet_txn_no_update FOR UPDATE USING (false)` and `wallet_txn_no_delete FOR
    DELETE USING (false)`. `revoke all … from anon` on all three; `grant select …
    to authenticated`. The comment says what `0010`'s says: RLS protects the
    browser and PostgREST, not the service-role path, which is why `refunds`
    routes still check ownership and capability themselves.

    `lib/supabase.ts` gains `refund_status`, `wallet_txn_type` and the triples for
    `refunds`, `wallets`, `wallet_transactions`, then `npm run db:schema`.
    `docs/DATABASE.md` gains all three tables, the RLS table, and the amended
    `apply_wallet_delta` with both amendments stated.

    `test/db.payments.test.ts` — the same §29.3 file from A1, extended (this is
    why one file spans both waves rather than two files pretending to be
    independent): refunds and wallets isolation between the two customers,
    `wallet_transactions` invisible across customers, and the UPDATE/DELETE
    refusal asserted directly with a `update`/`delete` through the authenticated
    client expecting a policy error.
  </behavior>
  <verify>
    <automated>npm run typecheck; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"; node scripts/check-migrations.mjs</automated>
    <human-check>PRE-MIGRATION — every command in `<automated>` runs before `db:migrate`. The exclusion is mandatory: `vitest.config.ts:7` includes every `*.test.ts` under `test/` with no db exclusion, and both new live-db files fail on `relation "public.refunds" does not exist` (or `"public.wallets"`) until `0015` is applied. `npm run db:migrate` runs only in the Wave B gate (Task B-GATE); only after it does the unexcluded `npx vitest run` (≥555) run, and `npm run test:db` — the runner that actually selects `test/db.payments.test.ts` and `test/db.wallet.test.ts` by the `test/db.` pattern — becomes the command to use.</human-check>
  </verify>
  <done>The header carries both amendments in the `0011`/`0028` voice; `apply_wallet_delta` writes `balance_after` and can raise `WALLET_OVERDRAFT`; `customers.wallet_id` has its FK; the three RLS blocks exist including §12.4's two; both refund RPCs are service-role-only; the mirror and `docs/DATABASE.md` are rebuilt; the suite is green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task B2 — refunds and the wallet: API and rule, no UI</name>
  <files>lib/refundServer.ts, lib/walletServer.ts, lib/constants.ts, app/api/refunds/route.ts, app/api/webhooks/razorpay/route.ts, app/api/bookings/[id]/cancel/route.ts, test/routes.refunds.test.ts, docs/API.md</files>
  <behavior>
    - `POST /api/refunds` is refused with `FORBIDDEN` for a caller without `refund.request`.
    - A manual refund of ₹2000 with no approval row stays `requested` and is not executed; the same refund of ₹1000 executes; an auto-refund of any size executes with no approver.
    - Cancelling a booking whose payment is `success` creates a refund row for `total_amount − cancellation_fee` and executes it.
    - A gateway refund that fails credits the wallet instead and raises an ops ticket (an audit row) — the customer is never left with nothing.
    - `refund.processed` on the webhook completes the refund and moves the booking to `refunded`.
  </behavior>
  <action>
    **`lib/constants.ts`** first, because the money rule needs a number:
    `PLATFORM_DEFAULTS.supportRefundLimit: Number(process.env.DEFAULT_SUPPORT_REFUND_LIMIT || 1500)` —
    rupees, the unit every other money constant in that object is in, with a
    comment saying it is the §12.3 default and that **`platform_settings` is a
    Phase 6 table, so this constant is the fallback — exactly the pattern Phase 1
    used for `instant_lead_minutes` and Phase 2 for `maxBookingMinutes`.**
    `lib/money.ts` converts at the boundary; no arithmetic happens on the
    constant.

    **`lib/walletServer.ts`** — `creditWallet(supabase, customerId, amountPaise,
    ref, description)` and `debitWallet(...)`: call `get_or_create_wallet`, then
    `apply_wallet_delta` with `numericLiteral(paise)` for the amount, and translate
    a `23514` carrying `WALLET_OVERDRAFT` into an `ApiHttpError`. The paise →
    `numeric` conversion happens here and nowhere else.

    **`lib/refundServer.ts`** — the rules, kept out of the Route Handler so the
    webhook and the cancel path share them:

    - `requestRefund(...)` builds the row: `reason_code`, `route` (`gateway` by
      default; `wallet` when the instrument is not refundable — expired card,
      closed UPI handle), `requested_by`. Manual requests take
      `requireCapability(req, 'refund.request')` (support, admin, super_admin per
      `lib/roles.ts`); execution takes `'refund.execute'` (ops, admin,
      super_admin). **Both are checked server-side**, not left to Phase 6's
      console — STATE.md records that the capability table *is* server-enforced
      on three booking routes, and a money endpoint that relied on a screen that
      does not exist yet would be enforced nowhere.
    - `withinLimit(amountPaise)`, and the approval rule: **above
      `supportRefundLimit` a manual refund may be created but not executed** — it
      stays `requested` with `approved_by` null, and this phase ships no path that
      executes it, because `POST /api/admin/refunds/:id/execute` (§25.10) is
      Phase 6's endpoint. The endpoint therefore *already refuses an unapproved
      ₹2000 refund*, which is what CONTEXT decision 3 wants Phase 6 to build on.
      Auto-refunds — system-initiated, no approver — execute directly.
    - `executeRefund(...)`: `record_booking_refund` → gateway
      `createRefund(...)` through the injectable client → on success
      `complete_booking_refund`; **on gateway failure, fall back to wallet credit
      via `creditWallet` with `ref_type 'refund'`, mark the refund
      `route='wallet'`/`completed`, and write an ops-ticket audit row**
      (`action: 'refund.ops_ticket'`, metadata carrying the failure reason) —
      §12.3's "a failed gateway refund moves the amount to wallet credit and
      raises an ops ticket automatically". The customer is never left with
      nothing, and the disclosure that the wallet is the fallback happens at
      cancellation time (§12.3) — say so in `docs/FEATURES.md`, which Task B3
      updates.

    **Routes** (house shape throughout — `handle()`, `requireAuth`,
    `requireCapability`, `created()`/`ok()`, `ApiHttpError`, `audit()`):

    | Route | Behaviour |
    |---|---|
    | `POST /api/refunds` | `{ paymentId, amount, reasonCode, note }`; staff-only via `refund.request`; validates amount ≤ `refundable_amount` and `> 0` (paise maths through `lib/money.ts`); auto-refund callers (system reasons) need no capability; above-limit manual requests return 202 `requested`, everything else executes |
    | `GET /api/refunds` | filters by status/booking/customer; a customer sees only their own (`getPaymentForCaller`-style ownership), staff see all; paginated with `parsePaging` |
    | webhook `refund.processed` | extend A4's route with this event: match on `gateway_refund_id`, then `complete_booking_refund`. **This is the one Wave B edit to a Wave A file — the route already exists and already verifies the signature, so the event table grows by one row rather than a second route appearing** |
    | `app/api/bookings/[id]/cancel/route.ts` | when the booking's payment is `success`, create and execute a refund for `total_amount − cancellation_fee` (the §11.1 fee the route already wrote) as an auto-refund with no approver |

    That last row is not optional. Phase 2's plan says *"cancel stops at
    `cancelled` and does not invent a refund… `refund_pending` and `refunded`
    become reachable in Phase 3, where `payments` exists"* — and once A4 makes
    `paid` reachable, `paid → cancelled` becomes a live customer path that would
    capture money and produce no refund. Closing that leak is this phase's work.

    `test/routes.refunds.test.ts` covers every row of `<behavior>`: capability
    refusal, the limit boundary at exactly `supportRefundLimit` and one paise over,
    the auto-refund path with no approver, the `route` selection, the
    gateway-failure → wallet fallback with its ops audit, the cancel-of-paid path
    producing one refund row, and `refund.processed` completing it. All against
    `FakeSupabase` and a stubbed transport — no network, per CONTEXT decision 4.

    `docs/API.md` §4.6 documents both refund endpoints, their capabilities, the
    limit, and the 202-above-limit response.
  </behavior>
  <verify>
    <automated>npx vitest run test/routes.refunds.test.ts test/routes.webhook.test.ts test/routes.bookings.test.ts; npm run typecheck</automated>
  </verify>
  <done>Both refund endpoints exist with server-side capability checks; the ₹1500 limit refuses an unapproved large refund and executes a small one; the cancel-of-paid leak is closed; the wallet fallback and ops ticket work; `refund.processed` completes a refund through the existing verified webhook; no UI of any kind was created for refunds; `docs/API.md` is updated.</done>
</task>

<task type="auto">
  <name>Task B3 — the live wallet tests and the phase record</name>
  <files>test/db.wallet.test.ts, docs/FEATURES.md, README.md, docs/DATABASE.md</files>
  <action>
    `test/db.wallet.test.ts` (live, `npm run test:db` at the Wave B gate, after
    `0015` is applied — sequential like the other
    three per the `--no-file-parallelism` reason `dbEnv.ts` records) — the file
    that actually discharges the wallet half of §29.2/§29.3 against real Postgres:

    - credit then debit on one wallet; `wallets.balance` and the newest
      `balance_after` agree to the paisa;
    - a debit larger than the balance raises **`WALLET_OVERDRAFT` with SQLSTATE
      23514** *and* leaves no `wallet_transactions` row behind — the assertion
      that proves the rollback, not just the raise;
    - two concurrent credits land as the exact sum (the row lock in Amendment A
      serialises them; the spec's single-statement `balance + X` form was already
      safe, and the `FOR UPDATE` is required by the amendment's pre-read, which
      is read-then-write without it);
    - `amount <= 0` is refused by the column's own `CHECK`;
    - a debit expressed as a negative `p_amount` is refused (the type carries the
      direction).

    `docs/FEATURES.md` gains the payments walkthrough in the house style —
    what a customer does, what the server does, what the webhook owns, what the
    cron owns, what is deliberately a manual step — and records that refund-to-wallet
    is disclosed at cancellation time, not at refund time (§12.3).
    `README.md` moves to "Phase 3 complete" with the new endpoints and the new
    test count. `docs/DATABASE.md` gets a final pass so the payments, refunds and
    wallet sections agree with the migrations as applied.

    Docs ship here rather than as a stray final task because they are the phase's
    record, and §31.2 lists "documented in `docs/`" as a per-feature DoD item —
    every behaviour was already documented in its own task; this is the
    reconciliation pass, not the writing.
  </action>
  <verify>
    <automated>npm run typecheck; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"; if (-not (Select-String -Path docs/FEATURES.md -Pattern "Reconcile|reconcile-payments" -Quiet)) { Write-Error "docs/FEATURES.md has no reconcile section"; exit 1 }; if (-not (Select-String -Path README.md -Pattern "Phase 3" -Quiet)) { Write-Error "README.md has no Phase 3 line"; exit 1 }</automated>
    <human-check>PRE-MIGRATION — every command above runs before `db:migrate`. `npm run test:db` is deliberately **not** run here: `test/db.wallet.test.ts` and the extended `test/db.payments.test.ts` both need `0015`, which is applied only in the Wave B gate. Typecheck still compiles the new test file, and the two docs assertions are real `if (-not (Select-String …)) { exit 1 }` gates — a plain `-Quiet` prints `$true`/`$false` and exits 0 either way, which is why it is not used. `npm run test:db` runs unmodified at Task B-GATE step 7.</human-check>
  </verify>
  <done>`test/db.wallet.test.ts` exists with all five cases; `docs/FEATURES.md`, `README.md` and `docs/DATABASE.md` describe the phase as built, candidly naming what is a manual step and what is deferred.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task B-GATE — Wave B gate, and the phase</name>
  <files>no files modified — this task runs the gate over Task B1–B3's output</files>
  <action>Run the nine checks in `<how-to-verify>` **in that order** and report each result. Steps 1–4 are PRE-MIGRATION and automated; step 5 (`npm run db:migrate`, applying `0015` to the live project) waits for the user's approval exactly as the Wave A gate did; steps 6–7 are POST-MIGRATION and automated; step 8 is the hand-check of §31.1's three exit clauses; step 9 confirms no commits. The order is load-bearing: the unexcluded suite and `test:db` cannot pass before step 5. Do not commit anything. If a step fails, stop and report the failing command's output rather than working around it — a gate that is talked past teaches the next reader to ignore it.</action>
  <what-built>The whole money-out path: `0015` with both amendments, the wallet ledger, refunds with the approval rule, the cancel-of-paid refund, `refund.processed`, and the RLS and wallet live tests.</what-built>
  <how-to-verify>
    1. **PRE-MIGRATION** `npm run typecheck` — exit 0.
    2. **PRE-MIGRATION** `npm run lint` — exit 0.
    3. **PRE-MIGRATION** `npm run build` — exit 0.
    4. **PRE-MIGRATION** `npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"` — green. The exclusion is mandatory here for the same reason as in the Wave A gate: `vitest.config.ts:7` includes every `*.test.ts` under `test/` with no db exclusion, and both files need `0014`/`0015`. No `.only`, no new skips.
    5. **GATE, AWAITING APPROVAL** `npm run db:migrate` — applies `0015_refunds_wallet.sql` to the live project (**waits for your approval**, as in the Wave A gate).
    6. **POST-MIGRATION** `npx vitest run` — no exclusion now — **green, at or above 555 tests**, with no `.only` and no new skips. This, not step 4, is where the ≥555 floor is asserted.
    7. **POST-MIGRATION** `npm run test:db` — green across all five live files, including `test/db.payments.test.ts` (all four tables isolated, `wallet_transactions` UPDATE/DELETE refused) and `test/db.wallet.test.ts` (overdraft raises and rolls back).
    8. Confirm the three §31.1 exit criteria by hand against the running app or the code: real money in (order created → webhook → `paid`), real money out (refund executed), webhook sole authority (**no client-reachable path writes `success`** — the webhook and the reconcile cron are the only writers, both gated on gateway truth and both funnelling through `confirm_booking_payment`), RLS on payments (step 7).
    9. **No git commits.**
  </how-to-verify>
  <verify>
    <automated>npm run typecheck; npm run lint; npm run build; npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"</automated>
    <human-check>Steps 1–4 are the PRE-MIGRATION automated block above, run in that order. Then `npm run db:migrate` applies 0015 to the live project with approval; POST-MIGRATION `npx vitest run` (no exclusion, ≥555 tests) and `npm run test:db` run green; §31.1's three exit clauses are checked by hand; `git status` confirms no commits.</human-check>
  </verify>
  <done>All nine checks pass in order: typecheck, lint, build, the excluded pre-migration suite green, `0015` applied to the live project, the unexcluded post-migration suite green at ≥555 tests, `test:db` green across all five live files, §31.1 exit criteria satisfied (money in, money out, webhook sole authority with no client-reachable writer of `success`, RLS on payments), and no commits on the branch. Phase 3 is complete.</done>
  <resume-signal>Type "approved" if all nine pass, or report which step failed with its output.</resume-signal>
</task>

</tasks>

## Decisions worth remembering

- **The specification is wrong about the signature algorithm: SHA-256, not SHA-512
  (§12.1).** Razorpay's documentation defines `X-Razorpay-Signature` as *"HMAC
  with SHA256 algorithm"* over the raw body with the webhook secret as the key
  (<https://razorpay.com/docs/webhooks/validate-test>), and the sibling SmartPOS
  project's own webhook route uses `.createHmac('sha256', …)`. Implementing
  §12.1 literally would pass every synthetic test and fail every real delivery —
  the exit criterion "the webhook is the sole authority" would be false in
  production while the suite stayed green. CONTEXT decision 1 locks the *shape*
  (pure function, synthetic vectors), not the algorithm.
- **`handle()` does not consume the body — a checked fact with a guard, not an
  assumption.** `lib/api.ts:132` reads only `x-request-id`, so `await req.text()`
  inside the callback is the first read and the signature covers the exact bytes.
  Because a future `handle()` change would break every webhook *silently*,
  `test/api.test.ts` pins it: if `handle()` ever reads the body, the suite fails
  instead of production.
- **`apply_wallet_delta` ships with two amendments, both flagged in `0015`'s
  header in the voice `0011`/`0028` use.** (1) `balance_after` is written, because
  §24.9 declares it `NOT NULL` and §12.4's INSERT never supplies it — the
  specification's function does not run against the specification's schema.
  (2) the balance is read under `FOR UPDATE` and checked before the write,
  because §12.4's `RAISE WALLET_OVERDRAFT` sits behind its own non-deferred
  `CHECK (balance >= 0)` and is unreachable there. The `CHECK` stays: it is the
  backstop for any path that bypasses the function.
- **`confirm_booking_payment`, not two sequential calls.** `payment_pending → paid`
  is legal (`0011:54`) but `transition_booking` cannot write the `payments` row, so
  calling both reproduces exactly the partial-write bug `0028` exists to fix. One
  `security definer` function does the payment update (guarded by
  `status IN ('created','pending')`, so a replay updates zero rows) and the booking
  hop in one statement, and the reconciliation cron funnels into the *same* function
  with a different audit note — three callers, one writer, because three writers
  with three behaviours is how a booking ends up `paid` while its payment says
  `pending`.
- **`quoteToken` is consumed at `create-order` — presence gates payment,
  freshness does not.** Re-verifying at the webhook is impossible (15-minute TTL
  against arbitrarily late delivery) and verifying freshness at `create-order`
  would refuse any booking older than its TTL. So `create-order` asserts
  `bookings.quote_token IS NOT NULL` — closing STATE.md's first open item with a
  load-bearing read — and `confirm_booking_payment` nulls it, making the token
  single-use across the payment lifecycle without breaking a retry after an
  abandoned checkout. The consequence stated rather than hidden: a booking
  created without a token cannot be paid, and can still be cancelled.
- **A failed or abandoned payment marks the payment, not the booking.**
  `payment.failed` sets `payments.status='failed'` with a `failure_reason` and
  leaves the booking `payment_pending`. §31.1's Phase 3 row gives this phase no
  cancellation authority, and §8.2's "15-min order expiry" guard carries a
  fee/refund ladder that neither §25.11's cron nor this phase owns. The
  consequence is recorded honestly: such a booking keeps occupying the address-use
  count until the customer cancels it (legal from `payment_pending`) or ops does
  (Phase 6). MEDIUM confidence in this reading — it is the conservative one.
- **`support_refund_limit` falls back through `PLATFORM_DEFAULTS`, because
  `platform_settings` is a Phase 6 table.** Same pattern Phase 1 used for
  `instant_lead_minutes` and Phase 2 for `maxBookingMinutes`: a seed value with a
  comment saying where the real home will be, never a query for a table that does
  not exist.
- **No new npm package.** The gateway is four `fetch` calls with an injectable
  transport, mirroring the sibling project; the `razorpay` SDK hides the transport
  behind a non-injectable client and would break CONTEXT decision 4. No package
  legitimacy checkpoint is triggered because nothing is installed.
- **The cron fails closed.** SmartPOS's guard skips the check when `CRON_SECRET`
  is unset; SmartHelp has no cron today, so there is no behaviour to preserve and
  503 is a strengthening. The three channels themselves are copied exactly, because
  §25.11 calls them "the exact SmartPOS guard".
- **The staff read-set on `payments`/`refunds` is a recommendation, not a
  finding.** The spec names nobody for these policies; `['admin','super_admin',
  'ops']` deliberately extends the `['admin','super_admin']` set every existing
  staff policy in migrations 0001–0024 uses — `0024_audit_idempotency.sql:168-169`
  included — because `ops` holds `refund.execute`. `support` holds
  `refund.request` while being outside that set — a support agent can request a
  refund they cannot see. Worth one line to the user if Phase 6's console needs
  `support` to read payments.

## Threat model

### Trust boundaries

| Boundary | Description |
|---|---|
| Razorpay → `/api/webhooks/razorpay` | Unauthenticated internet traffic whose only credential is the HMAC; the raw body is read before any parse |
| Browser → `/api/payments/*` | An authenticated customer whose body must never supply an amount |
| Browser → `/api/refunds` | A staff member whose capability check is the only thing above the ₹1500 line |
| Route Handler → Postgres | Service role, which **bypasses RLS** — ownership must be re-checked in the route |
| Cron platform → `/api/cron/reconcile-payments` | Scheduled traffic guarded only by `CRON_SECRET` |

### STRIDE threat register

| ID | Category | Component | Disposition | Mitigation |
|---|---|---|---|---|
| T-03-01 | Tampering | webhook payload | mitigate | `verifyRazorpaySignature` over the exact `req.text()` bytes with SHA-256 + length-checked `timingSafeEqual`, before `JSON.parse`; invalid ⇒ 400 and zero writes |
| T-03-02 | Spoofing | missing/placeholder `RAZORPAY_WEBHOOK_SECRET` | mitigate | `isUsableWebhookSecret` runtime guard ⇒ clear `SERVICE_UNAVAILABLE`, fail closed rather than 500 or silent accept |
| T-03-03 | Tampering | client-supplied amount | mitigate | Order amount is taken from `bookings.total_amount` only; `expectedTotal` is a comparison, never a source; webhook compares paise to paise against the stored row |
| T-03-04 | Repudiation / disclosure | `gateway_signature` in audit metadata | mitigate | Added to `REDACTED_KEYS` in `lib/audit.ts` (§12.2: "never logged"); a test asserts it never appears |
| T-03-05 | Information disclosure | cross-customer payment reads | mitigate | RLS select policies on all four tables **plus** `getPaymentForCaller`-style route checks, because the service role bypasses RLS; covered by `test/db.payments.test.ts` |
| T-03-06 | Elevation of privilege | refund above `support_refund_limit` | mitigate | `requireCapability('refund.request'/'refund.execute')` server-side; above-limit manual refunds stay `requested` with no execution path until Phase 6's approver endpoint |
| T-03-07 | Denial of service / abuse | unauthenticated cron | mitigate | Three-channel `CRON_SECRET` guard, 503 when unset (fail closed), 401 on mismatch |
| T-03-08 | Tampering | wallet ledger mutation | mitigate | Append-only: RLS `FOR UPDATE USING (false)` and `FOR DELETE USING (false)` outright; `balance` only written through `apply_wallet_delta` in one transaction |
| T-03-09 | Tampering | duplicate payment for one charge | mitigate | `withIdempotency(..., required: true)` as behaviour, `uniq_payments_idem` as the backstop that survives ledger pruning, and the replay guard inside `confirm_booking_payment` |
| T-03-SC | Tampering | npm installs | mitigate | **No packages are installed in this phase** (no `razorpay` SDK by design); slopcheck still applies to any install a task might otherwise introduce, and a blocking human checkpoint is required for any `[ASSUMED]`/`[SUS]` package |

## Verification

Wave A gate (Task A-GATE) and Wave B gate (Task B-GATE) are the two blocking
checkpoints. **The order below is the order, and every command is labelled with
the side of `db:migrate` it belongs on** — `vitest.config.ts:7` includes
every `*.test.ts` under `test/` with no db exclusion, so an unexcluded `npx vitest run`
before the migrations exist fails on `relation "public.payments" does not exist`
no matter how correct the work is:

```bash
# --- PRE-MIGRATION: what every task's <verify> runs, and gate steps 1-4 ---
npm run typecheck
npm run lint
npm run build
node scripts/check-migrations.mjs   # dry-run of the outstanding migrations; one
                                    # transaction, always rolled back, writes nothing
npx vitest run --exclude "test/db.payments.test.ts" --exclude "test/db.wallet.test.ts"
                                    # full suite with the two not-yet-applied
                                    # live-db files held out; green, no floor yet

# --- GATE-ONLY: awaits human approval, writes to the live project ---
npm run db:migrate

# --- POST-MIGRATION: gate steps 6-7 only, and only after db:migrate ---
npx vitest run            # no exclusion: must stay green, >= 555 tests, 29 files baseline
npm run test:db           # the live suite: `vitest run test/db.` — five files after
                          # 0015, four after 0014; this is where test/db.payments.test.ts
                          # and test/db.wallet.test.ts actually run
```

Per-task verification is the targeted `npx vitest run <file>` listed in each
`<verify>` block, so a failure names the task that caused it. The ≥555 floor and
`npm run test:db` are **POST-MIGRATION** assertions and appear only in the two
gates; no task before a gate asserts them.

## Success criteria

- **§31.1 exit criterion, all three clauses:** real money in (order → webhook →
  `paid`), real money out (refund executed to gateway or wallet), no
  client-reachable path writes `payments.status = 'success'` — the webhook and
  the gateway-reconciling cron are the only writers, both gated on gateway truth
  and both funnelling through `confirm_booking_payment` — and RLS on `payments`,
  `refunds`, `wallets`, `wallet_transactions`, each covered by an isolation test.
- All six requirement IDs (`P3-ORDERS`, `P3-WEBHOOK`, `P3-VERIFY`, `P3-REFUNDS`,
  `P3-WALLET`, `P3-CRON`) have at least one task that addresses them, and each
  task's `<done>` names what it delivered.
- The suite is green at **555 tests or more** with typecheck, lint and build
  clean, and no test makes a network call.
- STATE.md's first open item — "nothing consumes `quoteToken` for payment" — is
  closed with a test.
- `vercel.json` declares exactly one cron.
- **No git commits were made.**

## Out of scope

- **Phase 4** — gateway results driving job state beyond `paid` (on_the_way,
  arrived, OTP, completion). The webhook's job ends at `payments.status='success'`
  and `bookings.status='paid'`; §12.1's "matching engine starts" is Phase 5's
  first line, not this phase's.
- **Phase 5** — matching kick-off after `paid`, exhausted-search auto-refund,
  `searching → refund_pending`, the search sweeper cron.
- **Phase 6** — the admin console, `POST /api/admin/refunds/:id/execute` and its
  second approver, `platform_settings` (the `support_refund_limit` fallback
  stands in until then), and any screen that reads the payments tables.
- **Phase 7** — notification of payment and refund events.
- **Phase 8** — wallet top-up as a product feature (`POST /api/wallet/topup` is
  listed in §25.8 but §31.1 puts "wallet top-up" in Phase 8's row — the schema
  and ledger this phase builds are what it will use), referrals, surge, and
  **invoice PDF generation**.
- **§12.5 invoice row generation stays out.** Phase 2 ships an invoice *read
  model*, Phase 8 owns "invoices/PDF", and no clause of §31.1's Phase 3 exit
  criterion mentions invoices — generating rows here would be a feature the exit
  criterion does not ask for and no later phase has agreed to build on.
- **Any UI for refunds.** API and database rule only: no components, no pages,
  no `/admin` routes. Building half a console would be worse than none.
- **Cancelling an abandoned `payment_pending` booking on order expiry.** See
  *Decisions worth remembering* — the payment is marked failed and the booking is
  left for the customer or for Phase 6 ops.
- **Git commits of any kind.**

## Output

Create `.planning/phases/03-payments/03-SUMMARY.md` when the phase is done,
recording the wave gates, the test counts against the 555 baseline, and any
deviation from this plan with its reason — the same way `02-PLAN.md`'s summaries
and STATE.md's "recorded because the reasoning matters" sections read.
