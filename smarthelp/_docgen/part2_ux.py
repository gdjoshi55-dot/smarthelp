"""Part 2 — UI/UX specification: design-token parity with SmartPOS, components, screens, wireframes."""

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
    h1(doc, "18. Design System — Parity With SmartPOS")

    callout(
        doc,
        "Non-negotiable",
        "SmartHelp ships the SmartPOS visual language **byte-for-byte**: the same Tailwind token "
        "file, the same CSS variables, the same font, the same radius scale, the same shadcn/ui "
        "component set, the same toast library, the same card/table/button anatomy. The only thing "
        "that changes is the product name in the copy. Do not fork the design system.",
        fill="F1F5FF",
    )

    h2(doc, "18.1 Colour tokens")
    p(doc, "`app/globals.css` is copied unchanged from SmartPOS. These are the semantic HSL channels the shadcn primitives consume:")
    code(
        doc,
        """
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --card-foreground: 222 47% 11%;
    --popover: 0 0% 100%;
    --popover-foreground: 222 47% 11%;
    --primary: 221 83% 53%;        /* #2563EB — blue-600, the interaction colour   */
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96%;
    --secondary-foreground: 222 47% 11%;
    --muted: 210 40% 96%;
    --muted-foreground: 215 16% 47%;
    --accent: 210 40% 96%;
    --accent-foreground: 222 47% 11%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 210 40% 98%;
    --success: 142 71% 45%;
    --success-foreground: 0 0% 100%;
    --warning: 38 92% 50%;
    --warning-foreground: 0 0% 100%;
    --border: 214 32% 91%;
    --input: 214 32% 91%;
    --ring: 221 83% 53%;
    --radius: 0.5rem;
  }
}

@layer base {
  * { @apply border-border; box-sizing: border-box; }
  body {
    @apply bg-background text-foreground;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
}

@layer utilities {
  .scrollbar-thin::-webkit-scrollbar { width: 6px; height: 6px; }
  .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
  .scrollbar-thin::-webkit-scrollbar-thumb { background: hsl(215 16% 80%); border-radius: 3px; }
  .scrollbar-thin::-webkit-scrollbar-thumb:hover { background: hsl(215 16% 70%); }
  .line-clamp-1 { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
}
""",
        caption="Copied verbatim from smartpos-main/app/globals.css. The `success` and `warning` slots are SmartPOS project additions and are reused here.",
    )

    h2(doc, "18.2 Marketing brand hexes (public pages only)")
    table(
        doc,
        ["Token", "Hex", "Used on"],
        [
            ["Brand blue", "`#1E5FE8`", "Hero, primary CTA on the landing page"],
            ["Dark navy", "`#0B1B3A`", "Headings, footer background"],
            ["Light blue tint", "`#EBF3FE`", "Hero + alternating section backgrounds"],
            ["Off-white", "`#F6F9FC`", "Section background"],
            ["Pill blue", "`#D6E6FF`", "Category pills, badges"],
            ["Green accent", "`#1BA352`", "Success states, \"instant book\" pill, savings badges"],
            ["Footer link", "`#6DA4FF`", "Footer links on navy"],
        ],
        widths=[1.6, 1.2, 3.9],
    )
    note(
        doc,
        "Inside the authenticated app, feature code uses stock Tailwind `blue-600` / `gray-*` / "
        "`green-*` classes, exactly as SmartPOS does. Only the public marketing pages use the brand hexes. "
        "Keep that split — it is what makes the app feel native to the component library.",
    )

    h2(doc, "18.3 Typography & radius")
    kv_table(
        doc,
        [
            ("Font", "Inter via `next/font/google`, `subsets: ['latin']`, applied on `<body>` in `app/layout.tsx`"),
            ("Display", "`text-4xl lg:text-5xl font-bold` (marketing only)"),
            ("Page title", "`text-2xl font-bold text-gray-900`"),
            ("Section title", "`text-lg font-semibold text-gray-900`"),
            ("Body", "`text-sm text-gray-700`"),
            ("Meta / caption", "`text-xs text-gray-500`"),
            ("Price", "`text-lg font-bold` (never below `text-base`; prices are the CTA)"),
            ("Radius", "`lg = 0.5rem`, `md = 0.375rem`, `sm = 0.25rem` — no other radii"),
            ("Shadows", "Stock Tailwind `shadow-sm` / `shadow-md` only; no custom elevation scale"),
        ],
    )

    h2(doc, "18.4 `tailwind.config.ts` (unchanged from SmartPOS)")
    code(
        doc,
        """
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        success: { DEFAULT: 'hsl(var(--success))', foreground: 'hsl(var(--success-foreground))' },
        warning: { DEFAULT: 'hsl(var(--warning))', foreground: 'hsl(var(--warning-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
""",
    )

    h2(doc, "18.5 Component inventory")
    p(doc, "The full SmartPOS `components/ui` set is copied as-is. Every primitive SmartHelp needs already exists — nothing new needs to be authored.")
    table(
        doc,
        ["Primitive", "SmartHelp usage"],
        [
            ["`button`", "Every CTA. `variant`: `default` (primary), `outline` (secondary), `ghost`, `destructive`, `link`"],
            ["`card`", "Service cards, booking cards, KPI tiles, price breakdown panel"],
            ["`badge`", "Status pills: `searching` (warning), `in_progress` (primary), `completed` (success), `cancelled` (destructive), `disputed` (warning)"],
            ["`input` / `textarea` / `label`", "All forms; `react-hook-form` + `zod`-style manual validation, error text in `text-xs text-red-600`"],
            ["`input-otp`", "**Both** the customer's OTP display and the professional's OTP entry — the library is already a dependency"],
            ["`select`", "Duration, address, category filters"],
            ["`tabs`", "Booking history filter (Upcoming / Active / Completed / Cancelled), admin sections"],
            ["`dialog` / `alert-dialog`", "Checkout confirm, cancel confirmation, destructive admin actions"],
            ["`sheet`", "Mobile filter drawer, sort drawer, booking filters"],
            ["`drawer` (vaul)", "Mobile bottom sheets for duration picker and coupon entry"],
            ["`sheet`/`dialog` + `calendar` (react-day-picker)", "Scheduling date picker with disabled past dates"],
            ["`skeleton`", "Loading states for every async list — never a spinner where a skeleton fits"],
            ["`progress`", "KYC completion, profile completeness, payout progress"],
            ["`avatar`", "Professional photos, customer avatars, support agent avatars"],
            ["`table`", "Every admin list; sticky header, `text-sm`, zebra off"],
            ["`accordion`", "Included / excluded scope on service detail; FAQs"],
            ["`tooltip`", "Icon-only actions in admin tables"],
            ["`popover`", "Filter menus, column sort"],
            ["`command` (cmdk)", "Admin global search (booking, customer, professional)"],
            ["`carousel` (embla)", "Service image gallery on mobile"],
            ["`resizable-panels`", "Admin booking detail: customer / professional / history panes"],
            ["`switch`", "Online toggle, feature flags in Settings"],
            ["`radio-group`", "Instant vs Scheduled, address selection"],
            ["`separator`", "Price breakdown dividers"],
            ["`scroll-area`", "Chat thread, long scope lists"],
            ["`toast` (react-hot-toast)", "All transient feedback — **the only toast system in use**"],
        ],
        widths=[1.85, 4.85],
        font_size=8.5,
    )

    h2(doc, "18.6 Project-specific components to author")
    table(
        doc,
        ["Component", "Path", "Purpose"],
        [
            ["`LoadingSpinner`", "`components/ui/LoadingSpinner.tsx`", "Copied verbatim from SmartPOS — the only spinner allowed"],
            ["`ServiceCard`", "`components/service/ServiceCard.tsx`", "Image, name, from-price, duration chips, rating"],
            ["`DurationPicker`", "`components/booking/DurationPicker.tsx`", "Chip grid; `vaul` sheet on mobile"],
            ["`SlotPicker`", "`components/booking/SlotPicker.tsx`", "`react-day-picker` + slot list, disabled/unavailable states"],
            ["`PriceBreakdown`", "`components/booking/PriceBreakdown.tsx`", "Itemised lines, discount, tax, total"],
            ["`BookingStatusBadge`", "`components/booking/BookingStatusBadge.tsx`", "One place that maps status → variant + label"],
            ["`BookingTimeline`", "`components/booking/BookingTimeline.tsx`", "Vertical state history from `booking_status_history`"],
            ["`ServiceTimer`", "`components/booking/ServiceTimer.tsx`", "Server-synced countdown + progress bar"],
            ["`OtpDisplay` / `OtpEntry`", "`components/booking/`", "`input-otp` display (customer) and entry (professional)"],
            ["`RatingStars`", "`components/rating/RatingStars.tsx`", "Display + interactive modes, sub-score rows"],
            ["`ProCard`", "`components/professional/ProCard.tsx`", "Photo, name, rating, jobs, skills, distance, favourite heart"],
            ["`OfferCard`", "`components/professional/OfferCard.tsx`", "Live job offer with countdown and Accept/Decline"],
            ["`EarningsSummary`", "`components/professional/EarningsSummary.tsx`", "Today / week / month / pending tiles"],
            ["`ChatThread`", "`components/chat/ChatThread.tsx`", "Realtime messages + system messages"],
            ["`KycStepper`", "`components/professional/KycStepper.tsx`", "Document upload steps with per-step status"],
            ["`ImageUpload`", "`components/ui/ImageUpload.tsx`", "Copied from SmartPOS; reused for service images, KYC, chat"],
            ["`ConfirmationDialog`", "`components/ui/ConfirmationDialog.tsx`", "Copied from SmartPOS; used for every destructive action"],
            ["`EmptyState`", "`components/ui/EmptyState.tsx`", "Icon + headline + one-line explanation + primary action"],
            ["`DataTable`", "`components/admin/DataTable.tsx`", "Search, sort, filter, pagination, row actions, CSV export"],
            ["`StatCard`", "`components/admin/StatCard.tsx`", "KPI tile for every dashboard and analytics screen"],
            ["`AppShell`", "`components/shell/AppShell.tsx`", "Sidebar (desktop) / bottom nav (mobile) + `AuthProvider`"],
            ["`PageHeader`", "`components/shell/PageHeader.tsx`", "Title, breadcrumb, primary action slot"],
        ],
        widths=[1.7, 2.35, 2.65],
        font_size=8.5,
    )

    h2(doc, "18.7 Toasts, errors and empty states")
    code(
        doc,
        """
// Every async action follows the same three-line shape. There is no other pattern in the codebase.
const onSubmit = async (values: QuoteInput) => {
  try {
    const res = await fetch('/api/bookings/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
    setQuote(data);
    toast.success('Price ready');
  } catch (e: any) {
    toast.error(e.message);
  } finally {
    setLoading(false);
  }
};
""",
    )
    bullets(
        doc,
        [
            "Success → `toast.success(...)`. Failure → `toast.error(...)` with the server's `error` string verbatim — never a generic \"Something went wrong\" when the server gave a specific message.",
            "**No dead buttons.** If a control is not wired, it is not rendered, or it is rendered with an explicit \"Coming soon\" badge per the AI master prompt in Part 8.",
            "Every list has all four states: `skeleton` (loading), `EmptyState` (zero rows, with an action), inline error banner + retry, and populated.",
            "Destructive actions always go through `ConfirmationDialog` and name the object: \"Cancel booking SH-20260926-00124?\"",
        ],
    )

    # ── Navigation ────────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "19. Information Architecture & Navigation")

    h2(doc, "19.1 Route map")
    code(
        doc,
        """
app/
├── layout.tsx                     Root: Inter, AuthProvider, <Toaster position="top-center" />
├── globals.css                    Design tokens (verbatim from SmartPOS)
├── page.tsx                       PUBLIC LANDING (unauthenticated)
├── login/page.tsx                 Phone OTP sign-in  (?tab=signup)
├── services/page.tsx              PUBLIC catalogue (all services, filterable, no login)
├── services/[slug]/page.tsx       PUBLIC service detail + price preview
├── book/[code]/page.tsx           PUBLIC shareable booking link (mirror of SmartPOS /order/[code])
├── join/page.tsx                  PUBLIC professional application (KYC lead form)
├── legal/…                        privacy, terms, refund, cancellation, safety policies
│
├── customer/                      CUSTOMER SHELL  (bottom nav on mobile, sidebar on desktop)
│   ├── layout.tsx                 AuthGuard role=customer + AppShell
│   ├── page.tsx                   Home
│   ├── services/page.tsx          Browse / search
│   ├── services/[slug]/page.tsx   Service detail
│   ├── checkout/page.tsx          Duration + slot + address + coupon + pay
│   ├── bookings/page.tsx          History (tabs)
│   ├── bookings/[id]/page.tsx     Live tracking / OTP / timer / invoice / review
│   ├── wallet/page.tsx
│   ├── support/page.tsx           Ticket list + new ticket
│   ├── support/[id]/page.tsx      Ticket thread
│   ├── favourites/page.tsx
│   └── profile/page.tsx           Profile + addresses + notifications + logout
│
├── professional/                  PROFESSIONAL SHELL
│   ├── layout.tsx                 AuthGuard role=professional + AppShell
│   ├── page.tsx                   Home (earnings + today's jobs + online toggle)
│   ├── jobs/page.tsx              Upcoming / in-progress / offer inbox
│   ├── jobs/[id]/page.tsx         Job detail: navigate, arrive, OTP, complete
│   ├── earnings/page.tsx
│   ├── kyc/page.tsx               Documents + verification status
│   ├── availability/page.tsx      Working hours + time off + service areas
│   ├── training/page.tsx
│   └── profile/page.tsx
│
├── admin/                         ADMIN / OPS / SUPPORT SHELL (sidebar only)
│   ├── layout.tsx                 AuthGuard role in (admin, ops, support) + sidebar
│   ├── page.tsx                   Dashboard
│   ├── bookings/…                 list / [id] / assign / reassign
│   ├── professionals/…            list / [id] / kyc-review / suspend
│   ├── customers/…                list / [id]
│   ├── services/…                 categories / services / durations / areas
│   ├── pricing/…                  rules / surge / commission / policies
│   ├── payments/…                 payments / refunds / payouts
│   ├── coupons/…
│   ├── disputes/…
│   ├── support/…                  tickets / sla
│   ├── analytics/…                revenue / funnel / supply / ratings
│   ├── notifications/…            templates
│   ├── settings/…                 platform settings / cities / feature flags
│   └── audit/…                    audit log
│
├── api/                           Next.js Route Handlers (see Part 5)
└── features/                      Feature components (thin page re-exports), same as SmartPOS
""",
    )

    h2(doc, "19.2 Bottom navigation (mobile)")
    table(
        doc,
        ["Shell", "Tabs", "Active indicator"],
        [
            ["Customer", "Home · Bookings · Help · Profile", "`text-blue-600` icon + label, `h-16` bar, safe-area padding"],
            ["Professional", "Home · Jobs · Earnings · Profile", "Same. `Jobs` shows a red dot badge when an offer is live"],
            ["Admin (desktop)", "Sidebar, 240px, collapsible to icons", "Active item gets `bg-blue-50 text-blue-700` + left `border-l-2 border-blue-600`"],
        ],
        widths=[1.3, 2.5, 2.9],
    )
    note(
        doc,
        "SmartPOS uses a desktop sidebar for its dashboard and has no bottom bar. SmartHelp adds a "
        "bottom bar for the two consumer shells because they are phone-first. Everything else — "
        "token, spacing, icon size (`h-5 w-5`), label size (`text-xs`) — matches SmartPOS exactly.",
    )

    h2(doc, "19.3 Role-based section access")
    p(doc, "Same `ROLE_ACCESS` pattern as SmartPOS's `Dashboard.tsx`, extended to five roles.")
    code(
        doc,
        """
// app/features/customer/…  and  app/features/professional/…  and  app/admin/…
type SectionAccess = { sections: string[]; can: Capability[] };

const ROLE_ACCESS: Record<UserRole, SectionAccess> = {
  customer:     { sections: ['home','bookings','wallet','support','favourites','profile'], can: [] },
  professional: { sections: ['home','jobs','earnings','kyc','availability','training','profile'], can: [] },
  support:      { sections: ['dashboard','bookings','disputes','support','customers','audit'],
                  can: ['ticket.read.all','ticket.write','refund.request'] },
  ops:          { sections: ['dashboard','bookings','professionals','payments','disputes','support','analytics','audit'],
                  can: ['booking.read.all','booking.assign','booking.cancel','refund.execute','dispute.resolve'] },
  admin:        { sections: ['dashboard','bookings','professionals','customers','services','pricing',
                             'payments','coupons','disputes','support','analytics','notifications',
                             'settings','audit'],
                  can: ['*'] },
};

const CAPABILITIES: Record<UserRole, Capability[]> = {
  customer:     [],
  professional: [],
  support:      ['ticket.read.all', 'ticket.write', 'refund.request'],
  ops:          ['booking.read.all', 'booking.assign', 'booking.cancel', 'refund.execute', 'dispute.resolve'],
  admin:        ['*'],
};
""",
        caption="The guard is UI convenience only. RLS and the API route guards are the real enforcement (Part 4).",
    )

    h2(doc, "19.4 Route guards")
    code(
        doc,
        """
// app/customer/layout.tsx  —  identical guard shape to SmartPOS's role handling
'use client';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!profile)                router.replace('/login?next=/customer');
    else if (profile.role !== 'customer') router.replace('/professional');
  }, [profile, loading, router]);

  if (loading || !profile || profile.role !== 'customer') return <LoadingSpinner />;
  return <AppShell sections={ROLE_ACCESS.customer.sections}>{children}</AppShell>;
}
""",
    )

    # ── Screens ───────────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "20. Screen Inventory & Wireframes")

    p(doc, "Every screen below is annotated with its route, its data source, and its primary action. Wireframes are layout intent, not pixel specs — spacing and type come from §18.")

    h2(doc, "20.1 Public — landing `/`")
    code(
        doc,
        """
+--------------------------------------------------------------+
|  Logo            Services   How it works   For professionals|  <- sticky, white
|                                    [ Log in ]  [ Get help ]  |
+--------------------------------------------------------------+
|                                                              |
|   Trusted help.                            [ Book now ]      |  <- hero, bg #EBF3FE
|   Right when you need it.                                    |
|   Verified professionals. Transparent prices.               |
|   Tracked from booking to completion.                        |
|   [ Service or pincode............. ]  [ Search ]            |
|                                                              |
+--------------------------------------------------------------+
|  What do you need help with?                                |
|  ( Cleaning )( Bathroom )( Kitchen )( Laundry )( Laundry )  |  <- pill row
+--------------------------------------------------------------+
|  Popular services                        [ See all -> ]      |
|  +----------+  +----------+  +----------+                   |
|  |  IMG     |  |  IMG     |  |  IMG     |                   |
|  | Cleaning |  | Bathroom |  |  Kitchen |                   |
|  | from 199 |  | from 249 |  | from 229 |                   |
|  | 4.8 (312)|  | 4.7 (188)|  | 4.9 (95) |                   |
|  +----------+  +----------+  +----------+                   |
+--------------------------------------------------------------+
|  How it works          |  Why SmartHelp                    |
|  1 Pick a service      |  Verified, trained pros           |
|  2 Choose time         |  Fixed price before you pay       |
|  3 Pay securely        |  OTP-verified start               |
|  4 Track live          |  Support on every booking         |
+--------------------------------------------------------------+
|  Become a SmartHelp professional   [ Apply now ]            |  <- #EBF3FE band
+--------------------------------------------------------------+
|  Footer (navy #0B1B3A)  services | company | legal | support |
+--------------------------------------------------------------+
""",
    )
    kv_table(
        doc,
        [
            ("Data", "`/api/landing` — featured services, categories, city coverage, live `pro_count`"),
            ("Interactions", "Search → `/services?q=`; category pill → filtered catalogue; pincode → coverage check"),
            ("SEO", "`export const metadata` with title/description; JSON-LD `LocalBusiness` + `Service`"),
        ],
    )

    h2(doc, "20.2 Public — catalogue `/services`")
    bullets(
        doc,
        [
            "`cmdk` search bar filtering on service name, category and keywords (debounced 200 ms, client-side over the fetched catalogue).",
            "Category filter chips + `sheet` filter drawer (price range, duration, rating, availability today).",
            "`ServiceCard` grid: `grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4`.",
            "Services not available at the customer's detected location show a \"Not in your area\" badge and are excluded from the default view.",
        ],
    )

    h2(doc, "20.3 Public — service detail `/services/[slug]`")
    diagram(
        doc,
        """
+---------------------------------------------------------------+
|  [embla carousel]                                             |
|  +-----------------------------------+                       |
|  |        service image               |  <- 16:9, rounded-lg |
|  |                                   |                       |
|  +-----------------------------------+                       |
|                                                               |
|  Full House Cleaning                       4.8 (312)         |
|  Deep clean for the whole home...                               |
|                                                               |
|  From 199 / hour                                                |
|  30m  45m  60m  90m  2h  3h  4h     <- DurationPicker chips |
|                                                               |
|  +-- What's included ----------------------+                    |
|  |  v  Floor cleaning (all rooms)         |  <- accordion     |
|  |  v  Mopping &amp; scrubbing                  |                    |
|  |  v  Dusting (surfaces, ledges)         |                    |
|  |  v  Bathroom &amp; kitchen surfaces           |                    |
|  +---------------------------------------+                    |
|  +-- Not included ------------------------+                    |
|  |  x  High-reach / outside glass        |                    |
|  |  x  Moving heavy furniture            |                    |
|  +---------------------------------------+                    |
|  Materials: bring your own. Please keep detergent accessible.  |
|                                                               |
|  +-----------------------------------------------------------+|
|  |  Wed, 30 Sep    slots: 10:00  13:00  16:00      [Book]   |  <- sticky bar
|  +-----------------------------------------------------------+|
+---------------------------------------------------------------+
""",
        caption="Mobile: image, title, rating, duration, included accordion, sticky bottom bar with price + Book. Desktop: two columns — media/scope left, booking card right (sticky).",
    )
    note(
        doc,
        "The scope accordion is the trust centrepiece of this screen. **Included** items use a green "
        "check, **excluded** use a muted ×. Both come from `service_tasks` — nothing is hardcoded in the component.",
    )

    h2(doc, "20.4 Customer — home `/customer`")
    code(
        doc,
        """
+--------------------------------------+
|  Hello, Arushmita          [bell]     |
|  [ Home  12 Nibandari St, Kolkata ]  |  <- address switcher (Sheet)
+--------------------------------------+
|  [ Search a service...          ]     |  <- cmdk trigger
+--------------------------------------+
|  What do you need help with?          |
|  ( Cleaning )( Bathroom )( Laundry ) |
|  ( Kitchen )( Household )( Appliance)|
+--------------------------------------+
|  Book again                            |
|  +------------------+  +------------------+
|  | Full House Clean |  | Dishwashing     |
|  | 2h - last 24 Sep |  | 1h - last 2 Sep |
|  | 199/hr  [Book]   |  | 149/hr  [Book]  |
|  +------------------+  +------------------+
+--------------------------------------+
|  Your active booking                  |
|  +----------------------------------+  |
|  | Bathroom Cleaning   [IN PROGRESS]|  |
|  | Priya D.  4.8      01:24:32 left|  |
|  | [ Track ]          [ Message ]  |  |
|  +----------------------------------+  |
+--------------------------------------+
|  Offers for you        [ coupon card ]|
+--------------------------------------+
|  Home   Bookings(2)   Help   Profile   |
+--------------------------------------+
""",
    )

    h2(doc, "20.5 Customer — checkout `/customer/checkout`")
    p(doc, "A single scrollable stepper. No horizontal carousel of steps — one page, sticky pay bar, four collapsible sections.")
    code(
        doc,
        """
+--------------------------------------------------+
|  Checkout                                    <- |
+--------------------------------------------------+
| 1  ADDRESS                                      |
|    (o) Home - 12 Nibandari St, Kolkata  [edit]  |
|    ( ) Work - 4th Floor, Salt Lake      [edit]  |
|    (+) Add new address                         |
|    [ Landmark / gate code / access notes ]      |  <- inline, always visible
+--------------------------------------------------+
| 2  WHEN                                       |
|    (o) Instant - as soon as possible           |
|    ( ) Scheduled                               |
|        [ calendar ]  Wed 30 Sep                 |
|        10:00  11:00  13:00  16:00  18:00        |  <- slot chips
|        (greyed = unavailable, with reason)      |
|    Duration:  (60m) (90m) (120m) (180m)        |
+--------------------------------------------------+
| 3  PROFESSIONAL (optional)                     |
|    (o) Best available (recommended)            |
|    ( ) Priya D.   4.8  1.2 km  [favourite]     |
|    ( ) Amit S.    4.6  3.4 km                  |
|    Preference is honoured when available.      |
+--------------------------------------------------+
| 4  PRICE                                       |
|    Full House Cleaning 2h            398.00    |
|    Peak evening multiplier x1.1       39.80    |
|    Platform fee                        20.00   |
|    Coupon  HELLO50                    -50.00   |
|    GST (18%)                           73.44   |
|    -----------------------------------------   |
|    Total                              481.24    |
|    [ coupon input............ Apply ]          |
+--------------------------------------------------+
|  By paying you agree to the Terms & Cancellation |
|            [ Pay 481.24  -> ]                   |  <- sticky
+--------------------------------------------------+
""",
    )
    bullets(
        doc,
        [
            "Every time/address/duration change re-quotes via `POST /api/bookings/quote` (debounced 300 ms) and re-renders the breakdown. The pay button is disabled while a quote is in flight — this is what makes `PRICE_CHANGED` impossible in practice.",
            "The mobile sticky bar collapses the whole breakdown into `Total  481.24  [Details]` with a `Drawer` (vaul) for the line items.",
            "Slot chips that are unavailable show a reason on press: \"No professional free at 11:00\", \"Outside service hours\", \"Lead time 60 min required\".",
        ],
    )

    h2(doc, "20.6 Customer — live booking `/customer/bookings/[id]`")
    code(
        doc,
        """
+--------------------------------------------------+
|  Booking SH-20260926-00124          [Help]       |
+--------------------------------------------------+
|          [ status stepper ]                        |
|   Paid > Assigned > Accepted > On the way >        |
|   Arrived > Started > Done                        |
+--------------------------------------------------+
|  ON THE WAY                                        |
|  +--------------------------------------------+   |
|  | (avatar) Priya D.      4.8 (312 jobs)     |   |
|  |           ETA 8 min - arriving 6:14 PM    |   |
|  |  [ Call ]      [ Message ]                |   |
|  +--------------------------------------------+   |
|  Full House Cleaning - 2h                        |
|  12 Nibandari St, Kolkata                        |
+--------------------------------------------------+

  when status = arrived
+--------------------------------------------------+
|  Priya has arrived.                               |
|  Share this OTP to start the service:             |
|         +----+----+----+----+                    |
|         | 4  | 8  | 2  | 1  |                    |  <- input-otp display
|         +----+----+----+----+                    |
|  Expires in 09:41                                 |
+--------------------------------------------------+

  when status = in_progress
+--------------------------------------------------+
|  Service in progress - 01:24:32 remaining         |
|  [#################.........] 67%                  |  <- Progress
|  Started 6:02 PM  -  Ends 8:02 PM                 |
|  [ Request extension ]   [ Report an issue ]     |
+--------------------------------------------------+

  when status = completed
+--------------------------------------------------+
|  Service completed                                |
|  Actual duration 2h 04m  -  481.24 paid          |
|  [ Rate your experience ]   [ Download invoice ]  |
|  [ Book again ]              [ Report an issue ] |
+--------------------------------------------------+
""",
    )

    h2(doc, "20.7 Professional — home `/professional`")
    code(
        doc,
        """
+--------------------------------------+
|  Good morning, Priya        [bell]   |
+--------------------------------------+
|  [   ONLINE  (toggle)  ]   4.8 (312)  |  <- green when online
+--------------------------------------+
|  Today's earnings      Today's jobs  |
|  1,250                 5              |  <- StatCards
|--------------------------------------|
|  Next job in 42 min                   |
|  +----------------------------------+|
|  | 10:00  Full House Cleaning 2h    ||
|  | 12 Nibandari St - 1.2 km         ||
|  | [ Navigate ]  [ Start ]          ||
|  +----------------------------------+|
+--------------------------------------+
|  Incoming offers (2)                 |
|  +----------------------------------+|
|  | NEW OFFER - expires 00:38        ||
|  | Bathroom Cleaning 1h             ||
|  | 2.1 km  -  earns 249             ||
|  | [ Accept ]        [ Decline ]    ||
|  +----------------------------------+|
+--------------------------------------+
|  Home   Jobs   Earnings   Profile    |
+--------------------------------------+
""",
    )

    h2(doc, "20.8 Professional — job detail `/professional/jobs/[id]`")
    bullets(
        doc,
        [
            "**Before arrival**: customer first name only, locality, distance, landmark + `access_notes` in a highlighted box, `Navigate` (deep link to Google/Apple Maps), and the full `service_tasks` scope.",
            "**On arrival**: `Arrive` button (enabled within `arrival_radius_m` of the address, or via long-press override with a required reason).",
            "**At the door**: `input-otp` entry with attempt counter and lockout messaging.",
            "**In progress**: server-synced timer, running total of the extension offers received, `Message` and `Call`, and a `Complete service` confirmation dialog asking whether materials were used.",
            "**After completion**: earning summary for that job, prompt to rate the customer (optional), and the day's route summary.",
            "The professional never sees the customer's phone number in the UI; **Call** routes through a masked relay that logs the duration.",
        ],
    )

    h2(doc, "20.9 Professional — earnings `/professional/earnings`")
    code(
        doc,
        """
+--------------------------------------------------+
|  Earnings                        [ This month v ]|
+--------------------------------------------------+
|  +----------+ +----------+ +----------+ +-------+|
|  | Today    | | This week| | This month| |Pending||
|  | 1,250    | | 8,400   | | 31,220   | | 2,150 ||
|  +----------+ +----------+ +----------+ +-------+|
+--------------------------------------------------+
|  [ Recharts AreaChart - earnings trend ]          |
+--------------------------------------------------+
|  Date   Job                     Gross  Cut   Net |
|  26 Sep Bathroom Cleaning       249  50  199  |
|  26 Sep Full House Cleaning     398  80  318  |
|  25 Sep Dishwashing             149  30  119  |
|  -------------------------------------------- |
|  Payout: next Monday  |  [ Download statement ]  |
+--------------------------------------------------+
""",
    )

    h2(doc, "20.10 Professional — KYC `/professional/kyc`")
    bullets(
        doc,
        [
            "`KycStepper`: 1 Identity → 2 Address → 3 Skills → 4 Training → 5 Bank details → 6 Review & submit.",
            "Each step shows a status chip: `missing` (grey), `uploaded` (blue), `in_review` (amber), `verified` (green), `rejected` (red + reason + retry).",
            "`ImageUpload` (copied from SmartPOS) writes to the `kyc-documents` bucket via a signed upload URL; the bucket is **private** and only reachable through a signed read URL generated by an admin-guarded route.",
            "The professional can see status but can never see an admin's internal notes, only the rejection reason.",
        ],
    )

    h2(doc, "20.11 Admin — dashboard `/admin`")
    code(
        doc,
        """
+--------------------------------------------------------------------------+
| SMARTHELP  Dashboard Bookings Pros Customers Services Pricing Payments    |
|            Coupons Disputes Support Analytics Notifications Settings     |
|            Audit                                                           |
|---------------------+----------------------------------------------------+
|  Today 26 Sep 2026 |  +------------+ +------------+ +------------+     |
|                     |  | Bookings   | | GMV        | | Revenue    |     |
|  [ Bookings by day ]|  | 128        | | 84,210     | | 12,644     |     |
|  [ AreaChart        ]|  +------------+ +------------+ +------------+     |
|                     |  | Active 34 | | Refunds 3  | | Tickets 7  |     |
|  [ Revenue by day ]|  +------------+ +------------+ +------------+     |
|  [ BarChart         ]|                                                  |
|                     |  FUNNEL (today)                                  |
|                     |  quoted      412  ================================  |
|                     |  paid        128  ==========================         |
|                     |  matched     121  ======================            |
|                     |  accepted    118  ===================                |
|                     |  arrived     115  =================                 |
|                     |  completed   109  ================                    |
|                     |                                                  |
|                     |  ALERTS                                         |
|                     |  ! 3 bookings searching > 5 min                   |
|                     |  ! 2 professionals unverified > 48h               |
|                     |  ! 1 dispute awaiting SLA (6h left)               |
+---------------------+----------------------------------------------------+
""",
        caption="Sidebar + Recharts, exactly like SmartPOS's `/` dashboard. The funnel and the alerts block are SmartHelp additions and are the first thing ops looks at.",
    )

    h2(doc, "20.12 Admin — booking detail `/admin/bookings/[id]`")
    p(doc, "`resizable-panels` with four tabs: **Overview** (customer + items + price breakdown + invoice), **Assignment** (offer history, scores, manual assign/reassign), **Timeline** (`booking_status_history` with actor and IP), **Actions** (cancel, refund, dispute, chat export). Every action writes an `audit_logs` row and requires a typed confirmation for destructive operations.")

    h2(doc, "20.13 Admin — KYC review `/admin/professionals/[id]/kyc-review`")
    bullets(
        doc,
        [
            "Left pane: `resizable-panels` split of the uploaded documents, each with zoom and full-screen.",
            "Right pane: the profile data, the declared skills, and a decision form.",
            "Decision: `Verify` / `Reject` (reason required) / `Request re-upload` (per-document reason).",
            "Bulk action: multi-select in the professionals table with a `Verify selected` action for a queue of 30+.",
            "Every decision is audit-logged with `old_value` / `new_value` including the reviewing admin's ID and IP.",
        ],
    )

    h2(doc, "20.14 Responsive rules")
    table(
        doc,
        ["Breakpoint", "Customer / Professional", "Admin"],
        [
            ["`< 640px`", "Single column. Bottom nav. Sticky action bars. Filters in a `Sheet`.", "Not supported — desktop only, shows a rotate-device notice"],
            ["`640 – 1023px`", "Single column, wider gutters. Checkout stepper becomes 2-up where it fits.", "Collapsed icon sidebar"],
            ["`≥ 1024px`", "Max-width `1280px` container. Service detail becomes 2 columns with a sticky booking card. Bottom nav becomes a top bar.", "240px sidebar, tables get sticky headers"],
            ["`≥ 1536px`", "Same, container `1536px`.", "Sidebar expanded, 3-up KPI grid"],
        ],
        widths=[1.35, 3.2, 2.15],
    )
    note(
        doc,
        "The SmartPOS `container` config centres content with `2rem` padding and a `2xl: 1400px` "
        "max width. SmartHelp reuses it verbatim; the consumer shells additionally wrap in a "
        "`max-w-7xl mx-auto px-4` for phone-first comfortable measure.",
    )

    h2(doc, "20.15 Accessibility contract")
    bullets(
        doc,
        [
            "Every interactive element is reachable by keyboard with a visible `ring` (the `--ring` token, never `outline: none`).",
            "`Dialog` traps focus and restores it to the trigger; `Sheet` and `Drawer` do the same.",
            "Status is never conveyed by colour alone — every `BookingStatusBadge` has a text label, and the timeline has icons.",
            "`aria-live=\"polite\"` on the service timer region and on toast container; `role=\"alert\"` on validation errors.",
            "Contrast: all body text ≥ 4.5:1, all `text-xs` meta text ≥ 4.5:1 against its background. `text-gray-400` on white is **banned**.",
            "Touch targets ≥ 44×44 px. Slot chips, duration chips and bottom-nav items all meet this.",
            "The OTP `input-otp` component is keyboard-navigable and announces digit count to screen readers.",
        ],
    )
