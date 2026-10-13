# Phase 6 — Admin console · Plan

**Status:** planned.
**Exit criterion (§31.1):** *ops can run the marketplace without a database console.*
**Spec:** §3.1/§19.3 (roles & capabilities), §20.11–20.13 (admin screens),
§22 (API surface: `/api/admin/**`), §24 (schema), §31.1 Phase 6 scope.

## What is already in place

Phase 6 is almost entirely unbuilt. What exists:

- `/admin` — a **placeholder** (`app/admin/page.tsx`) that renders each staff role's
  `ROLE_SECTIONS` as a "Permission granted / Later" table and a local-only
  marketplace toggle. It reads the real auth context and is already wrapped in
  `AuthGuard role={['admin','ops','support','super_admin']}` + `RoleShell`.
- `lib/roles.ts` — the capability table (`booking.read.all`, `booking.assign`,
  `refund.execute`, `kyc.review`, `pro.verify`, `pro.suspend`, `service.manage`,
  `pricing.manage`, `coupon.manage`, `dispute.resolve`, `analytics.all`,
  `audit.read`, `role.manage`, …) and `ROLE_SECTIONS` — the exact sidebar the spec
  describes. The console renders from this table; it is not to be second-guessed.
- **One admin endpoint**, from Phase 4 D2: `POST
  /api/admin/professionals/:id/kyc/:docId/decision` (`kyc_document_decision`),
  which the review queue will drive.
- Every table the console reads already exists: `bookings`,
  `booking_status_history`, `booking_assignments`, `professionals`,
  `professional_documents`, `payments`, `refunds`, `wallets`,
  `wallet_transactions`, `coupons`, `coupon_usage`, `audit_logs`,
  `professional_earnings`.
- The staff guard pattern: `requireAuth(req, STAFF_ROLES)` (there is **no**
  `requireStaff`/`requireCapability` helper — those are dead exports; a route names
  its own allow-list).
- `lib/api.ts` (`handle`, `ok`, `created`, `ApiHttpError`), `lib/audit.ts`
  (`audit`, `clientIp`), `lib/refundServer.ts` (`refundCapturedBooking`),
  `lib/money.ts`.

What is missing is the console itself, `platform_settings`, `pricing_rules`,
`cancellation_policies`, and the staff read/write endpoints.

## Decisions

### D1 — API-first for sections whose UI is a later phase (confidence: HIGH)

The console is built as **staff-guarded Route Handlers + the UI that ops needs to
run the business today**. Sections whose *surface* belongs to a later phase ship
as API-only (the Phase 3 precedent): **notifications** (§20, Phase 7's dispatcher)
and **analytics reports** beyond the dashboard KPIs (Phase 7/8). This keeps Phase 6
to §31.1's actual bar — "run the marketplace **without a database console**" —
rather than reproducing every spec screen.

### D2 — `platform_settings` is a typed key/value table, read through one helper (confidence: HIGH)

`platform_settings` lands here (it is the ROADMAP's named Phase 6 deliverable).
Shape: `(key text primary key, value jsonb not null, updated_by uuid, updated_at)`.
A **typed accessor** in `lib/settingsServer.ts` reads a key with a default and a
parse, so `PLATFORM_DEFAULTS` stays the fallback and no call site sees raw `jsonb`.
The values the app already reads from `lib/constants.ts` (`instantLeadMinutes`,
`taxRate`, `commissionPct`, `platformFee`, `supportRefundLimit`, …) migrate to rows
with the same defaults, so nothing changes until an admin edits one.

### D3 — Staff reads run on the service role behind a role check; no new RLS (confidence: HIGH)

RLS is forced on every `public` table; staff policies already exist for
`bookings`, `payments`, `refunds`, `audit_logs`, `professional_documents` (staff
read). The console does **not** add broad staff RLS to every table — like every
other Route Handler, it uses the service-role client and re-checks the role and
(in writes) ownership/intent itself. A cross-tenant id is a 404 with zero writes,
never a 403 that confirms existence. This is the Phase 4 rule, applied to staff.

### D4 — Every admin write audits, and destructive writes require typed confirmation (confidence: HIGH)

§20.12: "Every action writes an `audit_logs` row and requires a typed confirmation
for destructive operations." So each mutating endpoint calls `audit(...)` with
`before`/`after`, and the destructive UI (cancel, force-refund, suspend) takes a
typed confirmation string. Refund execution reuses `refundCapturedBooking` — one
money path, already tested — rather than a second refund implementation.

### D5 — No new packages; DataTable/StatCard are authored (confidence: HIGH)

The spec lists `components/admin/DataTable.tsx` and `StatCard.tsx` as
to-author. They are built here on the existing shadcn/Radix primitives and
`recharts` (already a dependency). No new npm packages, `vercel.json` untouched
(Phase 6 adds no cron — the payout run stays Phase 8).

## Waves

### Wave A — the shell, the dashboard, and the booking/professional read surfaces

- **Migration `0033_platform_settings.sql`**: `platform_settings` (D2), seeded with
  the current `PLATFORM_DEFAULTS`; RLS (staff read via `is_trusted_session()` +
  role, admin/super_admin write); an UPDATE trigger stamping `updated_by`/`updated_at`.
- **Migration `0034_admin_write_paths.sql`**: `admin_cancel_booking` (booking
  cancel with an ops actor and a reason, reusing the §11.1 fee math) and
  `admin_assign_booking` (manual assign/reassign, walking the §8.2 edges under the
  §9.4 advisory lock — the same lock Phase 5 installed). Both `security definer`,
  service-role only.
- **`lib/adminServer.ts`**: staff read helpers — `listBookings(filters)`,
  `getAdminBooking(id)` (overview + assignment history + timeline), `listPros`,
  `getAdminPro`, `dashboardSummary()` (KPIs, funnel, alerts).
- **`lib/settingsServer.ts`**: typed `getSetting`/`setSetting` (D2).
- **`app/admin/layout.tsx`**: the staff guard + sidebar from `ROLE_SECTIONS`,
  active-item styling per §20.9, responsive rules per §20.14 (desktop-only notice
  under 640px).
- **`components/admin/`**: `DataTable.tsx` (search/sort/filter/paginate/row
  actions), `StatCard.tsx`, `Funnel.tsx`, `AlertList.tsx`.
- **Endpoints**: `GET /api/admin/dashboard`, `GET /api/admin/bookings`,
  `GET /api/admin/bookings/[id]`, `POST /api/admin/bookings/[id]/cancel`,
  `POST /api/admin/bookings/[id]/assign`, `GET /api/admin/professionals`,
  `GET /api/admin/professionals/[id]`.
- **UI**: real `/admin` dashboard; `/admin/bookings` + `/admin/bookings/[id]`
  (resizable panels: overview / assignment / timeline / actions);
  `/admin/professionals` + detail.
- **Tests**: `test/routes.admin.test.ts` (fake supabase); `test/db.admin.test.ts`
  for the two write RPCs when a live DB is present.

### Wave B — KYC review queue (drives the Phase 4 endpoint)

- `GET /api/admin/professionals/[id]/kyc` — documents + short-lived signed read
  URLs for the private `kyc-documents` bucket.
- `POST /api/admin/professionals/kyc/bulk-decision` — multi-select verify/reject.
- `POST /api/admin/professionals/[id]/suspend` — `pro.suspend`, audited.
- UI: `/admin/professionals/[id]/kyc-review` (§20.13) + the queue filter on the
  professionals list.

### Wave C — catalogue, pricing, coupons, refunds

- **Migration `0035_pricing_policies.sql`**: `pricing_rules` (multiplier/surge
  windows) and `cancellation_policies` (the §11.1 fee table made editable),
  backfilled from the current constants.
- Services CRUD (`service.manage`), service areas, durations.
- Pricing rules + cancellation policies editors; coupon management (reads 0016).
- **Refund execution** (`refund.execute`): `GET /api/admin/refunds`,
  `POST /api/admin/refunds/[id]/execute` → `refundCapturedBooking`; the
  `supportRefundLimit` dual-approval rule (§22).
- Wire `lib/pricing.ts` / `lib/constants.ts` reads to `platform_settings`.

### Wave D — disputes, support, audit, settings, (analytics)

- Disputes + support ticket queues (tables `0019_support.sql` — **new here** if
  absent).
- Audit log viewer (`audit.read`) over `audit_logs`.
- Settings editor (§ admin → Settings) over `platform_settings`.
- Dashboard analytics beyond the KPI tiles is deferred (D1).

### Wave E — docs and the phase gate

- `docs/API.md` §4.8 (the `/api/admin/**` surface), `docs/FEATURES.md` §8,
  `docs/DATABASE.md` §14, `README.md` "at Phase 6".
- The tiered gate: typecheck / lint / build → `npm test` → `npm run test:db` →
  §31.1 hand-check (an ops account can cancel+refund, verify a professional,
  edit a price and a setting, all without a database console) → `06-SUMMARY.md`.

## Deferred (recorded, not forgotten)

| Deferred | Why | Lands in |
|---|---|---|
| Notification templates + dispatcher | Needs the Phase 7 transport | Phase 7 |
| Analytics report pages (beyond dashboard KPIs) | Belongs with the notification/reporting phase | Phase 7/8 |
| Payout run UI (`/admin/payouts/run`) | `payouts` table is Phase 8 | Phase 8 |
| Chat export from the booking detail | Needs the Phase 7 chat tables | Phase 7 |
| Native admin mobile layout | §20.14 is desktop-only by decision | — (out of scope) |
| Instant-booking admin knobs | v2.0 | Phase 10 |
