import { ApiHttpError } from './api';
import { audit } from './audit';
import { PLATFORM_DEFAULTS } from './constants';
import { numericLiteral, parseNumeric, toPaise } from './money';
import { paymentAmountPaise } from './paymentServer';
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

export interface ExecutePendingRefundArgs {
  supabase: ServerClient;
  /** The existing `requested` (or `approved`) refund row being carried through. */
  refund: Refund;
  payment: Payment;
  processedBy: string;
  /** Reads the current support-refund-limit setting when not supplied. */
  supportRefundLimit?: number;
  note?: string | null;
  fetch?: typeof fetch;
  requestId?: string | null;
  ipAddress?: string | null;
}

/**
 * Execute a refund row that already exists — §25.10's approver, and the console
 * path for an above-limit request (Wave C).
 *
 * `executeRefund` is the path for refunds whose row is being created by the same
 * call that executes them (cancellations, the customer support flow). An
 * above-limit request, though, was created *without* being executed
 * (`requestRefund`, row left `requested`, `approved_by` null), so its execution
 * must not create a second row. The steps are the same as `executeRefund`'s
 * after its step 1 — gateway first, wallet on a definite refusal — minus the
 * `record_booking_refund` call, and with one extra fact: an above-limit refund
 * (amount > `supportRefundLimit`) may only be executed by an approver, which is
 * the Route Handler's job to have checked; this module only records who stamped
 * the approval on the row.
 *
 * The row is stamped `approved` (with the approver) before the money moves, so
 * an approval is never implied by a completed refund alone.
 */
export async function executePendingRefund(args: ExecutePendingRefundArgs): Promise<Refund> {
  const supabase = args.supabase;
  const { payment, processedBy } = args;
  let refund: Refund = args.refund;

  const limit = args.supportRefundLimit ?? PLATFORM_DEFAULTS.supportRefundLimit;
  const aboveLimit = toPaise(parseNumeric(refund.amount)) > toPaise(limit);

  // Stamp approval first: who approved and when is a fact the row must carry
  // even if the gateway is unreachable and the money cannot move just yet.
  if (aboveLimit && refund.status === 'requested') {
    const { data: approved, error } = await supabase
      .from('refunds')
      .update({ status: 'approved', approved_by: processedBy })
      .eq('id', refund.id)
      .select('*')
      .single();
    if (error) throw error;
    refund = approved;
  }

  const route = refund.route as RefundRoute;
  const note = args.note ?? `refund executed${aboveLimit ? ' (approved)' : ''}`;
  let gatewayRefundId: string | null = refund.gateway_refund_id;

  if (route === 'gateway' && !gatewayRefundId) {
    const attempt = await askGatewayForRefund({ payment, amountPaise: toPaise(parseNumeric(refund.amount)), fetch: args.fetch }, refund);
    if (attempt.ok) {
      gatewayRefundId = attempt.refundId;
      const { error: storeError } = await supabase
        .from('refunds')
        .update({ gateway_refund_id: gatewayRefundId })
        .eq('id', refund.id);
      if (storeError) throw storeError;
    } else if (attempt.unreachable) {
      await noteOpsTicket(supabase, {
        refund,
        payment,
        amountPaise: toPaise(parseNumeric(refund.amount)),
        reasonCode: refund.reason_code,
        failureReason: attempt.reason,
        reachable: false,
        requestId: args.requestId ?? null,
        ipAddress: args.ipAddress ?? null,
      });
      return refund;
    } else {
      return walletFallbackForPending(supabase, args, refund, attempt.reason);
    }
  }

  if (route === 'wallet') {
    await creditWallet(
      supabase,
      payment.customer_id,
      toPaise(parseNumeric(refund.amount)),
      `refund:${refund.id}`,
      `Refund of ${refund.amount} ${refund.currency || 'INR'} for booking ${refund.booking_id}`
    );
  }

  const { data: completed, error: completeError } = await supabase.rpc('complete_booking_refund', {
    p_refund_id: refund.id,
    p_gateway_refund_id: gatewayRefundId,
    p_route: route,
    p_note: note,
    p_processed_by: processedBy,
  });
  if (completeError) throw completeError;

  const row = completed ?? refund;
  await audit(supabase, {
    actorProfileId: processedBy,
    action: 'refund.approved_and_completed',
    entityType: 'refunds',
    entityId: row.id,
    before: { status: refund.status },
    after: { status: 'completed', route },
    metadata: {
      paymentId: payment.id,
      bookingId: refund.booking_id,
      amount: refund.amount,
      reason_code: refund.reason_code,
      gatewayRefundId,
    },
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return row;
}

/**
 * The wallet fallback for an already-requested refund row: same promise as
 * `walletFallback` (never left with nothing) but starting from a row that
 * already exists rather than one `executeRefund` just created.
 */
async function walletFallbackForPending(
  supabase: ServerClient,
  args: ExecutePendingRefundArgs,
  refund: Refund,
  failureReason: string
): Promise<Refund> {
  await creditWallet(
    supabase,
    args.payment.customer_id,
    toPaise(parseNumeric(refund.amount)),
    `refund:${refund.id}`,
    `Refund of ${refund.amount} ${refund.currency || 'INR'} for booking ${refund.booking_id}`
  );

  const { data: completed, error } = await supabase.rpc('complete_booking_refund', {
    p_refund_id: refund.id,
    p_gateway_refund_id: null,
    p_route: 'wallet',
    p_note: `refunded to the wallet: ${failureReason}`,
    p_processed_by: args.processedBy,
  });
  if (error) throw error;

  await noteOpsTicket(supabase, {
    refund: completed ?? refund,
    payment: args.payment,
    amountPaise: toPaise(parseNumeric(refund.amount)),
    reasonCode: refund.reason_code,
    failureReason,
    reachable: true,
    requestId: args.requestId ?? null,
    ipAddress: args.ipAddress ?? null,
  });

  return completed ?? refund;
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
  args: { payment: Payment; amountPaise: number; fetch?: typeof fetch },
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

/** The shape a Route Handler returns in its JSON body for an automatic refund. */
export interface CapturedRefund {
  id: string;
  amount: number;
  currency: string;
  status: Refund['status'];
  route: RefundRoute;
}

export interface RefundCapturedBookingArgs {
  supabase: ServerClient;
  bookingId: string;
  /**
   * Rupees withheld — §11.1's cancellation fee. Zero refunds everything, which
   * is the exhausted-search case: nobody provided a service, so nothing is kept.
   */
  feeRupees: number;
  /** Defaults to the §16 reason a customer cancellation carries. */
  reasonCode?: string;
  /** Defaults to a sentence naming the cancellation; overridden for exhaustion. */
  note?: string;
  ipAddress?: string | null;
}

/**
 * Give back what a captured-then-ended booking is owed, or nothing.
 *
 * This is the one place "refund the money we took" happens for a booking that
 * ended without a service, and two callers share it: the customer's
 * cancellation (`POST /api/bookings/:id/cancel`, where §11.1's fee may be
 * withheld) and Phase 5's exhausted search (fee 0 — no professional was ever
 * assigned, so there is no fee to keep). A second copy is a second place for the
 * paise arithmetic to be a rupee out.
 *
 * A booking with no captured payment — the common unpaid case — has nothing to
 * refund: this returns `null` rather than writing a zero-value ledger row. When
 * money *was* captured, the refundable part is the captured amount less the fee,
 * computed in paise, never re-derived in floats at the boundary. The
 * `> 0` guard is what stops a zero row when the fee equals the capture exactly;
 * `executeRefund`'s own `assertRefundable()` is the second line of defence.
 *
 * `auto: true` means it is never held for approval (see `planRefund`): the
 * platform is taking back its own money, and a booking that has already ended
 * must not be stranded waiting for a human.
 */
export async function refundCapturedBooking(
  args: RefundCapturedBookingArgs
): Promise<CapturedRefund | null> {
  const { data, error } = await args.supabase
    .from('payments')
    .select('*')
    .eq('booking_id', args.bookingId)
    .eq('status', 'success')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const payment = data as Payment;
  const amountPaise = paymentAmountPaise(payment) - toPaise(args.feeRupees);
  if (amountPaise <= 0) return null;

  const refund = await executeRefund({
    supabase: args.supabase,
    payment,
    amountPaise,
    reasonCode: args.reasonCode ?? 'booking_cancelled',
    note: args.note ?? `automatic refund on cancellation of booking ${args.bookingId}`,
    auto: true,
    requestedBy: null,
    ipAddress: args.ipAddress ?? null,
  });

  return {
    id: refund.id,
    amount: parseNumeric(refund.amount),
    currency: refund.currency,
    status: refund.status,
    route: refund.route,
  };
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
