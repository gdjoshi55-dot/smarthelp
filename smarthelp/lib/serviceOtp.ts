import { createHash } from 'node:crypto';
import { PLATFORM_DEFAULTS } from './constants';
import { generateOtpCode } from './otp';

/**
 * The service OTP — the code the customer reads out and the professional types
 * to start a job (§22.3, §20.6).
 *
 * ## Why the code is hash-only
 *
 * Only the SHA-256 digest of the code is ever stored (`bookings.otp_hash`); the
 * plaintext exists for exactly one moment, in the customer's
 * `POST /api/bookings/:id/otp/regenerate` response. The database can therefore
 * never re-derive the code — which is the point, and which is why the
 * professional's arrive route never mints one: the professional has to prove
 * *the customer knows the code*, so the professional must never be handed it
 * (D3).
 *
 * ## Why every clock is a parameter
 *
 * `otpIsExpired` and `otpIsLocked` take `serverNow` rather than calling
 * `Date.now()` themselves. The timer the customer sees is `ends_at − serverNow`
 * from the server, never from the device (§22.3, Interaction Contract 2), and a
 * helper that reads the wall clock internally cannot be tested at the boundary
 * where expiry actually turns.
 *
 * Server-only: it reaches `node:crypto`. Client components that need the policy
 * (how many slots to draw) import `lib/constants.ts` instead.
 */

/**
 * A fresh service code, `serviceOtpLength` digits, from the platform CSPRNG.
 *
 * Delegates to `lib/otp.ts`'s generator so both OTPs draw from one uniform
 * source — a second generator is a second thing to get the modulo bias wrong
 * in.
 */
export function generateServiceOtp(): string {
  return generateOtpCode(PLATFORM_DEFAULTS.serviceOtpLength);
}

/**
 * The stored form: an unsalted SHA-256 hex digest.
 *
 * `bookings.otp_hash` has no salt column, and the service code is short-lived
 * (ten minutes) and single-use, so the stored digest is not a long-lived secret
 * the way a password is. `verify_service_otp` (0029) re-derives this same
 * digest in SQL — `encode(digest(p_code, 'sha256'), 'hex')` — so the two halves
 * must agree on the algorithm exactly.
 */
export function hashServiceOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * The code's safe log form.
 *
 * A code is a secret, and a log line is forever: `redactOtpForLog('1234')` is
 * length-preserving but carries none of the digits, so a log that records "a
 * four-digit code was issued" cannot be replayed as the code itself. Use this
 * anywhere a log site would otherwise interpolate a `code`.
 */
export function redactOtpForLog(code: string): string {
  return code.length > 0 ? '•'.repeat(code.length) : '[empty]';
}

/** An instant accepted as a `Date`, an ISO string, or epoch milliseconds. */
type Instant = Date | string | number | null | undefined;

function instantMs(value: Instant): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether a code has expired. A missing expiry counts as expired: there is no
 * code to accept, and treating "no row" as "valid forever" is the wrong default
 * for a secret.
 */
export function otpIsExpired(expiresAt: Instant, serverNow: Instant): boolean {
  const expiry = instantMs(expiresAt);
  if (expiry === null) return true;
  const now = instantMs(serverNow);
  if (now === null) return true;
  return now >= expiry;
}

/**
 * Whether the code is in its lockout window. The lockout is a duration, not a
 * boolean, so it is stored as `otp_locked_until`; the code is locked while
 * `serverNow` is still before that instant.
 */
export function otpIsLocked(lockedUntil: Instant, serverNow: Instant): boolean {
  const until = instantMs(lockedUntil);
  if (until === null) return false;
  const now = instantMs(serverNow);
  if (now === null) return false;
  return now < until;
}

/**
 * Whether the attempt cap has been reached. Enforced in `verify_service_otp`
 * (the database is the authority); this is the pure predicate the route and its
 * tests share.
 */
export function otpAttemptsExhausted(
  attempts: number,
  maxAttempts = PLATFORM_DEFAULTS.otpMaxAttempts
): boolean {
  return attempts >= maxAttempts;
}
