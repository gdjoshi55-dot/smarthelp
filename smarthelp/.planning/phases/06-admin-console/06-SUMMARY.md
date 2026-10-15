---
phase: 06-admin-console
type: summary
date: 2026-10-14
status: complete
spec: §3.1/§19.3, §20.11–20.13, §20.14, §22, §24, §31.1 Phase 6
---

# Phase 6 — Admin console: summary

**Complete as of 2026-10-14.** Migrations `0033`–`0037` built and applied to the live
project (34 files, **35 applied, 0 outstanding**), the console surface landed, and
§31.1's exit criterion — *ops can run the marketplace without a database console* — is
hand-checked. The suite is **954 tests across 61 files** (the floor when the phase
began: 824 / 50), `npm run test:db` is green across all nine live files (**104
tests**, floor 99 / 8), and typecheck, lint and build exit 0.

## The migrations

Phase 6 is the first phase since Phase 2 to think about the schema as one thing. Five
migrations:

- **`0033_platform_settings.sql`** (D2). `platform_settings(key text primary key,
  value jsonb not null, updated_by uuid, updated_at)`, seeded with the current
  `PLATFORM_DEFAULTS` (`on conflict do nothing`, so a re-run never clobbers an
  operator's edit). Staff read / admin write RLS, and an UPDATE trigger stamping
  `updated_by`/`updated_at`. The values the app already read from `lib/constants.ts`
  (`instantLeadMinutes`, `taxRate`, `commissionPct`, `platformFee`,
  `supportRefundLimit`, `offerTtlMinutes`, …) migrate to rows with the same defaults,
  so nothing changes until an admin edits one.
- **`0034_admin_write_paths.sql`** (D4). `admin_cancel_booking` and
  `admin_assign_booking`, both `security definer`, service-role-only, both taking the
  same `assign:<booking_id>` advisory lock Phase 5 installed. Cancel reuses the §11.1
  fee math from `lib/cancellation.ts` (the fee is passed in, so the ladder stays in
  one place) and frees the professional's reserved window in the same statement.
  Assign is the manual counterpart to the matcher: it validates the state, withdraws
  the holder, and raises an **ordinary `offered`** assignment a professional still has
  to accept — it does not forge an acceptance.
- **`0035_pricing_policies.sql`** (D1/§7.1/§11.1). `pricing_rules` (the surge-window
  table) and `cancellation_policies` (the §11.1 ladder as rows, backfilled from the
  previous constant, keyed by band **ceiling** so the console and `quoteCancellation`
  cannot disagree).
- **`0036_broadcast_matching.sql`.** *Not in the plan* (see Deviations). It drops
  `uniq_active_assignment_per_booking`, adds `uniq_accepted_assignment_per_booking`
  (unique on `booking_id` `where status = 'accepted'`), and re-creates `match_booking`
  / `accept_offer` to offer to the whole ranked candidate list and withdraw the other
  live offers when one is accepted. This reverses Phase 5's D1.
- **`0037_support_disputes.sql`.** `support_tickets`, `support_messages` and
  `disputes`, with the standard staff-read / staff-write split. This is the content
  `0000` forward-referenced as `0019_support.sql`; renumbered because the ledger
  applies in filename order.

## The surface

- **`lib/adminServer.ts`** — the staff read model (bookings, professionals, KYC,
  dashboard KPIs in `Asia/Kolkata`, refunds, services, coupons, disputes, support,
  audit). Reads run on the service-role client behind an explicit role check (D3); a
  cross-tenant or unknown id is a **404 with zero writes**.
- **`lib/settingsServer.ts`** — the one typed reader/writer for `platform_settings`
  (D2). `loadPricingSettings()` in `lib/bookingQuote.ts` and the assign route both
  read it, so an edited setting actually changes a quote.
- **~33 Route Handlers under `app/api/admin/**`** — dashboard, bookings
  (list/detail/cancel/assign), professionals (roster/detail/KYC review/bulk
  verdict/suspend), refunds (+ execute), services/areas/durations, pricing rules,
  cancellation policies, coupons, disputes, support, settings, audit, localities.
- **The `/admin` shell** — `app/admin/layout.tsx` renders the sidebar from
  `ROLE_SECTIONS` in `lib/roles.ts`, so a screen cannot appear for a role the server
  would then refuse. `components/admin/{DataTable,StatCard,Funnel,AlertList}.tsx` are
  authored on the existing shadcn/Radix + `recharts` primitives (D5).
- **`requireCapability()` is now live** on every mutating route — the admin writes
  *and* the customer/refund paths. Reads are gated by the staff allow-list
  `['admin','ops','support','super_admin']`; two narrow it deliberately (raw KYC
  documents exclude `support`; the audit viewer needs `audit.read`, admin/super_admin).

## The gates

| Gate | Result |
|---|---|
| Migration gate | `0033`–`0037` applied to the live project — 34 files, **35 applied, 0 outstanding** |
| Exit criterion — ops run the marketplace without a database console | **hand-checked**: an ops account cancels a booking, verifies a professional, executes a refund, and edits a price and a setting from the UI |
| Tier-4 chain | typecheck / lint / build exit 0 → `npm test` **954 / 61 files, 0 failed** (floor 824 / 50) → `test:db` **104 / 9 files** (floor 99 / 8) → no code commits |
| Floors | Phase 5 landed at 824 / 99; Phase 6 lands at **954 / 104** — 130 full-suite and 5 db tests above it |

## The decisions, with reasons

Stated in full in `06-PLAN.md` (D1–D5).

- **D1 — API-first for sections whose UI is a later phase.** The console is the
  Route Handlers + the UI ops actually needs today; **notifications** (the Phase 7
  dispatcher) and **analytics reports** beyond the dashboard KPIs ship as API-only or
  not at all. This keeps Phase 6 to §31.1's real bar.
- **D2 — `platform_settings` is a typed key/value table read through one helper.**
  A new rule is a seed write, not a migration; the typing lives in
  `lib/settingsServer.ts`, so no call site sees raw `jsonb`.
- **D3 — staff reads run on the service role behind a role check; no new RLS.** The
  console does not add broad staff RLS to every table — it uses the service-role
  client and re-checks the role and intent itself. The Phase 4 rule, applied to staff.
- **D4 — every admin write audits; the refund path is reused.** Each mutating
  endpoint calls `audit(...)` with `before`/`after`. Refund execution reuses
  `refundCapturedBooking` — one money path — plus the §22 dual-approval rule: above
  `supportRefundLimit`, a refund whose requester is also the executor is refused with
  `SECOND_APPROVER_REQUIRED` (422).
- **D5 — no new packages.** `DataTable`/`StatCard` are authored on existing
  primitives; `vercel.json` is untouched (no cron in Phase 6).

## Deviations, with reasons

- **A sixth change — `0036_broadcast_matching.sql` — arrived during the phase and was
  not in the plan.** The product decision was made to offer a booking to the whole
  ranked candidate list at once rather than one candidate per round. It reverses
  Phase 5's D1 (round-based fan-out), moving the double-assign guarantee from
  `uniq_active_assignment_per_booking` to `uniq_accepted_assignment_per_booking`. The
  Phase 5 docs (FEATURES §7.2, API §4.7, DATABASE §11) were reconciled to match.
- **Support/disputes landed as `0037`, not `0019_support.sql`.** The plan named the
  `0000` forward-reference; the file is numbered `0037` because the ledger applies in
  filename order.
- **`requireCapability()` was implemented, contrary to the plan's note that no such
  helper existed.** It is the cleanest way to keep the capability table the single
  source of truth for writes, so the plan's "each route names its own allow-list" was
  superseded. `requireStaff`/`requireAdmin` were removed.
- **`0035`'s comment points at `lib/pricingServer.ts`, which does not exist.** The
  resolver is `resolveSurgeMultiplier` in `lib/policyServer.ts`. It is built and
  tested but **not yet applied** by `buildQuote`/`priceQuote` — the `pricing_rules`
  editor works, the quote path does not multiply by a surge factor yet.
- **No source, test, migration or config file was committed by this phase.** The code
  working tree remains uncommitted for the branch owner.

## Deferred (recorded, not forgotten)

| Deferred | Why | Lands in |
|---|---|---|
| Notification templates + dispatcher | Needs the Phase 7 transport | Phase 7 |
| Analytics report pages (beyond dashboard KPIs) | Belongs with the reporting phase | Phase 7/8 |
| Payout run UI (`/admin/payouts/run`) | `payouts` table is Phase 8 | Phase 8 |
| Chat export from the booking detail | Needs the Phase 7 chat tables | Phase 7 |
| Surge actually applied in the quote path | Editor built; the multiplier is unwired | later wave |
| Native admin mobile layout | §20.14 is desktop-only by decision | — (out of scope) |
| Instant-booking admin knobs | v2.0 | Phase 10 |

## Deliberately out of scope

The notification dispatcher and analytics reports (Phase 7), payouts (Phase 8),
surge application, and any role-management endpoint — still no route writes
`profiles.role`, so the `guard_profile_privileges()` gap in `README.md` remains open.
**No refund UI outside the console, no new cron, no new package.**
