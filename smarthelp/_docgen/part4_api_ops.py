"""Part 4 — API reference, auth, realtime, cron, security, testing, delivery."""

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
    # ── 25. API conventions ───────────────────────────────────────────────
    h1(doc, "25. API Design")

    p(doc, "All endpoints are Next.js Route Handlers under `app/api/**/route.ts`, base path `/api`. They are plain REST with a consistent envelope. There is no GraphQL and no tRPC — same as SmartPOS.")

    h2(doc, "25.1 Response envelope")
    code(
        doc,
        """
// Success
{ "success": true, "data": { ... } }

// Error
{
  "success": false,
  "error": "Professional is no longer available",
  "code": "PROFESSIONAL_UNAVAILABLE",
  "details": { "bookingId": "…", "retryAfter": 30 },
  "requestId": "req_7f2a91c4",
  "timestamp": "2026-09-26T18:30:00Z"
}
""",
    )
    kv_table(
        doc,
        [
            ("Status codes", "`200` ok · `201` created · `202` accepted for async · `204` no body"),
            ("Client errors", "`400` validation · `401` unauthenticated · `403` forbidden · `404` not found · `409` conflict (state/optimistic lock) · `422` business rule · `429` rate limited"),
            ("Server errors", "`500` unexpected · `502` upstream (Razorpay/SMS) · `503` degraded (matching offline)"),
            ("Idempotency", "`Idempotency-Key: <uuid>` header on all POST money/booking routes; replay returns the original response with `Idempotent-Replay: true`"),
            ("Pagination", "`?limit=&offset=` with `{ data, meta: { total, limit, offset } }`"),
            ("Versioning", "Path-scoped from the start: `/api/bookings`, not `/api/v1` — a single shipped surface does not need a version prefix; breaking changes get `/api/v2`"),
            ("Request ID", "`x-request-id` echoed in the response and attached to every log line"),
            ("Time", "ISO-8601 with offset, UTC in storage, city timezone for display"),
            ("Money", "Decimal numbers in major units with 2 dp, never floats; currency code always present"),
        ],
    )

    h2(doc, "25.2 Error codes")
    table(
        doc,
        ["Code", "HTTP", "Meaning", "Client behaviour"],
        [
            ["`VALIDATION_ERROR`", "400", "Field-level validation failed", "Show inline field errors from `details.fields`"],
            ["`UNAUTHENTICATED`", "401", "No/invalid session", "Redirect to `/login?next=`"],
            ["`FORBIDDEN`", "403", "Role or ownership check failed", "Toast + route away"],
            ["`NOT_FOUND`", "404", "Row absent or invisible under RLS", "Not-found screen"],
            ["`INVALID_STATE`", "409", "Action illegal in current status", "Refresh booking, show current status"],
            ["`STALE_VERSION`", "409", "Optimistic lock lost", "\"Updated elsewhere — refresh\""],
            ["`ASSIGNMENT_TAKEN`", "409", "Offer already accepted by another run", "Pro: stop the countdown"],
            ["`PRICE_CHANGED`", "409", "Server re-price differs from quote", "Re-quote and show the delta"],
            ["`PAYMENT_FAILED`", "402", "Gateway declined or verification failed", "Retry payment; booking stays `payment_pending`"],
            ["`PAYMENT_NOT_VERIFIED`", "402", "Webhook not yet received", "Poll; show \"Confirming payment…\""],
            ["`SERVICE_UNAVAILABLE`", "422", "Service not offered at this locality", "Show alternatives / waitlist"],
            ["`NO_SLOT_AVAILABLE`", "422", "No supply for requested time", "Show nearest slots"],
            ["`PROFESSIONAL_UNAVAILABLE`", "422", "Candidate pool exhausted", "Auto-reassign; refund if exhausted"],
            ["`OTP_INVALID`", "422", "Wrong code", "Inline error, attempt counter"],
            ["`OTP_EXPIRED`", "422", "TTL elapsed", "Offer regeneration"],
            ["`OTP_LOCKED`", "429", "Too many attempts", "Show lockout countdown"],
            ["`COUPON_INVALID`", "422", "Expired / not applicable / limit hit", "Inline on coupon field"],
            ["`COUPON_EXHAUSTED`", "422", "Global or per-user limit hit", "Remove coupon, show new total"],
            ["`ADDRESS_IN_USE`", "409", "Address has upcoming bookings", "Explain and offer archive"],
            ["`RATE_LIMITED`", "429", "Too many requests", "Back off with `Retry-After`"],
            ["`IDEMPOTENCY_CONFLICT`", "409", "Same key, different body", "Reject; tell user to retry with new key"],
            ["`ILLEGAL_TRANSITION`", "409", "State machine rejected the change", "Surface as a status conflict"],
            ["`INTERNAL_ERROR`", "500", "Unexpected", "Retry button + requestId for support"],
        ],
        widths=[1.5, 0.5, 2.3, 2.4],
        font_size=8.5,
    )

    h2(doc, "25.3 Authentication endpoints")
    table(
        doc,
        ["Method + path", "Auth", "Purpose"],
        [
            ["`POST /api/auth/send-otp`", "public", "Send login/service OTP to phone (SMS) or email (SMTP)"],
            ["`POST /api/auth/verify-otp`", "public", "Verify code → Supabase session; returns profile + role"],
            ["`POST /api/auth/refresh`", "session", "Refresh the access token"],
            ["`POST /api/auth/sign-out`", "session", "Revoke the refresh token"],
            ["`GET  /api/auth/me`", "session", "Profile, role, capabilities, unread counts"],
            ["`PUT  /api/auth/me`", "session", "Update name, avatar, email, locale"],
            ["`POST /api/auth/professional/apply`", "session", "Submit professional application (creates `professionals` row `not_submitted`)"],
        ],
        widths=[2.5, 0.8, 3.4],
    )

    h2(doc, "25.4 Customer endpoints")
    table(
        doc,
        ["Method + path", "Purpose"],
        [
            ["`GET    /api/customers/me`", "Profile, stats, default address"],
            ["`GET    /api/customers/me/addresses`", "Address list with locality coverage badge"],
            ["`POST   /api/customers/me/addresses`", "Create address (geocode + resolve locality)"],
            ["`PUT    /api/customers/me/addresses/:id`", "Update; `is_default` handled transactionally"],
            ["`DELETE /api/customers/me/addresses/:id`", "Delete; `409 ADDRESS_IN_USE` if referenced by live bookings"],
            ["`POST   /api/customers/me/addresses/:id/default`", "Set default (single partial-unique index guarantees one)"],
            ["`GET    /api/customers/me/bookings`", "Booking list, filter by status/date, paginated"],
            ["`GET    /api/customers/me/stats`", "Spend, repeat rate, favourite pro for home screen"],
            ["`GET    /api/wallet`", "Balance + paginated ledger"],
            ["`POST   /api/wallet/redeem`", "Spend wallet balance at checkout (creates a debit txn)"],
            ["`GET    /api/favourites`", "Favourited services and professionals"],
            ["`POST   /api/favourites`", "Add favourite (idempotent)"],
            ["`DELETE /api/favourites/:type/:id`", "Remove favourite"],
            ["`GET    /api/invoices/:bookingId`", "Invoice JSON + signed PDF URL"],
        ],
        widths=[2.6, 4.1],
    )

    h2(doc, "25.5 Catalogue and availability endpoints")
    table(
        doc,
        ["Method + path", "Purpose"],
        [
            ["`GET /api/service-categories`", "Active categories with counts and icons"],
            ["`GET /api/services`", "Catalogue; `?q= &category= &lat= &lng= &availableOnly=true`"],
            ["`GET /api/services/:slug`", "Detail: description, tasks (included/excluded), durations, serviceable-at-address"],
            ["`GET /api/availability`", "Slot list. Params: `serviceId`, `addressId`, `date`, `duration`, `professionalId?` → `{ slots: [{ start, end, remaining, reason }] }`"],
            ["`GET /api/availability/estimate`", "Instant ETA: `?serviceId&addressId` → `{ etaMinutes, prosAvailable }` — used for the \"as soon as possible\" card"],
            ["`GET /api/professionals/:id`", "Public pro profile: name, photo, rating, jobs, skills, reviews"],
            ["`GET /api/professionals/:id/reviews`", "Paginated reviews for the pro page"],
        ],
        widths=[2.9, 3.8],
    )

    h2(doc, "25.6 Booking endpoints")
    table(
        doc,
        ["Method + path", "Purpose", "Idempotent"],
        [
            ["`POST /api/bookings/quote`", "Pure price quote, returns `quoteToken`", "n/a (read-only)"],
            ["`POST /api/bookings`", "Create booking (draft → payment_pending); accepts `quoteToken`", "yes"],
            ["`GET  /api/bookings`", "List with filters", "—"],
            ["`GET  /api/bookings/:id`", "Detail: status, timeline, assignment, payment, invoice flag", "—"],
            ["`GET  /api/bookings/:id/track`", "Live view: status, pro location, ETA, OTP (if arrived), `serverNow`", "—"],
            ["`POST /api/bookings/:id/cancel`", "Cancel with reason; computes fee; queues refund", "yes"],
            ["`POST /api/bookings/:id/reschedule`", "New slot; re-validates availability and pro calendar", "yes"],
            ["`POST /api/bookings/:id/extend`", "Request extension; collision-checks the pro's next job", "yes"],
            ["`POST /api/bookings/:id/otp/regenerate`", "Re-issue the service OTP (max 3)", "yes"],
            ["`POST /api/bookings/:id/review`", "Submit rating + review", "yes (upsert on booking_id)"],
            ["`GET  /api/bookings/:id/invoice`", "Invoice data and PDF URL", "—"],
            ["`GET  /api/bookings/:id/chat`", "Thread + messages for the booking", "—"],
        ],
        widths=[2.5, 3.1, 1.1],
        font_size=8.5,
    )

    h2(doc, "25.7 Professional endpoints")
    table(
        doc,
        ["Method + path", "Purpose"],
        [
            ["`GET  /api/professionals/me`", "Profile, verification/training status, rating, earnings summary"],
            ["`PUT  /api/professionals/me`", "Update bio, service radius, photo, skills"],
            ["`POST /api/professionals/me/availability`", "Set online/offline/break (Presence + DB)"],
            ["`GET  /api/professionals/me/working-hours`", "Weekly template"],
            ["`PUT  /api/professionals/me/working-hours`", "Replace weekly template"],
            ["`POST /api/professionals/me/time-off`", "Block dates; rejects if it collides with a reserved job"],
            ["`GET  /api/professionals/me/jobs`", "Today's + upcoming jobs, statuses"],
            ["`GET  /api/professionals/offers`", "Live offer inbox (Realtime + polling fallback)"],
            ["`POST /api/professionals/offers/:id/accept`", "Atomic CAS accept; creates schedule window"],
            ["`POST /api/professionals/offers/:id/decline`", "Decline with optional reason; excluded from this booking"],
            ["`POST /api/professionals/jobs/:id/arrive`", "Geofence check, sets `arrived`"],
            ["`POST /api/professionals/jobs/:id/otp`", "Verify service OTP → `in_progress` (server timer starts)"],
            ["`POST /api/professionals/jobs/:id/complete`", "End service, record actual duration, create earning"],
            ["`POST /api/professionals/jobs/:id/no-show`", "Mark customer no-show after grace period"],
            ["`POST /api/professionals/me/location`", "Live location ping (throttled to 1/30s)"],
            ["`GET  /api/professionals/me/earnings`", "Summary + per-job earnings; `?period=today|week|month`"],
            ["`GET  /api/professionals/me/payouts`", "Payout history with statements"],
            ["`POST /api/professionals/me/kyc`", "Upload document → signed URL; submit for review"],
            ["`GET  /api/professionals/me/kyc`", "Per-document status"],
        ],
        widths=[2.9, 3.8],
    )

    h2(doc, "25.8 Payment, refund, wallet endpoints")
    table(
        doc,
        ["Method + path", "Purpose"],
        [
            ["`POST /api/payments/create-order`", "Razorpay order for a booking or extension; `Idempotency-Key` required"],
            ["`POST /api/payments/verify`", "Signature verification for immediate UX; webhook remains authoritative"],
            ["`POST /api/webhooks/razorpay`", "Authoritative: `payment.captured`, `refund.processed`, `payment.failed`"],
            ["`GET  /api/payments/:id`", "Poll payment status while webhook lands"],
            ["`POST /api/refunds`", "Request refund (admin/ops/support); auto-refunds for system reasons"],
            ["`GET  /api/refunds`", "Refund list with filters"],
            ["`POST /api/wallet/topup`", "Wallet top-up via Razorpay (v1: promo/ops credit only)"],
        ],
        widths=[2.6, 4.1],
    )

    h2(doc, "25.9 Support, chat, notification, referral, SOS endpoints")
    table(
        doc,
        ["Method + path", "Purpose"],
        [
            ["`POST /api/support/tickets`", "Create ticket; auto-computes priority, SLA, and `disputed` status if damage/safety"],
            ["`GET  /api/support/tickets`", "List (customer: own; staff: queue)"],
            ["`GET  /api/support/tickets/:id`", "Thread with messages and booking context"],
            ["`POST /api/support/tickets/:id/messages`", "Reply; `is_internal` for staff notes"],
            ["`PUT  /api/support/tickets/:id`", "Assign / status / priority (staff)"],
            ["`GET  /api/chat/threads/:id/messages`", "History"],
            ["`POST /api/chat/threads/:id/messages`", "Send; Realtime broadcast; system messages server-only"],
            ["`GET  /api/notifications`", "List; unread count"],
            ["`POST /api/notifications/:id/read`", "Mark read"],
            ["`POST /api/notifications/push-token`", "Register a push token (Realtime/push)"],
            ["`POST /api/referrals/validate`", "Check a referral code at signup"],
            ["`POST /api/sos`", "Create emergency incident; pages ops; freezes payout"],
        ],
        widths=[2.6, 4.1],
    )

    h2(doc, "25.10 Admin endpoints")
    p(doc, "Guarded by role capability checks in the handler **and** RLS. Every mutating admin route writes an `audit_logs` row and requires a `reason` for destructive actions.")
    table(
        doc,
        ["Method + path", "Roles", "Purpose"],
        [
            ["`GET  /api/admin/dashboard`", "admin, ops", "KPIs, funnel, alerts, charts"],
            ["`GET/POST/PUT/DELETE /api/admin/services…`", "admin", "Services, categories, tasks, images, durations, keywords"],
            ["`PUT  /api/admin/service-areas…`", "admin", "Enable services per locality; lead time; capacity"],
            ["`GET/POST/PUT /api/admin/professionals…`", "admin, ops", "List, filter, suspend, reactivate, commission override"],
            ["`POST /api/admin/professionals/:id/kyc/:docId/:decision`", "admin", "verify / reject / request re-upload"],
            ["`POST /api/admin/bookings/:id/assign`", "ops, admin", "Manual assign or force reassign (records score)"],
            ["`POST /api/admin/bookings/:id/cancel`", "ops, admin", "Cancel with reason; auto-refund"],
            ["`GET/PUT /api/admin/pricing-rules…`", "admin", "Multipliers, surge, fees, tax"],
            ["`GET/PUT /api/admin/cancellation-policies…`", "admin", "Cancellation ladder"],
            ["`GET/POST/PUT /api/admin/coupons…`", "admin", "Coupon CRUD and usage view"],
            ["`POST /api/admin/refunds/:id/execute`", "ops, admin", "Execute refund; dual approval above limit"],
            ["`GET  /api/admin/payouts` · `POST /api/admin/payouts/run`", "admin", "Payout batches"],
            ["`GET/PUT /api/admin/notification-templates…`", "admin", "Template editor with variable list"],
            ["`GET  /api/admin/disputes`", "ops, support, admin", "Dispute board"],
            ["`GET  /api/admin/analytics/:report`", "admin, ops", "revenue, funnel, supply, ratings, city, service"],
            ["`GET/PUT /api/admin/platform-settings…`", "admin", "Config; secrets write-only"],
            ["`GET  /api/admin/audit`", "admin", "Filterable audit log"],
        ],
        widths=[3.4, 1.0, 2.3],
        font_size=8,
    )

    h2(doc, "25.11 Cron endpoints")
    p(doc, "All cron routes require `CRON_SECRET` via `Authorization: Bearer`, `x-cron-secret`, or `?secret=` — the exact SmartPOS guard.")
    table(
        doc,
        ["Path", "Schedule", "Job"],
        [
            ["`/api/cron/search-sweeper`", "`*/2 * * * *`", "Cancel `searching` bookings past `search_expires_at`; auto-refund; alert ops"],
            ["`/api/cron/recurring-generate`", "`7 2 * * *`", "Materialise `recurring_occurrences` due within `recurring_lead_days` (idempotent)"],
            ["`/api/cron/service-reminders`", "`*/15 * * * *`", "\"Starting soon\", \"ending soon\", \"professional on the way\", ETA nudges"],
            ["`/api/cron/demand-index`", "`*/5 * * * *`", "Recompute surge `demand_index` per locality+service"],
            ["`/api/cron/rating-reminders`", "`13 19 * * *`", "Nudge customers to rate today's completed bookings"],
            ["`/api/cron/payout-run`", "`23 3 * * 1`", "Aggregate the week's `available` earnings into payout batches"],
            ["`/api/cron/wallet-expiry`", "`41 2 * * *`", "Expire promotional credits, prune `idempotency_keys` and `otp_requests`"],
            ["`/api/cron/reconcile-payments`", "`*/30 * * * *`", "Compare `payment_pending` older than 10 min against the gateway; resolve stragglers"],
        ],
        widths=[2.2, 1.1, 3.4],
        font_size=8.5,
    )

    h2(doc, "25.12 Route handler anatomy")
    code(
        doc,
        """
// app/api/bookings/route.ts  —  the canonical shape for every mutating route
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabaseServer';
import { requireAuth } from '@/lib/validation';
import { quoteBooking } from '@/lib/pricing';
import { withIdempotency } from '@/lib/idempotency';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const auth = await requireAuth(req, ['customer']);           // 401 / 403
  const idemKey = req.headers.get('idempotency-key');
  if (!idemKey) return err('VALIDATION_ERROR', 'Idempotency-Key required', 400);

  return withIdempotency(idemKey, 'bookings.create', auth.profileId, async () => {
    const body = await req.json().catch(() => null);
    const parsed = validateCreateBooking(body);
    if (!parsed.ok) return err('VALIDATION_ERROR', 'Invalid request', 400, { fields: parsed.errors });

    const supabase = createServerClient();                        // service role
    const quote = await quoteBooking(supabase, parsed.data, auth.profileId);
    if (!quote.serviceable)      return err('SERVICE_UNAVAILABLE', quote.reason, 422);
    if (quote.tokenMismatch)     return err('PRICE_CHANGED', 'Price changed, please review', 409, { quote });

    const booking = await createBookingRow(supabase, parsed.data, quote, auth.profileId);
    await audit(supabase, auth.profileId, 'booking.create', 'bookings', booking.id, null, quote, req);

    return NextResponse.json({ success: true, data: booking }, { status: 201 });
  });
}
""",
    )

    # ── 26. Security ──────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "26. Security Model")

    h2(doc, "26.1 Authentication")
    bullets(
        doc,
        [
            "**Customers and professionals**: Supabase Auth phone OTP. Code generated server-side, stored as salted SHA-256 in `otp_requests`, TTL 10 min, 3 attempts, 15-min lockout, 60-second resend throttle.",
            "**Staff (admin / ops / support)**: email + password (Supabase Auth). MFA required for `admin` and `super_admin` via OTP on `admin_mfa` purpose.",
            "Sessions are Supabase JWTs (access + refresh). The client never sees or stores the service-role key.",
            "The `super_admin` role is bootstrapped from the `NEXT_PUBLIC_SUPARTHELP_OWNER_LOGIN` allow-list (mirrors the SmartPOS owner pattern) and can only be *removed* in the UI, never granted.",
        ],
    )
    h2(doc, "26.2 Authorization")
    bullets(
        doc,
        [
            "Three layers: (1) RLS predicates keyed on `auth.uid()`; (2) Route handler capability checks via `requireAuth(req, roles)` / `requireCapability`; (3) UI guards for navigation convenience only.",
            "The service-role client is used **only** inside Route Handlers that have already validated the caller. It is never imported into a client component.",
            "Ownership is always checked explicitly (`customer_id = auth.uid()`-equivalent), even where RLS already covers it — defence in depth for the money paths.",
        ],
    )
    h2(doc, "26.3 Data protection")
    table(
        doc,
        ["Data", "At rest", "In transit", "Exposed to"],
        [
            ["Government ID / KYC files", "private bucket", "TLS + signed URLs", "owner and admin only"],
            ["Bank details / UPI", "encrypted column", "TLS", "pro (own) and admin payout view (masked)"],
            ["OTP codes", "salted hash", "SMS over TLS", "never logged, never returned after issue"],
            ["Razorpay signature", "stored for disputes", "TLS", "never logged, admin-only column select"],
            ["Customer phone", "plaintext (operational need)", "TLS", "pro sees a masked relay; full number only for assigned booking"],
            ["Live location", "plaintext, 90-day TTL", "TLS", "pro (own), assigned customer during the job only"],
        ],
        widths=[1.5, 1.4, 1.3, 2.5],
        font_size=8.5,
    )
    h2(doc, "26.4 Application security checklist")
    bullets(
        doc,
        [
            "Input validation on every Route Handler body (allow-list, type + length caps).",
            "RLS on all 47 tables; `bookings` and financial tables deny direct client UPDATE/DELETE.",
            "Rate limits: OTP send 3/hour/number, login 10/15min/IP, booking create 20/hour/customer, chat 60/hour/thread, review 5/day. Implemented with a `hashtext`-bucketed counter query (Redis-free).",
            "No secrets in client bundles. `RAZORPAY_KEY_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `SMTP_PASS` are server-only and read with no `NEXT_PUBLIC_` prefix.",
            "Razorpay webhook HMAC-SHA512 over the raw body; webhook secret env-only.",
            "Signed, short-lived upload URLs with MIME allow-list and size cap per bucket.",
            "Security headers via `next.config.mjs`: CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS in production.",
            "SQL injection: Supabase client parameterises everything; no string-concatenated SQL anywhere, including in `lib/` functions that use `.rpc()` or `.from()`.",
            "XSS: React escapes by default; no `dangerouslySetInnerHTML` except the invoice renderer, which escapes all interpolated values.",
            "Audit log on every privileged mutation with actor, IP, old/new value.",
        ],
    )

    # ── 27. Realtime ──────────────────────────────────────────────────────
    h1(doc, "27. Realtime, Notifications & Live Tracking")

    h2(doc, "27.1 Channel map")
    table(
        doc,
        ["Channel", "Type", "Subscribers", "Payloads"],
        [
            ["`booking:{id}`", "Postgres changes", "customer + assigned pro + staff", "`status`, `professional_id`, `started_at`, `ends_at`, `arrived_at`, `eta_minutes`"],
            ["`pro:{id}`", "Presence", "customer during an active booking", "`online`, `lat`, `lng`, `battery`, `updated_at`"],
            ["`offers:{proId}`", "Broadcast + Postgres changes", "the professional only", "new offer, offer withdrawn, countdown tick"],
            ["`chat:{threadId}`", "Postgres changes", "participants", "new message, read receipt"],
            ["`ticket:{id}`", "Postgres changes", "customer + assigned agent", "message, status change, SLA warning"],
            ["`me:{profileId}`", "Postgres changes", "the profile itself", "notification rows, unread count"],
        ],
        widths=[1.5, 1.3, 1.7, 2.2],
        font_size=8.5,
    )
    h2(doc, "27.2 Client subscription helper")
    code(
        doc,
        """
// hooks/use-realtime.ts
export function useBookingChannel(bookingId: string, onChange: (row: BookingRow) => void) {
  useEffect(() => {
    const channel = supabase
      .channel(`booking:${bookingId}`)
      .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'bookings',
            filter: `id=eq.${bookingId}` },
          (payload) => onChange(payload.new as BookingRow))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [bookingId]);
}

// Professional live location + online status via Presence
export function useProPresence(proId: string) {
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    const channel = supabase
      .channel(`pro:${proId}`, { config: { presence: { key: proId } } })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()[proId]?.[0] as any;
        if (state) setLoc({ lat: state.lat, lng: state.lng });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [proId]);
}
""",
    )
    h2(doc, "27.3 Polling fallback")
    p(doc, "Realtime is an optimisation, not a dependency. The booking screen also polls `GET /api/bookings/:id/track` every 15 s while the booking is active, and the offer inbox polls every 5 s. If Realtime is down, the product still functions correctly — it just updates less instantly.")
    h2(doc, "27.4 Notification dispatch")
    diagram(
        doc,
        """
 booking event
      |
      v
 render(template_code, payload)   -> lib/notifications.ts
      |          uses notification_templates rows (admin-editable)
      |          tokens: {{customerName}} {{serviceName}} {{date}} {{time}} …
      v
 insert notifications rows (status='queued', one per channel)
      |
      v
 dispatch (Route Handler or cron kick):
   push  -> Supabase Realtime push (browser) / FCM-style provider (mobile later)
   sms   -> POST SMS_PROVIDER_URL (generic webhook, SMS_API_KEY bearer)
   email -> Nodemailer (SMTP_HOST/PORT/USER/PASS)
   in_app-> Realtime channel me:{profileId}
      |
      v
 update status='sent' | 'failed' + error
""",
    )
    h2(doc, "27.5 Notification catalogue")
    table(
        doc,
        ["Code", "Channel", "Trigger"],
        [
            ["`OTP_LOGIN`", "sms", "Phone OTP requested"],
            ["`BOOKING_CONFIRMED`", "sms, push, email", "Payment verified"],
            ["`PRO_ASSIGNED` / `PRO_ACCEPTED`", "push, sms", "Assignment outcome"],
            ["`PRO_ON_THE_WAY`", "push, sms", "Professional started travelling (with ETA)"],
            ["`PRO_ARRIVED`", "push", "Professional at the address"],
            ["`SERVICE_STARTED`", "push", "OTP verified, timer armed"],
            ["`SERVICE_ENDING_SOON`", "push", "15 min before `ends_at` (to pro)"],
            ["`SERVICE_COMPLETED`", "push, email", "Professional completed the job"],
            ["`EXTENSION_REQUESTED`", "push", "Customer asked for more time"],
            ["`EXTENSION_ACCEPTED` / `_DECLINED`", "push", "Professional responded"],
            ["`BOOKING_CANCELLED`", "push, sms", "Either party cancelled"],
            ["`REFUND_PROCESSED`", "push, sms, email", "Refund completed (or moved to wallet)"],
            ["`NEW_OFFER`", "push", "Offer fanned out to a professional"],
            ["`OFFER_EXPIRING`", "push", "30 s before an offer lapses"],
            ["`NEW_JOB_REMINDER`", "push", "Upcoming job in 60 min / 15 min"],
            ["`EARNING_CREATED` / `PAYOUT_SENT`", "push, sms", "Earning available / payout processed"],
            ["`KYC_APPROVED` / `KYC_REJECTED`", "push, email", "Verification decision"],
            ["`TICKET_UPDATE`", "push, email", "Support reply or status change"],
            ["`SAFETY_ALERT`", "push, sms", "SOS incident created"],
            ["`RATING_REMINDER`", "push", "Rating nudge after completion"],
        ],
        widths=[2.1, 1.0, 3.6],
        font_size=8.5,
    )

    # ── 28. Concurrency ───────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "28. Concurrency, Idempotency & Reliability")

    h2(doc, "28.1 The six concurrency hazards and their fixes")
    table(
        doc,
        ["Hazard", "Scenario", "Fix", "Layer"],
        [
            ["Double assignment", "Two bookings match the same free pro", "`professional_schedule` GiST exclusion constraint + `uniq_active_assignment_per_booking`", "Database"],
            ["Double charge", "Customer taps Pay twice, or webhook replays", "`idempotency_keys` PK `(scope,key)` + `uniq_payments_idem` + status-guarded webhook", "Database + Handler"],
            ["Double booking creation", "Refresh / back button / retry", "`Idempotency-Key` required on `POST /api/bookings`; stored response replayed", "Handler + Database"],
            ["Lost update", "Two devices mutate the same booking", "`bookings.version` optimistic lock; `UPDATE … WHERE version = $n`; 0 rows → `STALE_VERSION`", "Database"],
            ["Search race", "Assignment cron and manual assign both fire", "`pg_advisory_xact_lock('assign:'||booking_id)` serialises the transaction", "Database"],
            ["Extension double-charge", "Customer taps Extend repeatedly", "Extension is a distinct `payment_purpose='extension'` row; `uniq` on `(booking_id, purpose)` while pending", "Database"],
        ],
        widths=[1.15, 1.6, 2.75, 0.85],
        font_size=8.5,
    )
    h2(doc, "28.2 Idempotency implementation")
    code(
        doc,
        """
// lib/idempotency.ts
export async function withIdempotency(key, scope, userId, fn) {
  const hash = sha256(canonical(JSON.stringify(await readBody())));

  // Fast path: completed replay
  const { data: done } = await supabase
    .from('idempotency_keys')
    .select('*').eq('scope', scope).eq('key', key).maybeSingle();
  if (done) {
    if (done.request_hash !== hash) throw conflict('IDEMPOTENCY_CONFLICT');
    return replay(done.response);                       // header: Idempotent-Replay: true
  }

  // Claim the key; the PK makes a concurrent duplicate fail here
  const { error: claimErr } = await supabase.from('idempotency_keys')
    .insert({ key, scope, request_hash: hash, status: 'in_progress', created_by: userId });
  if (claimErr?.code === '23505') {
    // Someone else is mid-flight: return 409 with Retry-After rather than double-execute
    return conflict('IDEMPOTENCY_CONFLICT');
  }

  const result = await fn();
  await supabase.from('idempotency_keys')
    .update({ response: result, status: 'completed' })
    .eq('scope', scope).eq('key', key);
  return result;
}
""",
    )
    h2(doc, "28.3 Optimistic locking on bookings")
    code(
        doc,
        """
UPDATE bookings
   SET status = $2, version = version + 1
 WHERE id = $1 AND version = $3;     -- $3 = the version the client read
-- 0 rows updated => someone else moved it => respond 409 STALE_VERSION with the fresh row
""",
    )
    h2(doc, "28.4 Failure isolation")
    bullets(
        doc,
        [
            "**Razorpay down** → order creation returns `502`; booking stays `payment_pending`; `reconcile-payments` cron retries reconciliation every 30 min.",
            "**SMS provider down** → OTP falls back to voice call (if configured) then email; `OTP_LOGIN` row marked failed but login still possible via the fallback path.",
            "**Realtime down** → polling fallback (§27.3).",
            "**Matching finds nobody** → search sweeper auto-cancels and refunds within 2 minutes of `search_expires_at`.",
            "**Cron overlap** → Vercel Cron is single-fire per schedule; the handlers additionally take an advisory lock so a manual trigger cannot race the schedule.",
            "**Database connection exhaustion** → service-role client uses the pooled URL; handlers are stateless so they scale horizontally.",
        ],
    )
    h2(doc, "28.5 Performance targets")
    table(
        doc,
        ["Operation", "Target p95", "Notes"],
        [
            ["`GET /api/services` (catalogue)", "< 200 ms", "Cached at the edge; catalogue rarely changes"],
            ["`GET /api/availability`", "< 400 ms", "One indexed query; slot list computed, not stored"],
            ["`POST /api/bookings/quote`", "< 150 ms", "Pure calculation, no writes"],
            ["`POST /api/bookings` (create)", "< 500 ms", "Single transaction"],
            ["`POST /api/bookings/:id/assign`", "< 300 ms", "Advisory lock + indexed candidate scan"],
            ["`GET /api/bookings/:id/track`", "< 150 ms", "Single row + last location"],
            ["Webhook → booking paid", "< 1 s", "Signature verify is constant-time"],
            ["Realtime status → screen", "< 1 s", "Plus ≤ 15 s worst case via polling"],
        ],
        widths=[2.5, 1.0, 3.2],
    )

    # ── 29. Testing ──────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "29. Testing Strategy")

    h2(doc, "29.1 Layers")
    table(
        doc,
        ["Layer", "Tool", "Scope"],
        [
            ["Unit", "Vitest", "`lib/pricing.ts`, `lib/matching.ts`, `lib/availability.ts`, `lib/status.ts`, validators, coupon logic, cancellation fee, commission split"],
            ["Integration", "Vitest + real Supabase (local `supabase start`)", "Booking create → match → accept → OTP → complete; payment webhook; refund; extension; RLS isolation tests"],
            ["API", "Vitest against `next dev`", "Status codes, envelope, error codes, idempotency replay, optimistic-lock conflict"],
            ["Component", "Vitest + Testing Library", "Price breakdown maths rendering, OTP dialog, status badge mapping, empty/error states"],
            ["E2E", "Playwright (desktop + mobile viewport)", "The critical acceptance flow in §30, plus checkout, pro accept, KYC review"],
            ["Manual", "Human, scripted", "`test/SmartHelp_Test_Suite.xlsx` + `TEST_PLAN.md` + `TEST_CONDITIONS.md` + `TEST_RESULTS.md` — mirrors the SmartPOS test folder"],
        ],
        widths=[1.0, 1.9, 3.8],
        font_size=8.5,
    )
    h2(doc, "29.2 Mandatory unit-test cases (the money and the state)")
    bullets(
        doc,
        [
            "**Pricing**: hourly/flat/per_unit line totals; peak multiplier stacking; platform fee floor; coupon cap; tax on post-discount taxable; `PRICE_CHANGED` when a rule changes mid-quote; surge clamp at max.",
            "**Cancellation**: every ladder band; fee 0 above 24 h; pro-cancelled always waives the fee; overcharge guard when fee > amount.",
            "**Commission**: gross/net split; pro override; rounding to 2 dp; negative-amount guard.",
            "**Matching**: candidate filter excludes unverified, untrained, offline, already-booked, out-of-radius, and prior-decliner; favourite bonus applied; score ordering stable.",
            "**Availability**: slot generation respects working hours, prep minutes, time-off, and `max_booking_minutes`; past slots excluded.",
            "**State machine**: every legal transition allowed, and a representative illegal set rejected (`draft → in_progress`, `completed → cancelled`, `refunded → paid`).",
        ],
    )
    h2(doc, "29.3 RLS isolation tests")
    p(doc, "For every table, an integration test creates two users (customer A, customer B) and asserts A cannot read or write B's rows via the anon/authenticated client. This is the highest-value test class in the project and it is not optional.")
    h2(doc, "29.4 Concurrency tests")
    bullets(
        doc,
        [
            "Fire 50 concurrent `POST /api/bookings/:id/assign` for one booking; assert exactly one offer reaches `accepted`.",
            "Attempt to insert two overlapping `professional_schedule` rows; assert the second is rejected by the exclusion constraint.",
            "Fire 10 concurrent `POST /api/bookings` with the same `Idempotency-Key`; assert one booking and one payment.",
            "Two concurrent OTP attempts with the correct code; assert the second gets `INVALID_STATE` because the booking already moved to `in_progress`.",
        ],
    )

    # ── 30. Acceptance ────────────────────────────────────────────────────
    page_break(doc)
    h1(doc, "30. Acceptance Test — The Critical Path")

    p(doc, "This end-to-end flow must pass in staging before any release. It is the automated Playwright spec `e2e/critical-booking.spec.ts` and a row in the manual suite.")
    steps(
        doc,
        [
            "Customer signs up with a phone number and verifies the OTP.",
            "Customer adds an address with a pincode that has an active `service_areas` row for Full House Cleaning.",
            "Customer opens Full House Cleaning and sees it as bookable; a service with no `service_areas` row is not offered.",
            "Customer selects **Instant**, 2 hours, and an address; availability returns a positive supply count.",
            "A price breakdown renders: subtotal, platform fee, tax, total — all server-computed; the client never adds anything.",
            "Customer applies a valid coupon; the discount line appears and the total drops by the capped amount.",
            "Customer pays. The Razorpay order is created; the webhook is delivered; the payment is verified by signature; the booking moves to `paid` and then `searching`.",
            "The matching engine ranks candidates; a professional receives an offer on their device in real time.",
            "The professional accepts. The booking moves to `assigned` → `accepted`; a `professional_schedule` window is created; the customer is notified.",
            "The professional taps **On the way**, then **Arrived**. The customer sees the OTP `4821` on their screen.",
            "The professional enters the wrong code once → `OTP_INVALID`, attempt counter increments. The correct code is then accepted.",
            "`started_at` and `ends_at` are set from the database clock; the customer's screen shows a countdown synced to `serverNow`.",
            "The customer requests a 30-minute extension; it is accepted, paid, and `ends_at` extends by 30 minutes.",
            "The professional completes the service; `actual_duration_minutes` is recorded; a `professional_earnings` row (status `pending`) is created; the customer is notified.",
            "The customer rates the professional 5 stars with a comment; the booking moves to `closed`; `professionals.rating` updates.",
            "Both `booking_status_history` and `audit_logs` contain the full trail of the flow.",
        ],
    )
    h2(doc, "30.1 Negative-path acceptance")
    bullets(
        doc,
        [
            "Pay, but remove all professionals from the pool → within 2 minutes the booking is `refund_pending` and then `refunded`; the customer sees a full refund notice.",
            "Professional accepts, then goes offline → the booking returns to `searching`; another professional is offered; if the pool is empty, auto-refund.",
            "Tamper with the price in the browser and resubmit → `PRICE_CHANGED`, booking not created, fresh quote shown.",
            "Replay the Razorpay webhook → no state change, no duplicate earning, logged as duplicate.",
            "A second customer tries to book the same professional for an overlapping time → that professional is not offered (exclusion constraint).",
        ],
    )

    # ── 31. Delivery ──────────────────────────────────────────────────────
    h1(doc, "31. Delivery Plan")

    h2(doc, "31.1 Phases")
    table(
        doc,
        ["Phase", "Scope", "Exit criteria"],
        [
            ["**0. Foundation**", "Next.js scaffold, design tokens verbatim, `AuthContext` (Supabase Auth), roles, migrations 0001–0006, seed data, Supabase buckets, deploy to Vercel", "Login works for all 3 role types; RLS verified; a professional and a service exist in the DB"],
            ["**1. Catalogue & availability**", "Public landing, catalogue, service detail, `GET /api/availability`, addresses, geolocation", "Customer can find a bookable service at their address and see real slots"],
            ["**2. Booking & pricing**", "Quote engine, booking create, cancel/reschedule, coupons, invoice stub, `bookings` state machine", "Bookings can be created and cancelled end-to-end with correct money maths"],
            ["**3. Payments**", "Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation cron", "Real money in, real money out; webhook is the sole authority; RLS on payments"],
            ["**4. Professional app**", "KYC upload, verification workflow, working hours, offers inbox, accept/decline, arrive, OTP, complete", "A verified professional can take and complete a job"],
            ["**5. Matching engine**", "Candidate ranking, offer fan-out, advisory locks, reassignment cascade, search sweeper", "No double assignment under concurrency; exhausted search auto-refunds"],
            ["**6. Admin console**", "Dashboard, bookings, KYC review, services, pricing rules, payments, coupons, disputes, support, audit, settings", "Ops can run the marketplace without a database console"],
            ["**7. Realtime & notifications**", "Channels, presence, chat, notification dispatcher, templates, reminders", "Status updates land in < 1 s; every catalogue notification fires"],
            ["**8. Growth & advanced**", "Recurring, wallet top-up, referrals, favourites, surge, invoices/PDF, PWA", "Recurring generates idempotently; surge is capped; PWA installs"],
            ["**9. Hardening & launch**", "Security review, RLS audit, load test, accessibility pass, legal pages, runbook", "Critical acceptance path green; no open P1/P2 security findings"],
        ],
        widths=[1.4, 2.6, 2.7],
        font_size=8.5,
    )
    h2(doc, "31.2 Definition of Done (per feature)")
    bullets(
        doc,
        [
            "Migration written, idempotent, and added to `supabase/schema.sql`.",
            "RLS policies written and covered by an isolation test.",
            "Route Handler with validation, capability check, error envelope, and audit log if privileged.",
            "Client wired to the real endpoint — **no placeholder buttons, no fake success states**.",
            "Loading, empty, error, success and retry states all present.",
            "Unit tests for pricing/logic; integration test for the happy path and one failure path.",
            "Toast copy is human and specific; no \"Something went wrong\" when the server said better.",
            "Responsive at 390 / 768 / 1280 px; keyboard navigable; no colour-only status.",
            "Documented in `docs/` (FEATURES / API / DATABASE) in the SmartPOS house style.",
        ],
    )
    h2(doc, "31.3 Environment variables")
    code(
        doc,
        """
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server only - never NEXT_PUBLIC_
SUPABASE_DB_URL=                    # optional, for scripts

# Auth / platform
NEXT_PUBLIC_APP_URL=                # https://smarthelp.vercel.app
NEXT_PUBLIC_SUPARTHELP_OWNER_LOGIN= # super_admin bootstrap allow-list (mirrors SmartPOS owner pattern)
CRON_SECRET=                        # guards all /api/cron/*

# Razorpay
NEXT_PUBLIC_RAZORPAY_KEY_ID=
RAZORPAY_KEY_ID=                    # server-side, for order creation
RAZORPAY_KEY_SECRET=                # server only
RAZORPAY_WEBHOOK_SECRET=            # server only, webhook HMAC

# Notifications
SMTP_HOST=  SMTP_PORT=  SMTP_USER=  SMTP_PASS=  SMTP_FROM=
SMS_PROVIDER_URL=                   # generic SMS/WhatsApp webhook (same contract as SmartPOS)
SMS_API_KEY=

# Defaults seeded into platform_settings on first run
DEFAULT_CURRENCY=INR
DEFAULT_TAX_RATE=0.18
DEFAULT_COMMISSION_PCT=0.20
DEFAULT_PLATFORM_FEE=20
DEFAULT_SERVICE_OTP_LENGTH=4
DEFAULT_INSTANT_LEAD_MINUTES=30

# Misc
LOW_STOCK_THRESHOLD=                # n/a here, kept for parity; do not use
NEXT_PUBLIC_MAP_STYLE_KEY=          # optional map tiles for the address picker
""",
    )
    h2(doc, "31.4 Operational runbook (top items)")
    table(
        doc,
        ["Situation", "First action", "Then"],
        [
            ["Bookings stuck in `searching`", "Check `/api/admin/bookings?status=searching`", "Search sweeper auto-cancels at expiry; if matching is broken, inspect `professionals.availability_status`"],
            ["Payments `pending` > 15 min", "Check `reconcile-payments` cron status", "Compare with Razorpay dashboard; force reconcile for a single payment via admin"],
            ["KYC queue backing up", "Check unverified > 48 h count", "Bulk-verify with the reviewer's checklist; add an ops approver"],
            ["Match rate drops", "Compare demand index vs online pros", "Lower `offer_window_seconds`, widen `offer_radius_km`, or pause surge"],
            ["Refund spike", "Check `refund_pending` by reason code", "Likely a pro-side issue; suspend repeat offenders"],
            ["SMS not delivering", "Check `notifications` rows with status `failed`", "Provider quota or DLT; fall back to email OTP"],
        ],
        widths=[1.5, 2.3, 2.9],
        font_size=8.5,
    )

    h2(doc, "31.5 Documentation deliverables in the repo")
    bullets(
        doc,
        [
            "`docs/README.md` — index + quick facts",
            "`docs/ARCHITECTURE.md` — data flow, folder structure, key modules, design notes",
            "`docs/DATABASE.md` — table reference, storage, RLS",
            "`docs/API.md` — endpoint reference, envelope, error codes, direct Supabase usage",
            "`docs/FEATURES.md` — numbered feature walkthrough per shell",
            "`docs/SECURITY.md` — auth model, RLS, secrets, payment verification, known gaps",
            "`docs/SETUP.md` — prerequisites, env, Supabase, run, deploy, smoke test",
            "`test/` — the manual suite workbook and results log",
        ],
    )
    note(
        doc,
        "The house style is the SmartPOS one: direct, technical, candid about known gaps, heavy on "
        "tables, explicit about which layer enforces what. Do not write marketing docs for engineers.",
    )
