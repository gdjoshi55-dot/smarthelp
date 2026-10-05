import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BookingType } from './supabase';

/**
 * §7.2's `quoteToken`.
 *
 * ## What it is for, and what it is not
 *
 * The signature exists so the server can tell "this total came out of our pricing
 * engine ten minutes ago" from "this total was typed into a request body". That is
 * all it proves. It is **not** what holds the price: the create route re-runs
 * `buildQuote` and compares the fresh total to what the customer agreed to, and a
 * difference is `409 PRICE_CHANGED` whether or not a token was presented. A token
 * is an assertion about the past, not a lock on the future — the engine's version
 * is what decides.
 *
 * So the create route treats a *missing* token as acceptable (a client that never
 * called the quote endpoint still gets priced honestly) and an *invalid* one as a
 * `VALIDATION_ERROR`, because a token nobody issued is a client that is trying to
 * say something untrue about a number.
 *
 * ## Shape
 *
 * `base64url(payload).base64url(hmac)` — two segments, no padding, no header. The
 * payload is the canonical JSON of the inputs the total depends on, plus the total
 * itself and an `exp` fifteen minutes out. Canonical means the keys are written in
 * a fixed order by hand rather than by `JSON.stringify` on an object literal, so a
 * signature never depends on property insertion order.
 *
 * ## The key
 *
 * `SUPABASE_SERVICE_ROLE_KEY`, which the server already holds and which never
 * leaves it. A separate `QUOTE_TOKEN_SECRET` would be one more value to provision
 * per environment for no additional strength — the property wanted is "a secret the
 * client cannot read", and this is one. When it is absent the token is simply not
 * issued: the quote route still returns everything the customer needs, and the
 * price is still enforced by the comparison.
 */

const TOKEN_TTL_SECONDS = 900;

export interface QuoteTokenPayload {
  items: Array<{ serviceId: string; durationMinutes: number; quantity: number }>;
  couponCode: string | null;
  bookingType: BookingType;
  total: number;
  /** Epoch seconds. */
  exp: number;
}

/** Milliseconds a quote stays quotable, per §7.2. */
export const QUOTE_TTL_SECONDS = TOKEN_TTL_SECONDS;

function secret(): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return key && key.length > 0 ? key : null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Fixed key order, written out rather than derived.
 *
 * `JSON.stringify` over an object literal would work today and break the day
 * someone adds a field to the middle of the literal: the same quote would sign
 * differently and every token issued before the edit would fail verification.
 */
function canonical(payload: QuoteTokenPayload): string {
  return JSON.stringify([
    payload.bookingType,
    payload.couponCode,
    payload.total,
    payload.exp,
    payload.items.map((item) => [item.serviceId, item.durationMinutes, item.quantity]),
  ]);
}

function sign(body: string, key: string): string {
  return base64url(createHmac('sha256', key).update(body).digest());
}

/**
 * Sign a quote, or return null when no secret is configured.
 *
 * Null is a supported answer rather than a thrown error: a development machine
 * without the service key should still be able to price a booking, and the absence
 * of an audit token is not a reason to refuse a customer.
 */
export function issueQuoteToken(args: {
  items: QuoteTokenPayload['items'];
  couponCode: string | null;
  bookingType: BookingType;
  total: number;
  now?: number;
}): string | null {
  const key = secret();
  if (!key) return null;

  const nowMs = args.now ?? Date.now();
  const payload: QuoteTokenPayload = {
    items: args.items,
    couponCode: args.couponCode,
    bookingType: args.bookingType,
    total: args.total,
    exp: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS,
  };

  const body = base64url(canonical(payload));
  return `${body}.${sign(body, key)}`;
}

/**
 * Check a token and return its payload, or null for anything untrustworthy.
 *
 * Malformed, forged, wrong-length and expired all collapse to `null` on purpose:
 * the caller asks one question — "is this a token we issued, still current?" — and
 * gets one answer. The signature comparison is `timingSafeEqual` so a caller cannot
 * learn the expected bytes by measuring how long a rejection took.
 */
export function verifyQuoteToken(token: string, now: number = Date.now()): QuoteTokenPayload | null {
  const key = secret();
  if (!key) return null;

  const [body, signature, ...rest] = token.split('.');
  if (!body || !signature || rest.length > 0) return null;

  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(signature);
  // A length mismatch makes `timingSafeEqual` throw, and a thrown verification is
  // not the answer this function owes its caller.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let payload: QuoteTokenPayload;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 5) return null;
    const [bookingType, couponCode, total, exp, rawItems] = parsed as [
      BookingType,
      string | null,
      number,
      number,
      unknown,
    ];
    if (typeof bookingType !== 'string' || !Array.isArray(rawItems)) return null;
    if (typeof total !== 'number' || typeof exp !== 'number') return null;

    // The canonical form writes each item as a positional triple to keep the
    // signature independent of key order, which means the parsed value is in the
    // wrong shape for every caller. It is rebuilt here rather than in each caller:
    // a payload whose items are arrays is exactly the kind of thing that passes a
    // signature check and then quietly compares as `undefined === undefined`.
    const items: QuoteTokenPayload['items'] = [];
    for (const item of rawItems as unknown[]) {
      if (!Array.isArray(item) || item.length !== 3) return null;
      const [serviceId, durationMinutes, quantity] = item as [unknown, unknown, unknown];
      if (typeof serviceId !== 'string' || serviceId.length === 0) return null;
      if (typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes)) return null;
      if (typeof quantity !== 'number' || !Number.isFinite(quantity)) return null;
      items.push({ serviceId, durationMinutes, quantity });
    }

    if (couponCode !== null && typeof couponCode !== 'string') return null;
    payload = { bookingType, couponCode: couponCode ?? null, total, exp, items };
  } catch {
    return null;
  }

  if (payload.exp * 1000 <= now) return null;
  return payload;
}

/**
 * Does a verified token describe the request that presented it?
 *
 * Without this the signature proves only that *some* quote was issued, at some
 * point, by this engine — so a client could quote a ₹500 cart, then submit that
 * token with a different one and no `expectedTotal` at all, and the token would
 * verify while saying nothing about what was actually being agreed to. The
 * `expectedTotal` comparison is the real price check; this is what makes a token
 * worth carrying, because it is the one field that survives a client that
 * declines to send anything to compare.
 *
 * Order-insensitive on items, because a cart is a set: re-ordering the same two
 * services is not a different booking, and refusing it would push customers into
 * editing the order in the browser until the tokens happened to match.
 */
export function quoteTokenAgrees(
  claims: QuoteTokenPayload,
  request: {
    items: QuoteTokenPayload['items'];
    couponCode: string | null;
    bookingType: BookingType;
    total: number;
  }
): boolean {
  if (claims.bookingType !== request.bookingType) return false;
  if ((claims.couponCode ?? null) !== (request.couponCode ?? null)) return false;
  // Paise, not rupees: the token carries a number, so a float compared with `===`
  // would turn 613.6 into a rejection over the last digit.
  if (Math.round(claims.total * 100) !== Math.round(request.total * 100)) return false;

  const key = (item: { serviceId: string; durationMinutes: number; quantity: number }) =>
    `${item.serviceId}:${item.durationMinutes}:${item.quantity}`;
  const claimed = claims.items.map(key).sort();
  const asked = request.items.map(key).sort();
  return claimed.length === asked.length && claimed.every((v, i) => v === asked[i]);
}