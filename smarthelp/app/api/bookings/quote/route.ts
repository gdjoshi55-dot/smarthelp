import { handle, ok } from '@/lib/api';
import { buildQuote, type QuoteItemInput } from '@/lib/bookingQuote';
import { ApiHttpError } from '@/lib/api';
import { isUuid, oneOf } from '@/lib/validation';
import { issueQuoteToken, QUOTE_TTL_SECONDS } from '@/lib/quoteToken';
import type { BookingType } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BOOKING_TYPES = ['instant', 'scheduled'] as const;

/**
 * POST /api/bookings/quote — price a booking without writing anything (§7.2).
 *
 * Pure: no row is touched, no key is spent, and the same inputs always produce
 * the same breakdown. That is what lets the checkout screen re-quote on every
 * keystroke of a duration change.
 *
 * The request carries **intent, not money**. It used to accept `basePrice`,
 * `pricingType` and `durationPrice` from the client and hand them to the
 * pricing engine, which meant the quote was whatever the browser said. §7.2 is
 * explicit that the server is the authority — so `items` is a list of
 * `{ serviceId, durationMinutes, quantity }` and every price comes out of
 * `services`, `service_durations` and `coupons` via `buildQuote`.
 *
 * Unauthenticated on purpose: a visitor prices a service before deciding to
 * sign up, and there is nothing here that is not already public catalogue data.
 * The create route re-runs this identical code path and compares.
 */
export async function POST(req: Request) {
  return handle(req, 'bookings.quote', async () => {
    const body = await readBody(req);
    const input = validateQuoteInput(body);

    const quote = await buildQuote({
      items: input.items,
      couponCode: input.couponCode,
      bookingType: input.bookingType,
    });

    return ok({
      quote: quote.breakdown,
      durationMinutes: quote.durationMinutes,
      expiresInSeconds: QUOTE_TTL_SECONDS,
      // §7.2's token. Carried into the create call so the booking row can say the
      // agreed total came from this engine and not from the browser; `null` when
      // the server has no signing key, which changes nothing about the price.
      quoteToken: issueQuoteToken({
        items: input.items.map((item) => ({
          serviceId: item.serviceId,
          durationMinutes: item.durationMinutes ?? quote.durationMinutes,
          quantity: item.quantity ?? 1,
        })),
        couponCode: input.couponCode,
        bookingType: input.bookingType,
        total: quote.breakdown.total,
      }),
    });
  });
}

function validateQuoteInput(body: Record<string, unknown>): {
  items: QuoteItemInput[];
  couponCode: string | null;
  bookingType: BookingType;
} {
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

  return {
    items,
    couponCode: body.couponCode ? String(body.couponCode).trim().toUpperCase() : null,
    bookingType: oneOf(body.bookingType ?? 'scheduled', 'bookingType', BOOKING_TYPES) as BookingType,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}