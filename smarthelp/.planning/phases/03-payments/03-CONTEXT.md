# Phase 3 — Payments · Context

**Gathered:** 2026-10-06
**Status:** Ready for planning

<domain>
## Task Boundary

Phase 3 from `ROADMAP.md`, scope verbatim from §31.1: *Razorpay orders, webhook, verify,
refunds, wallet ledger, reconciliation cron.*

Exit criteria (§31.1): **"Real money in, real money out; the webhook is the sole
authority; RLS on payments."**

Spec sections that define this phase: §12.1 (payment lifecycle), §12.2 (payments
table), §12.3 (refunds), §12.4 (wallet), §12.5 (invoices), §24.9 (schema),
§25.8 (endpoints), §25.11 (cron), §29.2 (mandatory money tests), §7.2 (quoteToken).

</domain>

<decisions>
## Implementation Decisions

### 1. Webhook signature — DECIDED BY USER

**Pure verifier + synthetic tests.** The environment cannot verify a real signature:
`RAZORPAY_WEBHOOK_SECRET` in the project `.env` is placeholder text (length 22,
matched `placeholder|REPLACE`), so a genuine `payment.captured` HMAC-SHA512 test is
impossible today.

- `verifyRazorpaySignature(rawBody: string | Buffer, secret: string, signature: string)`
  is a **pure function** in its own module (not inside the route), so it is testable
  without an HTTP frame, a Supabase client or a secret.
- Unit tests use **synthetic secrets and known-good vectors computed in the test**,
  asserting: correct signature accepted; tampered body rejected; wrong secret rejected;
  absent `x-razorpay-signature` rejected; non-hex signature rejected. The real secret
  never appears in the repo, the suite, or any committed fixture.
- A **runtime guard** on the webhook route returns a clear error when
  `RAZORPAY_WEBHOOK_SECRET` is absent or still the placeholder, rather than 500-ing on a
  `crypto.timingSafeEqual` length mismatch or silently accepting nothing.
- **Live end-to-end verification is a documented manual step** in `docs/SETUP.md`:
  configure the secret in the dashboard, replay an event, confirm `payments.status`
  moves. It is explicitly *not* claimed by the test suite.

**Consequence accepted:** the suite proves the verifier's algorithm, not the dashboard's
secret. The webhook's *authority* logic (it is the only writer of `success`, it is what
moves `payment_pending → paid`) is fully testable through the route with an injected
signature — only the HMAC's agreement with Razorpay's production key is unproven, and
that is the user's documented manual step.

### 2. Waves — DISCRETION (user did not select)

**Plan as one phase, execute in two verified waves.** The phase is large enough that a
single executor run would leave too big a surface unverified between gates.

- **Wave A — money in:** `0014_payments.sql`, the gateway client, `POST
  /api/payments/create-order`, `POST /api/payments/verify`, `POST
  /api/webhooks/razorpay`, `payment_pending → paid`, `GET /api/payments/:id`,
  `GET /api/cron/reconcile-payments`.
- **Wave B — money out:** `0015_refunds_wallet.sql`, `apply_wallet_delta`,
  auto-refunds, `POST/GET /api/refunds`, the wallet ledger and RLS.

Each wave runs the full gate (typecheck, lint, `npx vitest run`, `build`) before the
next begins. The `quoteToken` hand-off — Phase 2's principal open item — belongs to Wave
A and is the first thing it closes.

### 3. Refund approval workflow — DISCRETION (user did not select)

**Build the API and the rule, ship no UI.** §25.8 lists `POST /api/refunds`, and
§12.3's `support_refund_limit` (default ₹1500) with a second approver above it is a
*money* rule, so building it now without screens is correct: Phase 6 then adds the
console on top of an endpoint that already refuses an unapproved ₹2000 refund.

- Auto-refunds (paid-but-unmatched, professional-cancelled, ops-cancelled, goodwill)
  are system-initiated and need no approver.
- Manual refunds above the limit require an approval row before they may be processed;
  the limit is read from `platform_settings` **when that table exists** and falls back to
  a constant today, because `platform_settings` is a Phase 6 table (same pattern Phase 1
  and Phase 2 used for `instant_lead_minutes` / `PLATFORM_DEFAULTS`).
- **No components, no pages, no `/admin` routes** in this phase. That is Phase 6's scope
  and building half a console would be worse than none.

### 4. Gateway testing — DISCRETION (user did not select)

**Mock the transport, not the logic.** The house style is `test/helpers/fakeSupabase.ts`
and a pure-module-under-test approach; the suite is 555 tests that run offline apart
from the 67 live-database ones, and it must stay that way.

- The Razorpay HTTP client is a thin module with an injectable `fetch`, so order-create
  and refund calls are tested against a stub that returns recorded Razorpay-shaped
  responses — success, failure, and the mismatch cases (amount mismatch, currency
  mismatch).
- **No network call in the suite.** No test asserts against a live Razorpay endpoint.
- The things that actually decide correctness are tested directly: the signature verifier
  (pure), the amount/currency/gateway_order_id agreement check (pure), and the webhook's
  state transitions (through the route).

</decisions>

<specifics>
## Specific Ideas

- **The webhook is the sole authority (§12.1 "Hard rule").** The client-side Razorpay
  success handler never mutates a booking — it only triggers a refetch. A late webhook
  shows "Confirming payment…", never a false "Paid". Any code path that lets a client
  callback write `success` is a spec violation, and a test must exist that says so.
- **`quoteToken` closes here.** Phase 2 issues it, verifies it and stores it on
  `bookings.quote_token`, and `STATE.md` lists "nothing consumes quoteToken" as its
  first open item. §7.2's requirement was storage; Phase 3 must decide what a payment
  hand-off does with it. The plan must state the decision explicitly — consumed at
  `create-order`, re-checked at webhook, or deliberately left as a Phase 4 concern with
  reasoning. Do not silently drop it.
- **Refund-to-wallet is the default when the instrument is not refundable** (expired
  card, closed UPI handle), and that disclosure happens at *cancellation* time, not at
  refund time (§12.3). A failed gateway refund moves the amount to wallet credit and
  raises an ops ticket automatically.
- **Wallet is an append-only ledger, never a mutable balance on the customer row**
  (§12.4). `wallet_transactions` gets RLS that blocks UPDATE and DELETE outright;
  `wallets.balance` is a cache maintained in the same transaction by
  `apply_wallet_delta`, which raises `WALLET_OVERDRAFT` rather than going negative.
- **`customers.wallet_id` already exists as a bare uuid** whose comment says "FK added
  in 0015_refunds_wallet.sql" (`docs/DATABASE.md` §…). The migration that comment
  promises is this phase — the comment stops being a lie.
- **Only one cron belongs to this phase:** `/api/cron/reconcile-payments` (`*/30 * * * *`,
  payment_pending older than 10 min compared against the gateway). The other seven in
  §25.11 belong to Phases 5, 7 and 8 and are already recorded as prose in
  `docs/ARCHITECTURE.md` §7 after quick task 261006-01 removed them from `vercel.json`.
  **Add only the one this phase owns** back to `vercel.json`, behind the §25.11
  `CRON_SECRET` guard (bearer / `x-cron-secret` / `?secret=`).
- **Migration numbers are the specification's** (§23): `0014_payments.sql` and
  `0015_refunds_wallet.sql`, exactly as §24.9 names them. The gaps 0012, 0014–0023 are
  reserved; do not renumber.
- **`payment_purpose` was already declared in `0010_bookings.sql`** (Phase 2 shipped it
  early because §24.7 puts it in `0010`). `0014` must not re-declare the type — check
  for it first.
- **§12.5 invoices** — rows generated on completion and on refund, `INV/{FY}/{YYYY}/seq`.
  Phase 8 owns "invoices/PDF" and Phase 2 already ships an invoice *read model*. The
  plan must decide where invoice *row generation* lands and say so; the conservative
  reading is that it is not Phase 3's exit criterion and stays out.

</specifics>

<canonical_refs>
## Canonical References

- **Build specification `SmartHelp-Documentation.docx`** (in `smarthelp/`), extracted to
  `%TEMP%\SmartHelp-Documentation-extract.txt` for this session. Sections: §7.2
  quoteToken, §12.1–12.5 payments chapter, §24.9 schema, §25.8 endpoints, §25.11 cron,
  §29.2 money tests, §31.1 phase list and exit criteria.
- `.planning/ROADMAP.md` — Phase 3 row and exit criteria.
- `.planning/STATE.md` — Phase 2 hand-off: what exists, what is deliberately open.
- `.planning/phases/02-booking-pricing/02-PLAN.md` — the house plan shape this plan
  should match (goal = §31.1 exit criterion verbatim, tasks with migrations in spec
  order, "Decisions worth remembering", explicit out-of-scope).
- `docs/DATABASE.md`, `docs/API.md`, `docs/FEATURES.md` — must move with the behaviour.
- `smartpos-main/app/api/cron/*/route.ts` — the `CRON_SECRET` guard the spec calls
  "the exact SmartPOS guard"; mirror it rather than inventing a third one.

</canonical_refs>
