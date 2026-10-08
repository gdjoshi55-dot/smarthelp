import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signature verification — a pure function, and the reason it is one.
 *
 * ## The specification is wrong about the algorithm, and this file is not
 *
 * §12.1 says *"verify HMAC-SHA512 over RAW body"*. Razorpay's own documentation
 * defines `X-Razorpay-Signature` as *"HMAC with SHA256 algorithm; with your
 * webhook secret set as the key and the webhook request body as the message"*
 * (<https://razorpay.com/docs/webhooks/validate-test>), and the sibling SmartPOS
 * project independently got it right: `app/api/webhooks/razorpay/route.ts:28`
 * calls `.createHmac('sha256', webhookSecret)`.
 *
 * This is not a quibble. Implementing SHA-512 would produce a verifier that
 * passes every synthetic test in `test/razorpaySignature.test.ts` — because
 * those vectors are computed by the same function they check — and **fails
 * every real delivery**. The exit criterion "the webhook is the sole authority"
 * would then be false in production while the suite stayed green. CONTEXT
 * decision 1 locks the *shape* (pure function, synthetic vectors); it does not
 * lock the algorithm, and correcting it contradicts no locked decision.
 *
 * The same mistake in miniature is conflating the two secrets this phase uses.
 * They are different keys over different messages, and both live here so both
 * are tested in one file:
 *
 * | | Key | Message |
 * |---|---|---|
 * | Webhook (`X-Razorpay-Signature`) | `RAZORPAY_WEBHOOK_SECRET` | the raw body |
 * | Verify route (`razorpay_signature`) | `RAZORPAY_KEY_SECRET` | `order_id + '\|' + payment_id` |
 *
 * <https://razorpay.com/docs/developer-tools/integrations/standard-checkout>
 *
 * ## Why there is no HTTP frame, no Supabase client and no `process.env` here
 *
 * A verifier that reads its own secret cannot be pointed at a synthetic one, so
 * the tests would have to *be* integration tests — and CONTEXT decision 1 asks
 * for vectors computed in the test. Keeping the environment out is what makes
 * `vi.stubEnv` unnecessary here and the function trivially provable.
 *
 * ## Why the length check comes before `timingSafeEqual`
 *
 * `timingSafeEqual` raises `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when the
 * buffers differ in length. A wrong-length signature is an ordinary bad
 * signature, and letting it throw would turn a 400 into a 500 from a route that
 * handles unauthenticated internet traffic. So: length first, then compare.
 */

/** A SHA-256 digest as lowercase hex. */
const SHA256_HEX_LENGTH = 64;

/**
 * Verify `X-Razorpay-Signature` over the exact bytes that arrived.
 *
 * `rawBody` must be the string (or Buffer) `await req.text()` returned, before
 * any parse — a `JSON.stringify` round trip changes spacing and key order, and
 * the signature covers what the gateway sent rather than what it meant.
 *
 * Returns `false` for every refusal; it does not throw, for the reason above.
 */
export function verifyRazorpaySignature(
  rawBody: string | Buffer,
  secret: string,
  signature: string | null | undefined
): boolean {
  if (typeof signature !== 'string' || signature.length !== SHA256_HEX_LENGTH) return false;
  // Buffer.from(hex, 'hex') silently stops at the first non-hex character, so a
  // 64-character string of junk would decode to something short and be caught
  // by timingSafeEqual as a length mismatch — a `false` for the wrong reason.
  // The explicit check keeps the reason honest.
  if (!/^[0-9a-fA-F]+$/.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'hex');
  return timingSafeEqual(actual, expected);
}

/**
 * Verify `razorpay_signature` from the Checkout handler, which signs
 * `order_id + '|' + payment_id` with the *key* secret rather than the webhook
 * secret. Exported beside the webhook verifier so that both algorithms live in
 * one testable file and neither is copy-pasted into a route.
 */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  secret: string,
  signature: string | null | undefined
): boolean {
  return verifyRazorpaySignature(`${orderId}|${paymentId}`, secret, signature);
}

/**
 * Whether `RAZORPAY_WEBHOOK_SECRET` is a secret the route should verify with.
 *
 * The runtime guard CONTEXT decision 1 asks for. Without it there are two bad
 * outcomes, both silent: an unset secret makes every delivery fail a
 * `timingSafeEqual` the caller never sees the reason for, and a placeholder
 * left over from `.env.example` makes every delivery fail *consistently* while
 * looking configured. Failing closed with a sentence beats either — which is
 * why the webhook route answers `SERVICE_UNAVAILABLE` when this is false rather
 * than proceeding to verify against nothing.
 *
 * The `REPLACE` alternative is there because `.env.example` files are
 * routinely copied and half-edited, and `REPLACE_WITH_YOUR_WEBHOOK_SECRET` is
 * a perfectly valid 34-character string to an HMAC.
 */
export function isUsableWebhookSecret(secret: string | undefined): secret is string {
  if (typeof secret !== 'string') return false;
  const trimmed = secret.trim();
  if (trimmed.length === 0) return false;
  if (/placeholder|replace/i.test(trimmed)) return false;
  return true;
}
