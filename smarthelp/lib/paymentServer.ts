import { ApiHttpError } from './api';
import { audit } from './audit';
import { numericLiteral, parseNumeric, rupees, toPaise } from './money';
import { createRazorpayClient } from './razorpayClient';
import { createServerClient } from './supabaseServer';
import type { Booking, Payment, UserRole } from './supabase';

/**
 * The server half of taking money (§12, §25.8).
 *
 * Three things live here rather than in a Route Handler, because two routes
 * (A3's create-order and A4's read) plus the webhook all need them and a second
 * copy would be a second place to get them wrong:
 *
 *   1. **`getPaymentForCaller`** — the ownership check RLS cannot provide, for
 *      the same reason `getBookingForCaller` exists (`lib/bookingServer.ts`):
 *      every Route Handler reaches Postgres through `createServerClient()`, and
 *      the service role bypasses RLS entirely.
 *   2. **The amount conversion, once.** PostgREST hands `numeric(12,2)` back as
 *      a string; Razorpay wants an integer in paise; the JSON responses this app
 *      sends are rupees. All three meet in these two helpers, so the amount the
 *      order is built from, the amount stored on the row, the amount the webhook
 *      compares against and the amount the client is shown are the same number
 *      by construction. `lib/razorpayClient.ts` documents what happens if a
 *      second `* 100` appears anywhere else.
 *   3. **The create-order write path** — insert the row, ask the gateway, store
 *      the order id — so the route is a sequence of decisions and this is the
 *      sequence of writes.
 */

/**
 * Roles that answer for the marketplace rather than for one account. Stated
 * here rather than imported because `lib/bookingServer.ts` keeps its list
 * private, and a payment is a different aggregate with the same rule: staff
 * (including `ops`, which holds `refund.execute`) may read any payment, and a
 * professional or a support agent with no stake in the money may not.
 */
const STAFF_ROLES: readonly UserRole[] = ['admin', 'support', 'ops', 'super_admin'];

/**
 * Load a payment the caller is entitled to, or refuse.
 *
 * `customerId` is a `customers.id`, not a `profiles.id` — `payments.customer_id`
 * references `public.customers(id)`, exactly as `bookings.customer_id` does. The
 * pairing bug `lib/bookingServer.ts` documents (passing `auth.userId` and so
 * refusing every row to its own owner) applies here unchanged.
 */
export async function getPaymentForCaller(id: string, customerId: string, role: UserRole) {
  const supabase = createServerClient();
  const { data, error } = await supabase.from('payments').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiHttpError('NOT_FOUND', 'Payment not found', 404);
  if (data.customer_id === customerId || STAFF_ROLES.includes(role)) return data;
  throw new ApiHttpError('FORBIDDEN', 'This payment belongs to another account.', 403);
}

/**
 * Rupees on a `payments` row, as an integer of paise.
 *
 * `parseNumeric()` first — it refuses to guess at a null or a non-number, and on
 * a `not null` money column that means a broken query rather than an absent
 * value — then `toPaise()`, which is `Math.round(× 100)` with the epsilon nudge
 * that stops a float landing a paisa below the boundary it belongs on.
 */
export function paymentAmountPaise(payment: Pick<Payment, 'amount'>): number {
  return toPaise(parseNumeric(payment.amount));
}

/** Rupees on a `bookings` row, as an integer of paise. The same conversion. */
export function bookingAmountPaise(booking: Pick<Booking, 'total_amount'>): number {
  return toPaise(parseNumeric(booking.total_amount));
}

export interface CreateOrderArgs {
  booking: Booking;
  /** A `customers.id`. Written to `payments.customer_id`, which is not null. */
  customerId: string;
  /**
   * The same key the caller sent in `Idempotency-Key`, also written to
   * `payments.idempotency_key` so "one charge attempt, one row" survives the
   * ledger prune (§25.11's cron deletes `idempotency_keys` rows by age, and the
   * ledger is what answers a replay before this column ever has to).
   */
  idempotencyKey: string;
  actorProfileId: string;
  requestId?: string | null;
  ipAddress?: string | null;
}

export interface CreateOrderResult {
  paymentId: string;
  /** The Razorpay order id the Checkout client opens the checkout with. */
  orderId: string;
  /** The public key id Checkout is initialised with. Never the secret. */
  keyId: string;
  /** Rupees, like every other money figure this API returns. */
  amount: number;
  currency: string;
}

/**
 * Insert the charge attempt, ask the gateway for an order, store its id.
 *
 * The order of those three is the design, not an accident:
 *
 * **Row first, then gateway.** A row whose `gateway_order_id` is still null is
 * visible — it is exactly what the reconciliation cron looks for, and what an
 * operator can see in `payments`. A gateway order with no row behind it is
 * invisible to reconciliation, to refunds and to every screen in the product,
 * and it is created with money attached. So the insert happens first and the
 * gateway second, on purpose.
 *
 * **The amount comes from the booking, once.** `bookingAmountPaise(booking)` is
 * the only read of `bookings.total_amount` on this path. The total was frozen
 * when the booking was created (§16, #19); re-deriving a price here would charge
 * a figure the customer never confirmed. No field of the request body is read by
 * this function at all.
 *
 * **A lost race is not an error.** Two concurrent creates that both passed the
 * route's checks reach here with the same key; one insert wins and the other
 * raises `23505` on `uniq_payments_idem`. The loser adopts the winner's row
 * rather than failing, because from the caller's side it is the same request and
 * the same charge. That index is the backstop that keeps working after the
 * ledger row is pruned, which the `Idempotency-Key` header alone cannot do.
 *
 * **A gateway failure marks the row, then propagates.** `status='failed'` with
 * the gateway's own words in `failure_reason`, because a failed order-create
 * left sitting at `created` is a row the cron would later re-check against a
 * gateway that has never heard of it. The error is then rethrown unchanged —
 * `lib/razorpayClient.ts` already codes transport and gateway refusals as
 * `PAYMENT_FAILED`/402 — so this function never invents a sentence the gateway
 * already wrote.
 */
export async function createBookingOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
  const amountPaise = bookingAmountPaise(args.booking);
  const currency = args.booking.currency || 'INR';

  const keyId =
    process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

  // Nothing has been asked of the gateway yet, so this is a configuration
  // refusal rather than a failed charge: no row, no order, and a sentence that
  // names what is missing instead of a 500 out of Basic auth.
  if (!keyId || !keySecret) {
    throw new ApiHttpError(
      'SERVICE_UNAVAILABLE',
      'Online payment is not configured on this deployment yet. Please try again later.',
      422,
      { missing: keyId ? 'RAZORPAY_KEY_SECRET' : 'RAZORPAY_KEY_ID' }
    );
  }

  const supabase = createServerClient();
  const payment = await chargeRow(args, { amountPaise, currency, keyId, keySecret, supabase });

  return orderResult(payment, keyId);
}

/** Everything one charge attempt needs that is not the booking itself. */
interface ChargeContext {
  amountPaise: number;
  currency: string;
  keyId: string;
  keySecret: string;
  supabase: ReturnType<typeof createServerClient>;
}

/**
 * The row for this attempt, and an order id on it.
 *
 * Split out from `createBookingOrder` because both the fresh-insert path and the
 * duplicate-key path end in the same two steps, and a recovery that skipped the
 * gateway would answer with an order id that does not exist.
 */
async function chargeRow(args: CreateOrderArgs, ctx: ChargeContext): Promise<Payment> {
  const { supabase } = ctx;

  const { data: inserted, error } = await supabase
    .from('payments')
    .insert({
      booking_id: args.booking.id,
      customer_id: args.customerId,
      purpose: 'booking',
      // A string, not a number: PostgREST would otherwise be asked to trust a
      // JSON float to mean an exact `numeric(12,2)`.
      amount: numericLiteral(ctx.amountPaise),
      currency: ctx.currency,
      gateway: 'razorpay',
      status: 'created',
      idempotency_key: args.idempotencyKey,
    })
    .select('*')
    .single();

  let payment: Payment;

  if (error) {
    const existing = await paymentForKey(error, args.idempotencyKey);
    // Not readable, or a constraint that is not ours: the caller rethrows it.
    if (!existing) throw error;
    // The row already carries an order — the previous attempt finished, and
    // this response is that attempt's answer rather than a new charge.
    if (existing.gateway_order_id) return existing;
    // The previous attempt died between insert and store. Adopt the row and
    // finish it: the alternative is a permanent 409 on a key whose row is
    // never going to heal itself.
    payment = existing;
  } else {
    payment = inserted as Payment;
  }

  let orderId: string;
  try {
    const order = await createRazorpayClient({ keyId: ctx.keyId, keySecret: ctx.keySecret })
      .createOrder({
        amountPaise: ctx.amountPaise,
        // The booking number is the receipt Razorpay shows in its dashboard, so
        // a support conversation can name a booking rather than an order id.
        receipt: args.booking.booking_number,
        notes: { bookingId: args.booking.id, paymentId: payment.id },
      });
    orderId = order.id;
  } catch (e) {
    await supabase
      .from('payments')
      .update({
        status: 'failed',
        failure_reason: e instanceof ApiHttpError ? e.message : 'The order could not be created.',
      })
      .eq('id', payment.id);
    throw e;
  }

  const { error: storeError } = await supabase
    .from('payments')
    .update({ gateway_order_id: orderId })
    .eq('id', payment.id);

  if (storeError) {
    // The gateway now has an order this row does not know about. Say so loudly
    // rather than answering 201: the customer never received the order id, so
    // nobody can pay it, and the row stays in the `created` state the cron
    // reconciles — which is the visible, recoverable half of this failure.
    console.error('payments: could not store gateway_order_id:', storeError.message);
    throw new ApiHttpError('INTERNAL_ERROR', 'The order could not be saved. Please try again.', 500, {
      paymentId: payment.id,
    });
  }

  await audit(supabase, {
    actorProfileId: args.actorProfileId,
    action: 'payment.order.created',
    entityType: 'payments',
    entityId: payment.id,
    // Paise under a name that says so: an unlabelled `amount` in an audit row
    // stays ambiguous for the life of the table, and `redact()` runs over this
    // object on the way in.
    metadata: {
      bookingId: args.booking.id,
      amount_paise: ctx.amountPaise,
      currency: ctx.currency,
      gateway: 'razorpay',
      status: 'created',
    },
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return { ...payment, gateway_order_id: orderId };
}

/** The response body, built from the row rather than from the request. */
function orderResult(payment: Payment, keyId: string): CreateOrderResult {
  return {
    paymentId: payment.id,
    orderId: payment.gateway_order_id ?? '',
    keyId,
    amount: rupees(paymentAmountPaise(payment)),
    currency: payment.currency || 'INR',
  };
}

/**
 * A `23505` that came from `uniq_payments_idem` means this charge attempt
 * already has a row under the caller's key, so the caller answers with it.
 *
 * A duplicate from any other unique index is not ours to interpret and is
 * returned as `null`, which makes the caller rethrow: swallowing it would answer
 * a genuine conflict with somebody else's order id. A row with no
 * `gateway_order_id` is also returned — as a row to finish rather than a row to
 * replay — because the previous attempt died mid-flight and the unique index
 * holds the key until this attempt completes it.
 */
async function paymentForKey(
  error: { code?: string; message?: string },
  idempotencyKey: string
): Promise<Payment | null> {
  if (error.code !== '23505') return null;

  const supabase = createServerClient();
  const { data, error: readError } = await supabase
    .from('payments')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (readError) throw readError;
  if (!data) return null;
  // PostgREST read a row that is not the one this key inserted. Unlikely and
  // not something to paper over with the caller's own key.
  if (data.idempotency_key !== idempotencyKey) return null;
  return data;
}
