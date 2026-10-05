import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the Phase 2 booking contract (§20.5, §20.6).
 *
 * Everything the customer does with money goes through here, so there is one
 * place that decides how a `PRICE_CHANGED`, a `STALE_VERSION` or an
 * `IDEMPOTENCY_CONFLICT` reaches the screen. Those three are not errors in the
 * ordinary sense — each one carries the information needed to recover, and a
 * component that treated them as "something went wrong" would throw away the
 * fresh breakdown or the current version that the server deliberately attached.
 *
 * ## The idempotency key
 *
 * `createBooking` mints one per attempt and holds it for the life of that
 * attempt. It is *not* minted inside the fetch: a retry of a request that timed
 * out has to reuse the same key, or the ledger cannot tell it apart from a
 * second, genuinely new booking. `createIdempotencyKey()` is therefore exported
 * and called by the caller, and the key travels as an argument.
 *
 * ## The `Authorization` header
 *
 * Every call here is authenticated, and the session lives in `localStorage`
 * rather than in a cookie — `getSupabase()` persists it that way, so
 * `credentials: 'include'` carries nothing the server can use. `requireAuth`
 * reads the `Authorization` header and nothing else, so a fetch that forgets it
 * is a 401 that reads, on a page the user is visibly signed in to, as "Please
 * sign in to continue." The token is attached here rather than left to each call
 * site: `AuthContext.loadMe` already does this by hand, so any second client
 * that forgot would fail in exactly the same way.
 */

export class BookingApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BookingApiError';
  }

  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

/**
 * A key the ledger will accept: 16–128 characters of `A-Za-z0-9._:-`.
 *
 * `crypto.randomUUID` is in every browser that supports the checkout, and it
 * already matches the charset. The fallback exists for a non-secure origin,
 * where `randomUUID` is undefined.
 */
export function createIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * One authenticated call.
 *
 * `authorizationHeader()` is resolved before the try on purpose: a missing
 * `NEXT_PUBLIC_*` key makes `supabase` throw, and reporting that as "check your
 * connection" would send whoever is reading the screen after a bad deploy down
 * the wrong road entirely. Inside the try it would become a network error, which
 * is a claim about the world rather than about the build.
 */
async function request<T>(
  url: string,
  init?: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const auth = await authorizationHeader();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
        ...auth,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new BookingApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new BookingApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

// ── Types ────────────────────────────────────────────────────

/** One priced line, as `lib/pricing.ts` returns it. In rupees, already rounded. */
export interface PricedLine {
  serviceId: string;
  label: string;
  pricingType: 'hourly' | 'flat' | 'per_unit';
  durationMinutes: number;
  quantity: number;
  lineTotal: number;
  discount: number;
  net: number;
}

export interface PricingBreakdown {
  lines: PricedLine[];
  subtotal: number;
  platformFee: number;
  discount: number;
  discountCode: string | null;
  taxRate: number;
  tax: number;
  total: number;
  commissionPct: number;
  commission: number;
  professionalGross: number;
  platformRevenue: number;
  currency: string;
}

export interface QuoteItemInput {
  serviceId: string;
  durationMinutes?: number;
  quantity?: number;
}

export interface QuoteResult {
  quote: PricingBreakdown;
  durationMinutes: number;
  expiresInSeconds: number;
  /**
   * §7.2's signed token, or null when the server has no signing key. Sent back on
   * create so the booking row can record that the agreed total came out of the
   * engine rather than the browser. It is not what enforces the price.
   */
  quoteToken?: string | null;
}

/**
 * The booking row as the client receives it.
 *
 * Money arrives as strings because the columns are `numeric` and a double has
 * already lost its last paisa by the time JSON hands it over. `money.ts` parses
 * it back without going through a float, so nothing here needs a `Number()`.
 */
export interface BookingRow {
  id: string;
  booking_number: string;
  status: string;
  booking_type: string;
  version: number;
  duration_minutes: number;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  address_snapshot: Record<string, unknown>;
  subtotal: string;
  platform_fee: string;
  discount: string;
  discount_code: string | null;
  tax: string;
  tax_rate: string;
  total_amount: string;
  professional_gross: string;
  currency: string;
  pricing_snapshot: Record<string, unknown>;
  notes?: string | null;
  cancellation_fee: string;
  cancellation_reason_code: string | null;
  cancelled_at: string | null;
  created_at: string;
}

/**
 * The status block as `GET /api/bookings/[id]` returns it.
 *
 * Mirrors `StatusPresentation` in `lib/status.ts` rather than importing it, so
 * that a client component gets four fields instead of the whole 18-state table
 * and its transition lists pulled into its type graph. The route is the
 * authority; this is its shape.
 */
export interface StatusPresentation {
  label: string;
  description: string;
  tone: 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';
  badgeClass: string;
  terminal: boolean;
  customerCancellable: boolean;
  step: number | null;
}

export interface BookingListResult {
  bookings: BookingRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface BookingItem {
  service_id: string;
  service_name: string;
  quantity: number;
  duration_minutes: number;
  line_total: string;
}

export interface HistoryEntry {
  from_status: string | null;
  to_status: string;
  actor_role: string | null;
  note?: string | null;
  created_at: string;
}

export interface BookingDetailResult {
  booking: BookingRow;
  status: StatusPresentation;
  cancellable: boolean;
  /** The reschedule route will accept a move from this state. */
  reschedulable: boolean;
  items: BookingItem[];
  history: HistoryEntry[];
}

export interface InvoiceResult {
  booking: BookingRow;
  invoice: {
    bookingId: string;
    bookingNumber: string;
    amount: string;
    cancellationFee: number;
    items: BookingItem[];
  };
}

export interface CreateBookingInput {
  addressId: string;
  bookingType: 'instant' | 'scheduled';
  scheduledStartAt?: string | null;
  items: QuoteItemInput[];
  couponCode?: string | null;
  notes?: string | null;
/**
     * The total the customer was shown. Sent so the server can refuse with
     * `PRICE_CHANGED` if the price moved - see §7.2.
     */
    expectedTotal?: number | null;
    /** The `quoteToken` from the quote this booking came from, when there was one. */
    quoteToken?: string | null;
  }

export interface CancelResult {
  booking: BookingRow;
  cancellationFee: number;
  refund?: number;
  band?: string;
  waived?: boolean;
  alreadyCancelled?: boolean;
}

export interface RescheduleResult {
  booking: BookingRow;
  breakdown: PricingBreakdown;
  rescheduleFee: number;
  feeBand: string;
}

// ── Calls ────────────────────────────────────────────────────

/**
 * Price a booking. Writes nothing and spends no key, so it is safe to call on
 * every change to a duration, a coupon or a service — which is exactly what the
 * 300 ms debounce in checkout does.
 */
export function quoteBooking(input: {
  items: QuoteItemInput[];
  couponCode?: string | null;
  bookingType?: 'instant' | 'scheduled';
}): Promise<QuoteResult> {
  return request<QuoteResult>('/api/bookings/quote', {
    method: 'POST',
    body: JSON.stringify({
      items: input.items,
      couponCode: input.couponCode ?? null,
      bookingType: input.bookingType ?? 'scheduled',
    }),
  });
}

/**
 * Create the booking.
 *
 * `idempotencyKey` is required and must be the *same* key across retries of the
 * same attempt. Generate it once when the customer opens checkout, not per click.
 */
export function createBooking(
  input: CreateBookingInput,
  idempotencyKey: string
): Promise<{ booking: BookingRow; breakdown: PricingBreakdown }> {
  return request('/api/bookings', {
    method: 'POST',
    idempotencyKey,
    body: JSON.stringify({
      addressId: input.addressId,
      bookingType: input.bookingType,
      scheduledStartAt: input.scheduledStartAt ?? null,
      items: input.items,
      couponCode: input.couponCode ?? null,
      notes: input.notes ?? null,
      expectedTotal: input.expectedTotal ?? null,
      quoteToken: input.quoteToken ?? null,
    }),
  });
}

export function fetchBookings(query: {
  status?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
} = {}): Promise<BookingListResult> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.offset != null) params.set('offset', String(query.offset));
  const qs = params.toString();
  return request<BookingListResult>(`/api/bookings${qs ? `?${qs}` : ''}`);
}

export function fetchBooking(id: string): Promise<BookingDetailResult> {
  return request<BookingDetailResult>(`/api/bookings/${encodeURIComponent(id)}`);
}

export function fetchInvoice(id: string): Promise<InvoiceResult> {
  return request<InvoiceResult>(`/api/bookings/${encodeURIComponent(id)}/invoice`);
}

export function cancelBooking(
  id: string,
  reasonCode: string,
  reason?: string
): Promise<CancelResult> {
  return request<CancelResult>(`/api/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reasonCode, reason: reason ?? null }),
  });
}

/**
 * Move a booking to a new time.
 *
 * `version` is the optimistic lock: the one the customer read. A mismatch comes
 * back as `STALE_VERSION` carrying `details.currentVersion`, which is what the
 * panel re-renders from instead of guessing.
 */
export function rescheduleBooking(
  id: string,
  scheduledStartAt: string,
  version: number,
  idempotencyKey?: string
): Promise<RescheduleResult> {
  return request<RescheduleResult>(`/api/bookings/${encodeURIComponent(id)}/reschedule`, {
    method: 'POST',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    body: JSON.stringify({ scheduledStartAt, version }),
  });
}