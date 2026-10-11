import { describe, expect, it } from 'vitest';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import {
  generateServiceOtp,
  hashServiceOtp,
  otpAttemptsExhausted,
  otpIsExpired,
  otpIsLocked,
  redactOtpForLog,
} from '@/lib/serviceOtp';

/**
 * The service OTP helpers, the analogue of `test/otp.test.ts`.
 *
 * Pure functions only: no database, no `Date.now()` read internally. Everything
 * that turns on a clock takes `serverNow` as a parameter, which is why the
 * boundary cases below can be asserted exactly rather than approached.
 */

describe('generateServiceOtp', () => {
  it('produces exactly `serviceOtpLength` digits', () => {
    const n = PLATFORM_DEFAULTS.serviceOtpLength;
    const shape = new RegExp(`^\\d{${n}}$`);
    for (let i = 0; i < 200; i += 1) {
      expect(generateServiceOtp()).toMatch(shape);
    }
  });

  it('uses every digit, so a broken RNG is visible', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const digit of generateServiceOtp()) seen.add(digit);
    }
    expect([...seen].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('does not repeat itself, so the output space is not a constant', () => {
    // Four digits is 10,000 codes; by the birthday problem 200 draws collide
    // only rarely, and anything below 180 distinct means a degenerate space.
    const codes = new Set(Array.from({ length: 200 }, () => generateServiceOtp()));
    expect(codes.size).toBeGreaterThan(180);
  });
});

describe('hashServiceOtp', () => {
  it('is the unsalted SHA-256 hex the verify SQL re-derives', () => {
    // This vector matters: `verify_service_otp` (0029) compares
    // `encode(digest(p_code, 'sha256'), 'hex')`, so the JS half and the SQL half
    // must agree on algorithm, encoding and input exactly. If this test ever
    // fails, the two halves have drifted.
    expect(hashServiceOtp('1234')).toBe(
      '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'
    );
  });

  it('is deterministic and differs per code', () => {
    expect(hashServiceOtp('0000')).toBe(hashServiceOtp('0000'));
    expect(hashServiceOtp('0000')).not.toBe(hashServiceOtp('0001'));
  });

  it('always produces 64 lowercase hex characters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(hashServiceOtp(generateServiceOtp())).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('redactOtpForLog', () => {
  it('never contains the code it redacts', () => {
    for (const code of ['1234', '0000', '9876', '4821']) {
      const safe = redactOtpForLog(code);
      expect(safe).not.toContain(code);
    }
  });

  it('preserves length, so a log still says how long the secret was', () => {
    expect(redactOtpForLog('1234')).toHaveLength(4);
    expect(redactOtpForLog('[empty]')).toBeDefined();
    expect(redactOtpForLog('')).toBe('[empty]');
  });
});

describe('otpIsExpired', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');

  it('is false strictly before expiry', () => {
    expect(otpIsExpired(new Date('2026-10-08T10:00:01.000Z'), now)).toBe(false);
    expect(otpIsExpired('2026-10-08T10:00:01.000Z', now)).toBe(false);
  });

  it('is true at and after expiry', () => {
    expect(otpIsExpired(new Date('2026-10-08T10:00:00.000Z'), now)).toBe(true);
    expect(otpIsExpired(new Date('2026-10-08T09:59:59.000Z'), now)).toBe(true);
  });

  it('treats a missing expiry as expired, never as valid forever', () => {
    expect(otpIsExpired(null, now)).toBe(true);
    expect(otpIsExpired(undefined, now)).toBe(true);
  });
});

describe('otpIsLocked', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');

  it('is true while the lockout window is open', () => {
    expect(otpIsLocked(new Date('2026-10-08T10:00:01.000Z'), now)).toBe(true);
  });

  it('is false once the lockout has passed, or was never set', () => {
    expect(otpIsLocked(new Date('2026-10-08T09:59:59.000Z'), now)).toBe(false);
    expect(otpIsLocked(new Date('2026-10-08T10:00:00.000Z'), now)).toBe(false);
    expect(otpIsLocked(null, now)).toBe(false);
  });
});

describe('otpAttemptsExhausted', () => {
  it('turns true at the configured cap', () => {
    const cap = PLATFORM_DEFAULTS.otpMaxAttempts;
    expect(otpAttemptsExhausted(cap - 1)).toBe(false);
    expect(otpAttemptsExhausted(cap)).toBe(true);
    expect(otpAttemptsExhausted(cap + 1)).toBe(true);
  });

  it('honours an explicit cap', () => {
    expect(otpAttemptsExhausted(2, 5)).toBe(false);
    expect(otpAttemptsExhausted(5, 5)).toBe(true);
  });
});
