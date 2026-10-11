# Phase 4: professional-app - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 45 new/modified files (17 API routes, 7 pages, 7 components, 3 lib modules, 2 migrations, 9 test files)
**Analogs found:** 41 / 45 (12 exact, 26 role-match, 3 partial, 4 with no close analog → see "No Analog Found")

Sources: `04-RESEARCH.md` (§19.1 route map, P4-01..P4-10, Code Examples) and `04-UI-SPEC.md` (Screen Inventory, Interaction Contracts). Every analog below was read this session; line numbers are from the file as read.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `app/professional/jobs/page.tsx` | page (client) | request-response + 5s poll | `app/customer/bookings/[id]/page.tsx` + `app/professional/page.tsx` | role-match |
| `app/professional/jobs/[id]/page.tsx` | page (client) | request-response (RPC buttons) | `app/customer/bookings/[id]/page.tsx` | exact |
| `app/professional/kyc/page.tsx` | page (client) | file I/O via signed URL | `app/professional/page.tsx` | role-match |
| `app/professional/availability/page.tsx` | page (client) | CRUD | `app/professional/page.tsx` (frame) + addresses client pattern | role-match |
| `app/professional/earnings/page.tsx` (conditional, OQ-1) | page (client) | read | `app/professional/page.tsx` earnings stub (L155-163) | partial |
| `app/customer/bookings/[id]/page.tsx` (**modify**) | page (client) | request-response + 15s poll | itself (existing file is the analog) | exact |
| `app/professional/page.tsx` (**modify** — Phase-3 copy bug L119, jobs from API) | page (client) | request-response | itself | exact |
| `app/api/professionals/me/working-hours/route.ts` | controller | CRUD (GET/PUT) | `app/api/customers/me/addresses/route.ts` | exact |
| `app/api/professionals/me/time-off/route.ts` | controller | CRUD (GET/POST) | `app/api/customers/me/addresses/route.ts` | exact |
| `app/api/professionals/me/availability/route.ts` | controller | request-response (toggle RPC) | `app/api/customers/me/addresses/route.ts` + `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/professionals/me/kyc/route.ts` | controller | CRUD (GET status / POST submit) | `app/api/customers/me/addresses/route.ts` | exact |
| `app/api/professionals/me/jobs/route.ts` | controller | read (list, owner-filtered) | `app/api/customers/me/addresses/route.ts` GET (L29-57) | exact |
| `app/api/professionals/me/location/route.ts` | controller | write (throttled upsert) | `app/api/customers/me/addresses/route.ts` POST | role-match |
| `app/api/professionals/offers/route.ts` | controller | read model (field-filtered, §14.3) | `app/api/bookings/[id]/route.ts` | role-match |
| `app/api/professionals/offers/[id]/accept/route.ts` | controller | CAS write (guarded RPC) | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/professionals/offers/[id]/decline/route.ts` | controller | write (records reason) | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/professionals/jobs/[id]/arrive/route.ts` | controller | guarded transition (geofence) | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/professionals/jobs/[id]/otp/route.ts` | controller | guarded RPC (OTP verify) | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/professionals/jobs/[id]/complete/route.ts` | controller | guarded RPC (multi-effect txn) | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/professionals/jobs/[id]/no-show/route.ts` | controller | guarded transition + audit | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/bookings/[id]/track/route.ts` | controller | read model (15s poll, serverNow) | `app/api/bookings/[id]/route.ts` | exact |
| `app/api/bookings/[id]/otp/regenerate/route.ts` | controller | guarded RPC (cap 3) | `app/api/bookings/[id]/cancel/route.ts` | exact |
| `app/api/kyc-documents/upload-url/route.ts` | controller | signed URL mint (write pre-auth) | `app/api/customers/me/addresses/route.ts` (validation/ownership); signed-URL call itself has no analog → RESEARCH Code Example #7 | partial |
| `app/api/admin/professionals/[id]/kyc/[docId]/decision/route.ts` | controller | admin verdict + roll-up | `app/api/bookings/[id]/cancel/route.ts` + `requireAdmin` (`lib/validation.ts:228`) | role-match |
| `lib/professionalServer.ts` | service (server) | ownership/read-model + guarded RPC calls | `lib/bookingServer.ts` | exact |
| `lib/professionalClient.ts` | service (browser) | request-response client | `lib/bookingClient.ts` | exact |
| `lib/serviceOtp.ts` (or `jobActions.ts`) | utility (server) | transform (mint/redact/expiry) | `lib/otp.ts` | exact |
| `components/professional/OfferCard.tsx` | component | render (CTA + countdown) | `components/catalogue/ServiceCard.tsx` + `BookingStatusBadge` | role-match |
| `components/professional/JobCard.tsx` | component | render | `components/catalogue/ServiceCard.tsx` | role-match |
| `components/professional/KycStepper.tsx` | component | render (3-step state) | `components/catalogue/BookingTimeline.tsx` + `VERIFICATION_COPY` | role-match |
| `components/professional/EarningsSummary.tsx` (conditional) | component | render (recharts) | none (see No Analog) | none |
| `components/booking/OtpDisplay.tsx` | component | render (countdown) | `components/ui/input-otp.tsx` (slots) + `PriceBreakdown:117` tabular numerals | role-match |
| `components/booking/OtpEntry.tsx` | component | input (4-digit, auto-submit) | `components/ui/input-otp.tsx` | exact |
| `components/booking/ServiceTimer.tsx` | component | render (serverNow countdown) | none — contract only (UI-SPEC Interaction #2, RESEARCH Pattern 5) | none |
| `supabase/migrations/0012_assignment_integrity.sql` | migration | schema DDL (table + partial unique index) | `supabase/migrations/0001_core_identity.sql:57` (partial index) + 0028 grant/comment style | role-match |
| `supabase/migrations/0029_service_execution.sql` | migration | SQL RPCs (single-statement guards) | `supabase/migrations/0028_booking_write_paths.sql` | exact |
| `test/routes.professionals.test.ts` | test (route harness) | FakeSupabase | `test/routes.addresses.test.ts` | exact |
| `test/routes.offers.test.ts` | test (route harness) | FakeSupabase | `test/routes.addresses.test.ts` | exact |
| `test/routes.track.test.ts` | test (route harness) | FakeSupabase | `test/routes.addresses.test.ts` | exact |
| `test/routes.kycDecision.test.ts` | test (route harness) | FakeSupabase | `test/routes.addresses.test.ts` | exact |
| `test/professionalClient.test.ts` | test (transport) | fetch mock | `test/bookingClient.test.ts` | exact |
| `test/serviceOtp.test.ts` | test (unit) | pure helpers | `test/otp.test.ts` | exact |
| `test/db.assignments.test.ts` | test (live DB) | concurrency/CAS | `test/db.booking.test.ts` | exact |
| `test/db.jobs.test.ts` | test (live DB) | RPC behaviour + counters | `test/db.booking.test.ts` | exact |
| `test/db.rls.test.ts` (**extend**) | test (live DB) | RLS/policies | itself (exists; fix flaky predicate first — Wave 0 #1) | exact |

---

## Pattern Assignments

### `lib/professionalServer.ts` (service, server — ownership gate + guarded RPC calls)

**Analog:** `lib/bookingServer.ts` (125 lines, read in full). This is the single most important analog: RESEARCH Pattern 4 names it as the template, and its own doc comment (L42-44) says Phase 4 must add the professional analog deliberately.

**Imports pattern** (L1-5):
```typescript
import { createServerClient } from './supabaseServer'
import { requireCustomer } from './addressServer'
import { ApiHttpError } from './api'
import { canTransition } from './status'
import type { BookingStatus, UserRole } from './supabase'
```

**Ownership gate — copy this shape, swap customer→professional** (L46-51):
```typescript
export async function getBookingForCaller(id: string, customerId: string, role: UserRole) {
  const booking = await getBookingById(id)
  if (!booking) throw new ApiHttpError('NOT_FOUND', 'Booking not found', 404)
  if (booking.customer_id === customerId || STAFF_ROLES.includes(role)) return booking
  throw new ApiHttpError('FORBIDDEN', 'This booking belongs to another account.', 403)
}
// Phase 4 adds: requireProfessional(req) (mirroring requireCustomer below),
// getProBookingForCaller(...), getOffersFor(professionalId), stripOtpHash(...).
```

**The "caller row" resolver — mirror of `requireCustomer`** (`lib/addressServer.ts:41-64`, read this session):
```typescript
export async function requireCustomer(req: Request): Promise<{ auth: AuthContext; customer: { id: string } }> {
  const auth = await requireAuth(req);
  const { data: customer, error } = await createServerClient()
    .from('customers').select('id').eq('profile_id', auth.userId).maybeSingle();
  if (error) throw error;
  if (!customer) throw new ApiHttpError('FORBIDDEN', 'Addresses belong to a customer account...', 403);
  return { auth, customer };
}
// requireProfessional: identical, but .from('professionals') and a
// verification_status-aware message. Also mirror loadOwnedAddress (L69-87)
// for the 404-that-does-not-distinguish pattern.
```

**Versioned RPC call pattern — the write every pro mutation copies** (L85-125):
```typescript
export async function transitionBooking(bookingId, to, actor, note?, role = 'customer') {
  const booking = await getBookingById(bookingId)
  if (!booking) throw new ApiHttpError('NOT_FOUND', 'Booking not found', 404)
  const from = booking.status as BookingStatus
  if (!canTransition(from, to)) {
    throw new ApiHttpError('ILLEGAL_TRANSITION', `A booking cannot go from ... to ...`, 409, { from, to })
  }
  const supabase = createServerClient()
  const { data, error } = await supabase.rpc('transition_booking', {
    p_booking_id: bookingId, p_to: to, p_actor: actor, p_actor_role: role,
    p_note: note ?? null, p_expected_version: booking.version,   // version VALUE passed, never written directly
    p_window_from: null, p_window_to: null,
  })
  if (error) throw error
  if (!data) throw new ApiHttpError('STALE_VERSION', 'This booking changed while you were looking at it. Reload and try again.', 409)
  return data
}
// New: arriveJob / verifyServiceOtp / completeJob / noShowJob / acceptOffer
// follow this exact shape against the 0029/0012 RPCs.
```

---

### `lib/professionalClient.ts` (service, browser — authenticated fetch wrapper)

**Analog:** `lib/bookingClient.ts` (387 lines, read in full). Pitfall 2 makes this non-optional: every verb must send `authorizationHeader()`.

**Class + transport pattern — copy verbatim, rename** (L34-107):
```typescript
import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

export class BookingApiError extends Error {          // → ProfessionalApiError
  constructor(message: string, readonly code: ApiErrorCode | string,
              readonly status: number, readonly details?: Record<string, unknown>) {
    super(message); this.name = 'BookingApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const auth = await authorizationHeader();           // resolved BEFORE the try (see L67-72 note)
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: 'include',
      headers: { accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...auth, ...(init?.headers ?? {}) } });
  } catch { throw new BookingApiError('We could not reach SmartHelp. Check your connection and try again.', 'NETWORK_ERROR', 0); }
  if (!res.ok) { const { message, code, details } = await readApiError(res);
                 throw new BookingApiError(message, code, res.status, details); }
  return ((await res.json()) as { data: T }).data;
}
```

**Export style — one function per endpoint** (L333-367):
```typescript
export function fetchBookings(query: {...} = {}): Promise<BookingListResult> { ... }
export function cancelBooking(id: string, reasonCode: string, reason?: string): Promise<CancelResult> {
  return request<CancelResult>(`/api/bookings/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: JSON.stringify({ reasonCode, reason: reason ?? null }) });
}
// Phase 4: fetchOffers(), acceptOffer(id), declineOffer(id, reason), arriveJob(id, {lat,lng,overrideReason}),
// verifyServiceOtp(id, code), completeJob(id), regenerateOtp(bookingId), trackBooking(id),
// fetchWorkingHours(), saveWorkingHours(), addTimeOff(), setAvailability(), uploadKyc(file)...
```

**Session source:** `lib/sessionHeaders.ts:33-37` — `authorizationHeader()` reads `supabase.auth.getSession()` per call (never cached; never `credentials:'include'` alone).

---

### `app/api/professionals/me/{working-hours,time-off,availability,kyc,jobs,location}/route.ts` (controllers, CRUD)

**Analog:** `app/api/customers/me/addresses/route.ts` (159 lines, read in full). Same role (own-resource Route Handler under a `me/` path), same data flow, same house rules.

**Boilerplate every route file carries** (L1-18):
```typescript
import { created, handle, ok } from '@/lib/api';
import { validateAddressInput } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { requireCustomer /* → requireProfessional */ } from '@/lib/addressServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS = 'id, customer_id, address_type, label, ...';   // explicit column list — never select('*') (Pitfall 13)
```

**GET pattern — ownership filter lives in the query** (L29-56):
```typescript
export async function GET(req: Request) {
  return handle(req, 'customers.addresses.list', async () => {     // → 'professionals.working_hours.list' etc.
    const { customer } = await requireCustomer(req);
    const supabase = createServerClient();
    const { data, error } = await supabase.from('addresses').select(COLUMNS)
      .eq('customer_id', customer.id)
      .order('is_default', { ascending: false });
    if (error) throw error;
    return ok({ addresses: (data ?? []).map(toAddressView), ... });
  });
}
```

**POST pattern — validate → server-side decision → insert → audit → shaped response** (L78-151):
```typescript
export async function POST(req: Request) {
  return handle(req, 'customers.addresses.create', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const input = validateAddressInput(await readBody(req));       // hand-rolled validator from lib/validation.ts
    // ... server decides what the client may not (isFirst, locality, precision) ...
    const { data: inserted, error } = await supabase.from('addresses')
      .insert({ customer_id: customer.id, /* validated fields only */ }).select(COLUMNS).single();
    if (error) throw error;
    await auditAddress(req, { actorProfileId: auth.userId, requestId, action: '...', entityId: row.id, after: row });
    return created({ address: toAddressView(row, ...) });
  });
}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) as Record<string, unknown>; } catch { return {}; }
}
```

**Mapping per file:**
- `working-hours` GET/PUT → GET/PUT shape; PUT analog `app/api/customers/me/addresses/[id]/route.ts` (patch validation, `INVALID_STATE` on illegal unset, 404 on non-owner).
- `time-off` GET/POST → addresses GET/POST; GiST overlap errors map `23P01 → PROFESSIONAL_UNAVAILABLE` (Pitfall 7).
- `availability` POST → addresses POST + single RPC call (see cancel analog for `rpc()` + null→error mapping). Optimistic Switch rollback allowed only here (UI-SPEC Interaction #4).
- `kyc` GET/POST → addresses GET/POST (`status='submitted'` required by 0005 insert policy).
- `jobs` GET → addresses GET (owner-filtered list; field-filtered columns per §14.3).
- `location` POST → addresses POST; validate with `latitude()`/`longitude()` from `lib/validation.ts:468`, throttle 1/30s server-side (§25.7).

---

### `app/api/professionals/offers/[id]/{accept,decline}/route.ts` and `app/api/professionals/jobs/[id]/{arrive,otp,complete,no-show}/route.ts` (controllers, guarded writes)

**Analog:** `app/api/bookings/[id]/cancel/route.ts` (171 lines, read in full). Exact role+flow match: capability gate → ownership → validate → one guarded RPC → map null to 409.

**Full skeleton to copy** (L18-119, abridged):
```typescript
import { NextRequest } from 'next/server'
import { ok, err } from '@/lib/api'
import { uuid, str } from '@/lib/validation'
import { requireCapability } from '@/lib/validation'
import { getBookingForCaller, requireBookingCustomer } from '@/lib/bookingServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireCapability(req, 'booking.cancel.own')     // → 'offer.accept' | 'service.start' | 'service.complete'
    const { auth, customerId } = await requireBookingCustomer(req)   // → requireProfessional + pro ownership
    const id = uuid(params.id, 'id')                       // params validated BEFORE use
    const body = await req.json().catch(() => ({}))
    const reasonCode = str(body.reasonCode || 'changed_mind', 'reasonCode', { max: 60 })

    // Ownership first — "transitionBooking guards the state machine, not who is
    // asking, and the service-role client bypasses RLS" (L35-37).
    const booking = await getBookingForCaller(id, customerId, auth.role)

    // Idempotent-in-the-friendly-direction guard (L43-49): early ok() if already done.

    const { data: result, error } = await createServerClient().rpc('cancel_booking', {   // → accept_offer / arrive_job / ...
      p_booking_id: id,
      p_expected_version: booking.version,
      p_actor: auth.userId,                                // actor + role reach booking_status_history
      p_actor_role: auth.role,
    })
    if (error) throw error
    if (!result) {
      return err('STALE_VERSION', 'This booking changed while you were looking at it. Reload and try again.', 409)
      // accept route instead maps 0-rows to ASSIGNMENT_TAKEN (409); otp route to
      // OTP_INVALID with ONE generic message (Pitfall 5).
    }
    return ok({ booking: result, ... })
  } catch (e: any) {
    if (e.code) return err(e.code, e.message, e.status)
    return err('INTERNAL_ERROR', e.message || 'Failed to cancel booking', 500)
  }
}
```

**Per-route specifics:**
- `accept` — CAS is in the SQL (`04-RESEARCH` Code Example #2): `WHERE id=$1 AND status='offered' AND expires_at > now()`; 0-rows ⇒ `err('ASSIGNMENT_TAKEN', ..., 409)`; GiST overlap ⇒ catch `23P01` ⇒ `PROFESSIONAL_UNAVAILABLE` (422 per `lib/api.ts:52`); instant bookings use `now()` when `scheduled_start_at IS NULL` (Pitfall 8).
- `arrive` — server-authoritative geofence: `haversineKm` (`lib/geo.ts:70`) against `PLATFORM_DEFAULTS` radius (Q7); manual override ⇒ `write_audit` with required reason (L132-138 audit call shape in addresses POST).
- `otp` — never branch on which check failed; catch maps to a single generic message; attempts increment inside the RPC.
- `complete`/`no-show` — one RPC does duration + schedule close + counters (+ earning if Q4); reason required for no-show (same `str()` validation as L26-27).

---

### `app/api/bookings/[id]/track/route.ts` (controller, read model, 15s poll)

**Analog:** `app/api/bookings/[id]/route.ts` (65 lines, read in full) — same path, same role (one booking for a tracking page), the Phase-2 deferral this phase closes.

```typescript
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { auth, customerId } = await requireBookingCustomer(req)
    const id = uuid(params.id, 'id')
    const booking = await getBookingForCaller(id, customerId, auth.role)   // extend: professional caller too
    const presentation = statusPresentation(booking.status as BookingStatus)  // lib/status.ts:319 — server-resolved
    const [items, history] = await Promise.all([ ...two small queries... ])   // parallel reads
    if (items.error) throw items.error
    return ok({ booking, status: presentation, cancellable: ..., reschedulable: ..., items: ..., history: ... })
  } catch (e: any) { if (e.code) return err(e.code, e.message, e.status)
                     return err('INTERNAL_ERROR', e.message || 'Failed to get booking', 500) }
}
```

**Track-specific deltas (RESEARCH Code Example #5, Pattern 5):**
- Payload carries `startedAt / endsAt / serverNow / remainingSeconds` — compute `serverNow = new Date().toISOString()` at response time; `remainingSeconds = (endsAt - serverNow)/1000`.
- **Explicit column list, not `select('*')`** (addresses route L17-18 style): strip `otp_hash` (Pitfall 1, P4-10); plaintext OTP only when `status === 'arrived'` and caller is the customer; strip customer phone/full address for professional callers pre-accept (§14.3).
- `proLocation` from `professionals.current_lat/lng` when present, else `null` (Q6).

---

### `app/api/professionals/offers/route.ts` (controller, field-filtered inbox read)

**Analog:** `app/api/customers/me/addresses/route.ts` GET (L29-57) for the list+ownership shape; `app/api/bookings/[id]/route.ts` for server-resolved presentation.

Key excerpts to reuse: `handle(req, name, fn)` wrapper; `.select(COLUMNS)` explicit list filtered `.eq('professional_id', ...)`; `statusPresentation()` server-side; **the strip list is one function in `lib/professionalServer.ts`** (Pitfall 13: "one function owns the strip list") — no locality beyond area, no phone, no full address until accepted (§14.3 / UI-SPEC Interaction #6).

---

### `app/api/kyc-documents/upload-url/route.ts` (controller, signed upload URL)

**Analog (partial):** `app/api/customers/me/addresses/route.ts` POST for the validate-then-act shape; the signed-URL call itself has no repo analog — use RESEARCH Code Example #7:

```typescript
// Method presence VERIFIED in node_modules/@supabase/storage-js; shape [ASSUMED] (A1).
const { data, error } = await supabase.storage.from('kyc-documents')
  .createSignedUploadUrl(`${professionalId}/${docType}/${filename}`);
// path ownership: prefix MUST be ${professionalId}/${docType}/…
// validate: doc_type allow-list (oneOf), size ≤ 5 MB, MIME allow-list (§24.15/§26.4).
// NEVER getPublicUrl — components/ui/ImageUpload.tsx is dead SmartPOS code (do not adapt).
```

---

### `app/api/admin/professionals/[id]/kyc/[docId]/decision/route.ts` (controller, admin verdict + roll-up)

**Analog:** `app/api/bookings/[id]/cancel/route.ts` skeleton; gate on admin instead of capability:

```typescript
// lib/validation.ts:228-233
export function requireAdmin(auth: AuthContext): AuthContext {
  if (!isAdminRole(auth.role)) throw new ApiHttpError('FORBIDDEN', 'Admin access only.', 403);
  return auth;
}
// flow: requireAuth(req, ['admin']) → validate decision oneOf(['approved','rejected'])
// → RPC (service role) writing verdict + rolling up professionals.verification_status
// → write_audit (lib/audit.ts) — decision MUST be audited (Pitfall 11).
// Guard triggers in 0005 already allow service-role verdict writes; do not touch them.
```

---

### `app/professional/jobs/[id]/page.tsx` (page, request-response, phone-first job flow)

**Analog:** `app/customer/bookings/[id]/page.tsx` (328 lines, read in full) — the house detail-page pattern.

**Shell wiring** (L320-328):
```tsx
export default function CustomerBookingDetailPage({ params }: { params: { id: string } }) {
  return (
    <AuthGuard role="customer" capability="booking.create">       // → role="professional" capability="offer.accept"
      <RoleShell role="customer" eyebrow="Booking" title="Booking details">
        <BookingDetail id={params.id} />
      </RoleShell>
    </AuthGuard>
  );
}
```

**Fetch + loading/error/not-found states** (L82-169):
```tsx
const load = useCallback(async () => { const detail = await fetchBooking(id); setData({ detail }); return detail; }, [id]);
useEffect(() => { let cancelled = false;
  load().catch((e: unknown) => {
    if (cancelled) return;
    if (e instanceof BookingApiError && e.code === 'NOT_FOUND') { setNotFound(true); return; }
    setProblem(e instanceof BookingApiError ? e.message : 'We could not load this booking right now.');
  }).finally(() => { if (!cancelled) setLoading(false); });
  return () => { cancelled = true }; }, [load]);

// loading (L139-146): role="status" spinner + "Loading this booking…"
// notFound (L148-156): <EmptyState title=... message=... action={{ href, label }} />
// problem (L158-169): <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">…</p>
```

**Card/section conventions** (L187, L216): `className="rounded-xl border border-gray-200 bg-white p-5"`; back-link L177-183. Job page adds: current-state primary CTA as anchor (UI-SPEC focal point), `aria-busy` + spinner on in-flight buttons, no optimistic UI (Interaction #4), `min-h-11` touch targets on Accept/Decline/Arrive/Start/Complete (Spacing exceptions), ConfirmationDialog for decline/no-show/cancel with required reason.

---

### `app/professional/jobs/page.tsx` + `app/professional/kyc/page.tsx` + `app/professional/availability/page.tsx` (pages)

**Analog:** `app/professional/page.tsx` (169 lines, read in full) — the frame, card style and verification banner every new professional page must reuse.

**Frame + banner pattern** (L52-93):
```tsx
<AuthGuard role="professional">
  <RoleShell role="professional" eyebrow="Professional" title="Your jobs and earnings">
    {showVerificationGate ? (
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-4 rounded-xl border border-amber-200 bg-amber-50 p-5" role="status">
        ... <Link href="#kyc" className="... bg-amber-600 px-4 py-2 text-sm font-semibold ...">Upload documents</Link>
      </div>
    ) : ( <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-5" role="status"> ... </div> )}
```
- **VERIFICATION_COPY map (L18-44)** — reuse verbatim for KYC status chips (`not_submitted/submitted/verified/rejected/expired` with `bg-*-100 text-*-800` tones + blurbs). Do not reinvent chip copy.
- **Section card** (L97-98): `<section className="bg-white border border-gray-200 rounded-xl p-6">` + `<h2 className="text-base font-semibold text-gray-900">`.
- **Fix on this file:** L119 `"Availability and scheduling arrive in Phase 3."` → real availability state (Deferral Inventory #12); L138 upload-form stub → `/professional/kyc` link; L112-116 today's jobs from `GET /api/professionals/me/jobs`.
- **KYC page** reuses the amber banner "verbatim for submitted/rejected gates on every professional page" (UI-SPEC Interaction #10-11); upload flow per Interaction #9 (client pre-check → signed URL → `status='submitted'` row).
- **Empty/loading/error copy** comes from the UI-SPEC Copywriting Contract — every list page uses `EmptyState` with the exact heading/body rows specified; loading = spinner + text with `role="status"` (L139-146 of customer detail).

---

### `app/customer/bookings/[id]/page.tsx` (modify — OtpDisplay card, track poll, timer)

**Analog:** itself. Additions follow the file's own patterns:
- Data fetch already exists (L82-132). The **15s track poll** is new: `useEffect` + `setInterval` with `clearInterval` cleanup, abort in-flight, skip if prior tick in flight, pause on `document.hidden`, refresh on visibility return (UI-SPEC Interaction #1; Pitfall 12).
- Insert `<OtpDisplay>` section when `status === 'arrived'` (after the Progress section, L216-219), and `<ServiceTimer>` when `in_progress`.
- State updates adopt the response whole (see L297-314 `onCancelled` pattern: "the cancel response carries the whole updated row… without a refetch that could show the pre-cancel state for a frame").

---

### `components/booking/OtpEntry.tsx` (component, OTP input)

**Analog:** `components/ui/input-otp.tsx` (71 lines, read in full) — the vendored `input-otp` wrapper (spec §18.6's named library).

```tsx
import { OTPInput, OTPInputContext } from 'input-otp';   // wrapper exports InputOTP, InputOTPGroup, InputOTPSlot
// Slot box (L44): 'relative flex h-10 w-10 items-center justify-center border-y border-r ...'
```
Usage contract (UI-SPEC Interaction #7): 4 slots (`maxLength={4}` on `InputOTP`), `inputMode="numeric"`, auto-submit on 4th digit, wrong code clears + refocus first slot, never prefill, never log; wrapping control gets the 44px touch target (OTP slots stay `h-10 w-10`).

### `components/booking/OtpDisplay.tsx` (component, customer-side code + countdown)

**Analog (role-match):** `components/ui/input-otp.tsx` for slot rendering (read-only: `disabled` slots); numerals follow the house rule — `text-2xl font-semibold tabular-nums` (UI-SPEC Typography; `tabular-nums` precedent at `components/catalogue/PriceBreakdown.tsx:117` `text-xs tabular-nums text-gray-700`). Countdown = `Expires in mm:ss` derived from `otpExpiresAt − serverNow` (never `Date.now()` alone, §22.3); regenerate CTA "Get a new code" disabled at cap 3 with helper text `New code limit reached — ask support.` (UI-SPEC Interaction #8).

### `components/booking/ServiceTimer.tsx`, `components/professional/EarningsSummary.tsx`

→ see **No Analog Found** below.

### `components/professional/OfferCard.tsx` / `JobCard.tsx` (components, cards)

**Analog:** `components/catalogue/ServiceCard.tsx` (102 lines, read in full) — the house card.

**Card shell** (L37-41, adapted: OfferCard is a card with buttons, not a Link — buttons get the UI-SPEC CTA treatment):
```tsx
<div className="group flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white transition hover:border-blue-300 hover:shadow-md focus-within:ring-2 focus-within:ring-blue-500">
```
- Meta rows: `text-xs text-gray-600` with lucide icons `h-3.5 w-3.5` inline (L76-96) — offer card uses this for date window, locality, price.
- **Status chip:** never hand-rolled — `<BookingStatusBadge status={...} />` from `components/catalogue/PriceBreakdown.tsx:135-146`:
```tsx
export function BookingStatusBadge({ status }: { status: string }) {
  const presentation = statusPresentation(status as never);
  return (<span title={presentation.description}
    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${presentation.badgeClass}`}>
    {presentation.label}<span className="sr-only">. {presentation.description}</span></span>);
}
```
- Offer card fields per UI-SPEC OQ-4: service name, date/time window, locality (area only), quoted price, countdown to `expiresAt`, Accept/Decline — "fields only if the read model provides them".
- Accept CTA is the visual anchor of `/professional/jobs`; Decline is ghost/outline, **not red** (Copywriting Contract).

### `components/professional/KycStepper.tsx` (component, 3-step state)

**Analog:** `components/catalogue/BookingTimeline.tsx` (132 lines, read in full) — the house stepper.

```tsx
import { CUSTOMER_LADDER, statusPresentation } from '@/lib/status';
// Step marker (L71-79): rounded-full border-2, done/current = border-blue-600 bg-blue-600, todo = border-gray-300 bg-white
// Connector (L81-86): <span className="w-0.5 flex-1 ${done ? 'bg-blue-600' : 'bg-gray-200'}" aria-hidden="true" />
// Current step carries aria-current="step" + sr-only "(current step)" (L90-94) — copy this exactly.
```
Steps: Identity / Address / Selfie (UI-SPEC Interaction #9); per-step status chips reuse `VERIFICATION_COPY` tones from `app/professional/page.tsx:18-44`; "never show internal reviewer notes" (§20.10).

### Empty states (all screens)

**Analog:** `components/catalogue/EmptyState.tsx` (48 lines, read in full) — caller supplies `title`/`message`/`action`:
```tsx
<EmptyState title="No offers right now" message="New jobs appear here as they come in. Keep yourself online to get them." />
// shell: flex flex-col items-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center
// action button is blue-600; never render an action that does nothing (L15-18 doc comment).
```
Exact copy rows for every Phase 4 empty state is in 04-UI-SPEC "Empty states".

---

### `supabase/migrations/0029_service_execution.sql` (migration, SQL RPCs)

**Analog:** `supabase/migrations/0028_booking_write_paths.sql` (249 lines, read in full) — exact: same house-number style, same single-statement doctrine, `arrive_job`/`verify_service_otp`/`complete_job`/`no_show_job` are this file's functions with different effects.

**Function template** (L162-194 `cancel_booking` — the closest shape for a guarded pro write):
```sql
create or replace function public.cancel_booking(
  p_booking_id   uuid,
  p_expected_version int,
  p_reason_code  text,
  p_fee          numeric,
  p_note         text,
  p_actor        uuid,
  p_actor_role   public.user_role
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
begin
  perform set_config('app.transition_actor', coalesce(p_actor::text, ''), true);
  perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, ''), true);
  perform set_config('app.transition_note', coalesce(p_note, ''), true);

  update public.bookings
     set status = 'cancelled', cancelled_at = now(), ...
   where id = p_booking_id
     and (p_expected_version is null or version = p_expected_version)   -- 0 rows ⇒ caller answers 409
  returning * into v_booking;
  return v_booking;
end $$;

comment on function public.cancel_booking(...) is '...';   -- every function gets a comment (L191-194)

-- Grants (L243-249): revoke from public, anon, authenticated; grant execute to service_role only.
revoke all on function public.cancel_booking(...) from public, anon, authenticated;
grant  execute on function public.cancel_booking(...) to service_role;
```
**Header block style** (L1-48): file name banner, "Why this file exists" prose, idempotency note (`create or replace`), spec references (`Spec: §8.2, §25.6, §28.1`).

**OTP verify — spec's own SQL** (RESEARCH Code Example #1) goes inside `verify_service_otp` with attempt increment + generic-failure discipline (Pitfall 5); `complete_job` adds `ended_at`, `actual_duration_minutes`, schedule-row close, counter bumps, optional earning insert — all in one statement (Pitfalls 4/9).

### `supabase/migrations/0012_assignment_integrity.sql` (migration, DDL)

**Analog (role-match):** partial unique index syntax from `supabase/migrations/0001_core_identity.sql:57`:
```sql
create unique index if not exists uniq_profiles_email on public.profiles (lower(email)) where email is not null;
-- → create unique index if not exists uniq_active_assignment_per_booking
--     on public.booking_assignments (booking_id) where status in ('offered','accepted');
```
Plus 0028's header/comment/grant conventions. **Table DDL column list must be read from spec §24.8 verbatim** (Assumptions A3 — research only read §9.1/§9.4 fragments). Taking `0012` reverses STATE's Phase-5 deferral — record as plan decision (Q1/Q9).

---

### `test/routes.{professionals,offers,track,kycDecision}.test.ts` (route harness tests)

**Analog:** `test/routes.addresses.test.ts` (517 lines, read in full) — RESEARCH Code Example #6 names it the shape to copy.

**Harness boilerplate** (L1-34, L90-130):
```typescript
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as listAddresses, POST as createAddress } from '@/app/api/customers/me/addresses/route';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'test-token';
let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const PROFILE = { id: USER_ID, role: 'professional',   // ← professional variant (L81-88 was role: 'customer')
                  status: 'active', full_name: 'Deepa Nair', phone: '+919876543210', email: null };

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    { profiles: () => ({ data: PROFILE, error: null }),
      professionals: () => ({ data: { id: PRO_ID, verification_status: 'verified' }, error: null }),
      ...overrides },                                                        // tables…
    { write_audit: () => ({ data: null, error: null }) }                     // rpcs…
  );
}
function request(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', /* headers incl. Bearer */ });
}
const body = async (res: Response) => (await res.json()) as any;
beforeEach(() => { fake = build(); });
```

**Assertion idioms to reuse:**
- 401 without token: `expect(res.status).toBe(401); expect(json.code).toBe('UNAUTHENTICATED');` (L153-158)
- 403 no profile: L195-201. 404 non-owner + zero writes: `expect(fake.writesTo('addresses')).toHaveLength(0);` (L425-439)
- RPC-only write: `expect(fake.rpcCalls.filter(c => c.fn === 'set_default_address'))…` + `expect(fake.writesTo('addresses')).toHaveLength(0);` (L487-503)
- Overridden fixture per test: `fake = build({ offers: () => ({ data: [...], error: null }) });` (L176, L426)
- **P4-10 assertions in every pro/staff payload test:** `expect(JSON.stringify(json)).not.toContain('otp_hash')`.

---

### `test/professionalClient.test.ts` (transport test)

**Analog:** `test/bookingClient.test.ts` (238 lines, read in full) — exists precisely for Pitfall 2 ("489 tests, none of which imported the module that was broken", L4-17).

**Copy these cases, one per pro verb** (L89-133):
```typescript
it('attaches the bearer token on a read', async () => {
  await fetchOffers();
  expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
});
it('attaches it on every authenticated verb, not just the one that was noticed', async () => {
  await fetchOffers(); await acceptOffer(id); await declineOffer(id, 'x'); await arriveJob(id, {...});
  await verifyServiceOtp(id, '1234'); await completeJob(id); /* …every export… */
  expect(fetchMock).toHaveBeenCalledTimes(N);
  for (const call of fetchMock.mock.calls) {
    expect((call[1]?.headers ?? {}).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  }
});
```
Mock wiring: `vi.mock('@/lib/supabase', ...)` returning `auth.getSession` (L24-30); `vi.stubGlobal('fetch', fetchMock)` (L82); error body shape matching `err()` in `lib/api.ts` (L54-68); network-error + no-session cases (L135-153, L192-198).

---

### `test/serviceOtp.test.ts` (unit test, pure helpers)

**Analog:** `test/otp.test.ts` (70 lines, read in full) — same class (pure OTP helpers, no I/O).

```typescript
describe('generateOtpCode', () => {
  it('produces exactly the configured number of digits', () => {          // → 4 for serviceOtpLength
    for (let i = 0; i < 200; i += 1) expect(generateOtpCode(4)).toMatch(/^\d{4}$/);
  });
  it('uses every digit, so a broken RNG is visible', () => { /* seen-set over 200 draws, expect all 10 */ });
  it('does not repeat itself', () => { /* >180 distinct of 200 — see the birthday-problem comment L38-47 */ });
  it('honours an explicit length', () => { expect(generateOtpCode(4)).toMatch(/^\d{4}$/); });
});
```
Phase 4 adds: redaction helper ("never log the plaintext"), expiry math (`otp_expires_at` vs `serverNow`), attempt/lockout thresholds from `PLATFORM_DEFAULTS` (`serviceOtpLength: 4`, `OTP_LOCKOUT_MINUTES` analog) — constants imported from `lib/constants.ts`, not read from a settings table (Pitfall 14).

---

### `test/db.{assignments,jobs}.test.ts` (live-DB tests)

**Analog:** `test/db.booking.test.ts` (1201 lines; header + fixtures L1-75 read this session).

**Harness boilerplate** (L1-44):
```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

const describeDb = dbUrl ? describe : describe.skip;
if (!dbUrl) { console.warn('\n[db] Skipping the … database tests — no SUPABASE_DB_URL available.\n'); }
afterAll(closeDb);
const DB_TIMEOUT = 60_000;   // shared connection + real writes with triggers
```
**Fixture helpers — copy `professionalOf` verbatim** (L63-68):
```typescript
async function professionalOf(email: string): Promise<{ profileId: string; professionalId: string }> {
  const p = await profileId(email);
  const pr = await sql(`select id from public.professionals where profile_id = '${p}';`);
  if (!/^[0-9a-f-]{36}$/i.test(pr)) throw new Error(`${email} has no professionals row`);
  return { profileId: p, professionalId: pr };
}
```
**House philosophy — copy the doc comment's stance** (L7-22): assert *behaviour* ("attempt the illegal moves and expect the database to refuse them"), never schema inspection; these run as migration owner (bypass RLS) → policy assertions belong in `db.rls.test.ts`.
Required cases (§29.2-29.4 / Validation test map): 50 concurrent accepts ⇒ exactly one winner (`DB_TIMEOUT = 60_000`); expired offer refused; schedule overlap ⇒ `PROFESSIONAL_UNAVAILABLE`; arrive/verify/complete/no-show happy+sad; attempts/lockout; counters; schedule close; `otp_hash` invisible to `authenticated` (Pitfall 1 regression).

### `test/db.rls.test.ts` (extend)

Existing file. First fix the Wave-0 flake (`test/db.rls.test.ts:141` predicate `u.email like '%@smarthelp.test'` → `like 'demo.%@smarthelp.test'`), then add: `booking_assignments` + `professional_earnings` policies, `kyc-documents` no-public-policy assertions, and the column-privilege check for `bookings.otp_hash`.

---

## Shared Patterns

### Authentication (apply to: every `/api/professionals/**` route, every admin decision route)
**Source:** `lib/validation.ts:141-219`
```typescript
// Layer 2 — role flavour
export async function requireAuth(req: Request, roles?: UserRole[]): Promise<AuthContext> {
  const header = req.headers.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new ApiHttpError('UNAUTHENTICATED', 'Please sign in to continue.', 401);
  // …getUser(token) → load profile → reject deleted/suspended/blocked → role check…
  return { userId: profile.id, role: profile.role, status: profile.status, profile, accessToken: token };
}
// Layer 2, capability flavour — FIRST TIME routes actually call this (Deferral #14)
export async function requireCapability(req: Request, capability: Capability): Promise<AuthContext> {
  const auth = await requireAuth(req);
  if (!can(auth.role, capability)) throw new ApiHttpError('FORBIDDEN', 'You do not have permission to do this.', 403, { capability });
  return auth;
}
```
Capabilities already defined in `lib/roles.ts:45-49,71`: `offer.accept`, `service.start`, `service.complete`, `availability.write`, `kyc.submit` (professional role). Route gating:
- offers accept → `requireCapability(req, 'offer.accept')`
- arrive/otp → `'service.start'`; complete → `'service.complete'`
- working-hours/time-off/availability → `'availability.write'`
- kyc submit → `'kyc.submit'`; admin decision → `requireAuth(req, ['admin'])` + `requireAdmin` (`lib/validation.ts:228`)

### Error envelope (apply to: all routes and the browser client)
**Source:** `lib/api.ts`
- Codes/statuses already exist: `OTP_INVALID/EXPIRED/LOCKED` (422/422/429), `ASSIGNMENT_TAKEN` (409), `PROFESSIONAL_UNAVAILABLE` (422), `ILLEGAL_TRANSITION` (409), `STALE_VERSION` (409) — `lib/api.ts:35-58`. **Do not add codes.**
- Server: `handle(req, name, fn)` wrapper (L136-171) — converts `ApiHttpError` to JSON, logs only `e.message` with the comment "Never log a token, an OTP, a password or a payment secret" (L160). Success via `ok()/created()`; failure via `err(code, message, status, details)`.
- Client: `readApiError(res)` (L174-189) inside `professionalClient.request`.
- Catch idiom at route bottom (cancel route L115-118): `if (e.code) return err(e.code, e.message, e.status); return err('INTERNAL_ERROR', …, 500)`.

### Validation (apply to: all POST/PUT bodies + params)
**Source:** `lib/validation.ts` — `uuid(value, field)` (L68), `str(value, field, { max })` (L25), `oneOf(value, field, allowed)` (L113), `latitude(value, field)` (L468), `readJson(req)` (L237). Hand-rolled allow-lists only — no zod (zero-new-deps, RESEARCH Alternatives table). Errors: `ApiHttpError('VALIDATION_ERROR', …, 400, { fields: { fieldName: 'msg' } })` → renders as `details.fields` (UI-SPEC: 12px `text-red-600`, `aria-invalid` + `aria-describedby`).

### Ownership / privacy filtering (apply to: every pro route + track + offers read models)
**Source:** `lib/bookingServer.ts:25-51` + `lib/addressServer.ts:41-87`
1. authenticate → 2. resolve the caller's own row (`customers`/`professionals`) → 3. filter by owner id in the query (service role bypasses RLS) → 4. 404/403 without distinguishing "not yours" from "not there".
**One strip-list function** owns every pro/staff booking payload: no `otp_hash` (Pitfall 1, P4-10), no customer phone/full address pre-accept (§14.3), explicit column lists (addresses route L17-18 pattern — never `select('*')`).

### Status single-sourcing (apply to: all UI + steppers + badges)
**Source:** `lib/status.ts:319-325` `statusPresentation()`; rendered by `components/catalogue/PriceBreakdown.tsx:135-146` (`BookingStatusBadge`) and `components/catalogue/BookingTimeline.tsx`. Labels, tones (`bg-sky-100` info / `bg-amber-100` progress / `bg-emerald-100` success / `bg-orange-100` warning / `bg-red-100` danger — UI-SPEC Color) and the ladder all come from here. UI may not offer an action the state machine forbids (derive from `canTransition` / `isReschedulableStatus` precedent, `app/api/bookings/[id]/route.ts:57`).

### Server-authoritative clock (apply to: track payload, ServiceTimer, OtpDisplay countdown)
**Source:** RESEARCH Pattern 5 + Code Example #5. Payload: `startedAt / endsAt / serverNow / remainingSeconds`; client computes `endsAt − serverNow`, re-anchored every poll. `Date.now()` deltas forbidden (§22.3).

### Polling (apply to: jobs inbox 5s, track/timer 15s)
**Source:** UI-SPEC Interaction #1 + Pitfall 12. `useEffect` with `setInterval`, `clearInterval` on cleanup, abort in-flight, no overlapping ticks, pause on `document.hidden`, immediate refresh on visibility return. No `supabase.channel()` anywhere (Phase 7).

### Audit (apply to: manual geofence override, KYC decision, no-show)
**Source:** `lib/audit.ts` `write_audit` RPC, called as in `app/api/customers/me/addresses/route.ts:132-138` (`{ actorProfileId, requestId, action, entityId, after }`); `clientIp(req)` from `lib/audit` (cancel route L11, L161).

### Constants (apply to: OTP params, geofence radius, thresholds)
**Source:** `lib/constants.ts` `PLATFORM_DEFAULTS` (L93-125) — already has `serviceOtpLength: 4` (L101), `lateArrivalThresholdMin: 15` (L110), `noShowAfterMin: 45` (L112); add `DEFAULT_ARRIVAL_RADIUS_M` env-overridable (Q7). **Never query a settings table** — `platform_settings` does not exist (Pitfall 14). OTP policy constants (`OTP_LENGTH` etc., L139-143) are importable browser-side without pulling server deps.

### Shell / frame (apply to: all `/professional/*` pages + customer tracking additions)
**Source:** `components/auth/RoleShell.tsx` (183 lines) — `SECTION_LABELS` already defines `jobs`, `earnings`, `kyc→"Verification"`, `availability` (L10-36); nav active state `bg-blue-50 text-blue-700` (L160-163); eyebrow `text-xs font-semibold uppercase tracking-wide text-blue-600` + h1 (L175-176); skip-link + `#main` (L111-116, L173). **Red-dot badge** (UI-SPEC Interaction #3) attaches to the Jobs nav item: `h-2 w-2 rounded-full bg-red-600`, `aria-label="N open offers"`, count in `aria-live="polite"` — badge derived client-side from the 5s poll, no server state. OQ-2: RoleShell nav wins over spec §19.2 bottom nav.

---

## No Analog Found

Files with no close match in the codebase — planner should use `04-RESEARCH.md` / `04-UI-SPEC.md` contracts instead:

| File | Role | Data Flow | Reason | Contract source |
|------|------|-----------|--------|-----------------|
| `components/booking/ServiceTimer.tsx` | component | render (countdown) | No server-authoritative timer exists anywhere; all existing countdown-free UI | UI-SPEC Interaction #2 (`remaining = endsAt − serverNow`, `tabular-nums`, `mm:ss`, "Time's up" state) + RESEARCH Pattern 5 / Code Example #5 |
| `components/professional/EarningsSummary.tsx` | component | render (chart) | No chart component in repo; conditional on OQ-1 | UI-SPEC Screen Inventory + `recharts ^2.12.7` already installed; home stub at `app/professional/page.tsx:155-163` is the copy anchor |
| `app/api/kyc-documents/upload-url/route.ts` — signed-URL call | controller | signed URL mint | `createSignedUploadUrl` is called nowhere in the repo; `ImageUpload.tsx` is dead code using the wrong API | RESEARCH Code Example #7 (shape `[ASSUMED]` A1 — confirm against installed `storage-js` at implementation) + §24.15 rules (5 MB, MIME allow-list, path ownership) |
| `supabase/migrations/0012…sql` — `booking_assignments` DDL body | migration | DDL | Table does not exist in any migration or `schema.sql` | Spec §24.8 **verbatim** (Assumption A3 requires reading it before writing the file); partial-index *syntax* analog: `0001_core_identity.sql:57` |

Also note (not files, but constraints with no precedent): polling hooks (no `setInterval` fetch loops exist yet — Interaction #1 is the first), and the offers **producer** (minimal `paid → searching` offer creation per Q1 — no assignment/matching code exists anywhere).

---

## Metadata

**Analog search scope:** `lib/**`, `app/api/**`, `app/customer/**`, `app/professional/**`, `components/catalogue/**`, `components/auth/**`, `components/ui/**`, `test/**`, `supabase/migrations/**`
**Files scanned (structure):** 38 test files, 36 API routes, 4 customer pages, ~70 components, 38 lib modules, migrations `0000–0028`
**Files read for excerpts:** 20 (`bookingServer.ts`, `bookingClient.ts`, `bookingClient.test.ts`, `routes.addresses.test.ts`, `addresses/route.ts`, `bookings/[id]/route.ts`, `bookings/[id]/cancel/route.ts`, `professional/page.tsx`, `customer/bookings/[id]/page.tsx`, `RoleShell.tsx`, `api.ts`, `sessionHeaders.ts`, `constants.ts`, `validation.ts` §requireAuth, `otp.ts`, `geo.ts` §haversine, `status.ts` §presentation, `addressServer.ts` §requireCustomer, `0028_booking_write_paths.sql`, `EmptyState.tsx`, `ServiceCard.tsx`, `BookingTimeline.tsx`, `PriceBreakdown.tsx` §badge, `input-otp.tsx`, `otp.test.ts`, `db.booking.test.ts` header)
**Pattern extraction date:** 2026-10-08
