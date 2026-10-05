"""Part 3 — Technical architecture and the complete Supabase/PostgreSQL schema."""

from kit import (
    bullets,
    callout,
    cap,
    code,
    diagram,
    h1,
    h2,
    h3,
    h4,
    kv_table,
    note,
    p,
    page_break,
    steps,
    table,
)


def build(doc):
    # ── 21. Stack parity ──────────────────────────────────────────────────
    h1(doc, "21. Technology Stack — Exact SmartPOS Parity")

    callout(
        doc,
        "Rule",
        "SmartHelp uses the identical dependency set, versions, config files, and folder conventions "
        "as `smartpos-main`. If a capability is requested that the SmartPOS stack cannot serve, it is "
        "delivered with a **stack-native** mechanism (e.g. realtime via Supabase Realtime instead of "
        "a bespoke WebSocket server), never by introducing a new runtime.",
        fill="F1F5FF",
    )

    h2(doc, "21.1 Runtime and framework")
    table(
        doc,
        ["Layer", "Technology", "Version", "Role in SmartHelp"],
        [
            ["Framework", "Next.js App Router", "`^14.2.5`", "All four surfaces (public, customer, professional, admin) plus every API route"],
            ["UI runtime", "React", "`^18.3.1`", "Client components; `'use client'` at the top of every interactive file"],
            ["Language", "TypeScript", "`^5.5.3`", "`strict: true`, `moduleResolution: bundler`, `@/*` path alias"],
            ["Styling", "Tailwind CSS", "`^3.4.6`", "Token-driven; config copied verbatim (§18.4)"],
            ["Components", "shadcn/ui + Radix", "`default` style, slate base", "Full primitive set (§18.5)"],
            ["State (client)", "Zustand", "`^4.5.4`", "Booking cart, checkout draft, slot cache, professional job state"],
            ["Forms", "react-hook-form", "`^7.52.1`", "Every multi-field form"],
            ["Charts", "Recharts", "`^2.12.7`", "Admin analytics + professional earnings"],
            ["Toasts", "react-hot-toast", "`^2.4.1`", "`<Toaster position=\"top-center\" />` in the root layout"],
            ["Icons", "lucide-react", "`^0.441.0`", "All iconography"],
            ["Dates", "react-day-picker", "`^8.10.1`", "Scheduling calendar"],
            ["OTP", "input-otp", "`^1.2.4`", "Service OTP display + entry"],
            ["Sheets", "vaul + sheet", "`^0.9.1`", "Mobile bottom sheets"],
            ["Carousel", "embla-carousel-react", "`^8.1.0`", "Service image gallery"],
            ["Command", "cmdk", "`^1.0.0`", "Admin global search"],
            ["Resizable", "react-resizable-panels", "`^2.0.0`", "Admin KYC review / booking detail panes"],
            ["Email", "nodemailer", "`^9.0.3`", "Transactional email from Route Handlers"],
            ["Theme", "next-themes", "`^0.3.0`", "Present for parity; v1 ships light only (same as SmartPOS)"],
        ],
        widths=[1.05, 1.55, 0.95, 3.15],
        font_size=8.5,
    )

    h2(doc, "21.2 Backend-as-a-service")
    table(
        doc,
        ["Concern", "Service", "Usage"],
        [
            ["Primary database", "Supabase PostgreSQL", "All 47 tables, RLS, triggers, functions, `btree_gist`"],
            ["Authentication", "Supabase Auth", "Phone OTP (customer, professional), email + password (staff)"],
            ["Realtime", "Supabase Realtime", "Booking status channels, professional presence + location, chat"],
            ["Object storage", "Supabase Storage", "`service-media`, `pro-photos`, `kyc-documents`, `chat-media`, `support-media`, `invoices`"],
            ["Cron", "Vercel Cron → Next.js Route Handlers", "Search sweeper, recurring generation, reminders, payout runs, demand index"],
            ["Payments", "Razorpay", "Orders, signature verification, webhooks, refunds, route settlement"],
            ["SMS / WhatsApp", "Generic provider webhook (same `SMS_PROVIDER_URL` + `SMS_API_KEY` contract as SmartPOS)", "OTP delivery, status SMS"],
        ],
        widths=[1.35, 2.4, 2.95],
    )

    h2(doc, "21.3 `package.json` scripts and config files")
    code(
        doc,
        """
{
  "name": "smarthelp",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  }
}
""",
        caption="Identical to SmartPOS. `next.config.mjs` stays an empty `const nextConfig = {}`; `.eslintrc.json` is `{ \"extends\": \"next/core-web-vitals\" }`; `postcss.config.mjs` is `{ tailwindcss: {}, autoprefixer: {} }`.",
    )
    code(
        doc,
        """
// vercel.json — the SmartPOS cron pattern, extended to SmartHelp's schedule
{
  "crons": [
    { "path": "/api/cron/search-sweeper",        "schedule": "*/2 * * * *"  },
    { "path": "/api/cron/recurring-generate",    "schedule": "7 2 * * *"    },
    { "path": "/api/cron/service-reminders",     "schedule": "*/15 * * * *" },
    { "path": "/api/cron/demand-index",          "schedule": "*/5 * * * *"  },
    { "path": "/api/cron/rating-reminders",      "schedule": "13 19 * * *"  },
    { "path": "/api/cron/payout-run",            "schedule": "23 3 * * 1"   },
    { "path": "/api/cron/wallet-expiry",         "schedule": "41 2 * * *"   },
    { "path": "/api/cron/reconcile-payments",    "schedule": "*/30 * * * *" }
  ]
}
""",
    )

    h2(doc, "21.4 What replaced what in the original brief")
    p(doc, "The functional brief proposed a Java/Spring + Redis + WebSocket + mobile-app stack. Every requirement is retained; the mechanism is re-expressed in the SmartPOS stack. This table is the record of that translation.")
    table(
        doc,
        ["Brief asked for", "SmartHelp implements", "Notes"],
        [
            ["Java + Spring Boot REST API", "Next.js 14 Route Handlers in `app/api/**/route.ts`", "Same REST contract, one runtime, no separate deploy"],
            ["Spring Security + JWT", "Supabase Auth (JWT) + RLS + explicit route guards", "Stronger: the database is the policy engine, not the app"],
            ["Hibernate + JPA entities", "Typed row interfaces derived from the generated `Database` type", "Zero-ORM; schema is SQL and versioned"],
            ["PostgreSQL", "Supabase managed PostgreSQL", "Unchanged"],
            ["Redis (OTP, cache, locks, rate limit)", "Postgres: hashed OTP rows, `otp_attempts`, `pg_advisory_xact_lock`, `idempotency_keys`, `hashtext` bucketing, exclusion constraints", "No second datastore to operate or reconcile"],
            ["WebSocket server", "Supabase Realtime channels + Presence + Broadcast", "Managed, auto-scales, works with the anon/auth key model"],
            ["React Native customer + pro apps", "Responsive Next.js shells at `/customer` and `/professional`", "Same codebase, PWA-installable; native clients are a later additive surface"],
            ["Separate admin panel", "`/admin` routes inside the same app", "Shares types, auth and design system"],
            ["Razorpay", "Razorpay", "Unchanged — SmartPOS already integrates it, including webhooks"],
            ["S3 / Cloudinary", "Supabase Storage buckets + signed URLs", "One provider, one permission model, one dashboard"],
            ["Spring @Scheduled", "Vercel Cron → Route Handlers, guarded by `CRON_SECRET`", "Same pattern SmartPOS uses for subscription notifications"],
            ["JUnit / Mockito / Testcontainers", "Vitest + `pg` against a local Supabase, plus a manual test workbook", "See Part 6 for the testing strategy"],
            ["Admin-configurable business rules", "`pricing_rules`, `platform_settings`, `cancellation_policies`, `service_areas` tables + admin UI", "Not hardcoded, as required"],
        ],
        widths=[1.55, 2.5, 2.65],
        font_size=8.5,
    )

    # ── 22. Architecture ──────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "22. System Architecture")

    h2(doc, "22.1 Component diagram")
    diagram(
        doc,
        """
                            +--------------------------+
                            |      Vercel Edge / CDN   |
                            +------------+-------------+
                                         |
   +-----------------+       +---------+----------+        +------------------+
   |  Public web     |       |   Next.js 14 App   |        |  Vercel Cron     |
   |  (landing,      |       |   (RSC + Client    |        |  8 schedules     |
   |   catalogue)    +------>|    Components)      |<-------+  (CRON_SECRET)   |
   +-----------------+       |                    |        +------------------+
                             |  app/api/**/route  |
   +-----------------+       |  Handlers (Node)   |        +------------------+
   |  Customer shell |------>|                    |        |  Ops / Support   |
   |  /customer      |       +--------+-----------+        |  (internal)      |
   +-----------------+                |                    +------------------+
   +-----------------+                |
   |  Pro shell      |----------------+
   |  /professional  |
   +-----------------+
   +-----------------+
   |  Admin shell    |----------------+
   |  /admin         |
   +-----------------+
                                     |
              +----------------------+----------------------+
              |                      |                      |
    +---------v----------+  +--------v---------+  +----------v---------+
    |  Supabase          |  |  Razorpay        |  |  SMS / WhatsApp   |
    |  PostgreSQL + RLS  |  |  Orders, Refunds |  |  + Nodemailer SMTP |
    |  Auth              |  |  Webhooks        |  |  (provider URL)   |
    |  Realtime          |  +------------------+  +--------------------+
    |  Storage           |
    +---------+----------+
              |
              |  Supabase Realtime
              |  (booking channels, presence, chat)
              v
     Customer / Pro devices receive live updates
""",
    )

    h2(doc, "22.2 Data flow — booking creation to completion")
    diagram(
        doc,
        """
CLIENT            ROUTE HANDLER              SUPABASE              RAZORPAY
  |                     |                        |                     |
  |--POST /quote-------->|                        |                     |
  |                     |--read svc/areas/price-->|                     |
  |<--quoteToken+total--|                        |                     |
  |                     |                        |                     |
  |--POST /bookings---->|                        |                     |
  |  (Idempotency-Key)  |--BEGIN; insert booking->|                     |
  |                     |   status=draft;        |                     |
  |                     |--insert otp (hash)---->|                     |
  |                     |--insert status_history>|                     |
  |                     |--COMMIT-------------->|                     |
  |<--bookingId---------|                        |                     |
  |                     |                        |                     |
  |--POST /payments/create-order----------------->|                     |
  |                     |--insert payments(created)                     |
  |                     |--POST /orders-------------->|                  |
  |                     |<--order_id---------------------|             |
  |                     |--update payments(pending)->|                    |
  |<--gatewayOrderId----|                        |                     |
  |                     |                        |                     |
  |   [ Razorpay Checkout opens in-browser ]     |                     |
  |                     |                        |                     |
  |                     |<== POST /webhooks/razorpay (HMAC verified) ===|
  |                     |--verify sig + amount->|                     |
  |                     |--BEGIN: payments=success                      |
  |                     |       booking: payment_pending -> paid         |
  |                     |       matching: pg_advisory_xact_lock          |
  |                     |       rank candidates, insert offers          |
  |                     |       booking -> searching                    |
  |                     |--COMMIT--------------->|                     |
  |                     |                        |                     |
  |                     |--notify pro (Realtime + push + SMS)           |
  |<== Realtime: booking.assigned ================|                     |
  |                     |                        |                     |
  |   [ pro taps Accept ]                        |                     |
  |--POST .../respond--->|--UPDATE ... WHERE status='offered'  (CAS)    |
  |                     |--booking -> accepted    |                     |
  |<== Realtime: accepted =======================|                     |
  |                     |                        |                     |
  |   [ pro arrives, customer shows OTP ]        |                     |
  |--POST .../arrive---->|--geofence check        |                     |
  |--POST .../otp------->--hash compare, set started_at = now()        |
  |                     |--booking -> in_progress |                     |
  |<== Realtime: in_progress + startedAt/endsAt/serverNow ===========   |
  |                     |                        |                     |
  |--POST .../complete-->|--ended_at=now(), create earning            |
  |                     |--booking -> completed   |                     |
  |<== Realtime: completed ======================|                     |
""",
    )

    h2(doc, "22.3 Server-authoritative timer")
    p(doc, "The one rule that makes the timer trustworthy: **the client never counts; it subtracts two server timestamps.**")
    code(
        doc,
        """
// Server: the only place a timestamp is created
UPDATE bookings
   SET started_at = now(),                                -- DB clock
       ends_at    = now() + make_interval(mins => duration_minutes),
       status     = 'otp_verified'
 WHERE id = $1 AND status = 'arrived' AND otp_hash = encode(digest($2,'sha256'),'hex');

// Response includes the DB clock so the client can correct for drift
SELECT status, started_at, ends_at, now() AS server_now,
       GREATEST(0, EXTRACT(EPOCH FROM (ends_at - now())))::int AS remaining_seconds
  FROM bookings WHERE id = $1;

// Client: remaining = endsAt - serverNow, re-synced on every poll and on Realtime updates.
const [skew, setSkew] = useState(0);                       // ms
setSkew(new Date(res.serverNow).getTime() - Date.now());
const remaining = (new Date(b.endsAt).getTime() - (Date.now() + skew)) / 1000;
""",
    )
    note(
        doc,
        "A customer who changes their device clock cannot shorten or extend a service. A professional "
        "whose phone clock is wrong cannot start a service early. The database clock is the only clock.",
    )

    # ── 23. Folder structure ─────────────────────────────────────────────
    page_break(doc)
    h1(doc, "23. Project Structure")

    code(
        doc,
        """
smarthelp/
├── .env                          # see Part 7 - all keys documented
├── .env.local                    # local overrides, gitignored
├── .eslintrc.json                # { "extends": "next/core-web-vitals" }
├── .gitignore
├── components.json               # shadcn, copied verbatim from SmartPOS
├── next.config.mjs               # const nextConfig = {} ;
├── package.json                  # dependency set == SmartPOS
├── postcss.config.mjs            # { tailwindcss, autoprefixer }
├── tailwind.config.ts            # copied verbatim
├── tsconfig.json
├── vercel.json                   # 8 cron schedules
│
├── app/
│   ├── layout.tsx                # Inter, AuthProvider, <Toaster position="top-center" />
│   ├── globals.css               # design tokens, verbatim
│   ├── page.tsx                  # public landing
│   ├── login/page.tsx
│   ├── services/page.tsx
│   ├── services/[slug]/page.tsx
│   ├── book/[code]/page.tsx      # public shareable booking link
│   ├── join/page.tsx
│   ├── legal/{privacy,terms,refund,cancellation,safety}/page.tsx
│   │
│   ├── customer/
│   │   ├── layout.tsx            # AuthGuard(role=customer) + AppShell + bottom nav
│   │   ├── page.tsx              # Home
│   │   ├── services/page.tsx
│   │   ├── services/[slug]/page.tsx
│   │   ├── checkout/page.tsx
│   │   ├── bookings/page.tsx
│   │   ├── bookings/[id]/page.tsx
│   │   ├── wallet/page.tsx
│   ├── support/page.tsx
│   │   ├── support/[id]/page.tsx
│   │   ├── favourites/page.tsx
│   │   └── profile/page.tsx
│   │
│   ├── professional/
│   │   ├── layout.tsx            # AuthGuard(role=professional) + AppShell
│   │   ├── page.tsx
│   │   ├── jobs/page.tsx
│   │   ├── jobs/[id]/page.tsx
│   │   ├── earnings/page.tsx
│   │   ├── kyc/page.tsx
│   │   ├── availability/page.tsx
│   │   ├── training/page.tsx
│   │   └── profile/page.tsx
│   │
│   ├── admin/
│   │   ├── layout.tsx            # AuthGuard(role in admin|ops|support) + sidebar
│   │   ├── page.tsx              # Dashboard
│   │   ├── bookings/{page,[id],loading}.tsx
│   │   ├── professionals/{page,[id],loading}.tsx
│   │   ├── professionals/[id]/kyc-review/page.tsx
│   │   ├── customers/{page,[id]}/…
│   │   ├── services/{page,categories/[id],[id]}/…
│   │   ├── pricing/{page,rules,surge,commission,policies}/…
│   │   ├── payments/{page,refunds,payouts}/…
│   │   ├── coupons/page.tsx
│   │   ├── disputes/{page,[id]}/…
│   │   ├── support/{page,[id],sla}/…
│   │   ├── analytics/{page,funnel,supply,ratings}/…
│   │   ├── notifications/{page,templates}/…
│   │   ├── settings/{page,areas,features}/…
│   │   └── audit/page.tsx
│   │
│   ├── features/                 # all feature logic; pages are thin re-exports
│   │   ├── auth/{OtpLogin,Signup,RoleRedirect}.tsx
│   │   ├── landing/{Hero,CategoryPills,PopularServices,HowItWorks,Footer}.tsx
│   │   ├── customer/{Home,Browse,ServiceDetail,Checkout,BookingHistory,
│   │   │             BookingLive,Wallet,Favourites,Profile,Addresses}.tsx
│   │   ├── booking/{DurationPicker,SlotPicker,PriceBreakdown,BookingStatusBadge,
│   │   │            BookingTimeline,ServiceTimer,OtpPanel,ReviewDialog,InvoiceView}.tsx
│   │   ├── professional/{Home,JobList,JobDetail,OfferInbox,Earnings,Availability,
│   │   │                   Kyc,Training,Profile}.tsx
│   │   ├── admin/{Dashboard,BookingTable,BookingDetail,ProfessionalTable,KycReview,
│   │   │            CustomerTable,ServiceManager,PricingManager,PaymentTable,
│   │   │            RefundTable,PayoutTable,CouponManager,DisputeBoard,TicketBoard,
│   │   │            Analytics,TemplateManager,SettingsManager,AuditLog}.tsx
│   │   ├── chat/{ChatThread,ChatBubble,SystemMessage}.tsx
│   │   └── support/{TicketList,TicketThread,NewTicket}.tsx
│   │
│   └── api/                      # Route Handlers - see Part 4, section 25
│
├── components/
│   ├── ui/                       # shadcn primitives (verbatim) + LoadingSpinner,
│   │                             #   ImageUpload, ConfirmationDialog, EmptyState
│   ├── shell/{AppShell,Sidebar,BottomNav,PageHeader,AuthGuard,RoleBadge}.tsx
│   ├── service/{ServiceCard,ServiceGrid,ScopeAccordion,DurationPicker,PriceFrom}.tsx
│   ├── booking/{SlotPicker,PriceBreakdown,StatusBadge,Timeline,ServiceTimer,
│   │            OtpDisplay,OtpEntry,ReviewStars,TrackProfessional}.tsx
│   ├── professional/{ProCard,OfferCard,EarningsSummary,KycStepper,WorkingHoursEditor}.tsx
│   ├── admin/{StatCard,DataTable,FilterBar,FunnelChart,AuditTable,KycDocumentViewer}.tsx
│   ├── map/{AddressPicker,CoverageMap,LocationDot}.tsx
│   ├── chat/{ChatThread,ChatComposer}.tsx
│   └── subscription/…            # NOT used in SmartHelp (no SaaS gating)
│
├── contexts/
│   ├── AuthContext.tsx           # session, profile, role, capabilities, signIn/signOut
│   ├── BookingContext.tsx        # cart + checkout draft + live booking subscription
│   └── NotificationContext.tsx   # Realtime notification stream + toasts
│
├── hooks/
│   ├── use-booking.ts            # create/quote/cancel/reschedule/extend
│   ├── use-offers.ts             # professional offer inbox (Realtime + polling fallback)
│   ├── use-availability.ts       # slot generation
│   ├── use-realtime.ts           # channel subscribe helper (bookings, chat, presence)
│   ├── use-location.ts           # geolocation + reverse geocode
│   ├── use-countdown.ts          # server-synced countdown
│   └── use-toast.ts              # shadcn toast helper (present for parity)
│
├── lib/
│   ├── supabase.ts               # browser client + hand-maintained Database type
│   ├── supabaseServer.ts         # service-role client for Route Handlers
│   ├── utils.ts                  # cn(), formatCurrency(), formatDate()
│   ├── currency.ts               # FX cache (parity with SmartPOS)
│   ├── otp.ts                    # generate/verify/attempt helpers
│   ├── pricing.ts                # PURE pricing engine (shared by quote + completion)
│   ├── matching.ts               # PURE scoring function
│   ├── availability.ts           # PURE slot generator
│   ├── status.ts                 # booking_status -> { label, variant, colour }
│   ├── validation.ts             # zod-free validators used by both client and route
│   ├── receipt.ts                # invoice HTML renderer
│   ├── notifications.ts          # template rendering + dispatcher
│   ├── audit.ts                  # audit log writer
│   └── constants.ts              # routes, slot granularity, defaults
│
├── supabase/
│   ├── schema.sql                # consolidated, idempotent, rerunnable full schema
│   └── migrations/
│       ├── 0001_core_identity.sql
│       ├── 0002_geo.sql
│       ├── 0003_catalogue.sql
│       ├── 0004_service_areas_durations.sql
│       ├── 0005_professionals.sql
│       ├── 0006_professional_skills.sql
│       ├── 0007_service_catalogue_seed.sql
│       ├── 0008_addresses.sql
│       ├── 0009_booking_enum.sql
│       ├── 0010_bookings.sql
│       ├── 0011_booking_state_machine.sql
│       ├── 0012_assignment_integrity.sql
│       ├── 0013_professional_schedule.sql
│       ├── 0014_payments.sql
│       ├── 0015_refunds_wallet.sql
│       ├── 0016_coupons.sql
│       ├── 0017_ratings_favourites.sql
│       ├── 0018_recurring.sql
│       ├── 0019_support.sql
│       ├── 0020_chat_notifications.sql
│       ├── 0021_earnings_payouts.sql
│       ├── 0022_referrals_sos.sql
│       ├── 0023_settings_pricing_policies.sql
│       ├── 0024_audit_idempotency.sql
│       ├── 0025_rls_policies.sql
│       ├── 0026_realtime_publication.sql
│       ├── 0027_storage_buckets.sql
│       └── 0028_indexes_functions.sql
│
├── test/
│   ├── SmartHelp_Test_Suite.xlsx
│   ├── TEST_PLAN.md
│   ├── TEST_CONDITIONS.md
│   └── TEST_RESULTS.md
│
├── docs/
│   ├── README.md  ARCHITECTURE.md  DATABASE.md  API.md
│   ├── FEATURES.md  SECURITY.md  SETUP.md
│
└── public/
    ├── logo.svg  favicon.ico  og.png
    └── icons/…   # PWA icons for installability
""",
    )
    note(
        doc,
        "`app/features/**` holds the logic and `app/**/page.tsx` files are thin re-exports — exactly "
        "the SmartPOS convention. `components/<area>/X.tsx` shims exist only where SmartPOS had them "
        "for legacy import compatibility; SmartHelp does not need them and does not create them.",
    )

    # ── 24. Schema ───────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "24. Database Schema")

    p(doc, "47 tables across 9 domains, 28 numbered migrations. All SQL is idempotent (`IF NOT EXISTS`, `DO $$ … $$` for policies) so `supabase/schema.sql` can be re-run on a live project safely.")

    h2(doc, "24.1 Entity relationships")
    diagram(
        doc,
        """
  auth.users
      | 1:1
  profiles (role, status)
      |            |                     |
      | 1:1        | 1:1                | 1:1
  customers   professionals            staff (support/ops/admin live on profiles only)
      |            |
      |            +-- professional_documents      (kyc)
      |            +-- professional_skills         (n:m services)
      |            +-- professional_working_hours  (weekly template)
      |            +-- professional_time_off       (blackouts)
      |            +-- professional_schedule       (RESERVED WINDOWS - no overlap)
      |            +-- professional_earnings       -> payouts
      |            +-- booking_assignments         (offers)
      |            +-- chat_threads
      |
      +-- addresses (lat/lng, type, is_default)
      +-- bookings
      |     +-- booking_items             (n services, snapshot of name+price)
      |     +-- booking_status_history    (append only)
      |     +-- booking_assignments  n:1 -> professionals
      |     +-- payments  -> refunds
      |     +-- ratings
      |     +-- support_tickets -> support_messages
      |     +-- chat_threads   -> chat_messages
      |     +-- invoices
      |     +-- professional_earnings
      |     +-- coupon_usage  (n:1 -> coupons)
      |     +-- recurring_occurrences -> recurring_series
      |
      +-- wallets -> wallet_transactions  (append only)
      +-- favourites (polymorphic)
      +-- referrals
      +-- sos_incidents
      +-- reviews are inside ratings (comment column) + pro response

  cities -> localities -> service_areas (n:m localities x services)
  service_categories -> services -> service_tasks (included/excluded)
                                  -> service_images
                                  -> service_durations
                                  -> service_keywords  (search)

  platform_settings (kv)   pricing_rules   cancellation_policies
  notification_templates   notifications
  audit_logs   idempotency_keys   otp_requests
""",
    )

    h2(doc, "24.2 Core identity")
    code(
        doc,
        """
-- 0001_core_identity.sql
CREATE TYPE user_role   AS ENUM ('customer','professional','admin','support','ops','super_admin');
CREATE TYPE user_status AS ENUM ('active','suspended','blocked','deleted','pending_verification');

CREATE TABLE profiles (
  id                uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role              user_role   NOT NULL DEFAULT 'customer',
  status            user_status NOT NULL DEFAULT 'active',
  full_name         text        NOT NULL,
  phone             text        NOT NULL,
  phone_verified_at timestamptz,
  email             text,
  avatar_url        text,
  locale            text        NOT NULL DEFAULT 'en-IN',
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_phone_format CHECK (phone ~ '^\\+?[0-9]{10,15}$')
);

-- A phone number identifies exactly one human across the whole platform.
CREATE UNIQUE INDEX uniq_profiles_phone ON profiles (phone);
CREATE UNIQUE INDEX uniq_profiles_email ON profiles (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_profiles_role_status ON profiles (role, status);

CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  referral_code  text NOT NULL UNIQUE,
  referred_by    uuid REFERENCES customers(id) ON DELETE SET NULL,
  wallet_id      uuid,                       -- FK added in 0015
  total_bookings int NOT NULL DEFAULT 0,
  completed_bookings int NOT NULL DEFAULT 0,
  lifetime_value numeric(12,2) NOT NULL DEFAULT 0,
  cancelled_bookings int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_referral ON customers (referral_code);
CREATE UNIQUE INDEX uniq_customers_referral_per_profile ON customers (referral_code, profile_id);

-- updated_at maintenance
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_touch  BEFORE UPDATE ON profiles  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
""",
    )

    h2(doc, "24.3 Geography")
    code(
        doc,
        """
-- 0002_geo.sql
CREATE TABLE cities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  state            text NOT NULL,
  country          text NOT NULL DEFAULT 'India',
  country_code     char(2) NOT NULL DEFAULT 'IN',
  time_zone        text NOT NULL DEFAULT 'Asia/Kolkata',
  default_currency char(3) NOT NULL DEFAULT 'INR',
  pincode_prefixes text[] NOT NULL DEFAULT '{}',
  lat numeric(9,6), lng numeric(9,6),
  business_hours   jsonb NOT NULL DEFAULT '{"mon":{"open":"08:00","close":"21:00"},
                                           "tue":{"open":"08:00","close":"21:00"},
                                           "wed":{"open":"08:00","close":"21:00"},
                                           "thu":{"open":"08:00","close":"21:00"},
                                           "fri":{"open":"08:00","close":"21:00"},
                                           "sat":{"open":"08:00","close":"21:00"},
                                           "sun":{"open":"09:00","close":"20:00"}}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_cities_name_state ON cities (lower(name), lower(state));

CREATE TABLE localities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id    uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name       text NOT NULL,
  lat        numeric(9,6) NOT NULL,
  lng        numeric(9,6) NOT NULL,
  radius_km  numeric(5,2) NOT NULL DEFAULT 8.00,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_locality_per_city ON localities (city_id, lower(name));
CREATE INDEX idx_localities_geo ON localities USING gist (point(lng, lat));
""",
    )
    note(
        doc,
        "`lat`/`lng` columns are indexed with a GiST index over `point(lng, lat)` so \"find all "
        "localities within 5 km of me\" is an index scan rather than a sequential scan. The same "
        "pattern is used for professional live locations.",
    )

    h2(doc, "24.4 Catalogue")
    code(
        doc,
        """
-- 0003_catalogue.sql
CREATE TABLE service_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  icon_key   text NOT NULL,               -- lucide icon name, resolved in the UI
  image_url  text,
  sort_order int  NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE pricing_type AS ENUM ('hourly','flat','per_unit');

CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id       uuid NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE,
  short_description text,
  description       text,
  image_url         text,
  base_price        numeric(10,2) NOT NULL CHECK (base_price >= 0),
  pricing_type      pricing_type NOT NULL DEFAULT 'hourly',
  unit_label        text,                 -- 'kg' | 'piece' for per_unit
  unit_price        numeric(10,2),
  min_duration_min  int NOT NULL DEFAULT 30  CHECK (min_duration_min > 0),
  max_duration_min  int NOT NULL DEFAULT 360 CHECK (max_duration_min >= min_duration_min),
  prep_minutes      int NOT NULL DEFAULT 0,   -- lead time before a slot can start
  max_active_jobs   int NOT NULL DEFAULT 1,   -- concurrency cap for a single pro
  materials_included boolean NOT NULL DEFAULT false,
  materials_note    text,
  requires_photo_proof boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT per_unit_needs_unit CHECK (pricing_type <> 'per_unit' OR (unit_label IS NOT NULL AND unit_price IS NOT NULL))
);
CREATE INDEX idx_services_category_active ON services (category_id) WHERE is_active;

CREATE TABLE service_tasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('included','excluded')),
  label      text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);
CREATE INDEX idx_service_tasks_service ON service_tasks (service_id, kind, sort_order);

CREATE TABLE service_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  url        text NOT NULL,
  alt_text   text,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE service_keywords (
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  keyword    text NOT NULL,
  PRIMARY KEY (service_id, lower(keyword))
);
CREATE INDEX idx_service_keywords_kw ON service_keywords (lower(keyword));

-- 0004_service_areas_durations.sql
CREATE TABLE service_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locality_id   uuid NOT NULL REFERENCES localities(id) ON DELETE CASCADE,
  service_id    uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  lead_minutes  int  NOT NULL DEFAULT 0,
  slot_capacity int  NOT NULL DEFAULT 4,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (locality_id, service_id)
);
CREATE INDEX idx_service_areas_lookup ON service_areas (locality_id, service_id) WHERE is_active;

CREATE TABLE service_durations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  minutes          int  NOT NULL CHECK (minutes > 0),
  price            numeric(10,2),            -- flat override, nullable
  price_multiplier numeric(6,3),             -- or a multiplier on the hourly base
  is_active        boolean NOT NULL DEFAULT true,
  UNIQUE (service_id, minutes)
);
""",
    )

    h2(doc, "24.5 Professionals")
    code(
        doc,
        """
-- 0005_professionals.sql
CREATE TYPE verification_status AS ENUM ('not_submitted','submitted','in_review','verified','rejected','expired');
CREATE TYPE training_status     AS ENUM ('not_started','in_progress','completed');
CREATE TYPE availability_status AS ENUM ('offline','online','busy','break');

CREATE TABLE professionals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  employee_code      text UNIQUE,
  verification_status verification_status NOT NULL DEFAULT 'not_submitted',
  training_status     training_status     NOT NULL DEFAULT 'not_started',
  availability_status availability_status NOT NULL DEFAULT 'offline',
  is_available_today boolean NOT NULL DEFAULT false,
  current_lat        numeric(9,6),
  current_lng        numeric(9,6),
  location_updated_at timestamptz,
  service_radius_km  numeric(5,2) NOT NULL DEFAULT 12.00,
  commission_pct     numeric(5,4) NOT NULL DEFAULT 0.2000,
  rating             numeric(3,2) CHECK (rating BETWEEN 0 AND 5),
  rating_count       int NOT NULL DEFAULT 0,
  total_offers       int NOT NULL DEFAULT 0,
  accepted_offers    int NOT NULL DEFAULT 0,
  completed_jobs     int NOT NULL DEFAULT 0,
  cancelled_jobs     int NOT NULL DEFAULT 0,
  no_shows           int NOT NULL DEFAULT 0,
  experience_months  int NOT NULL DEFAULT 0,
  probation_until    timestamptz,
  suspended_reason   text,
  kyc_verified_at    timestamptz,
  onboarded_at       timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acceptance_rate_positive CHECK (accepted_offers <= total_offers),
  CONSTRAINT commission_range CHECK (commission_pct BETWEEN 0 AND 0.5)
);
CREATE INDEX idx_prof_matchable ON professionals (verification_status, training_status, availability_status);
CREATE INDEX idx_prof_rating     ON professionals (rating DESC NULLS LAST) WHERE verification_status = 'verified';
CREATE INDEX idx_prof_geo        ON professionals USING gist (point(current_lng, current_lat))
  WHERE current_lat IS NOT NULL;

CREATE TABLE professional_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  doc_type        text NOT NULL CHECK (doc_type IN
                    ('aadhaar_front','aadhaar_back','pan','address_proof','selfie',
                     'police_verification','training_certificate','bank_passbook')),
  file_path       text NOT NULL,           -- storage path, never a public URL
  status          verification_status NOT NULL DEFAULT 'submitted',
  rejection_reason text,
  reviewed_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_prof_doc ON professional_documents (professional_id, doc_type);

CREATE TABLE professional_skills (
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  proficiency     int NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  verified_at     timestamptz,
  PRIMARY KEY (professional_id, service_id)
);

CREATE TABLE professional_working_hours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  CONSTRAINT valid_range CHECK (end_time > start_time),
  UNIQUE (professional_id, weekday, start_time)
);

CREATE TABLE professional_time_off (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  CONSTRAINT valid_range CHECK (ends_at > starts_at)
);
CREATE INDEX idx_time_off_range ON professional_time_off (professional_id, starts_at, ends_at);
""",
    )

    h2(doc, "24.6 Addresses and service areas resolution")
    code(
        doc,
        """
-- 0008_addresses.sql
CREATE TYPE address_type AS ENUM ('home','work','other');

CREATE TABLE addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  locality_id   uuid REFERENCES localities(id) ON DELETE SET NULL,
  label         text NOT NULL DEFAULT 'Home',
  address_type  address_type NOT NULL DEFAULT 'home',
  line1         text NOT NULL,             -- flat / house
  line2         text,                      -- building / society
  area          text NOT NULL,
  city          text NOT NULL,
  state         text NOT NULL,
  pincode       text NOT NULL,
  lat           numeric(9,6) NOT NULL,
  lng           numeric(9,6) NOT NULL,
  landmark      text,
  access_notes  text,                      -- gate code, lift, parking - shown to the pro
  is_default    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Exactly one default address per customer.
CREATE UNIQUE INDEX uniq_default_address ON addresses (customer_id) WHERE is_default;
CREATE INDEX idx_addresses_customer ON addresses (customer_id, created_at DESC);
-- A booked address cannot be deleted out from under a future booking.
CREATE OR REPLACE FUNCTION block_address_delete_with_future_bookings() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM bookings
   WHERE address_id = OLD.id
     AND status NOT IN ('completed','cancelled','refunded','closed','no_show')
     AND (scheduled_start_at > now() OR status IN ('paid','searching','assigned','accepted',
                                                   'on_the_way','arrived','in_progress'));
  IF n > 0 THEN
    RAISE EXCEPTION 'ADDRESS_IN_USE bookings=%', n USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_address_delete_guard BEFORE DELETE ON addresses
  FOR EACH ROW EXECUTE FUNCTION block_address_delete_with_future_bookings();
""",
    )

    h2(doc, "24.7 Bookings — the centre of the system")
    code(
        doc,
        """
-- 0009_booking_enum.sql
CREATE TYPE booking_type   AS ENUM ('instant','scheduled','recurring');
CREATE TYPE booking_status AS ENUM (
  'draft','payment_pending','paid','searching','assigned','accepted','on_the_way','arrived',
  'otp_verified','in_progress','extension_requested','completed','cancelled',
  'refund_pending','refunded','disputed','no_show','closed');

-- 0010_bookings.sql
CREATE TYPE payment_purpose AS ENUM ('booking','extension','wallet_topup','penalty');

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_number      text NOT NULL UNIQUE,             -- SH-20260926-00124
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  professional_id     uuid REFERENCES professionals(id) ON DELETE SET NULL,
  address_id          uuid NOT NULL REFERENCES addresses(id) ON DELETE RESTRICT,
  address_snapshot    jsonb NOT NULL,                  -- frozen copy for disputes
  locality_id         uuid REFERENCES localities(id) ON DELETE SET NULL,
  city_id             uuid REFERENCES cities(id)       ON DELETE SET NULL,

  booking_type        booking_type NOT NULL,
  status              booking_status NOT NULL DEFAULT 'draft',
  version             int NOT NULL DEFAULT 1,          -- optimistic lock

  scheduled_start_at  timestamptz,
  scheduled_end_at    timestamptz,
  duration_minutes    int NOT NULL CHECK (duration_minutes > 0),
  extended_minutes    int NOT NULL DEFAULT 0,

  -- money (server computed, frozen at creation)
  subtotal            numeric(12,2) NOT NULL DEFAULT 0,
  platform_fee        numeric(12,2) NOT NULL DEFAULT 0,
  discount            numeric(12,2) NOT NULL DEFAULT 0,
  discount_code       text,
  tax                 numeric(12,2) NOT NULL DEFAULT 0,
  tax_rate            numeric(5,4)  NOT NULL DEFAULT 0,
  total_amount        numeric(12,2) NOT NULL DEFAULT 0,
  professional_gross  numeric(12,2) NOT NULL DEFAULT 0,
  commission_pct      numeric(5,4)  NOT NULL DEFAULT 0,
  currency            char(3) NOT NULL DEFAULT 'INR',
  quote_token         text,
  pricing_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- rules applied, for audit

  -- service execution
  otp_hash            text,
  otp_expires_at      timestamptz,
  otp_attempts        int NOT NULL DEFAULT 0,
  otp_generations     int NOT NULL DEFAULT 0,
  otp_verified_at     timestamptz,
  started_at          timestamptz,
  ends_at             timestamptz,
  ended_at            timestamptz,
  actual_duration_minutes int,

  -- assignment / SLA
  search_started_at   timestamptz,
  search_expires_at   timestamptz,
  matched_at          timestamptz,
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  eta_minutes         int,
  assignment_rounds   int NOT NULL DEFAULT 0,

  -- cancellation / resolution
  cancelled_at        timestamptz,
  cancellation_reason_code text,
  cancellation_fee    numeric(12,2) NOT NULL DEFAULT 0,
  completed_at        timestamptz,
  closed_at           timestamptz,
  notes               text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- instant bookings must not be scheduled in the past; scheduled ones must be in the future
  CONSTRAINT instant_not_scheduled CHECK (booking_type <> 'instant' OR scheduled_start_at IS NULL),
  CONSTRAINT money_non_negative CHECK (subtotal >= 0 AND total_amount >= 0 AND discount >= 0)
);
CREATE INDEX idx_bookings_customer   ON bookings (customer_id, created_at DESC);
CREATE INDEX idx_bookings_profession ON bookings (professional_id, scheduled_start_at DESC);
CREATE INDEX idx_bookings_status     ON bookings (status, created_at DESC);
CREATE INDEX idx_bookings_upcoming   ON bookings (scheduled_start_at)
  WHERE status IN ('paid','searching','assigned','accepted');
CREATE INDEX idx_bookings_search_exp ON bookings (search_expires_at) WHERE status = 'searching';
CREATE INDEX idx_bookings_city_date  ON bookings (city_id, scheduled_start_at);
CREATE INDEX idx_bookings_geo        ON bookings USING gist (point(address_snapshot->>'lng',
                                                                address_snapshot->>'lat'));
CREATE INDEX idx_bookings_number     ON bookings (booking_number text_pattern_ops);

CREATE TRIGGER trg_bookings_touch BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 0010 continued: items
CREATE TABLE booking_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  service_name     text NOT NULL,               -- snapshot: catalogue may change later
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  unit_price       numeric(10,2) NOT NULL,
  quantity         int NOT NULL DEFAULT 1,
  line_total       numeric(12,2) NOT NULL,
  scope_snapshot   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- frozen included/excluded
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_booking_items_booking ON booking_items (booking_id);
CREATE UNIQUE INDEX uniq_booking_service ON booking_items (booking_id, service_id);

-- 0011: history (append-only)
CREATE TABLE booking_status_history (
  id          bigserial PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status booking_status,
  to_status   booking_status NOT NULL,
  actor_id    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  actor_role  user_role,
  note        text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bsh_booking ON booking_status_history (booking_id, created_at);
CREATE INDEX idx_bsh_actor   ON booking_status_history (actor_id, created_at DESC);
""",
    )

    h2(doc, "24.8 Assignment and the professional calendar")
    code(
        doc,
        """
-- 0012_assignment_integrity.sql  +  0013_professional_schedule.sql
CREATE TYPE assignment_status AS ENUM ('offered','accepted','rejected','expired','withdrawn');
CREATE TYPE schedule_status    AS ENUM ('reserved','in_progress','completed','released');

CREATE TABLE booking_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  status          assignment_status NOT NULL DEFAULT 'offered',
  attempt_no      int NOT NULL DEFAULT 1,
  round_no        int NOT NULL DEFAULT 1,
  distance_km     numeric(6,2),
  score           numeric(6,2),            -- internal only, never sent to customers
  was_favourite   boolean NOT NULL DEFAULT false,
  was_repeat      boolean NOT NULL DEFAULT false,
  offered_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  responded_at    timestamptz,
  decline_reason  text
);
CREATE INDEX idx_assign_booking ON booking_assignments (booking_id, attempt_no);
CREATE INDEX idx_assign_prof    ON booking_assignments (professional_id, status, expires_at);
-- At most one live offer or acceptance per booking. This is the hard guarantee.
CREATE UNIQUE INDEX uniq_active_assignment_per_booking ON booking_assignments (booking_id)
  WHERE status IN ('offered','accepted');
-- The same professional is never offered the same booking twice.
CREATE UNIQUE INDEX uniq_prof_booking_offer ON booking_assignments (booking_id, professional_id);

CREATE TABLE professional_schedule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  booking_id      uuid REFERENCES bookings(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          schedule_status NOT NULL DEFAULT 'reserved',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_window CHECK (ends_at > starts_at)
);
-- Overlapping reserved windows are structurally impossible.
ALTER TABLE professional_schedule
  ADD CONSTRAINT professional_no_overlap EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('reserved','in_progress'));

CREATE INDEX idx_schedule_prof   ON professional_schedule (professional_id, starts_at);
CREATE INDEX idx_schedule_booking ON professional_schedule (booking_id);
""",
    )

    h2(doc, "24.9 Payments, refunds, wallet")
    code(
        doc,
        """
-- 0014_payments.sql
CREATE TYPE payment_status AS ENUM ('created','pending','success','failed','refunded','partially_refunded');
CREATE TYPE payment_method AS ENUM ('card','upi','netbanking','wallet','emi','cod');

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  purpose             payment_purpose NOT NULL DEFAULT 'booking',
  gateway             text NOT NULL DEFAULT 'razorpay',
  gateway_order_id    text,
  gateway_payment_id  text,
  gateway_signature   text,                     -- evidence for disputes; never logged
  gateway_method      text,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  fee                 numeric(12,2) NOT NULL DEFAULT 0,
  tax                 numeric(12,2) NOT NULL DEFAULT 0,
  currency            char(3) NOT NULL DEFAULT 'INR',
  method              payment_method,
  status              payment_status NOT NULL DEFAULT 'created',
  refundable_amount   numeric(12,2) NOT NULL DEFAULT 0,
  failure_reason      text,
  idempotency_key     text,
  captured_at         timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_payments_gateway_order ON payments (gateway, gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_payments_idem ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_payments_booking  ON payments (booking_id);
CREATE INDEX idx_payments_customer ON payments (customer_id, created_at DESC);
CREATE INDEX idx_payments_status   ON payments (status, created_at DESC);

-- 0015_refunds_wallet.sql
CREATE TYPE refund_status AS ENUM ('requested','processing','completed','failed');
CREATE TYPE wallet_txn_type AS ENUM ('credit','debit');

CREATE TABLE refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  booking_id        uuid REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  reason_code       text NOT NULL,
  reason_note       text,
  route             text NOT NULL DEFAULT 'gateway' CHECK (route IN ('gateway','wallet','mixed')),
  status            refund_status NOT NULL DEFAULT 'requested',
  gateway_refund_id text,
  failure_reason    text,
  requested_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  processed_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  approved_by       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_refunds_booking ON refunds (booking_id);
CREATE INDEX idx_refunds_status  ON refunds (status, created_at DESC);
-- One processing refund per payment at a time.
CREATE UNIQUE INDEX uniq_active_refund_per_payment ON refunds (payment_id) WHERE status IN ('requested','processing');

CREATE TABLE wallets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  balance    numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE customers ADD COLUMN wallet_id uuid REFERENCES wallets(id) ON DELETE SET NULL;

CREATE TABLE wallet_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id    uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type         wallet_txn_type NOT NULL,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  balance_after numeric(12,2) NOT NULL,
  ref_type     text NOT NULL,      -- refund | referral | promo | compensation | topup | spent
  ref_id       text,
  description  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallet_txn_wallet ON wallet_transactions (wallet_id, created_at DESC);
-- Append-only: no updates, no deletes, ever.
""",
    )

    h2(doc, "24.10 Coupons, ratings, favourites")
    code(
        doc,
        """
-- 0016_coupons.sql
CREATE TYPE discount_type AS ENUM ('percentage','fixed');

CREATE TABLE coupons (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL,
  description          text,
  discount_type        discount_type NOT NULL,
  discount_value       numeric(10,2) NOT NULL CHECK (discount_value > 0),
  max_discount         numeric(10,2),
  min_booking_amount   numeric(10,2) NOT NULL DEFAULT 0,
  max_discount_pct_of_total numeric(5,2) NOT NULL DEFAULT 40.00,
  valid_from           timestamptz NOT NULL DEFAULT now(),
  valid_to             timestamptz,
  usage_limit          int,
  usage_count          int NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  per_user_limit       int NOT NULL DEFAULT 1,
  applicable_services  uuid[] NOT NULL DEFAULT '{}',
  applicable_cities    uuid[] NOT NULL DEFAULT '{}',
  first_time_only      boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT percentage_needs_cap CHECK (discount_type <> 'percentage' OR max_discount IS NOT NULL)
);
CREATE UNIQUE INDEX uniq_coupons_code ON coupons (upper(code));
CREATE INDEX idx_coupons_active ON coupons (is_active, valid_from, valid_to);

CREATE TABLE coupon_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id      uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  discount_amount numeric(10,2) NOT NULL,
  used_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_coupon_usage_booking ON coupon_usage (booking_id);   -- one coupon per booking
CREATE INDEX idx_coupon_usage_coupon ON coupon_usage (coupon_id, customer_id);

-- 0017_ratings_favourites.sql
CREATE TABLE ratings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  overall          int NOT NULL CHECK (overall BETWEEN 1 AND 5),
  professionalism  int CHECK (professionalism BETWEEN 1 AND 5),
  quality          int CHECK (quality BETWEEN 1 AND 5),
  punctuality      int CHECK (punctuality BETWEEN 1 AND 5),
  behaviour        int CHECK (behaviour BETWEEN 1 AND 5),
  cleanliness      int CHECK (cleanliness BETWEEN 1 AND 5),
  comment          text CHECK (char_length(comment) <= 1000),
  pro_response     text CHECK (char_length(pro_response) <= 250),
  is_hidden        boolean NOT NULL DEFAULT false,
  hidden_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);
CREATE INDEX idx_ratings_pro ON ratings (professional_id, created_at DESC);
CREATE INDEX idx_ratings_cust ON ratings (customer_id, created_at DESC);

CREATE TABLE favourites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('service','professional')),
  target_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_favourite ON favourites (customer_id, target_type, target_id);
""",
    )

    h2(doc, "24.11 Recurring, support, chat, notifications")
    code(
        doc,
        """
-- 0018_recurring.sql
CREATE TYPE recurring_frequency AS ENUM ('daily','weekly','fortnightly','monthly','custom');

CREATE TABLE recurring_series (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  address_id       uuid NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  frequency        recurring_frequency NOT NULL,
  weekdays         smallint[] NOT NULL DEFAULT '{}',
  time_of_day      time NOT NULL,
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  start_date       date NOT NULL,
  end_date         date,
  exclusions       date[] NOT NULL DEFAULT '{}',
  occurrence_count int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekdays_required CHECK (frequency <> 'custom' OR cardinality(weekdays) > 0)
);
CREATE INDEX idx_series_due ON recurring_series (start_date) WHERE is_active;

CREATE TABLE recurring_occurrences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id       uuid NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
  booking_id      uuid REFERENCES bookings(id) ON DELETE SET NULL,
  occurrence_date date NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','materialised','skipped','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Cron re-runs are idempotent because of this.
CREATE UNIQUE INDEX uniq_occurrence ON recurring_occurrences (series_id, occurrence_date);

-- 0019_support.sql
CREATE TYPE ticket_status   AS ENUM ('open','in_progress','waiting_for_customer','resolved','closed');
CREATE TYPE ticket_priority AS ENUM ('low','normal','high','urgent');
CREATE TYPE ticket_category AS ENUM ('professional_issue','payment_issue','booking_issue','refund',
                                     'missing_item','property_damage','safety_issue','other');

CREATE TABLE support_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text NOT NULL UNIQUE,                 -- TKT-20260926-0007
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  booking_id   uuid REFERENCES bookings(id) ON DELETE SET NULL,
  category     ticket_category NOT NULL DEFAULT 'other',
  priority     ticket_priority NOT NULL DEFAULT 'normal',
  status       ticket_status   NOT NULL DEFAULT 'open',
  subject      text NOT NULL CHECK (char_length(subject) <= 200),
  description  text NOT NULL,
  assigned_to  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  resolution   text,
  resolved_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  sla_due_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  closed_at    timestamptz
);
CREATE INDEX idx_tickets_queue  ON support_tickets (status, priority, sla_due_at);
CREATE INDEX idx_tickets_cust   ON support_tickets (customer_id, created_at DESC);
CREATE INDEX idx_tickets_agent  ON support_tickets (assigned_to, status);

CREATE TABLE support_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  author_role    user_role,
  body           text NOT NULL,
  attachment_path text,
  is_internal    boolean NOT NULL DEFAULT false,        -- staff-only notes
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz
);
CREATE INDEX idx_support_messages_ticket ON support_messages (ticket_id, created_at);

-- 0020_chat_notifications.sql
CREATE TABLE chat_threads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  last_message_at timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  kind        text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','system')),
  body        text,
  image_path  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT text_or_image CHECK (kind <> 'text' OR body IS NOT NULL)
);
CREATE INDEX idx_chat_messages_thread ON chat_messages (thread_id, created_at);

CREATE TYPE notification_channel AS ENUM ('push','sms','email','in_app','whatsapp');

CREATE TABLE notification_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  channel    notification_channel NOT NULL,
  locale     text NOT NULL DEFAULT 'en-IN',
  subject    text,
  body       text NOT NULL,               -- supports {{token}} placeholders
  variables  text[] NOT NULL DEFAULT '{}',
  is_active  boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, channel, locale)
);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel       notification_channel NOT NULL,
  template_code text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  title         text,
  body          text,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','failed','read')),
  error         text,
  booking_id    uuid REFERENCES bookings(id) ON DELETE CASCADE,
  read_at       timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_recipient ON notifications (recipient_id, created_at DESC);
CREATE INDEX idx_notifications_pending  ON notifications (status, created_at) WHERE status = 'queued';
""",
    )

    h2(doc, "24.12 Earnings, payouts, referrals, SOS")
    code(
        doc,
        """
-- 0021_earnings_payouts.sql
CREATE TYPE earning_status AS ENUM ('pending','available','paid','reversed');
CREATE TYPE payout_status  AS ENUM ('draft','processing','paid','failed');

CREATE TABLE professional_earnings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id   uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  booking_id        uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  gross_amount      numeric(12,2) NOT NULL,
  commission_pct    numeric(5,4)  NOT NULL,
  commission_amount numeric(12,2) NOT NULL,
  net_amount        numeric(12,2) NOT NULL,
  bonus_amount      numeric(12,2) NOT NULL DEFAULT 0,
  status            earning_status NOT NULL DEFAULT 'pending',
  available_at      timestamptz NOT NULL,
  payout_id         uuid,
  reversed_reason  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_earnings_pro   ON professional_earnings (professional_id, created_at DESC);
CREATE INDEX idx_earnings_ready ON professional_earnings (available_at) WHERE status = 'available';

CREATE TABLE payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_number  text NOT NULL UNIQUE,                  -- PO-2026-W37-0142
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  gross_total    numeric(12,2) NOT NULL,
  commission_total numeric(12,2) NOT NULL,
  bonus_total    numeric(12,2) NOT NULL DEFAULT 0,
  net_total      numeric(12,2) NOT NULL,
  earnings_count int NOT NULL,
  status         payout_status NOT NULL DEFAULT 'draft',
  method         text,                                 -- upi | bank
  method_ref     text,                                 -- masked, encrypted at rest
  failure_reason text,
  processed_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  processed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payouts_pro ON payouts (professional_id, created_at DESC);

-- 0022_referrals_sos.sql
CREATE TYPE referral_status AS ENUM ('pending','qualified','rewarded','rejected');

CREATE TABLE referrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  referee_id    uuid NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  code          text NOT NULL,
  status        referral_status NOT NULL DEFAULT 'pending',
  referee_reward numeric(10,2) NOT NULL DEFAULT 0,
  referrer_reward numeric(10,2) NOT NULL DEFAULT 0,
  device_hash   text,
  instrument_hash text,
  reject_reason text,
  rewarded_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_self_referral CHECK (referrer_id <> referee_id)
);
CREATE INDEX idx_referrals_referrer ON referrals (referrer_id, created_at DESC);
-- One referral per device and per payment instrument: the anti-abuse core.
CREATE UNIQUE INDEX uniq_referral_device      ON referrals (device_hash)      WHERE device_hash IS NOT NULL;
CREATE UNIQUE INDEX uniq_referral_instrument ON referrals (instrument_hash) WHERE instrument_hash IS NOT NULL;

CREATE TABLE sos_incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lat numeric(9,6), lng numeric(9,6),
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','acknowledged','resolved','false_alarm')),
  severity      text NOT NULL DEFAULT 'high' CHECK (severity IN ('medium','high','critical')),
  acknowledged_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolution    text,
  payout_frozen boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX idx_sos_open ON sos_incidents (created_at DESC) WHERE status = 'open';
""",
    )

    h2(doc, "24.13 Settings, pricing rules, policies, audit, idempotency, OTP")
    code(
        doc,
        """
-- 0023_settings_pricing_policies.sql
CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  value_type  text NOT NULL DEFAULT 'string'
              CHECK (value_type IN ('string','number','boolean','json','array')),
  category    text NOT NULL DEFAULT 'general',   -- general | pricing | booking | notification | safety
  label       text NOT NULL,
  description text,
  is_secret   boolean NOT NULL DEFAULT false,    -- never returned to non-admin clients
  updated_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE pricing_rule_type AS ENUM ('multiplier','surcharge','platform_fee','tax','surge');

CREATE TABLE pricing_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type    pricing_rule_type NOT NULL,
  name         text NOT NULL,
  scope_type   text NOT NULL CHECK (scope_type IN ('global','category','service','city','locality')),
  scope_id     uuid,
  days_of_week smallint[] NOT NULL DEFAULT '{}',   -- 0-6; empty = every day
  start_time   time,
  end_time     time,
  factor       numeric(6,3),                        -- for multiplier/surge
  flat_amount  numeric(10,2),                       -- for surcharge
  value        numeric(6,4),                        -- for platform_fee / tax
  priority     int NOT NULL DEFAULT 100,            -- lower wins
  stackable    boolean NOT NULL DEFAULT false,
  max_factor   numeric(6,3) NOT NULL DEFAULT 2.000,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT needs_value CHECK (factor IS NOT NULL OR flat_amount IS NOT NULL OR value IS NOT NULL)
);
CREATE INDEX idx_rules_lookup ON pricing_rules (rule_type, scope_type, is_active, priority);

CREATE TABLE cancellation_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    uuid REFERENCES services(id) ON DELETE CASCADE,   -- NULL = global
  hours_before  int NOT NULL CHECK (hours_before >= 0),
  fee_type      text NOT NULL CHECK (fee_type IN ('free','percentage','fixed')),
  fee_value     numeric(10,4) NOT NULL DEFAULT 0,
  refund_to_gateway boolean NOT NULL DEFAULT true,
  applies_to    text NOT NULL DEFAULT 'customer' CHECK (applies_to IN ('customer','professional','both')),
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE NULLS NOT DISTINCT (service_id, hours_before)
);

-- 0024_audit_idempotency.sql
CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  actor_role user_role,
  action     text NOT NULL,          -- service.price.update, professional.suspend, refund.execute …
  entity     text NOT NULL,          -- services, professionals, bookings …
  entity_id  text,
  old_value  jsonb,
  new_value  jsonb,
  reason     text,
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_actor  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs (action, created_at DESC);

CREATE TABLE idempotency_keys (
  key         text NOT NULL,
  scope       text NOT NULL,          -- bookings.create, payments.create-order, refunds.execute …
  request_hash text NOT NULL,         -- sha256 of the canonical request body
  response    jsonb,
  status      text NOT NULL DEFAULT 'in_progress'
              CHECK (status IN ('in_progress','completed','failed')),
  created_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (scope, key)
);
CREATE INDEX idx_idem_expiry ON idempotency_keys (expires_at);

-- 0025 otp
CREATE TYPE otp_purpose AS ENUM ('login','service_start','email_verify','admin_mfa','address_verify');

CREATE TABLE otp_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier  text NOT NULL,             -- phone / email
  purpose     otp_purpose NOT NULL,
  code_hash   text NOT NULL,             -- sha256(code + server pepper)
  attempts    int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  blocked_until timestamptz,
  consumed_at timestamptz,
  expires_at  timestamptz NOT NULL,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_identifier ON otp_requests (identifier, purpose, created_at DESC);
CREATE INDEX idx_otp_expiry     ON otp_requests (expires_at) WHERE consumed_at IS NULL;
""",
    )
    note(
        doc,
        "`otp_requests` is how the system replaces Redis for OTP storage. The code is stored as a "
        "salted SHA-256 hash, `attempts` counts failures, `blocked_until` implements lockout, and a "
        "nightly cron deletes expired rows. There is no plaintext OTP anywhere in the database or the logs.",
    )

    h2(doc, "24.14 Row Level Security")
    p(doc, "RLS is enabled on every table. Policies follow one pattern: *who* may read, and *which predicate* scopes rows to them.")
    code(
        doc,
        """
-- 0025_rls_policies.sql  (representative; the full file covers all 47 tables)
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- Customers read and write only their own bookings.
CREATE POLICY bookings_select_own ON bookings FOR SELECT
  USING (customer_id IN (SELECT id FROM customers WHERE profile_id = auth.uid())
      OR professional_id IN (SELECT id FROM professionals WHERE profile_id = auth.uid())
      OR EXISTS (SELECT 1 FROM profiles p
                  WHERE p.id = auth.uid()
                    AND p.role IN ('admin','ops','support','super_admin')));

-- INSERT is narrowed further: the customer may only create a draft for themselves,
-- and money columns must be zero - they are set server-side by the Route Handler.
CREATE POLICY bookings_insert_own ON bookings FOR INSERT
  WITH CHECK (customer_id IN (SELECT id FROM customers WHERE profile_id = auth.uid())
              AND status = 'draft'
              AND total_amount = 0);

-- Nobody updates a booking directly from the client. All mutations go through
-- /api/bookings/* which uses the service-role client. This single policy removes
-- an entire class of state-machine bypass.
CREATE POLICY bookings_update_none ON bookings FOR UPDATE USING (false);

-- Professionals see only their own KYC documents, and only the metadata - the
-- file itself is fetched through a signed, admin/owner-guarded URL.
CREATE POLICY pro_docs_select_own ON professional_documents FOR SELECT
  USING (professional_id IN (SELECT id FROM professionals WHERE profile_id = auth.uid())
      OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                  AND p.role IN ('admin','super_admin')));

-- Audit logs are immutable and staff-readable only.
CREATE POLICY audit_read_staff ON audit_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                   AND p.role IN ('admin','super_admin')));
CREATE POLICY audit_no_write ON audit_logs FOR INSERT WITH CHECK (false);   -- service role only

-- Wallet ledger: read your own, write nothing.
CREATE POLICY wallet_txn_select_own ON wallet_transactions FOR SELECT
  USING (wallet_id IN (SELECT w.id FROM wallets w JOIN customers c ON c.id = w.customer_id
                        WHERE c.profile_id = auth.uid()));
CREATE POLICY wallet_txn_no_update ON wallet_transactions FOR UPDATE USING (false);
CREATE POLICY wallet_txn_no_delete ON wallet_transactions FOR DELETE USING (false);

-- Service catalogue is world-readable; writes are admin-only.
CREATE POLICY services_public_read ON services FOR SELECT USING (is_active OR is_staff());
CREATE POLICY services_admin_write ON services FOR ALL
  USING (is_staff('admin')) WITH CHECK (is_staff('admin'));

-- Helper predicates (SECURITY DEFINER, so they do not recurse through RLS)
CREATE OR REPLACE FUNCTION is_staff(p_roles user_role[]) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM profiles
                  WHERE id = auth.uid() AND status = 'active' AND role = ANY(p_roles));
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION current_role() RETURNS user_role AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;
""",
    )
    callout(
        doc,
        "The key policy",
        "`bookings_update_none` means a browser can never move a booking between states. Every state "
        "change goes through a Route Handler running the service-role client, where the transition "
        "guard, the pricing engine and the audit trail all live. The `enforce_booking_transition` "
        "trigger (§8.2) is the second line of defence, in case a future policy is written too loosely.",
    )

    h2(doc, "24.15 Storage buckets")
    table(
        doc,
        ["Bucket", "Public?", "Written by", "Read by", "RLS policy"],
        [
            ["`service-media`", "public", "admin (service images, category art)", "everyone", "`USING (true)`"],
            ["`pro-photos`", "public", "professional (own), admin", "everyone", "profiles can insert their own path"],
            ["`kyc-documents`", "**private**", "professional (own), admin", "owner + admin only", "no direct read; signed URL via guarded route"],
            ["`chat-media`", "**private**", "participants of the thread", "participants only", "`bucket_id` in a thread the user belongs to"],
            ["`support-media`", "**private**", "ticket participants + staff", "ticket participants + staff", "ticket membership check"],
            ["`invoices`", "**private**", "system", "booking owner + admin", "customer owns the booking"],
        ],
        widths=[1.3, 0.75, 1.55, 1.35, 1.75],
        font_size=8.5,
    )
    p(doc, "Uploads use signed upload URLs minted by a Route Handler (never the anon key), capped at 2 MB for chat/support and 5 MB for KYC, with MIME type allow-lists per bucket.")

    h2(doc, "24.16 Realtime publication")
    code(
        doc,
        """
-- 0026_realtime_publication.sql
-- Only these tables are broadcast. Postgres changes on `profiles` would leak staff data.
ALTER PUBLICATION supabase_realtime ADD TABLE bookings;
ALTER PUBLICATION supabase_realtime ADD TABLE booking_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE professional_earnings;
ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;

-- Clients subscribe to private channels, never to a table-wide feed:
--   booking:{bookingId}          -> status, professional_id, started_at, ends_at
--   pro:{professionalId}         -> Presence (online/offline, live location)
--   chat:{threadId}              -> chat_messages inserts
--   ticket:{ticketId}            -> support_messages inserts
--   me:{profileId}               -> notifications for this profile
-- RLS applies to Realtime exactly as it applies to REST, so a customer cannot
-- subscribe to another customer's booking channel.
""",
    )

    h2(doc, "24.17 Index and function catalogue (0028)")
    table(
        doc,
        ["Function", "Returns", "Used by"],
        [
            ["`current_role()`", "`user_role`", "every RLS predicate"],
            ["`is_staff(user_role[])`", "`boolean`", "every RLS predicate"],
            ["`is_serviceable(locality, service)`", "`boolean`", "availability gate"],
            ["`quote_booking(items, coupon, address, at)`", "`jsonb` breakdown", "`POST /api/bookings/quote`, booking creation"],
            ["`slot_availability(locality, service, day)`", "`jsonb[]` slots", "`GET /api/availability`"],
            ["`rank_candidates(booking, limit)`", "`table`", "`POST /api/bookings/:id/assign`"],
            ["`apply_wallet_delta(...)`", "`numeric`", "refunds, referral rewards, compensation"],
            ["`resolve_cancellation_fee(service, hours)`", "`numeric`", "cancel + reschedule"],
            ["`redeem_coupon(code, customer, subtotal)`", "`jsonb`", "quote + booking creation"],
            ["`booking_number_seq()`", "`text`", "trigger on `bookings` insert"],
            ["`enforce_booking_transition()`", "trigger", "§8.2 state machine"],
            ["`professional_no_overlap` (constraint)", "—", "§9.4 double-booking guard"],
            ["`recompute_professional_rating(pro)`", "`numeric`", "rating insert + nightly cron"],
            ["`block_address_delete_with_future_bookings()`", "trigger", "address delete guard"],
        ],
        widths=[2.5, 1.15, 3.05],
        font_size=8.5,
    )
