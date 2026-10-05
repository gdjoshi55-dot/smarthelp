"""Part 1 — Product definition: overview, roles, catalogue, booking, pricing, matching."""

from docx.enum.text import WD_ALIGN_PARAGRAPH

from kit import (
    GRAY,
    NAVY,
    bullets,
    callout,
    cap,
    code,
    diagram,
    h1,
    h2,
    h3,
    kv_table,
    note,
    p,
    page_break,
    steps,
    table,
    title,
)


def build(doc):
    # ── 1. Overview ────────────────────────────────────────────────────────
    h1(doc, "1. Project Overview")

    p(
        doc,
        "SmartHelp is an on-demand home-services marketplace. Customers book verified "
        "household professionals for cleaning, kitchen, laundry and general domestic "
        "work — instantly or on a schedule — with duration-based pricing, OTP-gated "
        "service start, server-authoritative timers and in-app support.",
    )
    p(
        doc,
        "SmartHelp is built as a **single Next.js 14 application** with three role-based "
        "shells (Customer, Professional, Admin) on top of **Supabase** (PostgreSQL + Auth + "
        "Storage + Realtime). It intentionally reuses the SmartPOS codebase conventions "
        "one-for-one: the same App Router layout, the same shadcn/ui component set, the same "
        "Tailwind tokens, the same Zustand store pattern, the same Razorpay integration, "
        "the same numbered SQL migration folder, and the same Vercel cron pattern.",
    )

    kv_table(
        doc,
        [
            ("Product", "SmartHelp — on-demand home services platform"),
            ("Tagline", "Trusted help. Right when you need it."),
            ("Document type", "Master product + engineering specification (single source of truth)"),
            ("Target stack", "Byte-for-byte parity with SmartPOS (see Part 3)"),
            ("Primary database", "Supabase managed PostgreSQL"),
            ("Payments", "Razorpay (Orders + Subscriptions + Route webhooks)"),
            ("Realtime", "Supabase Realtime (channels + Presence + Broadcast)"),
            ("Deployment", "Vercel (Next.js) + Supabase (DB/Auth/Storage/Realtime)"),
            ("Primary markets", "Configurable — country / state / city / locality (IN default)"),
            ("Currency", "Configurable per platform, default `INR` with `en-IN` formatting"),
        ],
    )

    h2(doc, "1.1 What ships in v1")
    bullets(
        doc,
        [
            "Customer app — browse, price, book (instant / scheduled / recurring), pay, track, rate, support.",
            "Professional app — KYC, availability, offer inbox, accept, navigate, OTP start, complete, earnings.",
            "Admin console — dashboard, catalogue, pricing rules, KYC review, bookings, payments, refunds, support, analytics, audit log.",
            "Platform services — availability engine, matching engine, pricing engine, notification dispatcher, scheduled-job runner.",
            "Public surfaces — marketing landing, service catalogue, and a shareable booking link (no account required to view prices).",
        ],
    )

    h2(doc, "1.2 Explicitly out of scope for v1")
    bullets(
        doc,
        [
            "Native iOS / Android binaries — v1 is responsive web, installable as a PWA.",
            "Material procurement or inventory consumption (professionals bring their own materials; recorded as text only).",
            "In-app wallet top-up via credit card — wallet is refund / promo / referral / compensation credit only in v1.",
            "Multi-language UI — data model carries a `locale` column on templates from day one, but ships `en-IN` only.",
            "Dispute arbitration automation — tickets are handled by humans; automation only assigns priority and SLA.",
        ],
    )

    # ── 2. Vision & problem ────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "2. Product Vision & Problem Statement")

    h2(doc, "2.1 Vision")
    p(
        doc,
        "Make domestic help as easy to book as a cab, and as trustworthy as a payroll "
        "transaction. Every booking must have an identity-verified professional, a "
        "fixed scope, a fixed price, a proof-of-arrival, and a paper trail.",
    )

    h2(doc, "2.2 Problems being solved")
    table(
        doc,
        ["Today", "SmartHelp answer"],
        [
            ["Domestic help is found through word of mouth; supply is invisible", "Searchable catalogue with live availability per pincode and time slot"],
            ["No transparent price — the worker quotes on arrival", "Duration-based price locked at checkout, itemised breakdown before payment"],
            ["No proof the worker actually attended or worked the full time", "Customer-shared OTP gates service start; server-authoritative timer"],
            ["No standard quality definition", "Per-service `service_tasks` with INCLUDED / EXCLUDED rows, visible before booking"],
            ["No digital payment or record trail", "Razorpay order → verified webhook → immutable payment row → generated invoice"],
            ["If the worker cancels, the customer is stuck", "Reassignment cascade with automatic full refund if the cascade exhausts"],
            ["No support or accountability after the visit", "Booking-scoped ticket thread with attachments, SLA priority, and audit log"],
            ["Service history is scattered across notebooks and phone calls", "Every booking, receipt, rating and message retained per customer account"],
        ],
        widths=[2.5, 4.2],
    )

    h2(doc, "2.3 Guiding principles (binding on all implementation)")
    table(
        doc,
        ["#", "Principle", "What it forbids"],
        [
            ["1", "Availability first", "Never promise a professional before availability is confirmed for the exact pincode + slot + duration"],
            ["2", "Backend is the source of truth", "No client-supplied price, status, role, or timer value is ever trusted"],
            ["3", "No hardcoded business rules", "Prices, durations, fees, commission, cancellation, surge, service areas are all admin-configurable rows"],
            ["4", "Payments are server-verified", "A booking is never marked paid from a client callback — only from a verified Razorpay signature/webhook"],
            ["5", "Explicit state machine", "Booking status is a Postgres enum; illegal transitions are rejected, not silently coerced"],
            ["6", "Concurrency-safe assignment", "Two customers can never be assigned the same professional for overlapping time (DB-level guarantee)"],
            ["7", "Idempotent money operations", "Create-booking, create-order, extend, cancel and refund all accept `Idempotency-Key`"],
            ["8", "Everything auditable", "Status history on every booking, audit log on every privileged mutation"],
            ["9", "Mobile-first", "Every primary flow is designed at 390px first; bottom navigation on mobile, sidebar on desktop"],
            ["10", "City-agnostic", "No `Kolkata` / `Mumbai` literals in code, seeds, or UI copy — all geography is data"],
            ["11", "Original identity", "The operating model is inspired by the on-demand home-services category; SmartHelp ships its own brand, copy, and assets"],
        ],
        widths=[0.4, 2.4, 3.9],
    )

    callout(
        doc,
        "Anti-clone clause",
        "SmartHelp may use the general on-demand home-services business model. It must not copy "
        "any third party's logo, brand assets, proprietary copy, UI pixel-for-pixel, or internal "
        "implementation. All copy, iconography, colour tokens and illustrations are SmartHelp's own.",
        fill="F1F5FF",
    )

    # ── 3. Roles ───────────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "3. Users, Roles & Permissions")

    h2(doc, "3.1 Role model")
    p(doc, "Roles are a Postgres enum on `profiles.role`. There is no role hierarchy — every capability is an explicit grant, enforced by RLS plus server-side checks in API routes.")

    code(
        doc,
        """
-- 0001_core.sql
CREATE TYPE user_role AS ENUM (
  'customer',      -- books and pays for services
  'professional',  -- performs services
  'admin',         -- full platform control
  'support',       -- tickets only, no pricing / KYC write access
  'ops'            -- bookings, assignment, refunds, disputes; no catalogue or role management
  'super_admin'    -- owner account; only one, bootstrapped via env allow-list
);
""",
    )

    h2(doc, "3.2 Capability matrix")
    table(
        doc,
        ["Capability", "customer", "professional", "support", "ops", "admin"],
        [
            ["Browse catalogue / prices", "yes", "yes", "yes", "yes", "yes"],
            ["Create / cancel / reschedule own booking", "yes", "no", "no", "yes (on behalf)", "yes"],
            ["View own bookings", "yes", "assigned only", "read-only", "all", "all"],
            ["Accept / reject an assignment offer", "no", "yes", "no", "no", "no"],
            ["Start service (consume OTP)", "no", "yes", "no", "no", "no"],
            ["Complete service", "no", "yes", "no", "no", "no"],
            ["Set own availability / working hours", "no", "yes", "no", "no", "yes (force)"],
            ["Submit / edit own KYC", "no", "yes", "no", "no", "yes (on behalf)"],
            ["Verify / suspend a professional", "no", "no", "no", "no", "yes"],
            ["Create / edit services & durations", "no", "no", "no", "no", "yes"],
            ["Edit pricing rules & surge", "no", "no", "no", "no", "yes"],
            ["Issue refund", "request only", "no", "no", "yes (≤ limit)", "yes"],
            ["Manage coupons & promos", "no", "no", "no", "no", "yes"],
            ["View support tickets", "own only", "own only", "all", "all", "all"],
            ["View analytics / reports", "no", "own earnings", "ticket stats", "ops stats", "all"],
            ["View audit log", "no", "no", "no", "no", "yes"],
            ["Change a user's role", "no", "no", "no", "no", "yes"],
        ],
        widths=[2.5, 0.85, 1.0, 0.75, 0.85, 0.75],
        font_size=8.5,
    )

    h2(doc, "3.3 Personas")
    h3(doc, "Customer — \"the time-poor household\"")
    bullets(
        doc,
        [
            "Wants a bathroom cleaned today, does not want to negotiate price on a phone call.",
            "Cares most about: *is the person verified*, *is the price final*, *will they actually show up*.",
            "Secondary cares: fixed arrival window, water/electricity arrangement hints, ability to rebook the same person.",
        ],
    )
    h3(doc, "Professional — \"the skilled independent worker\"")
    bullets(
        doc,
        [
            "Earns per hour; cares about utilisation, travel distance, and on-time payments.",
            "Cares most about: *fair offers near me*, *clear scope of work*, *guaranteed payout*.",
            "Secondary cares: training completion badge, rating protection, incentive bonuses.",
        ],
    )
    h3(doc, "Admin / Ops / Support — internal")
    bullets(
        doc,
        [
            "**Admin** owns catalogue, pricing, KYC policy, platform configuration.",
            "**Ops** handles the live board: unassigned bookings, cascading reassignments, refunds, disputes.",
            "**Support** handles tickets, damage/safety escalations, refund promises up to a limit.",
        ],
    )

    # ── 4. Service catalogue ──────────────────────────────────────────────
    page_break(doc)
    h1(doc, "4. Service Catalogue")

    h2(doc, "4.1 Categories and seed services")
    p(doc, "Categories and services are rows, not code. The following is the **seed set** applied by migration `0007_service_catalogue.sql`; admins may add, rename, reorder, deactivate, or extend any of it.")

    table(
        doc,
        ["Category", "Seed services", "Default pricing"],
        [
            [
                "Cleaning",
                "Full House Cleaning · Bathroom Cleaning · Kitchen Deep Clean · Balcony & Window Cleaning · Fan & Appliance Cleaning · Mopping & Floor Scrubbing",
                "Hourly, 30–240 min",
            ],
            [
                "Kitchen",
                "Dishwashing · Daily Cooking Support · Vegetable Prep & Chopping · Counter & Platform Cleaning · Gas Stove & Chimney Wipe-down",
                "Hourly, 60–240 min",
            ],
            [
                "Laundry",
                "Washing & Dry · Ironing & Folding · Stain Removal · Blanket / Heavy Curtain Wash",
                "Per kg or hourly, 60–240 min",
            ],
            [
                "Household",
                "Decluttering & Organising · Moving Help (packing) · Post-Partition Deep Clean · Errand & Shopping Run",
                "Hourly, 60–360 min",
            ],
            [
                "Appliance",
                "Refrigerator Deep Clean · Microwave Clean · Air Conditioner Service · Chimney Deep Clean",
                "Fixed or hourly, 60–180 min",
            ],
        ],
        widths=[1.1, 4.1, 1.5],
    )

    h2(doc, "4.2 Service record anatomy")
    table(
        doc,
        ["Field group", "Columns", "Notes"],
        [
            ["Identity", "`id`, `category_id`, `name`, `slug`, `description`", "`slug` unique, used for public URLs `/services/[slug]`"],
            ["Presentation", "`image_url`, `service_images[]`, `icon_key`", "Images live in the `service-media` Supabase Storage bucket"],
            ["Pricing", "`base_price`, `pricing_type`, `min_duration_min`, `max_duration_min`", "`pricing_type ∈ hourly | flat | per_unit`; `per_unit` services carry `unit_label` + `unit_price`"],
            ["Scope", "`service_tasks[]` with `kind ∈ included | excluded`", "Rendered as the ✓ / ✕ list on the service detail screen"],
            ["Materials", "`materials_note`, `materials_included boolean`", "Drives the pre-booking \"please keep X accessible\" note"],
            ["Ops", "`prep_minutes`, `max_active_jobs`, `requires_photo_proof boolean`", "`prep_minutes` is the lead time subtracted from slot availability"],
            ["Geo", "`service_areas[]` rows in `service_areas`", "A service is bookable only where a `service_areas` row is active"],
            ["State", "`is_active`, `sort_order`, `created_at`, `updated_at`", "Deactivating hides the service from search; it never deletes it"],
        ],
        widths=[1.15, 2.65, 2.9],
    )

    h2(doc, "4.3 Duration options")
    p(doc, "Durations are per-service rows in `service_durations`, not a global constant.")
    bullets(
        doc,
        [
            "Default ladder: 30, 45, 60, 90, 120, 180, 240, 300, 360 minutes.",
            "Each row may carry either a flat `price` override or a `price_multiplier` on top of the hourly base.",
            "The checkout only renders durations where `service_durations.is_active = true`, `min ≤ d ≤ max`, and a matching slot exists.",
            "Extension increments are configured in `platform_settings` as `extension_options_minutes` (default `30,60,90`).",
        ],
    )

    h2(doc, "4.4 Scope contract (included / excluded)")
    code(
        doc,
        """
-- Example seed: bathroom cleaning scope
INSERT INTO service_tasks (service_id, kind, label, sort_order) VALUES
  ('svc_bathroom', 'included', 'Floor cleaning (tiles, joints, drains)', 10),
  ('svc_bathroom', 'included', 'Toilet bowl, seat, exterior & flush cleaning', 20),
  ('svc_bathroom', 'included', 'Basin, taps, mirror & tap stains', 30),
  ('svc_bathroom', 'included', 'Shower area, glass & fittings', 40),
  ('svc_bathroom', 'included', 'Soap dish, holder, tissue, door handle', 50),
  ('svc_bathroom', 'excluded', 'Hazardous / bleach chemical deep treatment', 60),
  ('svc_bathroom', 'excluded', 'Outdoor or high-reach glass cleaning', 70),
  ('svc_bathroom', 'excluded', 'Moving heavy or fixed furniture', 80),
  ('svc_bathroom', 'excluded', 'Construction stain / paint removal', 90);
""",
        caption="service_tasks rows are what the customer sees as the ✓ included / ✕ excluded list.",
    )
    callout(
        doc,
        "Binding rule",
        "A dispute is adjudicated against `service_tasks` + `bookings.notes`. If a task is not in "
        "`kind = 'included'`, a professional is never expected to have performed it and a support "
        "agent may decline a re-service claim on that basis.",
    )

    # ── 5. Geography ───────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "5. Geography, Addresses & Service Areas")

    h2(doc, "5.1 Hierarchy")
    diagram(
        doc,
        """
country
  └── state
        └── city                      (city_id, name, is_active, time_zone, default_currency)
              └── locality            (lat, lng, radius_km, is_active)
                    └── service_area  (locality_id + service_id -> bookable, lead time, slot caps)
""",
        caption="Nothing above locality is hardcoded; the seed inserts one city and the admin console maintains the rest.",
    )

    h2(doc, "5.2 Address model")
    table(
        doc,
        ["Column", "Type", "Purpose"],
        [
            ["`label`", "text", "e.g. \"Home\", \"Parents' place\""],
            ["`address_type`", "enum", "`home | work | other`"],
            ["`line1`, `line2`", "text", "Flat / house, building / society"],
            ["`area`", "text", "Locality name (must resolve to a `localities` row)"],
            ["`city`, `state`, `pincode`", "text", "Used to resolve `locality_id` and validate serviceability"],
            ["`lat`, `lng`", "numeric(9,6)", "Source of truth for distance; geocoded on save, customer-correctable"],
            ["`landmark`", "text", "\"Opposite SBI ATM\" — shown to the professional during approach"],
            ["`access_notes`", "text", "Gate code, floor, \"no lift on 4th\", parking"],
            ["`is_default`", "boolean", "Exactly one default per customer (partial unique index)"],
        ],
        widths=[1.85, 1.05, 3.8],
    )

    note(
        doc,
        "`access_notes` is the single highest-leverage field in the whole product. A professional "
        "who cannot reach the gate loses the job on arrival; the checkout surfaces this field on the "
        "booking confirmation screen and the professional job screen.",
    )

    h2(doc, "5.3 Serviceability resolution")
    code(
        doc,
        """
-- Resolve which services are bookable for an address, at a time, for a duration.
-- Returns one row per service with the resolved locality and the slot's remaining capacity.
WITH target AS (
  SELECT l.id            AS locality_id,
         l.city_id,
         l.radius_km,
         ST_Distance(
           ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326)::geography,
           ST_SetSRID(ST_MakePoint(l.lng, l.lat), 4326)::geography
         ) / 1000        AS distance_from_pin
  FROM addresses a
  JOIN localities l
    ON lower(l.name) = lower(a.area)
   AND l.is_active
  WHERE a.id = $1
)
SELECT s.id                                        AS service_id,
       s.name,
       s.base_price,
       s.pricing_type,
       t.locality_id,
       sa.lead_minutes,
       COALESCE(sa.slot_capacity, 1)               AS slot_capacity,
       (
         SELECT count(*)
         FROM professionals pr
         JOIN professional_skills sk ON sk.professional_id = pr.id AND sk.service_id = s.id
         WHERE pr.verification_status = 'verified'
           AND pr.availability_status IN ('online','busy')
           AND EXISTS (SELECT 1 FROM service_areas x
                        WHERE x.locality_id = t.locality_id AND x.service_id = s.id AND x.is_active)
       )                                           AS eligible_professionals
FROM target t
JOIN service_areas sa ON sa.locality_id = t.locality_id AND sa.is_active
JOIN services s       ON s.id = sa.service_id AND s.is_active
ORDER BY eligible_professionals DESC, s.sort_order;
""",
        caption="This is the query behind GET /api/availability. It is the gate that stops the product showing an unbookable service.",
    )

    h2(doc, "5.4 Address capture flow")
    steps(
        doc,
        [
            "Customer picks \"Use current location\" (browser geolocation, permission requested with a plain-language reason), or searches, or selects a saved address.",
            "Coordinates are reverse-geocoded to a locality candidate; the customer confirms the locality (SmartHelp never silently guesses a pincode).",
            "Address form pre-fills line1/area/city/state/pincode; the customer can override any field.",
            "On save, `lat/lng` are stored and `locality_id` is resolved. If the locality is not covered, the address is still saved but shows a \"not yet available\" badge.",
            "Every subsequent availability check reuses the stored coordinates, so the customer is never re-prompted mid-booking.",
        ],
    )

    # ── 6. Booking types ───────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "6. Booking Types")

    h2(doc, "6.1 Instant booking")
    diagram(
        doc,
        """
Home -> Choose service -> [Instant] -> Duration -> Address
     -> Availability check (service_area + slot + professional capacity)
     -> Live price -> Coupon -> Pay (Razorpay order)
     -> Payment verified by webhook  =>  status = paid
     -> Matching engine starts      =>  status = searching
     -> Offers fan out (batched)    =>  status = assigned (on first accept)
     -> Professional accepts        =>  status = accepted
     -> Live location / ETA         =>  status = on_the_way
     -> Professional arrives        =>  status = arrived
     -> Customer reads OTP aloud     =>  status = otp_verified
     -> Timer starts (server clock) =>  status = in_progress
     -> Professional completes      =>  status = completed
     -> Customer rates              =>  status = closed
""",
    )
    p(doc, "**Instant SLA** is a platform setting: `instant_match_target_seconds` (default 120s) and `instant_match_max_attempts` (default 3 rounds of offers).")

    h2(doc, "6.2 Scheduled booking")
    p(doc, "The customer picks a date (bounded by `platform_settings.max_scheduling_days_ahead`, default 30) and a start time from a generated slot list.")
    bullets(
        doc,
        [
            "Slots are generated at **30-minute granularity** inside each locality's `business_hours` (per city, overridable per locality), minus the service's `prep_minutes`.",
            "A slot is hidden when projected supply (matching professionals free for the whole duration) is below `slot_min_supply` (default 1).",
            "Past slots and slots inside `instant_lead_minutes` (default 30) are never offered.",
            "Rescheduling uses the same generator, and additionally checks for collision with the professional's already-reserved window.",
        ],
    )

    h2(doc, "6.3 Recurring booking")
    table(
        doc,
        ["Field", "Values", "Notes"],
        [
            ["`frequency`", "`daily | weekly | fortnightly | monthly | custom`", "`custom` uses the `weekdays` array"],
            ["`weekdays`", "`0..6` (0 = Sunday)", "Ignored unless `frequency = 'custom'`"],
            ["`start_date`, `end_date`", "date", "`end_date` nullable = open-ended, capped by `series_max_occurrences` (default 24)"],
            ["`time_of_day`", "`time`", "One fixed start time for all occurrences"],
            ["`duration_minutes`", "int", "Baked into each generated booking"],
            ["`address_id`", "uuid", "Fixed address for the whole series"],
            ["`exclusions`", "`text[]` of dates", "Public holidays, travel, etc."],
        ],
        widths=[1.6, 2.7, 2.4],
    )
    p(
        doc,
        "A `recurring_series` row does **not** create bookings eagerly. The cron job "
        "`/api/cron/recurring-generate` materialises occurrences "
        "`recurring_lead_days` (default 2) ahead, each becoming a normal booking that follows the "
        "exact same state machine, payment flow and matching engine. Occurrences are recorded in "
        "`recurring_occurrences` with a unique `(series_id, occurrence_date)` so a re-run of the "
        "cron can never double-book.",
    )

    h2(doc, "6.4 Multi-service carts")
    p(
        doc,
        "A booking may contain several `booking_items` (e.g. Bathroom Cleaning 60m + Dishwashing "
        "60m in one visit). Rules that follow from this:",
    )
    bullets(
        doc,
        [
            "The booking's total `duration_minutes` is the **sum of item durations**, capped by `platform_settings.max_booking_minutes` (default 480).",
            "Matching requires **one** professional who holds skills for **every** item's service; otherwise the cart is split at checkout.",
            "The professional sees a combined scope, itemised, on the job screen.",
            "Refund on cancellation is prorated per item at the item's unit price.",
        ],
    )

    # ── 7. Pricing ─────────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "7. Pricing Engine")

    h2(doc, "7.1 Formula")
    code(
        doc,
        """
line_total      = base_price x (duration / 60)          -- hourly
                or base_price                              -- flat
                or unit_price x quantity                   -- per_unit

subtotal        = SUM(line_total)  +  SUM(extra_charges)
                    x (multiplier rules: peak / off-peak / surge / demand)

platform_fee    = max(platform_settings.platform_fee_min,
                      subtotal x pricing_rules.platform_fee_pct)

discount        = coupon discount  (capped at coupon.max_discount,
                                    and never below 0)
discount        = MIN(discount, subtotal + platform_fee)   -- floor guard

taxable         = subtotal + platform_fee - discount
tax             = taxable x platform_settings.tax_pct     -- default GST 18%

total           = round(subtotal + platform_fee - discount + tax, 2)

professional_gross = taxable - commission_pct x taxable
platform_revenue   = platform_fee + tax + (taxable x commission_pct)
""",
        caption="Evaluated server-side only. The client receives the breakdown; it never computes the total.",
    )

    h2(doc, "7.2 Quote endpoint contract")
    p(doc, "`POST /api/bookings/quote` is pure — it writes nothing — and returns a signed breakdown plus a `quote_token`.")
    code(
        doc,
        """
POST /api/bookings/quote
{
  "serviceId": "svc_house_cleaning",
  "items": [{ "serviceId": "svc_house_cleaning", "durationMinutes": 120 }],
  "addressId": "addr_9f2c...",
  "scheduledAt": "2026-09-30T10:00:00+05:30",
  "bookingType": "scheduled",
  "couponCode": "HELLO50"
}

200 OK
{
  "quoteToken": "qt_9f1c2b8a...",           // HMAC of the inputs + price, TTL 15 min
  "currency": "INR",
  "items": [{
    "serviceId": "svc_house_cleaning", "name": "Full House Cleaning",
    "durationMinutes": 120, "unitPrice": 500.00, "lineTotal": 500.00
  }],
  "breakdown": {
    "subtotal": 500.00,
    "multipliers": [{ "code": "PEAK_EVENING", "factor": 1.10, "amount": 50.00 }],
    "platformFee": 20.00,
    "discount": 50.00,
    "discountCode": "HELLO50",
    "taxableAmount": 470.00,
    "tax": 84.60, "taxRate": 0.18,
    "total": 554.60
  },
  "professionalPayout": 376.00,
  "commissionRate": 0.20,
  "availability": { "serviceable": true, "slotsRemaining": 4, "earliestSlot": "2026-09-30T10:00:00+05:30" },
  "expiresAt": "2026-09-26T19:15:00Z"
}
""",
    )
    callout(
        doc,
        "Price integrity",
        "`POST /api/bookings` accepts a `quoteToken`. The server re-prices and compares. If the "
        "server price differs from the token, the booking is rejected with `PRICE_CHANGED` and the "
        "client must show a fresh breakdown. A client-sent `amount` is never accepted.",
    )

    h2(doc, "7.3 Configurable rules")
    table(
        doc,
        ["Rule", "Storage", "Admin surface"],
        [
            ["Base price per service", "`services.base_price`", "Admin → Services → edit"],
            ["Duration price ladder", "`service_durations`", "Admin → Services → durations"],
            ["Peak / off-peak multipliers", "`pricing_rules` (type `multiplier`, window match)", "Admin → Pricing → Rules"],
            ["Surge", "`pricing_rules` (type `surge`) + computed `demand_index`", "Admin → Pricing → Surge"],
            ["Platform fee", "`platform_settings.platform_fee_pct` / `_min`", "Admin → Settings"],
            ["Tax rate & label", "`platform_settings.tax_pct`, `tax_label`", "Admin → Settings"],
            ["Professional commission", "`professionals.commission_pct` (per pro, overridable per category)", "Admin → Professionals"],
            ["Cancellation fees", "`cancellation_policies` rows", "Admin → Policies"],
            ["Late-arrival threshold", "`platform_settings.late_arrival_threshold_min` (default 15)", "Admin → Settings"],
            ["Extension increments", "`platform_settings.extension_options_minutes`", "Admin → Services"],
        ],
        widths=[1.75, 2.75, 2.2],
    )

    h2(doc, "7.4 Surge pricing")
    p(doc, "Surge is **opt-in** and off by default (`platform_settings.surge_enabled = false`). When enabled it is a bounded multiplier, not a free-form number.")
    code(
        doc,
        """
-- demand_index recomputed by /api/cron/demand-index (every 5 min), stored per locality+service
-- and read by the pricing function. Bounded so a bug can never produce an absurd price.
SELECT service_id,
       locality_id,
       GREATEST(0.50, LEAST(2.00, 1.00 + (open_requests - supply) * 0.15)) AS demand_index
FROM (
  SELECT b.service_id, s.locality_id,
         count(*) FILTER (WHERE b.status IN ('paid','searching','assigned')) AS open_requests,
         count(DISTINCT pr.id)                                          AS supply
  FROM bookings b
  JOIN service_areas s ON s.service_id = b.service_id AND s.is_active
  LEFT JOIN booking_assignments a ON a.booking_id = b.id AND a.status = 'accepted'
  LEFT JOIN professionals pr       ON pr.id = a.professional_id
  WHERE b.created_at > now() - interval '2 hours'
  GROUP BY 1, 2
) t;
""",
    )
    bullets(
        doc,
        [
            "A surge multiplier is applied only to **new** quotes; a booking already paid keeps its locked price forever.",
            "Surge is never applied retroactively and never applied without an itemised line named `SURGE` on the breakdown.",
            "The multiplier is clamped to `[0.50, 2.00]` at both the rule level and the calculation level.",
            "Regional compliance: some jurisdictions cap surge and require advance notice. `platform_settings.surge_max_factor` (default 1.50) enforces the cap; `surge_notice_minutes` (default 60) forces disclosure that far ahead.",
        ],
    )

    h2(doc, "7.5 Commission and earnings split")
    table(
        doc,
        ["Term", "Meaning", "Default"],
        [
            ["`taxable_amount`", "What the platform actually operated on, after discount", "subtotal + fees − discount"],
            ["`commission_pct`", "Professional's platform commission", "0.20 (per professional, overridable)"],
            ["`professional_gross`", "Professional's earnings for the job", "taxable × (1 − commission)"],
            ["`platform_revenue`", "Platform take", "platform_fee + tax + commission"],
            ["Payment hold", "Earnings are not withdrawable immediately", "`earnings_hold_hours` = 24"],
            ["Payout cadence", "Weekly, aggregated per professional", "`payout_weekday` = Monday"],
        ],
        widths=[1.7, 3.2, 1.8],
    )

    # ── 8. Booking state machine ──────────────────────────────────────────
    page_break(doc)
    h1(doc, "8. Booking State Machine")

    h2(doc, "8.1 Status enum")
    code(
        doc,
        """
CREATE TYPE booking_status AS ENUM (
  'draft',                 -- built in the client, not yet submitted
  'payment_pending',       -- payment order created, awaiting verification
  'paid',                  -- Razorpay signature/webhook verified
  'searching',             -- matching engine running, offers fanning out
  'assigned',              -- a professional holds an unexpired offer
  'accepted',              -- professional accepted the job
  'on_the_way',            -- professional started travelling
  'arrived',               -- professional at the address, awaiting OTP
  'otp_verified',          -- OTP consumed (transitional, immediately becomes in_progress)
  'in_progress',           -- timer running
  'extension_requested',   -- customer asked for more time, awaiting professional
  'completed',             -- professional ended the service
  'cancelled',             -- cancelled by customer, professional, ops or system
  'refund_pending',        -- cancellation with money to return
  'refunded',              -- refund completed at the gateway
  'disputed',              -- a support ticket flagged the booking
  'no_show',               -- nobody attended
  'closed'                 -- rated / archived; terminal
);
""",
    )

    h2(doc, "8.2 Legal transitions")
    p(doc, "Enforced twice: by the client-facing API guard and by a Postgres trigger, so a direct `supabase.from('bookings').update(...)` from a browser with a permissive policy can still never produce an illegal state.")
    table(
        doc,
        ["From", "To", "Actor", "Guard"],
        [
            ["draft", "payment_pending", "customer", "quote token valid, address serviceable"],
            ["payment_pending", "paid", "system", "verified gateway signature / webhook"],
            ["payment_pending", "cancelled", "customer|system", "gateway reports no capture, or 15-min order expiry"],
            ["paid", "searching", "system", "assignment requested"],
            ["searching", "assigned", "system", "offer sent and unexpired"],
            ["searching", "cancelled", "system", "`search_expires_at` passed → auto refund"],
            ["searching", "refund_pending", "system", "instant SLA exhausted"],
            ["assigned", "accepted", "professional", "offer still valid, pro still online"],
            ["assigned", "searching", "system", "offer expired or professional declined"],
            ["accepted", "on_the_way", "professional", "location ping received"],
            ["on_the_way", "arrived", "professional", "geofence within `arrival_radius_m` OR manual check-in"],
            ["arrived", "in_progress", "system", "OTP verified → `started_at` stamped, timer armed"],
            ["in_progress", "extension_requested", "customer", "next booking collision check passes"],
            ["extension_requested", "in_progress", "system", "extension paid → `duration_minutes` increased"],
            ["in_progress", "completed", "professional", "`ended_at` stamped, actual duration recorded"],
            ["paid..accepted", "cancelled", "customer", "cancellation policy fee computed"],
            ["accepted..in_progress", "cancelled", "ops|support", "documented reason required"],
            ["accepted..in_progress", "disputed", "customer", "ticket attached"],
            ["cancelled", "refund_pending", "system", "amount to refund > 0"],
            ["refund_pending", "refunded", "system", "gateway refund confirmed"],
            ["completed", "closed", "customer", "rating submitted, or 7 days elapsed"],
            ["any", "`—`", "—", "Any other transition is rejected with `ILLEGAL_TRANSITION`"],
        ],
        widths=[1.25, 1.35, 1.0, 3.1],
        font_size=8.5,
    )

    code(
        doc,
        """
-- 0011_booking_state_machine.sql
CREATE OR REPLACE FUNCTION enforce_booking_transition() RETURNS trigger AS $$
DECLARE
  allowed text[];
BEGIN
  allowed := CASE NEW.status
    WHEN 'payment_pending'   THEN ARRAY['draft','cancelled']
    WHEN 'paid'              THEN ARRAY['payment_pending','refund_pending']
    WHEN 'searching'         THEN ARRAY['paid','assigned']
    WHEN 'assigned'          THEN ARRAY['searching']
    WHEN 'accepted'          THEN ARRAY['assigned','refund_pending']
    WHEN 'on_the_way'        THEN ARRAY['accepted','refund_pending']
    WHEN 'arrived'           THEN ARRAY['on_the_way','refund_pending']
    WHEN 'otp_verified'      THEN ARRAY['arrived']
    WHEN 'in_progress'       THEN ARRAY['otp_verified','extension_requested']
    WHEN 'extension_requested' THEN ARRAY['in_progress']
    WHEN 'completed'         THEN ARRAY['in_progress','otp_verified']
    WHEN 'cancelled'         THEN ARRAY['draft','payment_pending','paid','searching','assigned',
                                          'accepted','on_the_way','arrived','extension_requested']
    WHEN 'refund_pending'    THEN ARRAY['cancelled','paid','accepted','on_the_way','arrived','disputed']
    WHEN 'refunded'          THEN ARRAY['refund_pending']
    WHEN 'disputed'          THEN ARRAY['accepted','on_the_way','arrived','in_progress','completed']
    WHEN 'closed'            THEN ARRAY['completed','refunded','no_show']
    ELSE ARRAY[]::text[]
  END;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NOT (OLD.status::text = ANY(allowed)) THEN
    RAISE EXCEPTION 'ILLEGAL_TRANSITION % -> % on booking %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO booking_status_history (booking_id, from_status, to_status, actor_id, actor_role, note)
  VALUES (NEW.id, OLD.status, NEW.status,
          auth.uid(), auth.jwt() ->> 'role', current_setting('app.transition_note', true));

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_booking_transition
  BEFORE UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_transition();
""",
        caption="The trigger is the last line of defence. Every legal transition is also written to booking_status_history automatically.",
    )

    # ── 9. Matching ───────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "9. Availability & Matching Engine")

    h2(doc, "9.1 Availability model")
    p(doc, "Availability is **derived**, never stored as a boolean. It is a function of:")
    bullets(
        doc,
        [
            "The address's resolved `locality_id`.",
            "An active `service_areas` row for (locality, service).",
            "The service's `prep_minutes` lead time and the platform's `instant_lead_minutes`.",
            "The requested duration versus `service_durations` and `max_booking_minutes`.",
            "Working hours: the professional's `professional_working_hours` for that weekday, minus `professional_time_off`.",
            "Live supply: professionals with the required skill who are online and not already reserved for an overlapping window.",
            "The professional's `max_active_jobs` and the locality's `slot_capacity`.",
        ],
    )

    h2(doc, "9.2 Candidate query")
    code(
        doc,
        """
-- Called from POST /api/bookings/[id]/assign (service-role connection, inside a transaction).
-- FOR UPDATE SKIP LOCKED is what makes concurrent assignment safe: two simultaneous
-- assignment runs simply walk past each other's locked rows instead of blocking.
WITH need AS (
  SELECT b.id, b.address_id, b.scheduled_start_at, b.scheduled_end_at, b.duration_minutes
  FROM bookings b WHERE b.id = $1
),
geo AS (
  SELECT a.lat, a.lng, l.id AS locality_id FROM need n
  JOIN addresses a ON a.id = n.address_id
  JOIN localities l ON lower(l.name) = lower(a.area)
),
candidates AS (
  SELECT pr.id,
         pr.rating,
         pr.acceptance_rate,
         pr.completed_jobs,
         (SELECT count(*) FROM professional_skills sk
           WHERE sk.professional_id = pr.id
             AND sk.service_id IN (SELECT service_id FROM booking_items WHERE booking_id = (SELECT id FROM need))
         ) AS skill_hits
  FROM professionals pr
  CROSS JOIN geo g
  WHERE pr.verification_status = 'verified'
    AND pr.training_status = 'completed'
    AND pr.availability_status IN ('online','busy')
    AND NOT EXISTS (SELECT 1 FROM professionals_suspended s WHERE s.professional_id = pr.id)
  HAVING skill_hits = (SELECT count(DISTINCT service_id) FROM booking_items WHERE booking_id = (SELECT id FROM need))
)
SELECT c.id,
       (ST_Distance(
          ST_SetSRID(ST_MakePoint(pr.current_lng, pr.current_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(g.lat, g.lng), 4326)::geography) / 1000)          AS distance_km,
       -- score: lower distance is better, everything else higher is better
       round(
         ( 40.0 * (1 - LEAST(1, distance_km / 15.0))
         + 20.0 * (COALESCE(c.rating,0) / 5.0)
         + 15.0 * COALESCE(c.acceptance_rate, 0.5)
         + 10.0 * LEAST(1, COALESCE(c.completed_jobs,0) / 200.0)
         + 15.0 * COALESCE((SELECT 1 FROM favourites f
                            WHERE f.customer_id = $2 AND f.target_type = 'professional'
                              AND f.target_id = c.id), 0)
       , 2) AS score,
       row_number() OVER (ORDER BY (
         ( 40.0 * (1 - LEAST(1,
             (ST_Distance(ST_SetSRID(ST_MakePoint(pr.current_lng, pr.current_lat),4326)::geography,
                          ST_SetSRID(ST_MakePoint(g.lat, g.lng),4326)::geography)/1000) / 15.0))
         + 20.0 * (COALESCE(c.rating,0)/5.0)
         + 15.0 * COALESCE(c.acceptance_rate,0.5)) DESC)) AS rank
FROM candidates c
JOIN professionals pr ON pr.id = c.id
CROSS JOIN geo g
WHERE NOT EXISTS (
        SELECT 1 FROM professional_schedule ps
        WHERE ps.professional_id = c.id
          AND ps.status IN ('reserved','in_progress')
          AND tstzrange(ps.starts_at, ps.ends_at) && tstzrange(win.s, win.e)
      )
  , LATERAL (SELECT n.scheduled_start_at AS s, n.scheduled_end_at AS e FROM need n) win
ORDER BY rank
LIMIT $3;   -- default 10
""",
        caption="Ranked candidates. `score` is persisted on booking_assignments for post-hoc quality analysis, and is never returned to customers.",
    )

    h2(doc, "9.3 Offer fan-out")
    diagram(
        doc,
        """
booking status = searching
        |
        v
round 1: top 6 candidates by score, within 12 km
        |  offer window = 90 s
        |  -> one accepts   => booking.assigned
        |  -> all decline/expire
        v
round 2: next 10 candidates, radius widened to 18 km, window 90 s
        |  -> one accepts   => booking.assigned
        |  -> all decline/expire
        v
round 3: city-wide pool, window 120 s
        |
        v
exhausted  =>  booking.refund_pending  =>  auto full refund  =>  customer notified
""",
    )
    kv_table(
        doc,
        [
            ("`offer_window_seconds`", "Seconds an offer stays live (default 90)"),
            ("`offer_batch_size`", "Candidates per round (default 6)"),
            ("`offer_radius_km`", "Initial search radius (default 12)"),
            ("`offer_radius_growth`", "Radius multiplier per round (default 1.5)"),
            ("`search_expires_at`", "Hard deadline; the cron sweeper cancels anything past it"),
            ("`max_assignments`", "Total offers before exhaustion (default 3 rounds)"),
        ],
        label_width=2.4,
        value_width=4.3,
    )

    h2(doc, "9.4 Double-assignment prevention (the hard part)")
    p(doc, "This is enforced at the database level, not in application code, so no race, retry, or second deploy can break it.")
    code(
        doc,
        """
-- 0012_assignment_integrity.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. A professional's calendar can never contain overlapping reserved windows.
ALTER TABLE professional_schedule
  ADD CONSTRAINT professional_no_overlap
  EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('reserved', 'in_progress'));

-- 2. A booking can be held by at most one professional at a time.
CREATE UNIQUE INDEX uniq_active_assignment_per_booking
  ON booking_assignments (booking_id)
  WHERE status IN ('offered', 'accepted');

-- 3. Advisory lock serialises the assignment transaction per booking.
--    (Taken with pg_advisory_xact_lock so it releases automatically on commit/rollback.)
SELECT pg_advisory_xact_lock(hashtext('assign:' || $1));

-- 4. Claim an offer atomically: the WHERE on status is the compare-and-swap.
UPDATE booking_assignments
   SET status = 'accepted', responded_at = now()
 WHERE id = $1 AND status = 'offered' AND expires_at > now()
 RETURNING *;
-- 0 rows => somebody else already took it. Client gets 409 ASSIGNMENT_TAKEN.
""",
    )

    h2(doc, "9.5 Smart matching and favourites")
    bullets(
        doc,
        [
            "A customer's favourite professionals get a **+15 score bonus**, not a guarantee.",
            "A previously-served professional gets a small bonus via `booking_assignments.was_repeat` and is also shown as \"Book again\" on the home screen.",
            "Ratings are **floored, not filtered**: a 3.2-rated professional near the customer can still outrank a 4.9 professional 15 km away, but a professional below `platform_settings.min_rating_threshold` (default 3.0) is not offered at all.",
            "New professionals get an exploration bonus (`new_pro_bonus`, default +5) so the marketplace is not starved of fresh supply.",
        ],
    )

    # ── 10. OTP & timer ───────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "10. OTP Check-In, Service Timer & Extensions")

    h2(doc, "10.1 OTP design")
    table(
        doc,
        ["Parameter", "Default", "Where"],
        [
            ["Length", "4 digits", "`platform_settings.service_otp_length`"],
            ["TTL", "10 minutes", "`platform_settings.service_otp_ttl_minutes`"],
            ["Max attempts", "3", "`platform_settings.service_otp_max_attempts`"],
            ["Attempt lockout", "15 min after 3 failures", "`platform_settings.service_otp_lockout_minutes`"],
            ["Storage", "SHA-256 hash only, never plaintext", "`bookings.otp_hash`"],
            ["Rotate on", "every booking; re-issue on explicit customer request", "—"],
            ["Regeneration", "max 3 per booking, then support must re-arm", "`bookings.otp_generations`"],
        ],
        widths=[1.6, 2.0, 3.1],
    )
    code(
        doc,
        """
-- The customer sees a 4-digit code; the professional types it in.
-- The hash is the only thing persisted, and comparison is constant-time via the DB.
UPDATE bookings
   SET status = 'otp_verified',
       otp_verified_at = now(),
       -- Server clock, always. The phone's clock is never consulted.
       started_at       = now(),
       ends_at          = now() + make_interval(mins => duration_minutes)
 WHERE id = $1
   AND status = 'arrived'
   AND otp_hash = encode(digest($2, 'sha256'), 'hex')
   AND otp_expires_at > now()
   AND otp_attempts < $3
 RETURNING started_at, ends_at;
-- 0 rows => distinguish in logs only; the client always sees "Invalid or expired code".
""",
    )
    note(
        doc,
        "The customer's OTP screen is a *display*, never a fetch that reveals the value to the "
        "professional's device. The professional's app only ever sends an attempt. The literal code "
        "is shown on the customer's screen and is generated server-side at booking creation time, so "
        "it exists before anyone arrives.",
    )

    h2(doc, "10.2 Service timer")
    p(doc, "The timer is rendered from server data, never counted locally.")
    code(
        doc,
        """
-- GET /api/bookings/:id  (fragment, polled every 15 s while in_progress)
{
  "status": "in_progress",
  "startedAt": "2026-09-26T12:32:00Z",
  "endsAt":   "2026-09-26T14:32:00Z",
  "serverNow": "2026-09-26T13:04:11Z",
  "remainingSeconds": 5270,
  "extendedMinutes": 30,
  "extensionAvailable": true
}

-- The client renders:  remaining = endsAt - serverNow  (not Date.now() - startedAt).
-- It re-syncs `serverNow` on every poll and applies clock-skew correction.
""",
    )
    bullets(
        doc,
        [
            "At `remaining = 15 min` the professional receives a `SERVICE_ENDING_SOON` notification.",
            "At `remaining = 0` the booking does **not** auto-complete; the professional must confirm completion. A cron nudge fires after 30 min of overrun.",
            "`actual_duration_minutes` is recorded on completion as `now() - started_at`, and drives the over/under-run analytics.",
        ],
    )

    h2(doc, "10.3 Extensions")
    steps(
        doc,
        [
            "Customer taps **Request extension** and picks 30 / 60 / 90 minutes (`extension_options_minutes`).",
            "`POST /api/bookings/:id/extend` runs a collision check: does the professional's next `professional_schedule` window leave room? Is the professional still online?",
            "If yes → `status = extension_requested`, a quote for the delta is returned, and the professional is notified with Accept / Decline.",
            "Customer pays the delta (Razorpay order for the extension amount only).",
            "On verified payment → `duration_minutes` increases, a new `ends_at` is computed, `professional_schedule.ends_at` is extended, and status returns to `in_progress`.",
            "If the professional declines or the next job collides → the request is rejected with a clear reason and no money moves.",
        ],
    )
    callout(
        doc,
        "Never charge for a declined extension",
        "The extension quote is created with `status = 'created'` and only becomes capturable after the "
        "professional accepts. A declined extension is marked `expired`. No orphaned payment intents.",
    )

    h2(doc, "10.4 Completion")
    p(doc, "`POST /api/professionals/jobs/:id/complete` stamps `ended_at`, computes `actual_duration_minutes`, moves the booking to `completed`, closes the professional's schedule row, writes the earning to `professional_earnings` (status `pending`), and fires `BOOKING_COMPLETED` to the customer and `EARNING_CREATED` to the professional.")

    # ── 11. Cancellation ───────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "11. Cancellation, No-Show & Reassignment")

    h2(doc, "11.1 Customer cancellation ladder")
    p(doc, "Configurable per service in `cancellation_policies`; the rows are evaluated from the most specific match upward.")
    table(
        doc,
        ["Hours before start", "Fee type", "Default value", "Rationale"],
        [
            ["≥ 24 h", "`free`", "0%", "No cost — encourage rescheduling instead of cancelling"],
            ["6 – 24 h", "`percentage`", "10%", "Covers the professional's reserved time"],
            ["2 – 6 h", "`percentage`", "25%", "Harder to refill the slot"],
            ["< 2 h", "`percentage`", "50%", "Near-instant loss of supply"],
            ["After `arrived`", "`percentage`", "100%", "The visit is treated as consumed"],
        ],
        widths=[1.5, 1.35, 1.25, 2.6],
    )
    code(
        doc,
        """
-- Cancellation fee resolution: most specific (service + hours) wins, then service, then global.
WITH policy AS (
  SELECT * FROM cancellation_policies
   WHERE is_active
     AND (service_id IS NULL OR service_id = $1)
     AND $2 <= hours_before            -- hours_before is the *ceiling* of the band
   ORDER BY (service_id IS NOT NULL) DESC, hours_before ASC
   LIMIT 1
)
SELECT CASE fee_type
         WHEN 'free'       THEN 0
         WHEN 'percentage' THEN round($3 * fee_value, 2)
         WHEN 'fixed'      THEN LEAST(fee_value, $3)
       END AS fee_amount
FROM policy;

-- Refund = total_amount - fee_amount  (floored at 0), routed to the wallet if the
-- original method is no longer refundable.
""",
    )

    h2(doc, "11.2 Professional cancellation and reassignment")
    diagram(
        doc,
        """
professional declines / cancels / goes offline mid-job
        |
        v
booking -> searching  (status recorded in booking_status_history)
recompute candidate pool excluding the original professional
        |
        +--> new offer accepted --> continue normally
        |
        +--> pool exhausted
                |
                v
        status = refund_pending
        full automatic refund (fee waived - not the customer's fault)
        customer notified with apology + promo credit (optional, platform_settings.goodwill_credit)
                |
                v
        status = refunded
""",
    )
    bullets(
        doc,
        [
            "A professional-initiated cancellation increments `professionals.cancelled_jobs`.",
            "Three professional cancellations in a rolling 30 days triggers `professionals.probation_until = now() + 7 days` and hides the professional from matching.",
            "A professional who fails to arrive within `late_arrival_threshold_min` (default 15) of `on_the_way` → ETA + arrival timestamps are both written and an ops alert is raised.",
            "No-show by the customer: after `on_the_way + no_show_after_min` (default 45) with no OTP, the professional may mark `no_show`; the full amount is forfeited and a support ticket is auto-opened for the customer to appeal.",
        ],
    )

    h2(doc, "11.3 Rescheduling")
    bullets(
        doc,
        [
            "Free for `paid` bookings; a fee (same ladder as cancellation) once the professional is assigned, because the calendar has already been committed.",
            "Re-runs the full availability generator and re-verifies the professional's calendar; if the original professional is unavailable, the booking is **re-matched** and the customer is told before confirming.",
            "The reschedule is a single transaction that updates the booking, extends/shrinks the `professional_schedule` row, and re-evaluates any surge multiplier.",
        ],
    )

    # ── 12. Payments ──────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "12. Payments, Refunds, Wallet & Invoices")

    h2(doc, "12.1 Payment lifecycle")
    diagram(
        doc,
        """
POST /api/payments/create-order
        |
        v
payments row: status = created   (gateway_order_id set)
        |
        v
client opens Razorpay Checkout
        |
        +--> user closes checkout ......... status = failed (reason: abandoned)
        |
        +--> checkout success callback ... (UNTRUSTED - only used to poll)
        |
        v
POST /api/webhooks/razorpay  (or payment.captured event)
   verify HMAC-SHA512 over RAW body with RAZORPAY_WEBHOOK_SECRET
   verify amount + currency + gateway_order_id against our payments row
        |
        +--> invalid signature --> 400, no state change, alert raised
        |
        v
payments row: status = success
booking:      payment_pending -> paid
matching engine starts
""",
    )
    callout(
        doc,
        "Hard rule",
        "The client-side Razorpay success handler never mutates a booking. It only triggers a refetch. "
        "The webhook is the sole authority. If the webhook is late, the booking shows \"Confirming "
        "payment…\" — it never shows a false \"Paid\".",
    )

    h2(doc, "12.2 Payments table")
    table(
        doc,
        ["Column", "Type", "Notes"],
        [
            ["`id`, `booking_id`, `customer_id`", "uuid", "`booking_id` indexed"],
            ["`purpose`", "enum", "`booking | extension | wallet_topup | penalty`"],
            ["`gateway`", "text", "`razorpay` in v1; column exists so PayU/Stripe can be added"],
            ["`gateway_order_id`", "text unique", "Our `receipt` sent to Razorpay"],
            ["`gateway_payment_id`", "text", "Set on verified capture"],
            ["`gateway_signature`", "text", "Stored for dispute evidence; never logged"],
            ["`amount`, `currency`", "numeric(12,2), char(3)", "Amounts stored in paise-safe decimals"],
            ["`fee`, `tax`", "numeric(12,2)", "Component split for reconciliation"],
            ["`method`", "enum", "`card | upi | netbanking | wallet | emi | cod`"],
            ["`status`", "enum", "`created | pending | success | failed | refunded | partially_refunded`"],
            ["`idempotency_key`", "text unique", "Deduplicates retried create-order calls"],
            ["`captured_at`, `created_at`, `updated_at`", "timestamptz", "Reconciliation window"],
        ],
        widths=[2.15, 1.6, 2.9],
    )

    h2(doc, "12.3 Refunds")
    bullets(
        doc,
        [
            "`refunds` rows track `requested_by`, `reason_code`, `amount`, `gateway_refund_id`, `status` (`requested → processing → completed | failed`).",
            "Automatic refunds: paid-but-unmatched, professional-cancelled, ops-cancelled, goodwill credit.",
            "Manual refunds: admin or support, subject to `platform_settings.support_refund_limit` (default ₹500). Above that, admin approval is required and the request is queued for a second approver.",
            "Refunds route to the **wallet** by default when the original instrument is not refundable (expired card, closed UPI handle), which is always disclosed to the customer at cancellation time.",
            "A failed gateway refund moves the amount to wallet credit and raises an ops ticket automatically.",
        ],
    )

    h2(doc, "12.4 Wallet")
    p(doc, "An append-only ledger, never a mutable balance field on the customer row.")
    code(
        doc,
        """
-- wallet_transactions is INSERT-ONLY. RLS blocks UPDATE and DELETE outright.
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_txn_no_update ON wallet_transactions
  FOR UPDATE USING (false);
CREATE POLICY wallet_txn_no_delete ON wallet_transactions
  FOR DELETE USING (false);

-- balance is always derived; the wallets.balance column is a cache maintained in the same tx.
CREATE OR REPLACE FUNCTION apply_wallet_delta(p_wallet uuid, p_type wallet_txn_type,
                                               p_amount numeric, p_ref text, p_desc text)
RETURNS numeric AS $$
DECLARE v_new numeric;
BEGIN
  INSERT INTO wallet_transactions (wallet_id, type, amount, ref_type, ref_id, description)
  VALUES (p_wallet, p_type, p_amount, split_part(p_ref,':',1), split_part(p_ref,':',2), p_desc);

  UPDATE wallets SET balance = balance + CASE WHEN p_type = 'credit' THEN p_amount ELSE -p_amount END
   WHERE id = p_wallet RETURNING balance INTO v_new;

  IF v_new < 0 THEN
    RAISE EXCEPTION 'WALLET_OVERDRAFT p_wallet=% p_amount=%', p_wallet, p_amount;
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql;
""",
    )

    h2(doc, "12.5 Invoices")
    p(doc, "`invoices` rows are generated on completion and on refund. The invoice number format is `INV/{FY}/{YYYY}/{zero-padded sequence}` and is unique. Rendering is a server-side HTML template printed to PDF via the browser's print pipeline in v1 — no headless browser dependency. The stored row is the legal record; the PDF is a rendering of it.")

    # ── 13. Ratings ───────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "13. Ratings, Reviews & Trust")

    bullets(
        doc,
        [
            "A rating can be submitted once per booking, only by the customer, only within 7 days of `completed`, and only if the booking is not `disputed`.",
            "Overall score 1–5, plus optional sub-scores: professionalism, quality, punctuality, behaviour, cleanliness. Sub-scores are required for any overall score ≤ 2 so support has something to act on.",
            "Free-text review is capped at 1000 characters and is scanned for phone numbers / abuse words before publishing.",
            "`professionals.rating` and `rating_count` are denormalised and recomputed on each insert inside the same transaction; a nightly cron also recomputes from `ratings` to self-heal drift.",
            "Professionals may respond once per review (250 characters). No editing of customer reviews by staff — moderation only hides, and every hide is audit-logged.",
            "Auto-moderation hides reviews containing phone numbers, URLs, or slurs, and queues them for review.",
        ],
    )

    # ── 14. Support ───────────────────────────────────────────────────────
    h1(doc, "14. Support, Disputes & Safety")

    h2(doc, "14.1 Ticket model")
    table(
        doc,
        ["Field", "Values", "Notes"],
        [
            ["`category`", "enum", "`professional_issue | payment_issue | booking_issue | refund | missing_item | property_damage | safety_issue | other`"],
            ["`priority`", "enum", "`low | normal | high | urgent` — auto-computed, staff may raise it"],
            ["`status`", "enum", "`open | in_progress | waiting_for_customer | resolved | closed`"],
            ["`booking_id`", "uuid nullable", "A ticket without a booking is general enquiry"],
            ["`assigned_to`", "uuid nullable", "Support agent; `unassigned` queue is the default"],
            ["`attachments`", "`support_messages.attachment_url`", "Photos of damage etc., in the `support-media` bucket"],
            ["`sla_due_at`", "timestamptz", "Derived from category + priority at creation"],
        ],
        widths=[1.35, 1.6, 3.75],
    )

    h2(doc, "14.2 Dispute workflow")
    steps(
        doc,
        [
            "Customer opens a ticket from booking detail; if `category` is damage or safety, the booking moves to `disputed` automatically.",
            "`safety_issue` additionally creates a `sos_incidents` row, pages the on-call ops channel, and freezes payout for that booking.",
            "Support requests evidence (photos, chat export); the professional is notified and given a response window (`platform_settings.dispute_response_hours`, default 48).",
            "Resolution is one of: no action, partial refund, full refund, re-service, warning, suspension, ban. Every resolution writes an `audit_logs` row with `old_value`/`new_value`.",
            "Payout is released or clawed back, and the outcome is explained to both parties in the ticket thread.",
        ],
    )

    h2(doc, "14.3 Emergency / SOS")
    bullets(
        doc,
        [
            "A persistent **Emergency** action is present on every active booking screen.",
            "Pressing it captures GPS, opens a priority ticket, notifies the ops on-call channel, and displays the professional's name and phone to the customer for direct escalation.",
            "The professional's device receives a `SAFETY_ALERT` push and is required to acknowledge within 2 minutes; non-acknowledgement pages a human.",
            "Professionals never see the customer's phone number or full address beyond the service locality until they accept — and after acceptance they see only what the job requires.",
        ],
    )

    h2(doc, "14.4 Chat")
    bullets(
        doc,
        [
            "A booking-scoped thread in `chat_threads` / `chat_messages`, delivered over Supabase Realtime.",
            "`kind = 'system'` messages are server-authored and immutable: \"Priya accepted your booking\", \"Priya is on the way\", \"Service started\", \"Service completed\".",
            "Free text and images up to 2 MB. No voice notes, no links auto-rendered (URLs are shown as text, not links).",
            "Thread closes when the booking reaches `closed`. Content is retained for 90 days for dispute evidence, then purged.",
        ],
    )

    # ── 15. Growth ────────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "15. Coupons, Promotions, Referrals & Favourites")

    h2(doc, "15.1 Coupons")
    table(
        doc,
        ["Field", "Notes"],
        [
            ["`code`", "Unique, case-insensitive, uppercase-normalised on write"],
            ["`discount_type` / `discount_value`", "`percentage` or `fixed`"],
            ["`max_discount`", "Ceiling for percentage coupons; mandatory when `percentage`"],
            ["`min_booking_amount`", "Subtotal threshold"],
            ["`valid_from` / `valid_to`", "Inclusive date range; `valid_to` nullable"],
            ["`usage_limit` / `usage_count`", "Global cap; a partial redemption must not overshoot"],
            ["`per_user_limit`", "Default 1"],
            ["`applicable_services` / `applicable_cities`", "Empty array = all"],
            ["`first_time_only`", "Restricts to customers with zero prior completed bookings"],
            ["`max_discount_pct_of_total`", "Hard guard so a coupon can never zero out a booking (default 40%)"],
        ],
        widths=[2.2, 4.5],
    )
    note(
        doc,
        "Coupon validation happens server-side inside the quote, and redemption is written to "
        "`coupon_usage` in the **same transaction** as the booking. `usage_count` is incremented with "
        "`UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1 AND usage_count < usage_limit "
        "RETURNING id` — a zero-row result means the limit was hit, and the whole transaction rolls back.",
    )

    h2(doc, "15.2 Referrals")
    steps(
        doc,
        [
            "Every customer gets a `referral_code` on signup (e.g. `ARUSH25`).",
            "A new customer enters it at signup or first booking; stored on `customers.referred_by`.",
            "Reward is granted only after the referee's **first booking reaches `completed`** — this blocks the signup-farming loop.",
            "Rewards: referee gets a coupon, referrer gets wallet credit (`referral_reward_referrer` / `_referee`, both configurable).",
            "Anti-abuse: one referral per phone number, per device fingerprint, per payment instrument; self-referral (same device + same UPI) is auto-rejected and audit-logged.",
        ],
    )

    h2(doc, "15.3 Favourites and book-again")
    bullets(
        doc,
        [
            "`favourites` covers both `target_type = 'professional'` and `'service'`, unique per `(customer, target_type, target_id)`.",
            "\"Book again\" is derived, not stored: the customer's most recent `booking_items` for each service, shown on the home screen with the last-used address and the last-paid price.",
            "Favouriting a professional never locks the customer to that professional — availability always wins (see §9.5).",
        ],
    )

    # ── 16. Edge cases ────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "16. Edge Cases & Failure Handling")

    table(
        doc,
        ["#", "Scenario", "System behaviour", "Customer-facing result"],
        [
            ["1", "Customer pays, no professional available", "Search exhausts → `refund_pending` → auto full refund", "\"We're sorry — no professional was available. ₹X has been refunded.\""],
            ["2", "Professional accepts then cancels", "Reassignment cascade with the original professional excluded", "\"Finding you another professional…\""],
            ["3", "Customer closes the app mid-service", "Service continues server-side; nothing is tied to the client session", "Reopening shows the live timer"],
            ["4", "Network drops during service", "Server is the source of truth; professional's actions are retried with `Idempotency-Key`", "\"Reconnecting…\""],
            ["5", "Customer is double-charged", "`idempotency_keys` unique on `(scope, key)`; duplicate webhook is a no-op", "One charge, one booking"],
            ["6", "Professional tries to start without OTP", "`status` is not `arrived`, or hash mismatch → 403", "\"Enter the OTP from the customer to start\""],
            ["7", "Two devices edit the same booking", "`bookings.version` optimistic lock; second writer gets 409", "\"This booking was updated elsewhere. Refresh.\""],
            ["8", "Webhook arrives twice", "Payment already `success` → early return, logged as duplicate", "No double confirmation"],
            ["9", "Webhook never arrives", "Client polls `/api/payments/:id`; after 10 min ops alert fires", "\"Confirming payment…\" then a support nudge"],
            ["10", "Razorpay is down at checkout", "Order creation fails → retry banner; no booking row in a paid state", "\"Payments are temporarily unavailable\""],
            ["11", "OTP read out incorrectly 3×", "Lockout 15 min, both parties notified, ops alerted", "\"Too many incorrect attempts. Contact support.\""],
            ["12", "Address outside coverage", "`service_areas` has no active row", "\"We haven't launched in your area yet\" + waitlist signup"],
            ["13", "Geolocation denied", "Manual address entry; no coordinates → customer must drop a pin", "Inline validation on the map"],
            ["14", "Price changes between quote and pay", "Server re-prices; mismatch → `PRICE_CHANGED`", "Fresh breakdown, one tap to continue"],
            ["15", "Professional works past the slot end", "Overrun recorded; `next_job_late_min` penalty flag for analytics; next booking auto-notified", "Next customer notified proactively"],
            ["16", "Refund fails at the gateway", "Amount moved to wallet credit, ops ticket raised", "\"Refund is in your SmartHelp wallet\""],
            ["17", "Recurring cron re-runs", "`UNIQUE (series_id, occurrence_date)` makes it idempotent", "No duplicate bookings"],
            ["18", "Customer deletes address with future bookings", "Delete is blocked while future bookings reference it", "\"This address is used by 2 upcoming bookings\""],
            ["19", "Admin edits a service price mid-booking", "Locked bookings keep their quoted price; only new quotes change", "Existing booking price unchanged"],
            ["20", "Professional goes offline with a job at `arrived`", "Ops alert; booking held in `arrived` for 30 min then reassigned", "\"Your professional is delayed — we're on it\""],
            ["21", "Rating submitted twice", "`UNIQUE (booking_id)` on `ratings`", "Second submit updates, never duplicates"],
            ["22", "Timezone / DST (if expanded beyond IST)", "All timestamps stored `timestamptz`; city carries `time_zone`; slot maths is always done in the city's zone", "No off-by-one-hour bookings"],
        ],
        widths=[0.32, 1.5, 2.5, 2.4],
        font_size=8,
    )

    # ── 17. Analytics ─────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "17. Analytics & Reporting")

    h2(doc, "17.1 Customer analytics")
    bullets(
        doc,
        [
            "New vs returning customers per period.",
            "Bookings per customer, average order value, repeat-booking rate (≥ 2 completed bookings).",
            "Cancellation rate split by `cancellation_reason_code`.",
            "Coupon-attributed bookings and discount leakage.",
            "Wallet liability outstanding.",
        ],
    )

    h2(doc, "17.2 Professional analytics")
    bullets(
        doc,
        [
            "Jobs completed / cancelled / declined.",
            "Acceptance rate = `accepted offers / total offers`.",
            "Utilisation = `busy minutes / available working minutes`.",
            "Average travel distance and average on-time arrival delta (`arrived_at - scheduled_start_at`).",
            "Earnings: gross, commission, net, pending, paid.",
            "Rating distribution and sub-score trends (quality, punctuality, behaviour).",
        ],
    )

    h2(doc, "17.3 Business analytics")
    bullets(
        doc,
        [
            "GMV, net revenue, platform take, refund rate, goodwill credit issued.",
            "Bookings by day / weekday / hour (heatmap) — this is what drives staffing.",
            "Bookings by service, by category, by city, by locality.",
            "Funnel: quote created → payment started → paid → matched → accepted → arrived → completed.",
            "**Match health**: median time-to-match, offer acceptance rate, assignment exhaustion rate, reassignment rate.",
            "Supply health: online professionals, verified-but-inactive professionals, churn risk (no job in 14 days).",
        ],
    )
    note(
        doc,
        "The funnel is the most important operational dashboard. A drop between \"paid\" and "
        "\"matched\" is a supply problem; a drop between \"matched\" and \"arrived\" is a quality or "
        "punctuality problem. Ops triages from that funnel first, every morning.",
    )
