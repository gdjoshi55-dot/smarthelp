import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { parseNumeric, toPaise } from '@/lib/money';
import { paymentAmountPaise } from '@/lib/paymentServer';
import { isUsableWebhookSecret, verifyRazorpaySignature } from '@/lib/razorpaySignature';
import { createServerClient } from '@/lib/supabaseServer';
import type { Payment, Refund } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/razorpay — the sole authority on whether money arrived
 * (§12.1, §30.1).
 *
 * This is the one Route Handler in the tree that is not authenticated by
 * `requireAuth`. Razorpay sends no bearer token, so its authority is the
 * signature over the bytes it sent, and four statements in a fixed order are
 * what make that authority real:
 *
 *   1. `await req.text()` — **the first thing that touches the body.**
 *   2. read `x-razorpay-signature`.
 *   3. the runtime guard: no secret, or a placeholder `.env.example` left
 *      behind ⇒ `SERVICE_UNAVAILABLE` with a sentence about it, rather than a
 *      500 out of `timingSafeEqual` or — worse — every delivery failing
 *      silently while the deployment *looks* configured.
 *   4. `verifyRazorpaySignature(rawBody, secret, signature)` ⇒ `400` on false.
 *   **Only then** `JSON.parse(rawBody)`.
 *
 * ## Two facts this header exists to keep true
 *
 * **1. `handle()` does not consume the body — checked, not assumed.**
 * `lib/api.ts:137` reads exactly one thing off `req`: the `x-request-id`
 * header. It never calls `req.json()`, `req.text()` or touches `req.body`, so
 * the stream is intact when the callback starts. That is a *fact with a guard*:
 * if a future `handle()` change reads the body, `req.text()` here returns an
 * empty string, every signature check in production fails, and the suite would
 * stay green. `test/api.test.ts` therefore has a case handing `handle()` a
 * request and asserting the callback can still read the exact body bytes —
 * pinning the assumption where it would break.
 *
 * **2. The secret is read at request time**, not at module load:
 * `vitest.config.ts` inlines only the four Supabase variables, so no
 * `RAZORPAY_*` key is repo-wide, and the runtime guard needs a per-request read
 * anyway. Tests supply `vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', …)`.
 *
 * Never call `readJson()`/`req.json()` on this route before step 1: `Request.body`
 * is one-shot, and parsing the string `req.text()` already returned costs
 * nothing.
 *
 * ## What it writes
 *
 * Exactly two things, and only ever through `confirm_booking_payment()` (0014):
 * `payments.status = 'success'` and `bookings.status = 'paid'`, in one
 * transaction, guarded by `status in ('created','pending')` so a re-delivered
 * webhook updates zero rows and answers 200 with a duplicate audit entry
 * (§30.1). A `payment.failed` marks the *payment* failed and leaves the booking
 * `payment_pending` — the customer decides whether to try again, and a booking
 * that vanished on a declined card would be a support conversation rather than
 * a fix.
 *
 * Every path writes one audit row with `actorProfileId: null` (a webhook has no
 * profile to name — `write_audit` and `lib/audit.ts` both tolerate that), and
 * `gateway_signature` never reaches them: it is dispute evidence under §12.2 and
 * `REDACTED_KEYS` in `lib/audit.ts` now carries it.
 */
export async function POST(req: Request) {
  return handle(req, 'payments.webhook', async (requestId) => {
    // 1. The exact bytes. A `JSON.parse` + `JSON.stringify` round trip changes
    // spacing and key order, and the signature covers what the gateway sent
    // rather than what it meant.
    const rawBody = await req.text();

    // 2.
    const signature = req.headers.get('x-razorpay-signature');
    if (!signature) {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'Missing x-razorpay-signature header.',
        400,
        { reason: 'signature_missing' }
      );
    }

    // 3. Request-time read: no `RAZORPAY_*` variable is inlined by vitest, and
    // a guard that ran at import time could not see `vi.stubEnv`.
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!isUsableWebhookSecret(secret)) {
      throw new ApiHttpError(
        'SERVICE_UNAVAILABLE',
        'Webhook deliveries cannot be verified: RAZORPAY_WEBHOOK_SECRET is unset or still the placeholder from .env.example.',
        422,
        { missing: 'RAZORPAY_WEBHOOK_SECRET' }
      );
    }

    // 4.
    if (!verifyRazorpaySignature(rawBody, secret, signature)) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Invalid webhook signature.', 400, {
        reason: 'signature_mismatch',
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new ApiHttpError('VALIDATION_ERROR', 'Webhook body is not JSON.', 400);
    }

    const event = typeof payload?.event === 'string' ? payload.event : '';

    if (event === 'payment.captured') {
      return handleCaptured(payload, signature, requestId, clientIp(req));
    }
    if (event === 'payment.failed') {
      return handleFailed(payload, signature, requestId, clientIp(req));
    }
    if (event === 'refund.processed') {
      return handleRefundProcessed(payload, requestId, clientIp(req));
    }

    // Signed, understood, and not ours to act on. Answering 200 stops the
    // gateway re-delivering an event nothing handles.
    return ok({ ignored: true, event: event || 'unknown' });
  });
}

/** The `payload.payment.entity` of an event, or a refusal for a signed but hollow body. */
function paymentEntity(payload: any, event: string): Record<string, any> {
  // The Razorpay envelope nests the entity a level deeper than a plain
  // `{"event": ..., "payment": ...}` object would: the gateway sends
  // `{ event, payload: { payment: { entity } } }`.
  const entity = payload?.payload?.payment?.entity;
  if (!entity || typeof entity !== 'object') {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      `The ${event} event carried no payment entity.`,
      400
    );
  }
  return entity;
}

/** The row this order belongs to, or a refusal that writes nothing. */
async function paymentForOrder(
  entity: Record<string, any>,
  event: string,
  requestId: string,
  ipAddress: string | null
): Promise<Payment> {
  const orderId = typeof entity.order_id === 'string' ? entity.order_id : '';

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('gateway', 'razorpay')
    .eq('gateway_order_id', orderId)
    .maybeSingle();
  if (error) throw error;

  // An order we never created is not a disagreement about an amount — it is a
  // delivery about a row that does not exist. Same answer either way: 400, no
  // write, an audit row an operator can see.
  if (!data) {
    await mismatch(entity, { reason: 'unknown_order' }, event, requestId, ipAddress);
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'No payment exists for that order.',
      400,
      { reason: 'unknown_order', orderId }
    );
  }

  return data;
}

/**
 * The agreement check: **paise against paise**.
 *
 * `payload.payment.entity.amount` is already an integer of paise from the
 * gateway, and `paymentAmountPaise(row)` is the same integer from Postgres, so
 * the comparison is `===` on two integers. Neither side is converted to rupees
 * and multiplied back — that is where a 613.60 booking would become 61359 and
 * a real capture would be rejected as a mismatch.
 */
function agrees(entity: Record<string, any>, row: Payment): { ok: boolean; detail: Record<string, unknown> } {
  const expectedPaise = paymentAmountPaise(row);
  const gotPaise = typeof entity.amount === 'number' ? entity.amount : NaN;
  const detail = {
    orderId: row.gateway_order_id,
    expectedAmount_paise: expectedPaise,
    gotAmount_paise: gotPaise,
    expectedCurrency: row.currency,
    gotCurrency: entity.currency,
  };
  return {
    ok:
      gotPaise === expectedPaise &&
      entity.currency === row.currency &&
      entity.order_id === row.gateway_order_id,
    detail,
  };
}

async function mismatch(
  entity: Record<string, any>,
  detail: Record<string, unknown>,
  event: string,
  requestId: string,
  ipAddress: string | null
) {
  const supabase = createServerClient();
  await audit(supabase, {
    actorProfileId: null,
    action: 'payment.webhook.mismatch',
    entityType: 'payments',
    entityId: typeof entity.order_id === 'string' ? entity.order_id : null,
    metadata: { event, ...detail },
    requestId,
    ipAddress,
  });
}

/** `payment.captured` ⇒ one call to the single writer, or a logged replay. */
async function handleCaptured(
  payload: any,
  signature: string | null,
  requestId: string,
  ipAddress: string | null
) {
  const entity = paymentEntity(payload, 'payment.captured');
  const row = await paymentForOrder(entity, 'payment.captured', requestId, ipAddress);

  const check = agrees(entity, row);
  if (!check.ok) {
    await mismatch(entity, check.detail, 'payment.captured', requestId, ipAddress);
    throw new ApiHttpError('VALIDATION_ERROR', 'Payment does not match this order.', 400, {
      reason: 'amount_mismatch',
      ...check.detail,
    });
  }

  const gatewayPaymentId = typeof entity.id === 'string' ? entity.id : '';
  const supabase = createServerClient();

  // A charge with no booking behind it is not this function's business:
  // `confirm_booking_payment` would move nothing and a `wallet_topup` (Phase 8)
  // has no booking to move. Answered rather than dropped, so the event does not
  // look like it was handled.
  if (!row.booking_id) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'That payment is not attached to a booking.',
      400,
      { reason: 'payment_has_no_booking', paymentId: row.id }
    );
  }

  // The row was found by `.eq('gateway_order_id', orderId)` in paymentForOrder,
  // so this is a string in fact — but the column is nullable and a query cannot
  // say so, so the narrowing is written here. It is not a cast: if the invariant
  // ever broke, a 400 is the honest answer, where a null passed through would
  // match nothing and be logged as a *duplicate* — a lie about what happened.
  const gatewayOrderId = row.gateway_order_id;
  if (!gatewayOrderId) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'That payment has no gateway order to confirm against.',
      400,
      { reason: 'payment_has_no_order', paymentId: row.id }
    );
  }

  // One statement, one transaction: the payment and the booking move together
  // or not at all. The replay guard is inside the function (`status in
  // ('created','pending')`), which is what makes a re-delivered webhook a no-op
  // rather than a second confirmation.
  const { data, error } = await supabase.rpc('confirm_booking_payment', {
    p_payment_id: row.id,
    p_gateway_order_id: gatewayOrderId,
    p_booking_id: row.booking_id,
    p_gateway_payment_id: gatewayPaymentId,
    p_gateway_signature: signature,
    p_note: `payment confirmed by webhook (payment.captured, ${gatewayPaymentId})`,
  });
  if (error) throw error;

  if (!data) {
    await audit(supabase, {
      actorProfileId: null,
      action: 'payment.webhook.duplicate',
      entityType: 'payments',
      entityId: row.id,
      metadata: { event: 'payment.captured', gatewayPaymentId },
      requestId,
      ipAddress,
    });
    return ok({ duplicate: true, paymentId: row.id });
  }

  await audit(supabase, {
    actorProfileId: null,
    action: 'payment.captured',
    entityType: 'payments',
    entityId: row.id,
    metadata: {
      bookingId: row.booking_id,
      gatewayPaymentId,
      amount_paise: paymentAmountPaise(row),
      currency: row.currency,
    },
    requestId,
    ipAddress,
  });

  return ok({ confirmed: true, paymentId: row.id, bookingId: row.booking_id });
}

/**
 * `payment.failed` ⇒ the payment fails and **the booking does not**.
 *
 * A declined card is a state the customer can leave by paying again, so the
 * booking stays `payment_pending` with its quote intact (only the webhook's
 * confirm path nulls `quote_token`). The JS check below is the real guard and
 * the `.in()` in SQL is the race guard: a payment that turned `success` between
 * this read and this write must not be walked back to `failed`.
 */
async function handleFailed(
  payload: any,
  _signature: string | null,
  requestId: string,
  ipAddress: string | null
) {
  const entity = paymentEntity(payload, 'payment.failed');
  const row = await paymentForOrder(entity, 'payment.failed', requestId, ipAddress);

  const supabase = createServerClient();

  if (row.status !== 'created' && row.status !== 'pending') {
    await audit(supabase, {
      actorProfileId: null,
      action: 'payment.webhook.duplicate',
      entityType: 'payments',
      entityId: row.id,
      metadata: { event: 'payment.failed', status: row.status },
      requestId,
      ipAddress,
    });
    return ok({ duplicate: true, paymentId: row.id });
  }

  const failureReason =
    (typeof entity.error_description === 'string' && entity.error_description) ||
    (typeof entity.error_code === 'string' && entity.error_code) ||
    'The gateway reported the payment as failed.';

  const { error } = await supabase
    .from('payments')
    .update({ status: 'failed', failure_reason: failureReason })
    .eq('id', row.id)
    .in('status', ['created', 'pending']);
  if (error) throw error;

  await audit(supabase, {
    actorProfileId: null,
    action: 'payment.failed',
    entityType: 'payments',
    entityId: row.id,
    metadata: { bookingId: row.booking_id, failureReason },
    requestId,
    ipAddress,
  });

  return ok({ failed: true, paymentId: row.id });
}

/**
 * `refund.processed` ⇒ the gateway confirms the money left (§12.3).
 *
 * `lib/refundServer.ts` already wrote the `refunds` row and persisted the
 * gateway's id on it *before* asking for completion, so this handler's job is
 * narrow: find that row by `gateway_refund_id` and finish it. The completion
 * goes through `complete_booking_refund()` — the same function the synchronous
 * path calls — so `refunds.status='completed'`, `bookings.status='refunded'`
 * and the payment's `refundable_amount` all move together, in one statement,
 * with the function's own replay guard answering `null` when a redelivery
 * arrives after the row already completed.
 *
 * An event naming a refund we did not create is a delivery about a row that
 * does not exist: `400`, zero writes, and a mismatch audit row — the same
 * discipline `paymentForOrder()` applies on the capture path. The signature is
 * never recorded; `redact()` in `lib/audit.ts` would strip it anyway.
 */
async function handleRefundProcessed(
  payload: any,
  requestId: string,
  ipAddress: string | null
) {
  const entity = payload?.payload?.refund?.entity;
  if (!entity || typeof entity !== 'object') {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'The refund.processed event carried no refund entity.',
      400
    );
  }

  const gatewayRefundId = typeof entity.id === 'string' ? entity.id : '';
  if (!gatewayRefundId) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'The refund.processed event carried no refund id.',
      400
    );
  }

  const supabase = createServerClient();
  const { data: row, error } = await supabase
    .from('refunds')
    .select('*')
    .eq('gateway_refund_id', gatewayRefundId)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    await audit(supabase, {
      actorProfileId: null,
      action: 'refund.webhook.mismatch',
      entityType: 'refunds',
      entityId: null,
      metadata: { event: 'refund.processed', gatewayRefundId, reason: 'unknown_refund' },
      requestId,
      ipAddress,
    });
    throw new ApiHttpError('VALIDATION_ERROR', 'No refund exists for that gateway refund id.', 400, {
      reason: 'unknown_refund',
      gatewayRefundId,
    });
  }

  const refund = row as Refund;
  const { data: completed, error: completeError } = await supabase.rpc(
    'complete_booking_refund',
    {
      p_refund_id: refund.id,
      p_gateway_refund_id: gatewayRefundId,
      p_route: 'gateway',
      p_note: `refund confirmed by webhook (refund.processed, ${gatewayRefundId})`,
      p_processed_by: null,
    }
  );
  if (completeError) throw completeError;

  // `null` is the replay guard: the synchronous path (or an earlier delivery)
  // already completed this refund. The row is correct either way, and completing
  // a second time would draw the payment's remainder down twice.
  if (!completed) {
    await audit(supabase, {
      actorProfileId: null,
      action: 'refund.webhook.duplicate',
      entityType: 'refunds',
      entityId: refund.id,
      metadata: { event: 'refund.processed', gatewayRefundId },
      requestId,
      ipAddress,
    });
    return ok({ duplicate: true, refundId: refund.id });
  }

  await audit(supabase, {
    actorProfileId: null,
    action: 'refund.processed',
    entityType: 'refunds',
    entityId: refund.id,
    metadata: {
      bookingId: refund.booking_id,
      paymentId: refund.payment_id,
      gatewayRefundId,
      amount_paise: toPaise(parseNumeric(refund.amount)),
      route: 'gateway',
    },
    requestId,
    ipAddress,
  });

  return ok({ refunded: true, refundId: refund.id, bookingId: refund.booking_id });
}
