# Phase 3: Payments — Research

**Researched:** 2026-10-06
**Domain:** Razorpay order creation, webhook authority, idempotency, `payment_pending → paid`, RLS, wallet ledger, reconciliation cron
**Confidence:** HIGH overall — every claim below is backed by a file:line in this repo or by official Razorpay docs. Two spec-vs-reality conflicts were found and are called out (SHA-512, and `apply_wallet_delta`'s missing `balance_after`).

**Scope constraint honoured:** `03-CONTEXT.md` decisions are treated as locked. Decision 1 (pure verifier + synthetic tests), decision 2 (one phase, two waves), decision 3 (API + rule, no UI), decision 4 (mock the transport, not the logic) are the frame this research works inside.

---

## Verdict table

| # | Question | Recommendation | Why |
|---|---|---|---|
| 1 | Razorpay integration shape | **Thin `fetch` wrapper, no `razorpay` npm package.** Server calls `POST https://api.razorpay.com/v1/orders` with Basic auth; client opens Checkout by loading `checkout.razorpay.com/v1/checkout.js` and passing `order_id`. | No `razorpay` dep exists in `smarthelp/package.json` nor in the sibling project — and the sibling already implements exactly this with `fetch`. Decision 4 requires an injectable `fetch`; the SDK would hide the transport behind a non-injectable client. |
| 2 | Webhook signature / raw body | **`const rawBody = await req.text()` as the FIRST body read, inside the `handle()` callback.** Verify `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` against `x-razorpay-signature` with `timingSafeEqual`. | `handle()` (`lib/api.ts:132`) reads only `req.headers` — it never touches the body, so the body is intact. **The spec's "HMAC-SHA512" (§12.1) is wrong**: Razorpay signs with **SHA-256**. |
| 3 | Idempotency | **Compose, don't choose.** `withIdempotency()` is the behaviour (replay/conflict); write the same key into `payments.idempotency_key` inside `run()` as the durable row-level backstop. | The ledger is pruned by the `wallet-expiry` cron (§25.11), so it cannot be the long-term guarantee; the column's unique partial index (§24.9) can. |
| 4 | `payment_pending → paid` | **Legal.** New RPC `confirm_booking_payment(...)` in `0014`, modelled on `0028`, doing the `payments` UPDATE *and* the booking hop in one statement. Do **not** reuse `transition_booking` alone. | `0011:54` allows it. `transition_booking` cannot write the payment row, so calling both reproduces exactly the partial-write bug `0028` exists to fix. |
| 5 | RLS | **Mirror `0010:339-392` exactly**: enable RLS, `do $$ … exception when duplicate_object` policy creation, `revoke all from anon`, `grant select to authenticated`, **no** INSERT/UPDATE/DELETE policy where the service role is the only writer. | Route Handlers use the service role and bypass RLS, so RLS protects the anon/authenticated client and PostgREST; ownership stays route-enforced (the `routes.bookings.test.ts` header says this explicitly). |
| 6 | `apply_wallet_delta` | **Ship amended, not verbatim** — two amendments, flagged in the migration header the way `0011`/`0028` flag theirs. | Verbatim it **fails its own schema**: §24.9 declares `balance_after numeric(12,2) NOT NULL` and §12.4's INSERT never supplies it. And the `CHECK (balance >= 0)` fires before the `RAISE`, so `WALLET_OVERDRAFT` is unreachable. |
| 7 | Testing | Six named files (below): pure verifier, fetch-stub gateway client, payment routes, webhook route, refund routes, cron route — plus two live-DB files for RLS and the SQL wallet function. | Decision 4: mock transport, never assert against a live endpoint. `test/helpers/fakeSupabase.ts` already gives route-level DB fakes; `vi.stubEnv` supplies the secret. |
| 8 | Reconciliation cron | "Compare" = read `payment_pending` bookings older than 10 min whose payment is `created`/`pending`, `GET /v1/orders/{gateway_order_id}` through the injectable client, then apply one of three resolutions through the *same* writer the webhook uses. | Three legal outcomes: **paid** (replay the success path), **failed** (mark `failed` + `failure_reason`), **still open** (leave untouched, raise an ops alert). Gateway error = no state change + alert. |

---

## 1. Razorpay integration shape in Next.js App Router

**No `razorpay` dependency exists — confirmed.** `smarthelp/package.json` lists 41 dependencies; none is `razorpay` (nor is it in `devDependencies`). The sibling project has none either.

**The house pattern already exists one directory over.** `smartpos-main/app/api/create-order/route.ts` does this, with no SDK:

```ts
const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
const response = await fetch('https://api.razorpay.com/v1/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
  body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: … }),
});
```

`smartpos-main/app/api/subscription/create/route.ts` is the same shape. The spec calls the CRON_SECRET guard "the exact SmartPOS guard" — the same deference applies here: **mirror the sibling's transport rather than inventing a new one.**

**Recommendation:** a `lib/razorpayClient.ts` with an injectable `fetch` (module-level default `globalThis.fetch`, overridable per test), exposing `createOrder(...)`, `fetchOrder(orderId)`, `listPaymentsForOrder(orderId)`, `createRefund(...)`. Reasons, in order:

1. **Decision 4 is not satisfiable with the SDK.** The `razorpay` npm client constructs its own request layer; there is no supported way to hand it a fake transport for tests. A `fetch` seam is what makes "no network call in the suite" true.
2. Only four endpoints are needed. The SDK buys `orders.create` and nothing else of consequence.
3. It matches the sibling project and adds zero install surface.

**Amounts.** Razorpay's `amount` is an integer in the smallest currency unit — **paise for INR**. `lib/money.ts` already counts paise (`toPaise`, `sumPaise`, `percentOfPaise` all return integer paise; `numericLiteral(paise)` at `lib/money.ts:78` is the string form for `numeric(12,2)` columns). So the conversion is:

```ts
// bookings.total_amount (numeric) -> string -> paise -> order amount. No float.
const totalPaise = Math.round(parseNumeric(booking.total_amount) * 100);
// or, if the value is already held in paise: pass it through untouched.
body: JSON.stringify({ amount: totalPaise, currency: 'INR', receipt: booking.booking_number })
```

The one float step (`* 100`) is unavoidable because PostgREST hands `numeric` back as a **string**; `parseNumeric()` (`lib/money.ts:46`) is the sanctioned boundary and `Math.round` closes it immediately. **Never** do `Number(rupees) * 100` without rounding, and never round-trip a paise integer through `rupees()` before sending it to the gateway. The gateway response echoes `amount` in paise, so the webhook's agreement check compares **paise to paise** (`order.amount` from Razorpay vs. our stored amount ×100) with no decimal arithmetic on either side.

**Order-create response** (`POST /v1/orders`): `{ id: 'order_…', entity: 'order', amount, amount_paid, currency, receipt, status: 'created', notes, created_at }`. `id` is what the client needs and what we store in `payments.gateway_order_id` (spec §12.2, unique per `(gateway, gateway_order_id)`).

**Client-side Checkout.** No server SDK needed: the route returns `{ orderId, keyId, amount }`, and the client loads `https://checkout.razorpay.com/v1/checkout.js` (script tag, `NEXT_PUBLIC_RAZORPAY_KEY_ID` for `key`) then `new window.Razorpay({ key, order_id, handler })`. The `handler` payload (`razorpay_order_id | razorpay_payment_id | razorpay_signature`) is posted to `POST /api/payments/verify`. Per §12.1's hard rule and CONTEXT decision 1, that handler **only** triggers a refetch — it must not write `success`.

**Env vars already provisioned:** `.env.example` carries `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CRON_SECRET`; `.env.local` has all four (placeholder values).

*Confidence: HIGH (in-repo precedent + official docs).*

---

## 2. Webhook signature verification — and the raw-body problem

### The algorithm: SHA-256, not SHA-512 ⚠️

**The specification is wrong here.** §12.1 says "verify HMAC-SHA512 over RAW body with `RAZORPAY_WEBHOOK_SECRET`". Razorpay's own documentation says:

> `X-Razorpay-Signature`: The hash signature is calculated using **HMAC with SHA256 algorithm**; with your webhook secret set as the key and the webhook request body as the message.
> `key = webhook_secret`, `message = webhook_body // raw webhook request body`, `expected_signature = hmac('sha256', message, key)`
> — https://razorpay.com/docs/webhooks/validate-test

Header name is **`x-razorpay-signature`** (lower-cased when read via `Headers.get`), hex digest, lowercase.

The sibling project independently got this right: `smartpos-main/app/api/webhooks/razorpay/route.ts:28` uses `.createHmac('sha256', webhookSecret)`.

**Recommendation:** implement `verifyRazorpaySignature(rawBody, secret, signature)` with **SHA-256** and note the spec discrepancy in the migration/route header. CONTEXT decision 1 does *not* lock the algorithm — it locks "pure function, synthetic tests" — so correcting the algorithm does not contradict a locked decision. Implementing SHA-512 would produce a verifier that can never match a real Razorpay delivery, i.e. the exit criterion ("the webhook is the sole authority") could never be satisfied in production.

Two further details that belong in the same function:

- **Two distinct secrets.** The webhook uses `RAZORPAY_WEBHOOK_SECRET` (dashboard webhook config); `POST /api/payments/verify` uses `RAZORPAY_KEY_SECRET` over `order_id + '|' + payment_id` — `HMAC-SHA256`, per https://razorpay.com/docs/developer-tools/integrations/standard-checkout. They are different keys and different messages; conflating them is the classic mistake.
- **`timingSafeEqual` only after a length check.** `crypto.timingSafeEqual` throws on unequal lengths. The CONTEXT decision explicitly wants a *runtime guard* when the secret is missing or still the placeholder, so the order is: (1) secret present and not `placeholder|REPLACE` → else a clear 503; (2) signature header present and 64 hex chars → else 400; (3) `timingSafeEqual`.

### The raw-body problem: `handle()` does not consume the body ✅

This was the highest-risk unknown and it resolves cleanly.

`lib/api.ts:132`:

```ts
export async function handle(
  req: Request,
  name: string,
  fn: (requestId: string) => Promise<NextResponse>
): Promise<NextResponse> {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  try {
    const res = await fn(requestId);
```

**`handle()` reads exactly one thing off `req`: the `x-request-id` header.** It never calls `req.json()`, `req.text()` or `req.body`. The route closure captures `req` and reads it inside `fn` — see `app/api/bookings/route.ts:44`:

```ts
return handle(req, 'bookings.create', async () => {
  await requireCapability(req, 'booking.create');
  …
  const input = validateCreateInput(await readBody(req));
```

So **the body stream is untouched when the webhook route's callback starts**, and `await req.text()` inside the callback is the first and only read. Signature verification therefore happens over the exact bytes received.

**Order of operations in the webhook route — this is the one thing to get right:**

```ts
export async function POST(req: Request) {
  return handle(req, 'webhooks.razorpay', async (requestId) => {
    const rawBody = await req.text();              // (1) FIRST body read
    const signature = req.headers.get('x-razorpay-signature');
    verifyRazorpaySignature(rawBody, secret, signature);   // (2) throws ApiHttpError on mismatch
    const event = JSON.parse(rawBody);             // (3) parse only after verification
    …
  });
}
```

**Never** call `readJson()`/`req.json()` (`lib/validation.ts:238`) before step (1) on this route — `Request.body` is a one-shot stream and `json()` consumes it. After `req.text()`, `JSON.parse` on the returned string is free and safe (no second read).

**Also:** the webhook route must **not** call `requireAuth` — Razorpay sends no bearer token. Its authority is the signature, not a caller identity. That makes it the one route in the tree that is authenticated by something other than `requireAuth`, which is worth saying in the route's docstring.

*Confidence: HIGH — official Razorpay docs for the algorithm, direct file read for `handle()`.*

---

## 3. Idempotency and concurrency for create-order

### What `lib/idempotency.ts` gives you

`IdempotencyInput<T>` (`lib/idempotency.ts:48`) is exactly:

```ts
{
  key: string | null;         // from readIdempotencyKey(req) — 16..128 chars of [A-Za-z0-9._:-]
  operation: string;          // 'payments.create.order' — part of the ledger's unique key
  actorProfileId: string;     // the caller's profiles.id
  payload: unknown;           // the VALIDATED body; canonicalised + sha256'd
  required?: boolean;         // true for create-order (§25.8: "Idempotency-Key required")
  run: () => Promise<{ status: number; body: T }>;
}
```

`withIdempotency()` (`:116`) returns `{kind:'executed'}` | `{kind:'replay'}` | `{kind:'rejected'}`, backed by `claim_idempotency_key` / `complete_idempotency_key` from `0024:107`. Both functions are `security definer`, `EXECUTE` granted to `service_role` only (`0024:224-228`) — which is what `createServerClient()` is, so the existing wiring works unchanged.

### `payments.idempotency_key` vs `idempotency_keys` — recommend **both, with distinct jobs**

| | `idempotency_keys` (0024) | `payments.idempotency_key` (§24.9) |
|---|---|---|
| Key shape | `(key, operation, actor_profile_id)` | global unique, partial `WHERE idempotency_key IS NOT NULL` |
| Lives | **pruned** — §25.11's `wallet-expiry` cron explicitly "prunes idempotency_keys and otp_requests" | forever, on the row |
| Answers | "is this the same request? replay / conflict / in_flight" | "was a payment row already written for this key?" |

**Recommendation: use `withIdempotency()` as the single behavioural mechanism, and set `payments.idempotency_key = <same key>` inside `run()`.** They compose rather than duplicate:

- The ledger provides the four-way outcome and byte-identical replay — which the column cannot do (it stores no response).
- The column's unique partial index is a **backstop that survives pruning**: if the ledger row is gone and a very late retry arrives, the second INSERT fails on `uniq_payments_idem` instead of creating a second payment for one charge. §29.4's "10 concurrent `POST /api/bookings` with the same Idempotency-Key → one booking and one payment" is asserted against the ledger, and the column is what makes it true even after a prune.
- Operation string should be `'payments.create.order'` so a key spent on `bookings.create` (Phase 2) does not collide — the ledger's unique triple already separates them, but the operation name is what documents the intent.

**Concurrency beyond the key.** `run()` must itself be safe against a double-insert if two requests genuinely race the ledger (e.g. after a prune): insert the `payments` row with the key set, and treat a `23505` on `uniq_payments_idem` as "load the existing row and return it". That is a second line of defence, not a replacement for the ledger.

**Quote the webhook's idempotency separately:** it has no `Idempotency-Key` and no actor. Its idempotency is *state-based* — if `payments.status` is already `success`, do nothing and log a duplicate (§30.1: "Replay the Razorpay webhook → no state change, no duplicate earning, logged as duplicate").

*Confidence: HIGH (all three sources read directly).*

---

## 4. The `payment_pending → paid` transition

**It is legal.** `0011_booking_state_machine.sql:54`:

```sql
when 'paid'                 then array['payment_pending']
```

That is §8.2's table read as "which states may legally become this one". The trigger `enforce_booking_transition` will accept it, and it will write `booking_status_history` in the same statement.

**What to call: a new RPC, not `transition_booking`.**

`transition_booking` (0028) already exists, is `service_role`-only, and already sets `app.transition_actor` / `app.transition_actor_role` / `app.transition_note` transaction-locally. Its signature:

```sql
transition_booking(p_booking_id uuid, p_to public.booking_status, p_actor uuid,
                   p_actor_role public.user_role, p_note text,
                   p_expected_version int, p_window_from timestamptz, p_window_to timestamptz)
```

**But it only writes `bookings.status`.** Using it for the webhook means two PostgREST calls — payment row first, booking second — which is precisely the partial-write failure `0028`'s header documents ("a failure between any two left a booking with a total and nothing behind it"). `create_booking`'s own comment even anticipates this phase: *"Phase 3 adds the payment row to this same function, which is the reason it is a function."*

**Recommendation: `confirm_booking_payment(...)` in `0014_payments.sql`**, modelled on `0028`:

```sql
-- Sets the actor settings itself, then:
--   1. UPDATE payments SET status='success', gateway_payment_id=…, captured_at=now()
--        WHERE id = p_payment_id AND gateway_order_id = p_gateway_order_id
--        AND status IN ('created','pending')           -- replay-guard: second call updates 0 rows
--   2. UPDATE bookings SET status='paid' WHERE id = p_booking_id AND status='payment_pending'
--   Both in one statement-transaction; returns the payment row (or null when nothing moved).
```

`security definer`, `revoke all … from public, anon, authenticated`, `grant execute … to service_role` — the identical grant block `0028` uses at its tail.

**The actor question for an anonymous webhook.** Three facts constrain the answer:

1. `booking_status_history.actor_id uuid references profiles(id)` (`0010:254`) — **nullable**.
2. `public.user_role` (`0001:14`) is `customer | professional | admin | support | ops | super_admin` — **there is no `system` value**, and adding one is an `ALTER TYPE` on a table with a history row behind every row (the exact cost STATE.md warns about).
3. `enforce_booking_transition` falls back to `auth.uid()` when `app.transition_actor` is null, and under the service role `auth.uid()` is null — so passing `''` yields a legitimately null actor, not a wrong one.

**So: `p_actor => null, p_actor_role => null, p_note => 'payment confirmed by webhook (payment.captured, pay_…)'`.** The *note* is the provenance. This is honest — there is no profile to name — and `0011`'s comment already frames null-actor rows as the thing its `app.*` settings exist to fix *when an actor exists*. Where an actor genuinely does not exist, a note naming the event is the right record.

Additionally write `audit_logs` through `audit(supabase, { actorProfileId: null, action: 'payment.webhook', entityType: 'payments', entityId: …, metadata: { event, gatewayPaymentId } })` — `write_audit` accepts a null profile (`audit_logs.actor_profile_id` is nullable, `0024:20`) and `lib/audit.ts` already tolerates a null actor. **Do not log `gateway_signature`** — §12.2 marks it "evidence for disputes; never logged", and `lib/audit.ts`'s `REDACTED_KEYS` does not currently include it.

**Also expected of the same path (flag for the planner):** §12.1's flow puts "matching engine starts" after the hop, but matching is Phase 5 — the webhook's job ends at `payments.status = 'success'` + `bookings.status = 'paid'`.

*Confidence: HIGH.*

---

## 5. RLS on `payments`, `refunds`, `wallets`, `wallet_transactions`

**The house pattern to copy is `0010_bookings.sql:339-392`, verbatim in structure:**

```sql
alter table public.<t> enable row level security;

do $$ begin
  create policy <t>_select_own on public.<t> for select
    using (…);
exception when duplicate_object then null; end $$;   -- idempotent re-run

-- no INSERT/UPDATE policy at all, when the service role is the only writer

revoke all on public.<t> from anon;
grant select on public.<t> to authenticated;
```

(`0010:342` = `bookings_select_own`, `0010:348` = `bookings_insert_own`, `0010:384-390` = the revoke/grant block, `0024:150-190` = the same `do $$` idiom for four policies in a row.)

**What the spec actually requires:** §31.1's exit criterion says only *"RLS on payments"*. §12.4 additionally spells out `wallet_transactions` explicitly — `ENABLE ROW LEVEL SECURITY` + `FOR UPDATE USING (false)` + `FOR DELETE USING (false)`. Nothing more is mandated, so keep the rest minimal and in the house shape.

**Who reads:**

| Table | `authenticated` SELECT | INSERT/UPDATE/DELETE | Rationale |
|---|---|---|---|
| `payments` | `customer_id = current_customer_id()` **OR** `is_staff(['admin','super_admin','ops'])` | none — service role only | §31.1's "RLS on payments"; `is_staff()` already exists (`0001:100`) and is what `audit_read_staff` (`0024:168-169`) uses. |
| `refunds` | same as `payments` (via `customer_id`) | none | The customer must see their own refund status; only ops/admin may request or execute (`lib/roles.ts` grants `refund.request` to support/admin, `refund.execute` to ops/admin/super_admin). |
| `wallets` | `customer_id = current_customer_id()` | none | The balance is a cache; the ledger is the truth. |
| `wallet_transactions` | `exists (select 1 from wallets w where w.id = wallet_id and w.customer_id = current_customer_id())` | **explicit `FOR UPDATE USING (false)` and `FOR DELETE USING (false)`** (§12.4 verbatim), no INSERT policy | Mirror `booking_items_select_own`'s `exists` shape (`0010:367`). |

**Two things to be honest about in the docs, because STATE.md already flags the analogous gap:**

1. **RLS does not protect any server path.** `lib/supabaseServer.ts` uses the service role, which bypasses RLS. So every ownership rule on these four tables must *also* exist as a route-side check (`getPaymentForCaller(...)` mirroring `getBookingForCaller`, `lib/bookingServer.ts:46`). `test/routes.bookings.test.ts`'s header states this as a project invariant: *"a missing `getBookingForCaller` is a real breach rather than a latent one."*
2. **The capability table is UI-enforced for screens** — but as STATE.md records, `requireCapability` *is* server-enforced on three booking routes. `POST /api/refunds` and `POST/GET /api/refunds` must therefore call `requireCapability(req, 'refund.execute')` / `'refund.request'` server-side, not rely on Phase 6's console.

**Anon must get nothing**: `revoke all on public.payments, public.refunds, public.wallets, public.wallet_transactions from anon;` — same as `0010:384`.

*Confidence: HIGH for the pattern and the mechanism; MEDIUM for the exact staff-role list on `payments` SELECT (the spec does not name one — `is_staff(['admin','super_admin','ops'])` is a recommendation, mirroring `audit_read_staff`, and is worth confirming with the user if Phase 6 needs `support` to see payments).*

---

## 6. Wallet ledger safety — **amend, do not ship verbatim**

§12.4's function, checked against §24.9's schema it has to run against:

```sql
CREATE TABLE wallet_transactions (
  …
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  balance_after numeric(12,2) NOT NULL,          -- ← NOT NULL
  ref_type text NOT NULL, ref_id text, description text NOT NULL, …
);
CREATE TABLE wallets ( … balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0), … );
```

### Finding 1 — verbatim fails: `balance_after` is never written

§12.4's `INSERT INTO wallet_transactions (wallet_id, type, amount, ref_type, ref_id, description) VALUES (…)` supplies six columns. `balance_after` is `NOT NULL` and is **not** among them, and the table has no default. **The verbatim function raises `not-null violation` on its very first call.** This is a genuine defect in the specification, not a reading ambiguity.

**Amendment A — write `balance_after`.** Since the value only exists *after* the balance update, reorder:

```sql
select balance into v_cur from public.wallets where id = p_wallet for update;
v_new := v_cur + case when p_type = 'credit' then p_amount else -p_amount end;
if v_new < 0 then
  raise exception 'WALLET_OVERDRAFT wallet=% delta=% balance=%', p_wallet, p_amount, v_cur
    using errcode = 'check_violation';          -- 23514, same code the constraint gives
end if;
update public.wallets set balance = v_new, updated_at = now() where id = p_wallet;
insert into public.wallet_transactions (wallet_id, type, amount, balance_after, ref_type, ref_id, description)
values (p_wallet, p_type, p_amount, v_new, split_part(p_ref,':',1), split_part(p_ref,':',2), p_desc);
return v_new;
```

Both writes are in the caller's transaction, so the `RAISE` rolls back both — the ledger and the cache can never disagree.

### Finding 2 — `CHECK (balance >= 0)` and the `RAISE` do duplicate each other, and the `RAISE` loses

In §12.4's ordering, `UPDATE wallets SET balance = balance + (-p_amount)` evaluates to a negative value and Postgres enforces the **non-deferred** `CHECK (balance >= 0)` at the end of the statement — raising `23514 check_violation` *before* control ever reaches `IF v_new < 0`. So:

- `WALLET_OVERDRAFT` as written is **unreachable** for an overdraft.
- The caller gets an anonymous constraint violation instead of a named, loggable error.

**Amendment B — the pre-check above makes `WALLET_OVERDRAFT` reachable again** (and `using errcode = 'check_violation'` keeps the SQLSTATE identical to the constraint's, so no existing `check_violation` handling is surprised). Keep the `CHECK` — it is the backstop for any future path that writes `wallets` without going through the function, and STATE.md's whole philosophy ("the database half is the one that matters") says a redundant constraint that fires first is a feature, not a bug.

### Finding 3 — the race you asked about: **the spec's arithmetic is already safe**

`UPDATE wallets SET balance = balance + X` is a *single* statement. Postgres takes the row lock for the duration and evaluates `balance + X` against the locked current value, so two concurrent credits serialise: 0→100 then 100→200. **There is no lost update and no `FOR UPDATE` needed for correctness of the spec's form.** The classic lost-update only appears if application code reads `balance` into a variable and writes it back.

`FOR UPDATE` in Amendment A is needed for a *different* reason: the amended function pre-reads to produce a good error message, and read-then-write **is** the lost-update pattern unless the read locks the row. So: `FOR UPDATE` is required by the amendment, not by the original.

### How to flag it

Both amendments go in `0015_refunds_wallet.sql`'s header comment, in the voice `0011` and `0028` already use — state what the spec says, what is wrong, and why the departure is correctness rather than preference. Example wording:

> §12.4's `apply_wallet_delta` is reproduced with two amendments.
> **(1)** `balance_after` is written because §24.9 declares it `NOT NULL` and §12.4's
> INSERT omits it — the specification's function does not run against the
> specification's schema. **(2)** the balance is read under `FOR UPDATE` and checked
> before the write, because §12.4's `RAISE WALLET_OVERDRAFT` is unreachable behind
> its own `CHECK (balance >= 0)`, which fires first.

**Also note for the planner:** `wallet_transactions.amount CHECK (amount > 0)` plus `type credit|debit` means **`p_amount` must be strictly positive** — a debit is expressed by `type`, never by a negative `p_amount`. And `wallets` needs `updated_at` maintained if the column exists in §24.9 (it does).

*Confidence: HIGH — this is arithmetic on two documents read directly, not external knowledge.*

---

## 7. Testing strategy

**Constraint from CONTEXT decision 1:** no live `RAZORPAY_WEBHOOK_SECRET` (`.env.local` value is a placeholder), so the suite proves the *algorithm* with synthetic vectors computed in the test, and the *authority* through the route with an injected signature. Live end-to-end is a documented manual step in `docs/SETUP.md`.

**Constraint from decision 4:** no network in the suite. The gateway client takes an injectable `fetch`.

**Environment note:** `vitest.config.ts` inlines `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL` into `test.env` — **no `RAZORPAY_*` keys**. The webhook route must therefore read the secret **at request time** (which the runtime guard needs anyway), and tests supply it with `vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'test-webhook-secret')` rather than adding a repo-wide placeholder to `vitest.config.ts`.

### The files that should exist

| File | Proves |
|---|---|
| `test/razorpaySignature.test.ts` | The verifier's algorithm, with vectors **computed in the test** from a synthetic secret: valid signature accepted; tampered body rejected; wrong secret rejected; missing header rejected; non-hex / wrong-length signature rejected (no `timingSafeEqual` throw escaping as a 500). No HTTP frame, no Supabase, no real secret — exactly decision 1's shape. |
| `test/gatewayClient.test.ts` | The transport with a stubbed `fetch`: `orders.create` sends integer paise and `currency: 'INR'`; Basic auth header built from key id + secret; a non-2xx Razorpay error body surfaces as `PAYMENT_FAILED`; `fetchOrder`/`createRefund` parse the recorded response. Asserts the URL and body — the stub *is* the assertion. |
| `test/routes.payments.test.ts` | `POST /api/payments/create-order`: requires `Idempotency-Key` (`required: true`), re-prices and refuses a total that disagrees (`PRICE_CHANGED`), consumes/validates `quoteToken`, writes one `payments` row with the server's own amount, is a no-op on replay. `POST /api/payments/verify`: **never writes `success`** — a valid `razorpay_signature` changes nothing on its own (the hard rule). `GET /api/payments/:id`: ownership refused for another customer's row. |
| `test/routes.webhook.test.ts` | The authority path: raw body is read before any parse (assert a body whose *bytes* differ from its re-serialised JSON still verifies, and that a re-serialised body does **not**); bad signature → 400 and **zero** writes; good signature → one RPC (`confirm_booking_payment`) with the right args; replay of an already-`success` payment → no state change, duplicate logged; amount/currency/`gateway_order_id` mismatch → rejected with no write; missing/placeholder secret → the clear guard error, not a 500. |
| `test/routes.refunds.test.ts` | `requireCapability('refund.execute')` refuses a customer; a manual refund above the limit is refused without an approval row; auto-refund paths need no approver; `refunds` insert shape and `route` selection (`gateway`/`wallet`). |
| `test/routes.cron.test.ts` | The `CRON_SECRET` guard accepts bearer / `x-cron-secret` / `?secret=`, rejects a wrong value with 401, and rejects an **unset** secret (fail-closed — see Risks). Plus the reconciliation resolution mapping (item 8) against a stubbed gateway client. |
| `test/db.payments.test.ts` *(live, `npm run test:db`)* | §29.3 RLS isolation: customer A cannot select customer B's `payments`, `refunds`, `wallets`, `wallet_transactions` through the anon/authenticated client; `wallet_transactions` UPDATE and DELETE are refused outright (§12.4); anon sees nothing. This is the file that actually discharges "RLS on payments". |
| `test/db.wallet.test.ts` *(live)* | `apply_wallet_delta` against real Postgres: credit then debit; `balance_after` recorded correctly; overdraft raises `WALLET_OVERDRAFT` (23514) **and** leaves no `wallet_transactions` row behind (proving the rollback); two concurrent credits land as the exact sum. |

Everything except the two `db.*` files runs offline, preserving the current 555-test/67-live split. Route tests mock `@/lib/supabaseServer` with `FakeSupabase` exactly as `test/routes.bookings.test.ts:47` does.

**One test is non-negotiable per CONTEXT's "Specific Ideas":** *the client-side Razorpay success handler never mutates a booking* — a test that calls `POST /api/payments/verify` with a correct signature and asserts `bookings.status` and `payments.status` are both unchanged.

*Confidence: HIGH for the file list and what each proves; the exact assertion wording is a planner decision.*

---

## 8. Reconciliation cron

**Spec:** §25.11 — `/api/cron/reconcile-payments`, `*/30 * * * *`, *"Compare `payment_pending` older than 10 min against the gateway; resolve stragglers."* Recorded in `docs/ARCHITECTURE.md:553` as Phase 3's cron, and `vercel.json` is currently `{}` (the eight phantom crons were removed by task 261006-01). **Add only this one back.**

### The guard

Copy `smartpos-main/app/api/cron/promotion-campaigns/route.ts:27-38` exactly — it is what §25.11 calls "the exact SmartPOS guard":

```ts
const cronSecret = process.env.CRON_SECRET;
if (cronSecret) {
  const auth =
    req.headers.get('authorization')?.replace('Bearer ', '') ||
    req.headers.get('x-cron-secret') ||
    req.nextUrl.searchParams.get('secret') || '';
  if (auth !== cronSecret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

Three channels, in that precedence. One deviation worth making — see Risks: SmartPOS skips the check entirely when `CRON_SECRET` is unset.

### What "compare" means

Scope: rows where `bookings.status = 'payment_pending'` **and** the related `payments` row is `created`/`pending` **and** `payments.created_at < now() - interval '10 minutes'` (`idx_payments_status` on `(status, created_at)` serves this directly). Then, per row, one call through the injectable gateway client: `GET /v1/orders/{gateway_order_id}`.

### The three legal outcomes (plus one non-outcome)

| Gateway answer | Resolution | Writes |
|---|---|---|
| `order.status = 'paid'` (and/or a `payment` entity with `status: 'captured'`) | **success** | call the *same* `confirm_booking_payment` RPC the webhook uses — one writer, no second code path: `payments.status='success'`, `gateway_payment_id`, `captured_at`, booking `payment_pending → paid`. Audit action `payment.reconciled`. |
| a payment exists with `status: 'failed'` / order `expired` | **failed** | `payments.status='failed'`, `failure_reason`. The **booking stays `payment_pending`** — nothing in §12.1 or §25.11 authorises cancelling it here, and cancellation with its fee/refund ladder is a different decision (see Risks). |
| still `created`, nothing charged, inside its own window | **still pending** | no state change. Count it and return `{ resolved: n, failed: m, stillPending: k }`. |
| *(non-outcome)* gateway unreachable / 5xx / rate-limited | — | **no state change**, count as `unreachable`, raise the alert. A reconciliation pass that wrote rows on a failed API call would be worse than no cron. |

**Alerting** for `stillPending` beyond a second threshold and for `unreachable`: an `audit_logs` row via `audit()` (`action: 'payment.reconcile.alert'`, `metadata: { count, oldest }`) plus a `console.warn` with the request id — `lib/audit.ts` is already the house's "make it loud" channel and `write_audit` tolerates a null actor. Phase 6's dashboard reads it; nothing exists yet to *notify* on, and inventing an notification channel is out of scope.

**Key design point:** reconciliation must not be a second implementation of "payment succeeded". The webhook, `POST /api/payments/verify` (UX only) and the cron all funnel into one `confirm_booking_payment` RPC with different audit notes. Three writers with three behaviours is how a booking ends up `paid` while its payment says `pending`.

**In tests, "compare against the gateway" is fully deterministic:** `fetch` is stubbed per row, so the test asserts the *mapping* — a stubbed `paid` order produces exactly the RPC call with the right args; a stubbed `created` order produces zero writes and a non-zero `stillPending` count; a rejected `fetch` produces zero writes and `unreachable: 1`.

*Confidence: HIGH for the outcome table (derived from §12.1's lifecycle + §25.11's wording); MEDIUM for the "booking stays `payment_pending` on failure" reading — the spec does not say what happens to the booking, which is why it is listed under Risks.*

---

## Risks and unknowns

1. **The spec says SHA-512; Razorpay signs with SHA-256.** *(Resolved in favour of SHA-256 — flagged because it contradicts the specification text, and the planner should record that contradiction rather than silently "fixing" it.)* Official docs: https://razorpay.com/docs/webhooks/validate-test. Confidence: HIGH. Risk if treated as `ASSUMED`: a SHA-512 verifier passes every synthetic test and **fails every real delivery**, so the exit criterion "the webhook is the sole authority" would be false in production while the suite stays green.

2. **§12.4's `apply_wallet_delta` does not run against §24.9's schema** (`balance_after` NOT NULL, never supplied). *(Resolved — Amendment A.)* Flag in the `0015` header. Risk if shipped verbatim: every wallet credit raises `not-null violation`.

3. **`WALLET_OVERDRAFT` is unreachable behind the spec's own `CHECK`.** *(Resolved — Amendment B.)* Same header flag.

4. **What happens to a booking whose payment fails or is abandoned?** §12.1 draws "user closes checkout → status = failed (reason: abandoned)" on the *payment*, and says nothing about the booking. The booking then sits in `payment_pending` forever unless something cancels it. This phase should **mark the payment failed and leave the booking** (no cancellation authority in §31.1's Phase 3 row), and record the open question — the planner must state the decision explicitly, exactly as CONTEXT demands of the `quoteToken` decision. Confidence that "leave it" is the conservative reading: MEDIUM.

5. **`quoteToken` consumption — the decision CONTEXT says must be stated, not silently dropped.** Three coherent options: consume at `create-order` (assert the booking's `quote_token` matches the request), re-check at webhook (no — the token has a 15-minute TTL and a legitimate webhook can arrive later), or declare it a Phase 4 concern. **Recommendation: consume at `create-order`** — the create route already verified it (Phase 2), so `create-order` should assert `booking.quote_token` is present and non-null before creating an order, and null it out after the webhook lands (single-use). This is a *plan-level* decision, not a research fact; flagged here so it cannot be skipped. Confidence: MEDIUM.

6. **`CRON_SECRET` unset ⇒ SmartPOS's guard is a no-op.** `if (cronSecret) { … }` means an unset secret disables the check rather than failing closed. The spec asks for "the exact SmartPOS guard", so the three-channel read should be copied exactly; but since SmartHelp has **no cron route today** and `vercel.json` is `{}`, there is no existing behaviour to preserve — so returning 503 when `CRON_SECRET` is absent is a strengthening, not a change. **Recommend: mirror the three channels, fail closed when unset.** Marked as a deliberate amendment for the planner to confirm. Confidence that SmartPOS behaves as described: HIGH (file read).

7. **Who may read `payments`/`refunds` besides the owner.** The spec does not name the staff set for these tables. Recommended `is_staff(['admin','super_admin','ops'])` mirroring `audit_read_staff` (`0024:168-169`) — but `support` holds `refund.request` in `lib/roles.ts`, so a support agent who can *request* a refund may not be able to *see* it. Worth one line in the plan; not resolvable from the documents. Confidence: LOW on the right answer, HIGH that the ambiguity exists.

8. **Partially-paid orders.** Razorpay's order states include `partially_paid`. Nothing in §12.1–12.5 addresses it, and `payment_status` has no `partially_paid` value. Recommendation: treat `partially_paid` as **still pending** (the fourth row of the outcome table) and let the reconciliation cron keep watching. Confidence that the spec is silent: HIGH (read §12.1–12.5 and §24.9).

9. **`gateway_signature` must not be logged.** §12.2 marks it "never logged"; `lib/audit.ts`'s `REDACTED_KEYS` does **not** include it, so a careless `after: payment` audit row would leak it. The plan should either add `gateway_signature` to `REDACTED_KEYS` or pass an explicit allow-list to `audit()`. Small, cheap, and exactly the kind of thing this codebase's audit docstring warns about. Confidence: HIGH that the redaction list lacks it (file read).

10. **What I could not resolve:** whether `POST /api/wallet/topup` (§25.8, Phase 8 per §31.1 but listed among this phase's endpoints) belongs in Wave B. §31.1 puts "wallet top-up" in Phase 8's row; §25.8 lists the endpoint without a phase. Recommendation: **out of scope**, cite §31.1. Confidence: MEDIUM.

---

**Sources.** Primary: `03-CONTEXT.md`; `0010_bookings.sql`, `0011_booking_state_machine.sql`, `0024_audit_idempotency.sql`, `0028_booking_write_paths.sql`; `lib/api.ts`, `lib/idempotency.ts`, `lib/money.ts`, `lib/audit.ts`, `lib/validation.ts`, `lib/supabaseServer.ts`, `lib/roles.ts`, `lib/quoteToken.ts`; `test/helpers/fakeSupabase.ts`, `test/helpers/dbEnv.ts`, `vitest.config.ts`, `test/routes.bookings.test.ts`; `smartpos-main/app/api/{create-order,webhooks/razorpay,cron/promotion-campaigns,subscription/create}/route.ts`; `docs/ARCHITECTURE.md:547-565`, `docs/DATABASE.md`, `docs/API.md`. Spec: `SmartHelp-Documentation.docx` §7.2, §12.1–12.5, §24.9, §25.8, §25.11, §29.2, §30.1, §31.1. External: razorpay.com/docs/webhooks/validate-test, razorpay.com/docs/developer-tools/integrations/standard-checkout (both fetched this session).
