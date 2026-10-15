# Phase 8 — Growth · Plan

**Status:** in progress (Wave A complete).
**Exit criteria (§31.1):** *recurring generates idempotently; surge is capped; the
PWA installs.*
**Spec:** §6.3 (recurring booking), §7.1/§7.4 (pricing formula and surge),
§25.4 (wallet redeem), §25.8 (wallet top-up), §25.9 (favourites), §24
(referrals/recurring/invoices DDL sketches), §20.6 (invoice panel), §31.1
(Phase 8).

## What is already in place

- `pricing_rules` (`0035`) and the pure `resolveSurgeMultiplier` in
  `lib/policyServer.ts` (with `listPricingRules` and the console CRUD). The
  resolver was written in Phase 6 but **never called by the engine** — the surge
  gap.
- `platform_settings` (`0033`) and its typed reader `lib/settingsServer.ts`.
- The wallet ledger: `wallets`, `wallet_transactions`, `apply_wallet_delta()`,
  and `lib/walletServer.ts` (credit/debit write-side). `GET /api/wallet` and now
  `POST /api/wallet/redeem`.
- `favourites` (`0042`), the `/api/favourites` endpoints, the favourites page and
  the catalogue `FavouriteButton` — the §25.9 slice, complete.
- A JSON receipt at `GET /api/bookings/[id]/invoice` (reads the frozen booking
  money columns; no `invoices` table, no PDF).
- `customers.referral_code` exists; `referrals`, `recurring_series`,
  `recurring_occurrences`, `invoices` do **not**.

## Waves

| Wave | Scope | Exit signal | Status |
|---|---|---|---|
| **A** | Surge pricing: wire `resolveSurgeMultiplier` into the quote engine, clamp, itemise, snapshot | a windowed rule raises the quote and is capped | **done** |
| **B** | Wallet redeem + v1 ops top-up | spend balance (checkout) and grant credit (ops) | **done** |
| **C** | Favourites | save/unsave a service and a professional | **done** (`0042`) |
| **D** | Referrals: `referrals` table, validate at signup, reward both sides | a code pays out once, idempotently | pending |
| **E** | Recurring: `recurring_series` / `recurring_occurrences`, `/api/cron/recurring-generate` | a series materialises occurrences idempotently | pending |
| **F** | Invoices: `invoices` table, PDF render of the frozen receipt | a downloadable invoice per booking | receipt JSON exists; PDF pending |
| **G** | PWA: manifest + service worker | the app installs | pending |

## Decisions

### D1 — Surge scales the subtotal, itemised as its own line (confidence: HIGH)

§7.1 states `subtotal = SUM(line_total) x (multiplier rules)` and its own
illustrative JSON is arithmetically inconsistent with that (it shows a 1.10
multiplier of 50 on a 500 subtotal but then computes tax on the un-surged 500).
The **formula is normative**, so the engine scales the subtotal by each factor —
and because §7.1 computes the platform fee and tax on the subtotal, a surge
raises all three together. That is the only reading under which surge changes
the price, which is its stated purpose. The multiplier is applied *after* the
lines are summed and *before* the fee, and appears as its own `multipliers[]`
entry (`code`, `factor`, `amount`) plus a `multiplier` snapshot rule, so the
customer's receipt can itemise it exactly as §7.4 requires. A factor of 1 is not
itemised: "no surge" is the absence of a line.

### D2 — Clamped twice, and the engine is the last line of defence (confidence: HIGH)

§7.4 clamps a surge factor to the absolute `[0.50, 2.00]`. A new
`platform_settings` key `surgeMaxFactor` (default **1.50**) tightens the ceiling
further; `resolveBookingMultipliers` clamps to
`[0.50, min(2.00, surgeMaxFactor)]` before handing the factor to the engine, and
`priceQuote` re-checks the absolute bounds itself and throws `RangeError`
otherwise. A mistyped rule cannot double a bill on its way through either layer.

### D3 — Surge is resolved at the scheduled wall clock, in the platform zone
(confidence: HIGH)

A surge window is a business-hours statement, so the rule is matched against the
**local** day-of-week and minute-of-day of the booking's scheduled start (or
"now" for an instant booking) in `DEFAULT_TIMEZONE`. `buildQuote` gains an
optional `scheduledAt`; `POST /api/bookings/quote` accepts it and
`POST /api/bookings` passes `scheduledStartAt`. A multi-service booking takes the
highest factor any of its services earns — surge is a property of the moment.

### D4 — An empty `pricing_rules` table changes nothing (confidence: HIGH)

`resolveBookingMultipliers` returns `[]` with no rules, and `priceQuote` applies
and itemises nothing for a factor of 1. Every existing quote — and every
existing test — is byte-for-byte unchanged until a rule is authored. The engine
version bumps to 3 so a snapshot records which engine priced it.

### D5 — Wallet redeem is real; wallet top-up is v1 ops/promo credit only
(confidence: HIGH)

§2 lists in-app card top-up as an explicit **non-goal for this version** ("the
wallet is refund / promo / referral / compensation credit only"), and §25.8
annotates the endpoint the same way. So Wave B builds no gateway flow:

- `POST /api/wallet/redeem` (`app/api/wallet/route.ts`) spends balance — a
  `debit` through `apply_wallet_delta`, 409 `wallet_overdraft` on insufficient
  funds. §25.4 calls this "spend wallet balance at checkout"; wiring it into the
  checkout/payment flow (a partial payment) is **deferred** — it is a booking
  money-path change, larger than this wave, and no screen consumes it yet.
- `POST /api/wallet/topup` (`app/api/wallet/topup/route.ts`) is the ops lever:
  a staff member holding the new **`wallet.credit`** capability (granted to
  `ops`, `admin`, and `super_admin` via `'*'`) grants a figure to a named
  customer. The write goes through `creditWallet` — the one ledger path — and is
  audited. Customer-facing top-up stays postponed.

There is therefore no customer UI for top-up; the wallet page continues to show
the balance, the ledger and refunds.

## Wave A — as built

- `lib/pricing.ts`: `MultiplierInput` / `AppliedMultiplier`, `SURGE_MIN_FACTOR`
  (0.5) / `SURGE_MAX_FACTOR` (2.0), `PriceQuoteInput.multipliers`,
  `PricingBreakdown.multipliers`, a `multiplier` snapshot rule,
  `snapshot.totals.rawSubtotal`, `PRICING_ENGINE_VERSION = 3`.
- `lib/bookingQuote.ts`: `BookingQuoteRequest.scheduledAt`, the exported pure
  `localWallClock(at)`, and `resolveBookingMultipliers(request, servicesById,
  surgeMaxFactor)` which reads `listPricingRules` and resolves the highest
  factor. `loadPricingSettings()` also returns `surgeMaxFactor`.
- `lib/constants.ts` + `lib/settingsServer.ts`: the `surgeMaxFactor` key.
- `supabase/migrations/0043_surge_max_factor.sql`: seeds the row (idempotent).
- Routes: `/api/bookings/quote` accepts `scheduledAt`; `/api/bookings` passes
  `scheduledStartAt`.
- Tests: `test/pricing.test.ts` (+6 surge cases), `test/surge.test.ts` (new:
  the resolver's specificity/tie/window/wrap/validity logic and `localWallClock`
  in `Asia/Kolkata`); `test/db.admin.test.ts` updated 22 → 23 settings.

**Gates:** typecheck/lint/build exit 0; `npm test` **1046/68** (was 1030/67;
+1 file, +16 tests); `npm run test:db` unchanged at **117/10** (the settings
count assertion moves 22 → 23 but the test count does not). Migration `0043`
applied live (40 files, 40 applied).
