import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isUsableWebhookSecret,
  verifyCheckoutSignature,
  verifyRazorpaySignature,
} from '../lib/razorpaySignature';

/**
 * The signature verifier's whole contract, against vectors computed here.
 *
 * No fixture in this file holds a real secret, and none needs to: the
 * algorithm is a hash, so a synthetic key produces a synthetic — and equally
 * valid — signature. What matters is the *algorithm* and the *input*, and both
 * are pinned below.
 *
 * The algorithm is SHA-256, not the SHA-512 §12.1 names. Razorpay documents
 * `X-Razorpay-Signature` as "HMAC with SHA256 algorithm; with your webhook
 * secret set as the key and the webhook request body as the message"
 * (<https://razorpay.com/docs/webhooks/validate-test>), and the sibling
 * SmartPOS project's own webhook route calls `.createHmac('sha256', …)`.
 * Implementing §12.1 literally would pass every test in this file and fail
 * every real delivery — which is exactly why the vectors below are computed
 * with `createHmac('sha256', …)` rather than read from a table.
 */

const SECRET = 'synthetic-webhook-secret-for-tests';

const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('verifyRazorpaySignature', () => {
  it('accepts a signature computed over the exact raw bytes', () => {
    const raw = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}';
    expect(verifyRazorpaySignature(raw, SECRET, sign(raw))).toBe(true);
  });

  it('accepts bytes whose spacing and key order a JSON re-serialisation would change', () => {
    // A real gateway is not obliged to emit canonical JSON. The signature covers
    // the octets that arrived, so anything the route parses after verifying is
    // irrelevant to this function.
    const raw = '{ "event" : "payment.captured",  "payload" : { "a":1 } }';
    expect(verifyRazorpaySignature(raw, SECRET, sign(raw))).toBe(true);
    expect(verifyRazorpaySignature(JSON.stringify(JSON.parse(raw)), SECRET, sign(raw))).toBe(false);
  });

  it('accepts a Buffer body as well as a string', () => {
    const raw = '{"event":"payment.captured"}';
    expect(verifyRazorpaySignature(Buffer.from(raw, 'utf8'), SECRET, sign(raw))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const raw = '{"event":"payment.captured","amount":123000}';
    const tampered = '{"event":"payment.captured","amount":1}';
    expect(verifyRazorpaySignature(tampered, SECRET, sign(raw))).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const raw = '{"event":"payment.captured"}';
    expect(verifyRazorpaySignature(raw, SECRET, sign(raw, 'the-other-secret'))).toBe(false);
  });

  it('rejects an absent signature without throwing', () => {
    const raw = '{"event":"payment.captured"}';
    expect(verifyRazorpaySignature(raw, SECRET, null)).toBe(false);
    expect(verifyRazorpaySignature(raw, SECRET, undefined)).toBe(false);
    expect(verifyRazorpaySignature(raw, SECRET, '')).toBe(false);
  });

  it('rejects a non-hex signature', () => {
    const raw = '{"event":"payment.captured"}';
    const notHex = 'z'.repeat(64);
    expect(verifyRazorpaySignature(raw, SECRET, notHex)).toBe(false);
  });

  it('rejects a wrong-length signature with a false, never a throw', () => {
    // `timingSafeEqual` raises when the buffers differ in length, which would
    // surface as a 500 from the webhook for what is only a bad signature. The
    // length check is what keeps that a 400.
    const raw = '{"event":"payment.captured"}';
    const tooShort = sign(raw).slice(0, 32);
    const tooLong = sign(raw) + 'ab';
    expect(() => verifyRazorpaySignature(raw, SECRET, tooShort)).not.toThrow();
    expect(verifyRazorpaySignature(raw, SECRET, tooShort)).toBe(false);
    expect(() => verifyRazorpaySignature(raw, SECRET, tooLong)).not.toThrow();
    expect(verifyRazorpaySignature(raw, SECRET, tooLong)).toBe(false);
  });

  it('rejects an all-zero signature of the right length', () => {
    const raw = '{"event":"payment.captured"}';
    expect(verifyRazorpaySignature(raw, SECRET, '0'.repeat(64))).toBe(false);
  });
});

describe('isUsableWebhookSecret', () => {
  it('accepts a real-looking secret', () => {
    expect(isUsableWebhookSecret('whsec_abcdefghijklmnopqrstuvwxyz')).toBe(true);
  });

  it('refuses an absent, empty or blank secret', () => {
    expect(isUsableWebhookSecret(undefined)).toBe(false);
    expect(isUsableWebhookSecret('')).toBe(false);
    expect(isUsableWebhookSecret('   ')).toBe(false);
  });

  it('refuses the placeholder a copied .env.example leaves behind', () => {
    // The two markers the guard is specified to look for. Deliberately not a
    // broader heuristic: sniffing for "looks like an example" would start
    // refusing real secrets the moment somebody picks an unlucky one, and a
    // refused secret fails loudly (SERVICE_UNAVAILABLE) rather than silently.
    expect(isUsableWebhookSecret('REPLACE_WITH_YOUR_WEBHOOK_SECRET')).toBe(false);
    expect(isUsableWebhookSecret('<placeholder>')).toBe(false);
    expect(isUsableWebhookSecret('PLACEHOLDER')).toBe(false);
  });
});

describe('verifyCheckoutSignature', () => {
  // A different key and a different message from the webhook's, which is the
  // point of exporting it separately: `POST /api/payments/verify` signs
  // `order_id + '|' + payment_id` with `RAZORPAY_KEY_SECRET`.
  const checkoutSecret = 'synthetic-key-secret-for-tests';
  const checkoutSign = (orderId: string, paymentId: string, secret = checkoutSecret) =>
    createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  it('accepts the correct signature over order_id | payment_id', () => {
    expect(
      verifyCheckoutSignature('order_abc', 'pay_123', checkoutSecret, checkoutSign('order_abc', 'pay_123'))
    ).toBe(true);
  });

  it('rejects a signature built from the two ids in the other order', () => {
    expect(
      verifyCheckoutSignature('order_abc', 'pay_123', checkoutSecret, checkoutSign('pay_123', 'order_abc'))
    ).toBe(false);
  });

  it('rejects the wrong secret, a missing signature and a wrong length', () => {
    const good = checkoutSign('order_abc', 'pay_123');
    expect(verifyCheckoutSignature('order_abc', 'pay_123', 'other', good)).toBe(false);
    expect(verifyCheckoutSignature('order_abc', 'pay_123', checkoutSecret, null)).toBe(false);
    expect(verifyCheckoutSignature('order_abc', 'pay_123', checkoutSecret, good.slice(0, 10))).toBe(
      false
    );
  });
});
