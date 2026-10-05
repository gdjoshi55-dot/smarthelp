import { created, handle, ok } from '@/lib/api';
import { audit } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { assertPriceUnchanged, buildQuote, type QuoteItemInput } from '@/lib/bookingQuote';
import { assertSlotAvailable } from '@/lib/bookingAvailability';
import { readIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { quoteTokenAgrees, verifyQuoteToken } from '@/lib/quoteToken';
import { createServerClient } from '@/lib/supabaseServer';
import { ApiHttpError } from '@/lib/api';
import { isUuid, oneOf, optionalStr, requireCapability, uuid } from '@/lib/validation';
import type { BookingType, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BOOKING_TYPES = ['instant', 'scheduled'] as const;

/**
 * POST /api/bookings — create a booking (§25.6).
 *
 * The order of operations is the point of this route:
 *
 *   1. capability   `booking.create`, so a professional's token cannot book.
 *   2. validate     the address must be the caller's own row.
 *   3. price        every figure comes from `buildQuote`, which reads
 *                   `services` / `service_durations` / `coupons`. A
 *                   client-sent total is compared, never stored.
 *   4. compare      a moved price is `409 PRICE_CHANGED` with the fresh
 *                   breakdown attached, and no row is written.
 *   5. idempotency  `Idempotency-Key` is *required*. A customer who taps Pay
 *                   twice on a slow connection gets one booking, not two.
 *   6. insert       `address_snapshot` is frozen now, because the address can be
 *                   corrected later and §24.7 calls the snapshot the dispute
 *                   evidence.
 *   7. transition   `draft -> payment_pending`, so the history shows both hops.
 *                   Phase 2 takes no money so it stops there; Phase 3 inserts
 *                   the payment row in this same transaction.
 *
 * Pricing happens *before* the idempotency claim on purpose. A request that
 * could never be priced should not spend a customer's key, so a client that
 * fixes its payload and retries gets a fresh key rather than a stored rejection.
 */
export async function POST(req: Request) {
  return handle(req, 'bookings.create', async () => {
    await requireCapability(req, 'booking.create');
    const { auth, customer } = await requireCustomer(req);

    const input = validateCreateInput(await readBody(req));
    const supabase = createServerClient();

    // The address must belong to this customer. The service-role client bypasses
    // RLS, so `bookings.address_id` would happily point at somebody else's row
    // and the snapshot would freeze their street address onto our booking.
    const { data: address, error: addressError } = await supabase
      .from('addresses')
      .select('id, locality_id')
      .eq('id', input.addressId)
      .eq('customer_id', customer.id)
      .maybeSingle();

    if (addressError) throw addressError;
    if (!address) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Choose one of your saved addresses.', 400, {
        fields: { addressId: 'This address is not one of yours' },
      });
    }

    const quote = await buildQuote({
      items: input.items,
      couponCode: input.couponCode,
      bookingType: input.bookingType,
    });

    // The chosen slot is re-checked against the engine before anything is
    // written. The availability screen offered it some minutes ago; a booking can
    // sit in a tab, and §9.1's answer has to still be true when the customer
    // presses the button. Every service on the booking is checked, not just the
    // first — a two-service booking is only bookable if both can be done.
    if (input.bookingType === 'scheduled' && input.scheduledStartAt) {
      const localityId = (address as { locality_id: string | null }).locality_id ?? null;
      for (const item of input.items) {
        await assertSlotAvailable({
          serviceId: item.serviceId,
          localityId,
          startAt: input.scheduledStartAt,
          durationMinutes: item.durationMinutes ?? quote.durationMinutes,
        });
      }
    }

    // A token is checked, not trusted. Absent is fine — a client that never called
    // the quote endpoint is still priced honestly by the comparison below — but a
    // token that is forged, tampered with or expired is a client asserting a price
    // this engine never produced, and it is refused before anything is written.
    if (input.quoteToken) {
      const claims = verifyQuoteToken(input.quoteToken);
      if (!claims) {
        throw new ApiHttpError(
          'VALIDATION_ERROR',
          'That quote has expired. Refresh the price and try again.',
          400,
          { fields: { quoteToken: 'This quote is no longer valid' } }
        );
      }

      // A token for a different cart, coupon, booking type or total is not a
      // stale quote, it is a different agreement wearing this one's signature. The
      // message is the price one, because from the customer's side that is what
      // happened: what they agreed to is not what they are being charged.
      if (
        !quoteTokenAgrees(claims, {
          items: input.items.map((item) => ({
            serviceId: item.serviceId,
            durationMinutes: item.durationMinutes ?? quote.durationMinutes,
            quantity: item.quantity ?? 1,
          })),
          couponCode: input.couponCode,
          bookingType: input.bookingType,
          total: quote.breakdown.total,
        })
      ) {
        throw new ApiHttpError('PRICE_CHANGED', 'This quote is for a different booking.', 409, {
          fields: { quoteToken: 'Refresh the price to continue' },
        });
      }
    }

    assertPriceUnchanged(
      input.expectedTotal == null ? null : { total: input.expectedTotal },
      quote.breakdown
    );

    const outcome = await withIdempotency<{ booking: unknown; breakdown: unknown }>({
      key: readIdempotencyKey(req),
      operation: 'bookings.create',
      actorProfileId: auth.userId,
      // The validated body, not the raw text: whitespace must not spend a
      // customer's key, and two payloads differing in a real field must not look
      // identical. See `lib/idempotency.ts`.
      payload: {
        items: input.items,
        addressId: input.addressId,
        bookingType: input.bookingType,
        couponCode: input.couponCode,
        scheduledStartAt: input.scheduledStartAt,
        notes: input.notes,
      },
      required: true,
      run: async () => ({
        status: 201,
        body: await insertBooking({
          customerId: customer.id,
          input,
          quote,
          addressSnapshot: await freezeAddress(address.id),
          localityId: (address as { locality_id: string | null }).locality_id ?? null,
          actorProfileId: auth.userId,
          actorRole: auth.role,
        }),
      }),
    });

    if (outcome.kind === 'rejected') return outcome.response;
    if (outcome.kind === 'replay') return ok(outcome.body, outcome.status, outcome.headers);
    return created(outcome.body, outcome.headers);
  });
}

/**
 * GET /api/bookings — the customer's own bookings (§25.4).
 *
 * Filterable by status and by the scheduled window, and paginated. Ownership is
 * the caller's `customer_id` from `requireCustomer`, never a query parameter —
 * the service-role client would otherwise honour one.
 */
export async function GET(req: Request) {
  return handle(req, 'bookings.list', async () => {
    const { customer } = await requireCustomer(req);
    const url = new URL(req.url);
    const supabase = createServerClient();

    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 10_000);

    let query = supabase
      .from('bookings')
      .select('*', { count: 'exact' })
      .eq('customer_id', customer.id);

    if (status) {
      query = query.eq('status', status as never);
    }
    // `scheduled_start_at` is null for an instant booking, so a date filter
    // legitimately excludes them rather than erroring on a null comparison.
    if (from) query = query.gte('scheduled_start_at', from);
    if (to) query = query.lte('scheduled_start_at', to);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return ok({ bookings: data ?? [], total: count ?? 0, limit, offset });
  });
}

interface CreateInput {
  items: QuoteItemInput[];
  addressId: string;
  bookingType: BookingType;
  couponCode: string | null;
  scheduledStartAt: string | null;
  notes: string | null;
  /** The total the customer was shown. Compared, never stored. */
  expectedTotal: number | null;
  /** §7.2's token from the quote they were shown, when they sent it back. */
  quoteToken: string | null;
}

function validateCreateInput(body: Record<string, unknown>): CreateInput {
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Choose at least one service.', 400, {
      fields: { items: 'At least one service is required' },
    });
  }

  const items: QuoteItemInput[] = rawItems.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new ApiHttpError('VALIDATION_ERROR', 'Each item needs a service.', 400, {
        fields: { [`items.${index}`]: 'This item is not valid' },
      });
    }
    const row = raw as Record<string, unknown>;
    if (!isUuid(row.serviceId)) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Each item needs a service.', 400, {
        fields: { [`items.${index}.serviceId`]: 'This service is not valid' },
      });
    }
    return {
      serviceId: row.serviceId,
      durationMinutes: row.durationMinutes == null ? undefined : Number(row.durationMinutes),
      quantity: row.quantity == null ? undefined : Number(row.quantity),
    };
  });

  // `recurring` exists in the enum but is Phase 8. Accepting it here would
  // create a booking the app cannot honour.
  const bookingType = oneOf(body.bookingType ?? 'scheduled', 'bookingType', BOOKING_TYPES);

  let scheduledStartAt: string | null = null;
  if (bookingType === 'scheduled') {
    const raw = body.scheduledStartAt;
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Choose a date and time for this booking.', 400, {
        fields: { scheduledStartAt: 'Pick a valid date and time' },
      });
    }
    scheduledStartAt = new Date(raw).toISOString();
  }

  let expectedTotal: number | null = null;
  if (body.expectedTotal != null) {
    const value = Number(body.expectedTotal);
    if (!Number.isFinite(value) || value < 0) {
      throw new ApiHttpError('VALIDATION_ERROR', 'The quoted total is not valid.', 400, {
        fields: { expectedTotal: 'Not a valid amount' },
      });
    }
    expectedTotal = value;
  }

  return {
    items,
    addressId: uuid(body.addressId, 'addressId'),
    bookingType: bookingType as BookingType,
    couponCode: body.couponCode ? String(body.couponCode).trim().toUpperCase() : null,
    scheduledStartAt,
    notes: optionalStr(body.notes, 'notes', { max: 500 }),
    expectedTotal,
    quoteToken: optionalStr(body.quoteToken, 'quoteToken', { max: 4000 }),
  };
}

/**
 * Copy the address row as it stands right now.
 *
 * §24.7's `address_snapshot` is the dispute evidence, so it holds the customer's
 * own text rather than a re-derivation from `localities`. Renaming or
 * correcting the address afterwards must not rewrite history.
 */
async function freezeAddress(addressId: string): Promise<Record<string, unknown>> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('addresses')
    .select('address_type, label, line1, line2, area, city, state, pincode, lat, lng, landmark, access_notes')
    .eq('id', addressId)
    .single();

  if (error) throw error;

  return {
    ...(data as Record<string, unknown>),
    frozen_at: new Date().toISOString(),
  };
}

async function insertBooking(args: {
  customerId: string;
  input: CreateInput;
  quote: Awaited<ReturnType<typeof buildQuote>>;
  addressSnapshot: Record<string, unknown>;
  localityId: string | null;
  actorProfileId: string;
  actorRole: UserRole;
}) {
  const { customerId, input, quote, actorProfileId, actorRole } = args;
  const supabase = createServerClient();

  const scheduledEndAt = input.scheduledStartAt
    ? new Date(
        new Date(input.scheduledStartAt).getTime() + quote.durationMinutes * 60_000
      ).toISOString()
    : null;

  // One call, because one call is one transaction. This used to be three
  // PostgREST requests — insert the row, insert the items, move the status — and a
  // failure between the second and third left a priced booking with no item lines
  // and an empty timeline, with no rollback able to reach across them. The
  // sequence number, the frozen address snapshot and the `draft -> payment_pending`
  // hop are all in there too, so a partially written booking is not a state the
  // database can be left in.
  const { data, error } = await supabase.rpc('create_booking', {
    p_customer_id: customerId,
    p_address_id: input.addressId,
    p_locality_id: args.localityId,
    p_address_snapshot: args.addressSnapshot,
    p_booking_type: input.bookingType,
    p_duration_minutes: quote.durationMinutes,
    p_scheduled_start_at: input.scheduledStartAt,
    p_scheduled_end_at: scheduledEndAt,
    p_notes: input.notes,
    // `quote.money` holds the numeric columns as text literals, which is what the
    // engine produces and what the function casts back.
    p_money: {
      ...quote.money,
      tax_rate: quote.settings.taxRate.toFixed(4),
      commission_pct: quote.breakdown.commissionPct.toFixed(4),
      currency: quote.settings.currency,
    },
    p_discount_code: quote.breakdown.discountCode,
    p_pricing_snapshot: quote.breakdown.snapshot,
    p_quote_token: input.quoteToken,
    p_items: quote.itemRows,
    p_actor: actorProfileId,
    p_actor_role: actorRole,
  });

  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('INTERNAL_ERROR', 'The booking could not be written.', 500);
  }

  return { booking: data, breakdown: quote.breakdown };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}