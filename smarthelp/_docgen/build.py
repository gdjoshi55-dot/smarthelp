"""Builds smarthelp/SmartHelp-Documentation.docx from the part modules."""

import datetime
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from kit import (  # noqa: E402
    bullets,
    callout,
    code,
    h1,
    h2,
    kv_table,
    new_document,
    note,
    p,
    page_break,
    part_divider,
    table,
    title,
    toc_field,
    update_fields_on_open,
)
import part1_product  # noqa: E402
import part2_ux  # noqa: E402
import part3_tech  # noqa: E402
import part4_api_ops  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, "..", "SmartHelp-Documentation.docx"))


def cover(doc):
    from docx.shared import Pt

    title(doc, "SmartHelp", "Trusted help. Right when you need it.")
    para_ = doc.add_paragraph()
    run = para_.add_run("Product & Technical Documentation — Master Build Specification")
    run.font.size = Pt(14)
    run.font.bold = True
    run.font.color.rgb = doc.styles["Heading 1"].font.color.rgb
    para_.paragraph_format.space_after = Pt(14)

    kv_table(
        doc,
        [
            ("Project", "SmartHelp — on-demand home services platform"),
            ("Document", "Complete product requirements, UX, business logic, data model, API and delivery plan"),
            ("Audience", "Engineering team, product, design, QA, and any AI coding agent building the system"),
            ("Stack", "Next.js 14 · React 18 · TypeScript 5.5 · Tailwind 3.4 · shadcn/ui · Supabase (Postgres/Auth/Realtime/Storage) · Razorpay · Vercel"),
            ("Stack policy", "Byte-for-byte parity with the SmartPOS codebase — see Part 3, §21"),
            ("UI policy", "Identical design system to SmartPOS — tokens, components, spacing, tone"),
            ("Version", "1.0 (build spec)"),
            ("Date", datetime.date.today().strftime("%B %d, %Y")),
            ("Status", "Ready for implementation"),
        ],
    )

    h2(doc, "What this document is")
    p(
        doc,
        "This is not a feature wishlist. It is a build specification: a single source of truth that an "
        "engineer — or an AI coding agent — can execute module by module without asking follow-up "
        "questions. It defines the data model, the state machines, the pricing and matching algorithms "
        "as executable SQL, the full API surface, the security posture, the UI at the screen level, and "
        "the acceptance tests that decide whether a feature is finished.",
    )
    bullets(
        doc,
        [
            "**Part 1 — Product**: what SmartHelp is, who uses it, what it sells, how bookings work end to end, how money is calculated, and every edge case.",
            "**Part 2 — UX/UI**: the design system (identical to SmartPOS), the route map, and annotated wireframes for every screen in the customer, professional and admin shells.",
            "**Part 3 — Architecture & data**: the exact stack, the component diagram, the complete 47-table PostgreSQL schema across 28 migrations, RLS, storage, realtime.",
            "**Part 4 — API & operations**: endpoint reference, error catalogue, security model, realtime channels, cron jobs, concurrency strategy, testing, and the phased delivery plan.",
        ],
    )

    callout(
        doc,
        "Read this first",
        "If you are an AI coding agent or a new engineer: implement strictly in the phase order in "
        "§31.1, and for each feature satisfy the Definition of Done in §31.2 before moving on. The "
        "state machine (§8) and the pricing engine (§7) are the two subsystems everything else "
        "depends on — get them right, and the rest of the platform is assembly.",
        fill="F1F5FF",
    )

    h2(doc, "Table of contents")
    toc_field(doc)


def how_to_use(doc):
    page_break(doc)
    h1(doc, "How to use this document")
    bullets(
        doc,
        [
            "**Engineers** start at §21 (stack) and §24 (schema), then read the phase they are assigned in §31.1.",
            "**AI coding agents** should read the whole document, then implement one phase at a time, running the Definition of Done gate (§31.2) per feature. The final instruction block in this document is written to be pasted verbatim as a system prompt.",
            "**Designers** work from Part 2 only; every screen, state and component needed is specified there.",
            "**QA** builds the suite from §16 (edge cases), §29 (testing layers) and §30 (acceptance path).",
            "**Product / ops** read Part 1, then §31.4 for the runbook.",
        ],
    )
    callout(
        doc,
        "Numbering is stable",
        "Section numbers (§ and subsection numbers) are referenced from code comments and from other "
        "documents. Do not renumber when editing — append instead.",
    )


def closing(doc):
    page_break(doc)
    h1(doc, "Appendix A — The AI master prompt")
    p(
        doc,
        "Paste the following as the system prompt for an AI coding agent. It encodes the constraints "
        "from the whole document in the imperative form an agent needs.",
    )
    code(
        doc,
        """
You are building SmartHelp, a production on-demand home-services platform, inside the `smarthelp/`
folder. The product specification, UX, data model, API and delivery plan are in
`smarthelp/SmartHelp-Documentation.docx`. Read it before writing code.

STACK — do not deviate. Use exactly the SmartPOS stack:
  Next.js 14 App Router, React 18, TypeScript 5.5 strict, Tailwind 3.4, shadcn/ui (Radix),
  @supabase/supabase-js (Postgres + Auth + Realtime + Storage), Zustand, react-hook-form,
  react-hot-toast, Recharts, lucide-react, input-otp, react-day-picker, cmdk, vaul,
  embla-carousel, react-resizable-panels, nodemailer, Razorpay. Deploy on Vercel with Vercel Cron.
  Do NOT introduce Java/Spring, Redis, a separate WebSocket server, React Native, ORM/Prisma,
  Redux, or any new runtime dependency. Where a capability is needed, use the stack-native
  equivalent (Supabase Realtime instead of a WebSocket server; Postgres advisory locks, exclusion
  constraints and idempotency tables instead of Redis; Next.js Route Handlers instead of a
  separate Spring service).

UI — identical to SmartPOS. Copy `app/globals.css`, `tailwind.config.ts`, `components.json`,
`components/ui/**`, and `lib/utils.ts` verbatim from the SmartPOS codebase. Same tokens, same
shadcn set, same toast library, same spacing and type scale. Do not redesign, do not add a new
colour, do not introduce a second UI library. Mobile-first; bottom nav for the customer and
professional shells; sidebar for the admin shell.

BUILD RULES — non-negotiable:
1. Build a real, production-oriented application. No mock/demo app, no fake data generators, no
   placeholder buttons. Any rendered control connects to a real API or a clearly labelled
   "Coming soon" affordance.
2. The backend is the source of truth. Never trust client-supplied price, status, role, or timer.
3. Never hardcode business rules. Pricing, durations, commission, cancellation fees, surge, service
   areas and operating hours are admin-configurable rows, not code or constants.
4. Booking status is a Postgres enum with a transition trigger. No free-text status strings.
5. Payments are confirmed only by a verified Razorpay webhook/signature. The client callback only
   triggers a refetch.
6. Prevent double assignment at the database level (exclusion constraint on professional_schedule,
   partial unique index on booking_assignments, pg_advisory_xact_lock). Prevent double charge and
   double booking-creation with an Idempotency-Key on the mutating endpoints.
7. Write numbered, idempotent SQL migrations in supabase/migrations and keep supabase/schema.sql in
   sync. Enable RLS on every table and add isolation tests.
8. Enforce authorization on the server (RLS + route capability checks), never only in the UI.
9. Ship loading, empty, error, success and retry states for every async surface. Use react-hot-toast
   with the server's specific error message.
10. Use transactions, optimistic locking (bookings.version) and idempotency for every money or
    state-changing operation.
11. Validate all input on the server with Bean-Validation-equivalent discipline (explicit validators,
    length caps, allow-lists). Never log OTPs, passwords, payment secrets, full ID numbers or bank
    credentials.
12. Keep the code modular and typed: route handlers thin, business logic in lib/ (pricing, matching,
    availability, notifications, audit), row types derived from the Database type.
13. Implement strictly in the phase order of §31.1 and satisfy the Definition of Done (§31.2) for
    each feature before starting the next.
14. Make every screen responsive, keyboard accessible, and correct in dark/light per the tokens.
    Never convey status by colour alone.

When done with a module, state which spec sections you implemented, which migrations you added, and
which tests you ran.
""",
    )

    h1(doc, "Appendix B — Glossary")
    kv_table(
        doc,
        [
            ("Assignment", "An offer of a booking to a professional; becomes accepted, rejected, expired or withdrawn"),
            ("Availability", "Derived: whether a service + slot + duration can be served at an address given supply, hours, lead time and area coverage"),
            ("Booking item", "One service line inside a booking (a booking may have several)"),
            ("Commission", "The platform's percentage cut of a professional's taxable amount"),
            ("Coverage / service area", "The (locality × service) pairs where a service is offered"),
            ("Instant booking", "A booking that starts as soon as a professional accepts, not on a fixed clock time"),
            ("Lead time", "Minimum minutes between now and a slot start (service prep + platform instant lead)"),
            ("Matching engine", "The ranked-candidate + offer fan-out system that assigns a professional to a paid booking"),
            ("Offer window", "How long a single offer stays live before expiring"),
            ("OTP check-in", "Customer-shared code the professional must enter to start the timer"),
            ("Reassignment", "Returning an accepted or offered booking to `searching` for a new candidate"),
            ("Serviceable", "The address resolves to a locality with an active service_areas row for the service"),
            ("Slot", "A concrete bookable start time for a duration, with remaining supply"),
            ("Taxable amount", "Subtotal + fees − discount, on which tax and commission are computed"),
            ("Wallet", "Append-only credit balance funded by refunds, promos, referrals and compensation"),
        ],
    )


def main():
    doc = new_document()

    cover(doc)
    how_to_use(doc)

    part_divider(doc, "I", "Product Specification",
                 "What SmartHelp sells, to whom, and the exact business rules that govern a booking, its money, and its lifecycle.")
    part1_product.build(doc)

    part_divider(doc, "II", "UX / UI Specification",
                 "The SmartPOS design system reproduced exactly, plus the route map and annotated wireframes for every screen.")
    part2_ux.build(doc)

    part_divider(doc, "III", "Architecture & Data",
                 "The exact SmartPOS stack, the component and data-flow diagrams, and the complete 47-table PostgreSQL schema with RLS, storage and realtime.")
    part3_tech.build(doc)

    part_divider(doc, "IV", "API, Security & Delivery",
                 "Every endpoint, the error catalogue, the security model, realtime channels, cron jobs, concurrency strategy, testing layers and the phased plan.")
    part4_api_ops.build(doc)

    closing(doc)

    update_fields_on_open(doc)
    doc.save(OUT)
    print("Wrote:", OUT)
    print("Size :", f"{os.path.getsize(OUT) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
