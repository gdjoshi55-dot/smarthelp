"""Builds smarthelp/SmartHelp-Overview.docx - a 6-9 page condensed brief.

Condensed from the full specification (SmartHelp-Documentation.docx).
Same toolkit, same design language, roughly one-twentieth the length.
"""

import datetime
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from docx.shared import Pt  # noqa: E402

from kit import (  # noqa: E402
    bullets,
    callout,
    code,
    diagram,
    h1,
    h2,
    kv_table,
    new_document,
    note,
    p,
    page_break,
    table,
    title,
    update_fields_on_open,
)

OUT = os.path.normpath(os.path.join(HERE, "..", "SmartHelp-Overview.docx"))


def build(doc):
    # ── Cover ─────────────────────────────────────────────────────────────
    title(doc, "SmartHelp", "Trusted help. Right when you need it.")
    para_ = doc.add_paragraph()
    run = para_.add_run("Product & Technical Overview — condensed build brief")
    run.font.size = Pt(12.5)
    run.font.bold = True
    run.font.color.rgb = doc.styles["Heading 1"].font.color.rgb
    para_.paragraph_format.space_after = Pt(6)

    kv_table(
        doc,
        [
            ("Product", "On-demand home services marketplace — cleaning, kitchen, laundry, household"),
            ("Stack", "Next.js 14 · React 18 · TypeScript 5.5 · Tailwind 3.4 · shadcn/ui · Supabase (Postgres/Auth/Realtime/Storage) · Razorpay · Vercel"),
            ("Stack policy", "Exact parity with the SmartPOS codebase. No new runtime, no ORM, no Redis, no separate API server, no native app."),
            ("UI policy", "Identical design system to SmartPOS — same tokens, same components, same spacing, same tone"),
            ("Surfaces", "Public site · Customer app · Professional app · Admin console — one codebase, four role-based shells"),
            ("Full spec", "SmartHelp-Documentation.docx — 31 sections, 47 tables, 28 migrations, 108 pages"),
            ("Date", datetime.date.today().strftime("%B %d, %Y")),
        ],
        label_width=1.2,
        value_width=5.5,
    )

    # ── 1 ────────────────────────────────────────────────────────────────
    h1(doc, "1. What SmartHelp Is")
    p(
        doc,
        "SmartHelp lets customers book verified household professionals for cleaning, kitchen, laundry and "
        "general domestic work — instantly or on a schedule — with duration-based pricing locked at checkout, "
        "OTP-gated service start, a server-authoritative timer and in-app support. The operating model is the "
        "standard on-demand home-services category; the brand, copy, assets and implementation are SmartHelp's own.",
    )
    table(
        doc,
        ["Problem today", "SmartHelp answer"],
        [
            ["Supply is invisible; found by word of mouth", "Searchable catalogue with live availability per locality and slot"],
            ["Price is quoted on arrival", "Duration price locked at checkout, itemised breakdown shown before payment"],
            ["No proof they attended or worked the time", "Customer-shared OTP gates service start; the DB clock is authoritative"],
            ["No standard definition of the work", "Per-service included/excluded task list, visible before booking, binding in disputes"],
            ["If they cancel, the customer is stuck", "Reassignment cascade, then automatic full refund if it exhausts"],
        ],
        widths=[2.5, 4.2],
        font_size=8.5,
    )

    # ── 2 ────────────────────────────────────────────────────────────────
    h1(doc, "2. Technology Stack — Exact SmartPOS Parity")
    table(
        doc,
        ["Layer", "Technology", "Role"],
        [
            ["Framework", "Next.js 14 App Router", "All four surfaces plus every API Route Handler"],
            ["UI", "React 18 · TS 5.5 strict · Tailwind 3.4 · shadcn/ui", "`globals.css`, `tailwind.config.ts`, `components/ui/**` copied verbatim from SmartPOS"],
            ["State · forms · feedback", "Zustand · react-hook-form · react-hot-toast · Recharts · lucide-react", "Booking cart, checkout draft, job state; all toasts; admin analytics; all icons"],
            ["Data", "Supabase PostgreSQL", "47 tables, RLS, triggers, exclusion constraints, 28 numbered migrations"],
            ["Auth · Realtime · Storage", "Supabase Auth · Realtime · Storage", "Phone OTP + email/password; booking, presence and chat channels; 6 private buckets behind signed URLs"],
            ["Payments", "Razorpay", "Orders, server-side signature verification, webhooks, refunds"],
            ["Notifications & scheduling", "Nodemailer · generic SMS/WhatsApp webhook · Realtime push · Vercel Cron", "Same `SMS_PROVIDER_URL` contract SmartPOS uses; 8 `CRON_SECRET`-guarded jobs"],
        ],
        widths=[1.05, 2.1, 3.55],
        font_size=7.5,
    )
    callout(
        doc,
        "Replacements made in the SmartPOS stack",
        "Spring Boot → Next.js Route Handlers. Spring Security + JWT → Supabase Auth + RLS. Hibernate → typed rows, "
        "zero ORM. Redis → Postgres advisory locks, exclusion constraints, hashed OTP rows, idempotency tables. "
        "WebSocket server → Supabase Realtime. React Native → responsive role-based shells. Every functional "
        "requirement is retained; only the mechanism changes. No new dependency is added.",
    )

    # ── 3 ────────────────────────────────────────────────────────────────
    h1(doc, "3. Roles")
    p(doc, "`user_role` enum: `customer`, `professional`, `admin`, `ops`, `support`, `super_admin`. No hierarchy — every capability is an explicit grant enforced by RLS plus server-side checks.")
    table(
        doc,
        ["Capability", "customer", "professional", "support", "ops", "admin"],
        [
            ["Browse catalogue, get prices", "y", "y", "y", "y", "y"],
            ["Create / cancel / reschedule booking", "own", "—", "—", "on behalf", "y"],
            ["Accept / decline an offer · start service (OTP) · complete", "—", "y", "—", "—", "—"],
            ["Set availability, submit KYC", "—", "own", "—", "—", "force"],
            ["Verify / suspend a professional", "—", "—", "—", "—", "y"],
            ["Edit services, pricing, commission, surge", "—", "—", "—", "—", "y"],
            ["Issue refund  ·  manage tickets  ·  analytics / audit", "request / own / —", "— / own / own", "≤ limit / all / ticket", "≤ limit / all / ops", "y"],
        ],
        widths=[2.4, 0.9, 1.0, 0.8, 0.85, 0.75],
        font_size=8,
    )

    # ── 4 ────────────────────────────────────────────────────────────────
    h1(doc, "4. What It Sells")
    table(
        doc,
        ["Category", "Seed services", "Pricing"],
        [
            ["Cleaning", "Full house, bathroom, kitchen deep clean, balcony & window, fan & appliance, mopping", "Hourly, 30–240 min"],
            ["Kitchen", "Dishwashing, daily cooking support, prep & chopping, counter & platform, stove & chimney", "Hourly, 60–240 min"],
            ["Laundry", "Wash & dry, iron & fold, stain removal, blankets and heavy curtains", "Per kg or hourly"],
            ["Household", "Decluttering, moving help, post-partition deep clean, errands", "Hourly, 60–360 min"],
            ["Appliance", "Refrigerator, microwave, AC service, chimney deep clean", "Fixed or hourly"],
        ],
        widths=[0.95, 4.45, 1.3],
        font_size=8.5,
    )
    bullets(
        doc,
        [
            "Catalogue, prices, durations, scope and service areas are **rows, not code** — an admin creates a service without a deploy.",
            "Each service carries `service_tasks` split into `included` and `excluded`. This renders as the ✓/✕ list on the service page and is binding when support adjudicates a dispute. A service is bookable only where an active `service_areas` row exists for the customer's locality.",
            "Durations are per-service rows (default ladder 30/45/60/90/120/180/240/300/360), each with a flat price override or a multiplier.",
        ],
    )

    # ── 5 ────────────────────────────────────────────────────────────────
    h1(doc, "5. Booking Lifecycle")
    diagram(
        doc,
        """
Quote -> Book -> Pay -> Verified -> Matching -> Assigned -> Accepted -> On the way
  -> Arrived -> OTP verified -> In progress -> Completed -> Rated -> Closed
                  |             |            |
                  v             v            v
           Payment failed   Reassign     Cancel -> Refund
""",
    )
    table(
        doc,
        ["Status", "Meaning", "Next legal states"],
        [
            ["`payment_pending`", "Order created, awaiting verified payment", "`paid`, `cancelled`"],
            ["`paid`", "Razorpay signature/webhook verified", "`searching`, `refund_pending`"],
            ["`searching`", "Matching engine running, offers fanning out", "`assigned`, `refund_pending`"],
            ["`assigned` → `accepted`", "Live offer, then professional takes the job", "`on_the_way`, `searching`"],
            ["`on_the_way` → `arrived`", "Travelling (ETA shown), then at the address awaiting OTP", "`otp_verified`, `refund_pending`"],
            ["`in_progress`", "Timer running on the DB clock", "`extension_requested`, `completed`"],
            ["`completed` → `closed`", "Service ended, actual duration recorded, then rated", "`disputed`"],
            ["`cancelled` · `refund_pending` · `refunded` · `disputed` · `no_show`", "Terminal money and exception paths", "—"],
        ],
        widths=[1.9, 2.6, 2.2],
        font_size=8,
    )
    callout(
        doc,
        "The state machine is enforced twice",
        "A Postgres `booking_status` enum plus a `BEFORE UPDATE` trigger that rejects any transition outside the legal set "
        "and writes `booking_status_history` automatically. On top of that, an RLS policy denies client `UPDATE` on "
        "`bookings` entirely — every state change must pass through a Route Handler running the service-role client, where "
        "the transition guard, pricing engine and audit trail live. No free-text status strings exist anywhere.",
    )

    # ── 6 ────────────────────────────────────────────────────────────────
    h1(doc, "6. Pricing")
    code(
        doc,
        """
line_total        = base_price x (duration/60)  |  base_price  |  unit_price x qty
subtotal          = SUM(line_total)
platform_fee      = max(fee_min, subtotal x platform_fee_pct)
discount          = MIN(coupon_discount, max_discount_cap, 40% of total)
taxable           = subtotal + platform_fee - discount
tax               = taxable x tax_pct
total             = subtotal + platform_fee - discount + tax

professional_gross = taxable x (1 - commission_pct)
platform_revenue   = platform_fee + tax + (taxable x commission_pct)
""",
        caption="Evaluated server-side only. The client renders a breakdown; it never computes a total.",
    )
    bullets(
        doc,
        [
            "`POST /api/bookings/quote` is pure and returns a signed `quoteToken`. Booking creation re-prices and rejects with `PRICE_CHANGED` on any mismatch — a client-sent amount is never accepted.",
            "Peak / off-peak multipliers, surge, platform fee, tax, commission, coupon caps and cancellation fees are all admin-configurable rows (`pricing_rules`, `platform_settings`, `professionals.commission_pct`, `cancellation_policies`).",
            "Surge is opt-in, clamped to `[0.50, 2.00]`, itemised as its own line, and applied only to new quotes — a paid booking's price is frozen forever. A booking may hold several `booking_items`; matching then requires one professional skilled in every item.",
        ],
    )

    # ── 7 ────────────────────────────────────────────────────────────────
    h1(doc, "7. Availability, Matching & Concurrency")
    p(doc, "Availability is derived, never stored: service area + lead time + duration + the professional's working hours and time off + live supply of online, verified, skilled professionals not already reserved for an overlapping window. Candidates are ranked on distance, rating, acceptance rate, completed jobs and a favourite bonus, then offers fan out in three widening rounds (6 pros / 12 km → 10 / 18 km → city-wide). If the pool exhausts, the booking auto-cancels and auto-refunds within two minutes.")
    table(
        doc,
        ["Hazard", "Fix", "Layer"],
        [
            ["Same pro assigned to two overlapping bookings", "`EXCLUDE USING gist` on `professional_schedule (professional_id, tstzrange(starts_at, ends_at))` — structurally impossible", "Database"],
            ["Two live offers on one booking", "Partial unique index `UNIQUE (booking_id) WHERE status IN ('offered','accepted')`", "Database"],
            ["Assignment races · double charge · double booking · two devices", "`pg_advisory_xact_lock('assign:'||booking_id)`; `Idempotency-Key` → `idempotency_keys` PK `(scope,key)`, replay returns the original response; `bookings.version` optimistic lock, loser gets `409 STALE_VERSION`", "Database + handler"],
            ["Duplicate webhook", "Status-guarded update; an already-`success` payment returns early and logs a duplicate", "Handler"],
        ],
        widths=[1.9, 3.7, 0.75],
        font_size=8,
    )

    # ── 8 ────────────────────────────────────────────────────────────────
    h1(doc, "8. Service Execution, Cancellation & Money")
    table(
        doc,
        ["Concern", "Rule"],
        [
            ["OTP", "4 digits, generated server-side, stored only as a SHA-256 hash. 10-min TTL, 3 attempts, 15-min lockout, max 3 regenerations. A correct code moves `arrived → in_progress`; a wrong one increments the attempt counter."],
            ["Timer", "`started_at = now()` and `ends_at = now() + duration`, both from the **database** clock. The client renders `endsAt − serverNow` and re-syncs every poll. Changing the phone clock changes nothing."],
            ["Extension · completion", "Customer picks 30/60/90 min → the professional's next job is collision-checked → professional accepts → customer pays only the delta → `ends_at` extends; a declined extension never charges. Completion records `actual_duration_minutes` and creates a pending earning."],
            ["Cancellation", "Customer: free ≥ 24 h, 10% at 6–24 h, 25% at 2–6 h, 50% under 2 h, 100% after arrival — a configurable ladder resolved by a SQL function, most-specific match first. Professional: the booking returns to `searching` with them excluded; if the cascade exhausts the fee is waived and a full automatic refund is issued. Three cancellations in 30 days triggers probation."],
            ["Late / no-show", "Expected and actual arrival timestamps are both stored; breaching the threshold raises an ops alert. Customer no-show is declared by the professional after a grace period, forfeiting the amount and auto-opening an appeal ticket."],
            ["Payments · refunds", "Razorpay order → verified webhook (HMAC-SHA512 over the raw body) → `payments` row `success` → booking `paid`. The browser callback only triggers a refetch; it never mutates state. Refunds are full, partial, automatic or manual; above `support_refund_limit` a second approver is required, and un-refundable instruments route to wallet credit, disclosed at cancellation time."],
            ["Wallet · earnings", "The wallet is an append-only ledger — `wallet_transactions` has `UPDATE` and `DELETE` policies of `false`, the balance is a cache maintained in the same transaction, and an overdraft guard raises on negative. Commission is a per-professional percentage, overridable; earnings run `pending → available (24 h) → paid` via a weekly Monday payout batch."],
        ],
        widths=[1.2, 5.5],
        font_size=8,
    )

    # ── 9 ────────────────────────────────────────────────────────────────
    h1(doc, "9. Data Model — 47 Tables, 28 Migrations")
    table(
        doc,
        ["Domain", "Tables"],
        [
            ["Identity", "`profiles` (role, status) · `customers` (referral, stats) · `otp_requests` (hashed codes, attempts, lockout)"],
            ["Geography", "`cities` (time zone, business hours, currency) · `localities` (lat/lng, radius) · `service_areas` (locality × service, lead time, capacity)"],
            ["Catalogue", "`service_categories` · `services` · `service_tasks` (included/excluded) · `service_images` · `service_durations` · `service_keywords`"],
            ["Professionals", "`professionals` (verification, training, availability, live location, rating, commission) · `professional_documents` · `professional_skills` · `professional_working_hours` · `professional_time_off` · `professional_schedule` (reserved windows)"],
            ["Bookings", "`bookings` · `booking_items` · `booking_status_history` · `booking_assignments` (offers) · `favourites` · `recurring_series` · `recurring_occurrences`"],
            ["Money", "`payments` · `refunds` · `wallets` · `wallet_transactions` · `coupons` · `coupon_usage` · `professional_earnings` · `payouts` · `invoices`"],
            ["Trust & support", "`ratings` (+ pro response) · `support_tickets` · `support_messages` · `chat_threads` · `chat_messages` · `sos_incidents` · `referrals`"],
            ["Platform", "`platform_settings` (kv) · `pricing_rules` · `cancellation_policies` · `notification_templates` · `notifications` · `audit_logs` · `idempotency_keys`"],
        ],
        widths=[1.05, 5.65],
        font_size=7.5,
    )
    note(
        doc,
        "RLS is on every table. Customers read only their own rows, professionals read only assigned bookings and their own "
        "KYC metadata, and financial and audit tables deny all client writes. KYC, chat, support and invoice buckets are private, "
        "reachable only through short-lived signed URLs minted by a guarded Route Handler.",
    )

    # ── 10 ───────────────────────────────────────────────────────────────
    h1(doc, "10. API Surface")
    code(
        doc,
        """
success  { "success": true, "data": { ... } }
error    { "success": false, "error": "…", "code": "NO_SLOT_AVAILABLE",
           "details": { … }, "requestId": "req_7f2a", "timestamp": "…" }
""",
    )
    table(
        doc,
        ["Group", "Endpoints"],
        [
            ["Auth", "`POST /auth/send-otp` · `/auth/verify-otp` · `/auth/refresh` · `POST /auth/professional/apply` · `GET|PUT /auth/me`"],
            ["Customer", "`GET|PUT /customers/me` · `/customers/me/addresses` (CRUD) · `/customers/me/bookings` · `/customers/me/stats` · `GET /wallet` · `/favourites` · `GET /invoices/:bookingId`"],
            ["Catalogue", "`GET /service-categories` · `GET /services?q=&lat=&lng=` · `/services/:slug` · `GET /professionals/:id` · `/professionals/:id/reviews`"],
            ["Availability", "`GET /availability?serviceId&addressId&date&duration` → slots with remaining supply and a reason for each disabled slot · `GET /availability/estimate` → instant ETA"],
            ["Booking", "`POST /bookings/quote` · `POST /bookings` · `GET /bookings/:id` · `/track` · `POST /bookings/:id/cancel` · `/reschedule` · `/extend` · `/otp/regenerate` · `/review` · `/invoice` · `/chat`"],
            ["Professional", "`GET|PUT /professionals/me` · `POST /professionals/me/availability` · `PUT .../working-hours` · `POST .../time-off` · `/location` · `GET /professionals/offers` · `POST /professionals/offers/:id/accept` · `/decline` · `POST /professionals/jobs/:id/arrive` · `/otp` · `/complete` · `/no-show` · `GET /earnings` · `/payouts` · `/kyc`"],
            ["Payments", "`POST /payments/create-order` · `/verify` · `POST /webhooks/razorpay` · `GET /payments/:id` · `POST /refunds` · `GET /refunds` · `POST /wallet/topup`"],
            ["Support, chat, misc", "`/support/tickets` (CRUD + `/messages`) · `/chat/threads/:id/messages` · `POST /sos` · `GET /notifications` · `POST /notifications/push-token` · `POST /referrals/validate`"],
            ["Admin", "`/admin/dashboard` · `/admin/services…` · `/admin/service-areas…` · `/admin/professionals…` · `/admin/professionals/:id/kyc/:docId/:decision` · `/admin/bookings/:id/assign` · `/cancel` · `/admin/pricing-rules…` · `/admin/cancellation-policies…` · `/admin/coupons…` · `/admin/refunds/:id/execute` · `/admin/payouts/run` · `/admin/disputes` · `/admin/analytics/:report` · `/admin/platform-settings…` · `/admin/audit`"],
            ["Cron", "`search-sweeper` (*/2 min) · `recurring-generate` · `service-reminders` (*/15 min) · `demand-index` (*/5 min) · `rating-reminders` · `payout-run` (Mon) · `wallet-expiry` · `reconcile-payments` (*/30 min)"],
        ],
        widths=[1.0, 5.7],
        font_size=7.5,
    )
    note(
        doc,
        "All POST money and booking routes accept `Idempotency-Key`. Error codes are a fixed catalogue — `PRICE_CHANGED`, "
        "`NO_SLOT_AVAILABLE`, `PROFESSIONAL_UNAVAILABLE`, `OTP_INVALID`, `OTP_LOCKED`, `COUPON_EXHAUSTED`, `STALE_VERSION`, "
        "`ASSIGNMENT_TAKEN`, `ILLEGAL_TRANSITION`, `ADDRESS_IN_USE` — so the client reacts specifically instead of showing a "
        "generic failure.",
    )
    # ── 11 ───────────────────────────────────────────────────────────────
    h1(doc, "11. UI — Identical to SmartPOS")
    bullets(
        doc,
        [
            "`app/globals.css`, `tailwind.config.ts`, `components.json` and `components/ui/**` are **copied verbatim** from SmartPOS — same HSL token channels (`--primary 221 83% 53%`, `--success`, `--warning`, `--radius 0.5rem`), same Inter font, same `react-hot-toast` `<Toaster position=\"top-center\" />`. Only the marketing pages use the brand hexes (`#1E5FE8`, `#0B1B3A`, `#EBF3FE`, `#1BA352`), exactly as SmartPOS splits them.",
            "The full shadcn set is already available, including `input-otp` (service OTP), `react-day-picker` (scheduling), `vaul` (mobile sheets), `cmdk` (admin search), `react-resizable-panels` (KYC review) and `carousel` (service gallery). Components to author: `ServiceCard`, `DurationPicker`, `SlotPicker`, `PriceBreakdown`, `BookingStatusBadge`, `BookingTimeline`, `ServiceTimer`, `OtpDisplay`/`OtpEntry`, `RatingStars`, `ProCard`, `OfferCard`, `EarningsSummary`, `ChatThread`, `KycStepper`, `DataTable`, `StatCard`, `AppShell`, `EmptyState`. `LoadingSpinner`, `ImageUpload` and `ConfirmationDialog` are copied from SmartPOS.",
        ],
    )
    table(
        doc,
        ["Shell", "Navigation", "Key screens"],
        [
            ["Public", "Top nav", "Landing · `/services` · `/services/[slug]` · `/book/[code]` shareable link · `/join` (pro application) · `/login`"],
            ["Customer", "Bottom nav: Home · Bookings · Help · Profile", "Home · browse · service detail · checkout (address, when, professional, price) · live booking with status stepper, ETA, OTP display, countdown, extension, rating, invoice · wallet · support · favourites · profile"],
            ["Professional", "Bottom nav: Home · Jobs · Earnings · Profile", "Home (online toggle, today) · offer inbox with countdown · job detail (navigate, arrive, OTP entry, complete) · earnings + payouts · KYC stepper · availability & working hours · training · profile"],
            ["Admin / Ops / Support", "Sidebar, 240px, collapsible", "Dashboard with funnel and alerts · bookings + detail · professionals + KYC review · customers · services · pricing · payments · refunds · payouts · coupons · disputes · support · analytics · templates · settings · audit"],
        ],
        widths=[1.15, 1.6, 3.95],
        font_size=8,
    )
    note(
        doc,
        "Every list ships four states — `skeleton` loading, `EmptyState` with an action, inline error + retry, populated — and "
        "every destructive action goes through `ConfirmationDialog` naming the object. Accessibility contract: visible focus "
        "ring, keyboard-navigable OTP and dialogs with focus restore, status never conveyed by colour alone, ≥ 4.5:1 "
        "contrast, ≥ 44×44 px touch targets, `aria-live` on the timer. Responsive at 390 / 768 / 1280 px; the admin console is "
        "desktop-only.",
    )

    # ── 12 ───────────────────────────────────────────────────────────────
    h1(doc, "12. Non-Negotiables")
    bullets(
        doc,
        [
            "**Availability first** — never promise a professional before availability is confirmed for that exact locality, slot and duration.",
            "**Backend is the source of truth** — never trust a client-supplied price, status, role or timestamp.",
            "**No hardcoded business rules** — prices, durations, fees, commission, surge, cancellation and service areas are all admin-editable rows.",
            "**Payments are server-verified; statuses are an enum** with a transition trigger and full history; **assignment is concurrency-safe at the database level; money operations are idempotent; everything is auditable** (`booking_status_history` per booking, `audit_logs` on every privileged mutation with actor, IP, old/new value).",
            "**City-agnostic** — no city name in code, seed data or UI copy; all geography is data.",
            "**Original identity** — own brand, copy and assets; the operating model is category-standard, not copied.",
        ],
    )

    # ── 13 ───────────────────────────────────────────────────────────────
    h1(doc, "13. Edge Cases That Must Work")
    table(
        doc,
        ["Scenario", "Behaviour"],
        [
            ["Paid, but no professional available", "Search expires → `refund_pending` → automatic full refund → customer notified"],
            ["Professional accepts then cancels", "Reassignment cascade excluding them; auto-refund if the pool exhausts"],
            ["Customer closes the app, or the network drops", "Service continues server-side; professional actions retried with `Idempotency-Key`"],
            ["Customer is double-charged · a pro accepts then cancels", "`idempotency_keys` dedupe + a status-guarded webhook → one booking, one payment. A pro who then cancels re-enters `searching`; an exhausted pool auto-refunds in full."],
            ["Professional starts without a valid OTP", "Rejected: the booking is not in `arrived`, or the hash does not match"],
            ["Webhooks arrive twice, or never · price changes between quote and pay", "Duplicate is a logged no-op; a missing one is caught by the 30-minute reconciliation cron. A changed price returns `PRICE_CHANGED` with a fresh breakdown and does not create the booking."],
            ["Recurring cron re-runs · address deleted while booked", "Occurrence is idempotent via `UNIQUE (series_id, occurrence_date)`; address delete is blocked with `ADDRESS_IN_USE`"],
        ],
        widths=[2.3, 4.4],
        font_size=8,
    )

    # ── 14 ───────────────────────────────────────────────────────────────
    h1(doc, "14. Delivery")
    table(
        doc,
        ["Phase", "Scope"],
        [
            ["0 · Foundation", "Scaffold, design tokens verbatim, Supabase Auth with 5 roles, migrations 0001–0006, seed catalogue, buckets, Vercel deploy"],
            ["1 · Catalogue", "Public site, catalogue, service detail, `GET /availability`, addresses, geolocation"],
            ["2 · Booking & pricing", "Quote engine, booking create, cancel/reschedule, coupons, state machine, invoice stub"],
            ["3 · Payments", "Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation cron"],
            ["4 · Professional app", "KYC upload + review, working hours, offers inbox, accept/decline, arrive, OTP, complete"],
            ["5 · Matching engine", "Candidate ranking, offer fan-out, advisory locks, reassignment cascade, search sweeper"],
            ["6 · Admin console", "Dashboard, bookings, KYC review, services, pricing, payments, coupons, disputes, support, audit, settings"],
            ["7 · Realtime & notifications", "Channels, presence, chat, dispatcher, templates, reminders"],
            ["8 · Growth", "Recurring, wallet, referrals, favourites, surge, invoice PDF, PWA"],
            ["9 · Hardening & launch", "Security review, RLS isolation audit, load test, accessibility pass, legal pages, runbook"],
        ],
        widths=[1.25, 5.45],
        font_size=8,
    )
    p(doc, "**Definition of Done, per feature:** idempotent migration added and `schema.sql` synced · RLS written and covered by an isolation test · Route Handler with validation, capability check, error envelope and audit log · client wired to the real endpoint, no placeholder UI · loading/empty/error/success/retry states · unit tests for logic plus one happy-path and one failure-path integration test · responsive, keyboard accessible, no colour-only status · documented in `docs/`.")
    p(doc, "**Critical acceptance path:** signup → OTP → add address → pick Full House Cleaning → Instant, 2 h → availability positive → itemised price → pay → webhook verified → matching runs → professional receives and accepts → customer notified → professional arrives → customer shares OTP → timer starts on the DB clock → extension requested, accepted and paid → professional completes → earning created → customer rates → booking `closed`, with the full trail in `booking_status_history` and `audit_logs`. Negatives: no pro available → auto refund; double submit → one booking; tampered price → `PRICE_CHANGED`; replayed webhook → no double effect.")

    # ── Appendix ─────────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "Appendix — AI Master Prompt")
    p(doc, "Paste as the system prompt for a coding agent. The full version, with every table, endpoint, migration and screen, is in `SmartHelp-Documentation.docx`.")
    code(
        doc,
        """
Build SmartHelp, a production on-demand home-services platform, in the `smarthelp/` folder.

STACK — do not deviate. Use exactly the SmartPOS stack: Next.js 14 App Router, React 18, TypeScript 5.5
strict, Tailwind 3.4, shadcn/ui (Radix), @supabase/supabase-js (Postgres + Auth + Realtime + Storage),
Zustand, react-hook-form, react-hot-toast, Recharts, lucide-react, input-otp, react-day-picker, cmdk,
vaul, embla-carousel, react-resizable-panels, nodemailer, Razorpay. Deploy on Vercel with Vercel Cron.
Do NOT introduce Java/Spring, Redis, a separate WebSocket server, React Native, an ORM, Redux, or any
new dependency. Where a capability is needed, use the stack-native equivalent: Supabase Realtime
instead of a WebSocket server; Postgres advisory locks, exclusion constraints and idempotency tables
instead of Redis; Next.js Route Handlers instead of a separate API service.

UI — identical to SmartPOS. Copy `app/globals.css`, `tailwind.config.ts`, `components.json`,
`components/ui/**` and `lib/utils.ts` verbatim. Same tokens, same component set, same toast library,
same spacing and type scale. Do not redesign, do not add a colour, do not add a second UI library.
Mobile-first; bottom nav for the customer and professional shells, sidebar for admin.

BUILD RULES — non-negotiable:
 1. Build a real production application. No mock/demo app, no fake data, no placeholder buttons. Any
    rendered control connects to a real API or a clearly labelled "Coming soon" affordance.
 2. The backend is the source of truth. Never trust a client-supplied price, status, role or time.
 3. No hardcoded business rules. Pricing, durations, commission, cancellation fees, surge and service
    areas are admin-configurable rows, not code or constants.
 4. Booking status is a Postgres enum enforced by a transition trigger. No free-text statuses.
 5. Payments are confirmed only by a verified Razorpay webhook/signature; the client callback only
    triggers a refetch.
 6. Prevent double assignment at the database level: a GiST exclusion constraint on
    professional_schedule, a partial unique index on booking_assignments, pg_advisory_xact_lock.
    Prevent double charge and double booking creation with an Idempotency-Key on mutating endpoints.
 7. Write numbered, idempotent SQL migrations in supabase/migrations and keep schema.sql in sync.
    Enable RLS on every table and add an isolation test per table.
 8. Enforce authorization on the server (RLS + route capability checks), never only in the UI.
 9. Ship loading, empty, error, success and retry states for every async surface, and surface the
    server's specific error message via react-hot-toast.
10. Use transactions, optimistic locking (bookings.version) and idempotency for every money or
    state-changing operation.
11. Validate all input server-side. Never log OTPs, passwords, payment secrets, full ID numbers or
    bank credentials.
12. Keep route handlers thin; put business logic in lib/ (pricing, matching, availability,
    notifications, audit) and derive row types from the Database type.
13. Implement in the phase order of section 14 and satisfy the Definition of Done per feature before
    starting the next.
14. Make every screen responsive and keyboard accessible, and never convey status by colour alone.

When a module is done, state which spec sections you implemented, which migrations you added, and
which tests you ran.
""",
    )


def main():
    doc = new_document()
    build(doc)
    update_fields_on_open(doc)
    doc.save(OUT)
    print("Wrote:", OUT)
    print("Size :", f"{os.path.getsize(OUT) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
