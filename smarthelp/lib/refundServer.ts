import { ApiHttpError } from './api';
import { audit } from './audit';
import { PLATFORM_DEFAULTS } from './constants';
import { numericLiteral, parseNumeric, toPaise } from './money';
import { createRazorpayClient } from './razorpayClient';
import type { Capability } from './roles';
import type { SupabaseClient } from '@supabase/supabase-js';
import { creditWallet } from './walletServer';
import type { Database, Payment, Refund, RefundRoute } from './supabase';

/**
 * The server half of giving money back (§12.3, §8.2, §25.10).
 *
 * The rules live here rather than in a Route Handler because three callers
 * share them and a second copy would be a second place to get them wrong:
 * `POST /api/refunds`, the `refund.processed` webhook and the cancel-of-a-paid-
 * booking path. What each of those does with the *answer* is its own business;
 * the answer itself — may this be executed now, and which way does the money
 * go — is decided once, here.
 *
 * Three facts this module exists to keep true:
 *
 *   1. **Row first, gateway second.** `record_booking_refund()` writes the
 *      `refunds` row before `createRefund()` is called, for the same reason
 *      `createBookingOrder()` writes the charge attempt before asking for an
 *      order: a gateway refund with no row behind it is invisible to every
 *      screen in the product and it is created with money attached. The
 *      gateway's id is then persisted *before* completion, so a process that
 *      dies between the two still leaves a row the webhook can find.
 *   2. **A refusal is answered with money, not with nothing.** If the gateway
 *      definitively refuses, the same amount is credited to the customer's
 *      wallet and the refund completes as `route = 'wallet'` — §12.3's promise
 *      — with an ops ticket so a human can see why the instrument did not take
 *      it. An *unreachable* gateway is deliberately not treated the same way:
 *      the request may already have been processed, and crediting a wallet on
 *      top of an instrument refund would pay the customer twice.
 *   3. **Above the limit, a refund may be created but not executed.**
 *      `supportRefundLimit` is the line §12.3 draws: at or below it a support
 *      agent's request executes immediately, above it the row stays
 *      `requested` with `approved_by` null until Phase 6's approver endpoint
 *      (§25.10) runs it. **No path in this phase executes an above-limit
 *      manual refund**, which is what makes the capability check meaningful.
 */

type ServerClient = SupabaseClient<Database>;

/**
 * The two capabilities, read from `lib/roles.ts`'s list rather than written
 * out here. Both checks are server-side (CONTEXT decision 3): the client is
 * never asked, because a client that decided a refund was allowed would be a
 * client that could decide it was above ₹1500.
 */
export const REFUND_REQUEST_CAPABILITY: Capability = 'refund.request';
export const REFUND_EXECUTE_CAPABILITY: Capability = 'refund.execute';

/**
 * At or below `supportRefundLimit` — rupees on one side, paise on the other,
 * converted exactly once here rather than at each call site.
 *
 * `platform_settings` is a Phase 6 table, so the limit is read from
 * `PLATFORM_DEFAULTS` today; when it lands, this becomes a settings read and
 * nothing else changes.
 */
export function withinLimit(amountPaise: number): boolean {
  return amountPaise <= toPaise(PLATFORM_DEFAULTS.supportRefundLimit);
}

/** Rupees on a payment's remaining refundable amount, as an integer of paise. */
export function refundablePaise(payment: Pick<Payment, 'refundable_amount'>): number {
  return toPaise(parseNumeric(payment.refundable_amount));
}

/**
 * The `> 0` and `≤ refundable_amount` checks, in paise.
 *
 * Both are enforced in SQL too (`payments.refundable_amount` carries a CHECK
 * and `record_booking_refund()` re-checks), so this is not the only line of
 * defence — it is the one that can answer with a sentence instead of a
 * SQLSTATE. A caller that gets here with a non-positive amount has skipped
 * `lib/money.ts`, and that is a `TypeError` rather than a 400: it is a defect
 * in this codebase, not something a customer can send.
 */
export function assertRefundable(payment: Payment, amountPaise: number): void {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`amountPaise must be a positive integer number of paise, got ${amountPaise}`);
  }
  const remaining = refundablePaise(payment);
  if (amountPaise > remaining) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'That is more than the amount left to refund on this payment.',
      400,
      { amount_paise: amountPaise, refundable_paise: remaining }
    );
  }
}

/**
 * Which way the money goes.
 *
 * A payment with a gateway id captured the money through the gateway, so the
 * gateway refunds it. Everything else — a payment whose instrument cannot take
 * a refund, or one written before any of this existed — has nowhere to send it
 * but the wallet, and the customer is told that at cancellation time rather
 * than at refund time (§12.3).
 */
export function refundRoute(payment: Pick<Payment, 'gateway_payment_id'>): RefundRoute {
  return payment.gateway_payment_id ? 'gateway' : 'wallet';
}

export interface RefundPlan {
  /** Execute now, or leave the row `requested` for an approver. */
  execute: boolean;
  route: RefundRoute;
  /** Why it is not being executed, when `execute` is false. */
  reason?: 'above_limit';
}

/**
 * The decision, in one place.
 *
 * `auto` is what distinguishes a cancellation refund — the platform taking
 * back its own money under §11.1 — from an agent's manual request: an
 * automatic refund is never held for approval, at any size, because there is
 * no human asking for it and holding it would strand a cancelled booking.
 */
export function planRefund(args: {
  payment: Payment;
  amountPaise: number;
  auto?: boolean;
}): RefundPlan {
  const route = refundRoute(args.payment);
  if (args.auto) return { execute: true, route };
  if (withinLimit(args.amountPaise)) return { execute: true, route };
  return { execute: false, route, reason: 'above_limit' };
}

export interface RequestRefundArgs {
  supabase: ServerClient;
  payment: Payment;
  amountPaise: number;
  reasonCode: string;
  note?: string | null;
  /** A `profiles.id`. Null for an automatic refund, which has nobody to name. */
  requestedBy?: string | null;
  route?: RefundRoute;
  requestId?: string | null;
  ipAddress?: string | null;
}

/**
 * Create a refund nobody is going to execute yet — §12.3's above-limit
 * request, and the only write this phase makes that does not move money.
 *
 * The row is written directly rather than through `record_booking_refund()`,
 * and that is the whole point: the RPC hops the booking to `refund_pending`,
 * and a request that sits unapproved for a week must not leave a *paid*
 * booking in a state that says the money is going back. `record_booking_refund()`
 * is called by `executeRefund()`, where somebody has already decided to pay.
 */
export async function requestRefund(args: RequestRefundArgs): Promise<Refund> {
  const { supabase, payment } = args;
  assertRefundable(payment, args.amountPaise);

  if (!payment.booking_id) {
    throw new ApiHttpError(
      'INVALID_STATE',
      'That payment is not attached to a booking, so it cannot be refunded here.',
      409,
      { paymentId: payment.id }
    );
  }

  const { data, error } = await supabase
    .from('refunds')
    .insert({
      payment_id: payment.id,
      booking_id: payment.booking_id,
      customer_id: payment.customer_id,
      amount: numericLiteral(args.amountPaise),
      currency: payment.currency,
      status: 'requested',
      route: args.route ?? refundRoute(payment),
      reason_code: args.reasonCode,
      note: args.note ?? null,
      requested_by: args.requestedBy ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;

  await audit(supabase, {
    actorProfileId: args.requestedBy ?? null,
    action: 'refund.requested',
    entityType: 'refunds',
    entityId: data.id,
    after: { status: 'requested', route: data.route, reason_code: args.reasonCode },
    metadata: {
      paymentId: payment.id,
      bookingId: payment.booking_id,
      amount_paise: args.amountPaise,
      currency: payment.currency,
      reason_code: args.reasonCode,
      // The consequence of the limit, stated rather than inferred from a status.
      held_for_approval: !withinLimit(args.amountPaise),
    },
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return data;
}

export interface ExecuteRefundArgs extends RequestRefundArgs {
  /** An automatic refund (cancellation, reconciliation) needs no approver. */
  auto?: boolean;
  /** Who is executing it now. Defaults to `requestedBy`. */
  processedBy?: string | null;
  /** The seam: a test passes a stub and the suite performs no network call. */
  fetch?: typeof fetch;
}

/**
 * Move the money and say so, in the order that makes each step recoverable.
 *
 * 1. `record_booking_refund()` — the row, and the booking to `refund_pending`.
 * 2. `createRefund()` — only when the route is `gateway`.
 * 3. the gateway's id onto the row, **before** completion, so a process that
 *    dies here leaves something the `refund.processed` webhook can match on and
 *    finish rather than a refund nobody can see.
 * 4. `complete_booking_refund()` — refund `completed`, booking `refunded`,
 *    `payments.refundable_amount` down, all in one statement.
 *
 * On a definitive gateway refusal the same amount goes to the wallet instead
 * and step 4 runs with `route = 'wallet'`. On an *unreachable* gateway nothing
 * is credited: the request may already have been processed by the gateway, and
 * crediting a wallet on top of that would refund twice. The row stays
 * `requested` with the failure recorded — money is never silently dropped, and
 * it is never duplicated either.
 *
 * Returns the row: `status === 'completed'` means the money moved, `requested`
 * means it is queued for an operator. The route decides what to answer.
 */
export async function executeRefund(args: ExecuteRefundArgs): Promise<Refund> {
  const { supabase, payment } = args;
  assertRefundable(payment, args.amountPaise);

  if (!payment.booking_id) {
    throw new ApiHttpError(
      'INVALID_STATE',
      'That payment is not attached to a booking, so it cannot be refunded here.',
      409,
      { paymentId: payment.id }
    );
  }

  const route = args.route ?? refundRoute(payment);
  const requestedBy = args.requestedBy ?? null;
  const processedBy = args.processedBy ?? requestedBy;
  const note = args.note ?? null;

  const { data: created, error: recordError } = await supabase.rpc('record_booking_refund', {
    p_payment_id: payment.id,
    p_booking_id: payment.booking_id,
    p_amount: numericLiteral(args.amountPaise),
    p_reason_code: args.reasonCode,
    p_route: route,
    p_note: note,
    p_requested_by: requestedBy,
  });
  if (recordError) throw recordError;
  if (!created) {
    throw new ApiHttpError(
      'INVALID_STATE',
      'That refund could not be created for this payment.',
      409,
      { paymentId: payment.id }
    );
  }

  let gatewayRefundId: string | null = null;

  if (route === 'gateway') {
    const attempt = await askGatewayForRefund(args, created);
    if (attempt.ok) {
      gatewayRefundId = attempt.refundId;
      // Persisted before completion so a crash between here and step 4 leaves a
      // row the webhook can find by `gateway_refund_id` and finish.
      const { error: storeError } = await supabase
        .from('refunds')
        .update({ gateway_refund_id: gatewayRefundId })
        .eq('id', created.id);
      if (storeError) throw storeError;
    } else if (attempt.unreachable) {
      await noteOpsTicket(supabase, {
        refund: created,
        payment,
        amountPaise: args.amountPaise,
        reasonCode: args.reasonCode,
        failureReason: attempt.reason,
        reachable: false,
        requestId: args.requestId ?? null,
        ipAddress: args.ipAddress ?? null,
      });
      return created;
    } else {
      return walletFallback(supabase, args, created, attempt.reason, processedBy);
    }
  }

  const { data: completed, error: completeError } = await supabase.rpc(
    'complete_booking_refund',
    {
      p_refund_id: created.id,
      p_gateway_refund_id: gatewayRefundId,
      p_route: route,
      p_note: note ?? `refund completed (${route})`,
      p_processed_by: processedBy,
    }
  );
  if (completeError) throw completeError;
  // `null` is the replay guard: another caller already completed this refund
  // (the webhook arriving while this request was in flight). The row is
  // correct either way, and re-completing would draw the payment down twice.
  const row = completed ?? created;

  await audit(supabase, {
    actorProfileId: processedBy,
    action: 'refund.completed',
    entityType: 'refunds',
    entityId: row.id,
    after: { status: 'completed', route },
    metadata: {
      paymentId: payment.id,
      bookingId: payment.booking_id,
      amount_paise: args.amountPaise,
      currency: payment.currency,
      reason_code: args.reasonCode,
      gatewayRefundId,
    },
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return row;
}

/** What the gateway said, and whether it said it at all. */
type GatewayAttempt =
  | { ok: true; refundId: string }
  | { ok: false; unreachable: boolean; reason: string };

/**
 * Ask Razorpay for the refund.
 *
 * The transport is injected exactly as `lib/razorpayClient.ts` documents
 * (CONTEXT decision 4): no test in this suite performs a network call. A
 * response the gateway wrote is a *definite* answer; a refused socket is not,
 * and `lib/razorpayClient.ts` marks that with `unreachable: true` so this
 * function can tell the two apart.
 */
async function askGatewayForRefund(
  args: ExecuteRefundArgs,
  refund: Refund
): Promise<GatewayAttempt> {
  const gatewayPaymentId = args.payment.gateway_payment_id;
  if (!gatewayPaymentId) {
    return { ok: false, unreachable: false, reason: 'The payment has no gateway id to refund against.' };
  }

  const keyId =
    process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!keyId || !keySecret) {
    // Not a transport failure and not the gateway's answer either, but it is
    // definite: nothing was sent, so nothing can have been processed. The
    // wallet can take the money safely, and the ticket names the missing key.
    return {
      ok: false,
      unreachable: false,
      reason: `Razorpay is not configured on this deployment (${keyId ? 'RAZORPAY_KEY_SECRET' : 'RAZORPAY_KEY_ID'} is unset).`,
    };
  }

  try {
    const result = await createRazorpayClient({
      keyId,
      keySecret,
      ...(args.fetch ? { fetch: args.fetch } : {}),
    }).createRefund({
      paymentId: gatewayPaymentId,
      amountPaise: args.amountPaise,
    });
    const id = typeof result.id === 'string' ? result.id : '';
    if (!id) {
      return { ok: false, unreachable: false, reason: 'The gateway accepted the refund but returned no id for it.' };
    }
    return { ok: true, refundId: id };
  } catch (e) {
    const unreachable =
      e instanceof ApiHttpError &&
      typeof e.details?.unreachable === 'boolean' &&
      (e.details.unreachable as boolean);
    return {
      ok: false,
      unreachable,
      reason: e instanceof ApiHttpError ? e.message : 'The gateway rejected the refund.',
    };
  }
}

/**
 * §12.3's "never left with nothing": the same amount, credited to the wallet,
 * with the refund completing through the same function so the payment's
 * remainder still comes down and the booking still reaches `refunded`.
 *
 * A bare `update refunds set status='completed'` would do neither of those,
 * which is exactly the half-finished state 03-RESEARCH flagged — so the
 * completion goes through `complete_booking_refund()` with `route='wallet'`,
 * and only the credit itself happens here.
 */
async function walletFallback(
  supabase: ServerClient,
  args: ExecuteRefundArgs,
  refund: Refund,
  failureReason: string,
  processedBy: string | null
): Promise<Refund> {
  await creditWallet(
    supabase,
    args.payment.customer_id,
    args.amountPaise,
    `refund:${refund.id}`,
    `Refund of ${numericLiteral(args.amountPaise)} ${args.payment.currency || 'INR'} for booking ${refund.booking_id}`
  );

  const { data: completed, error } = await supabase.rpc('complete_booking_refund', {
    p_refund_id: refund.id,
    p_gateway_refund_id: null,
    p_route: 'wallet',
    p_note: `refunded to the wallet: ${failureReason}`,
    p_processed_by: processedBy,
  });
  if (error) throw error;

  await noteOpsTicket(supabase, {
    refund,
    payment: args.payment,
    amountPaise: args.amountPaise,
    reasonCode: args.reasonCode,
    failureReason,
    reachable: true,
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  await audit(supabase, {
    actorProfileId: processedBy,
    action: 'refund.wallet_fallback',
    entityType: 'refunds',
    entityId: refund.id,
    after: { status: 'completed', route: 'wallet' },
    metadata: {
      paymentId: args.payment.id,
      bookingId: refund.booking_id,
      amount_paise: args.amountPaise,
      failureReason,
      reason_code: args.reasonCode,
    },
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return completed ?? refund;
}

/**
 * The ops ticket for a refund that did not go the way the product wanted.
 *
 * §12.3's other half: a customer is never left with nothing, *and* an operator
 * is never left with no idea why. `refund.ops_ticket` is the action the support
 * console filters on, and its metadata carries the gateway's own sentence —
 * never `gateway_signature`, which `redact()` strips on the way in anyway.
 */
async function noteOpsTicket(
  supabase: ServerClient,
  args: {
    refund: Refund;
    payment: Payment;
    amountPaise: number;
    reasonCode: string;
    failureReason: string;
    /** False when the gateway could not be reached at all — no money moved. */
    reachable: boolean;
    requestId: string | null;
    ipAddress: string | null;
  }
): Promise<void> {
  await audit(supabase, {
    actorProfileId: null,
    action: 'refund.ops_ticket',
    entityType: 'refunds',
    entityId: args.refund.id,
    after: { status: args.refund.status, route: args.refund.route },
    metadata: {
      paymentId: args.payment.id,
      bookingId: args.refund.booking_id,
      amount_paise: args.amountPaise,
      reason_code: args.reasonCode,
      failureReason: args.failureReason,
      // Distinguishes "tried and fell back" from "never asked".
      gateway_reached: args.reachable,
    },
    requestId: args.requestId,
    ipAddress: args.ipAddress,
  });
}
