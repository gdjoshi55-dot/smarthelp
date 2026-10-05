import { describe, expect, it } from 'vitest';
import {
  OTP_LENGTH,
  OTP_LOCKOUT_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_TTL_MINUTES,
} from '@/lib/constants';
import { deliverOtp, generateOtpCode } from '@/lib/otp';

describe('OTP policy constants', () => {
  it('matches §26.1', () => {
    expect(OTP_TTL_MINUTES).toBe(10);
    expect(OTP_MAX_ATTEMPTS).toBe(3);
    expect(OTP_LOCKOUT_MINUTES).toBe(15);
    expect(OTP_RESEND_SECONDS).toBe(60);
    expect(OTP_LENGTH).toBe(6);
  });
});

describe('generateOtpCode', () => {
  it('produces exactly the configured number of digits', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('uses every digit, so a broken RNG is visible', () => {
    // 200 six-digit codes is 1200 draws. If any digit never appears, the
    // generator is not uniform over 0-9 and the test should say so.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const digit of generateOtpCode()) seen.add(digit);
    }
    expect([...seen].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('does not repeat itself', () => {
    // Not "200 draws are all distinct": by the birthday problem that holds only
    // ~98% of the time for a uniform generator over 10^6 codes, so asserting
    // exact uniqueness fails on chance roughly one run in fifty — and it was
    // observed doing so. A collision is not a defect; the generator being
    // degenerate is.
    //
    // A uniform generator yields ~199.98 distinct out of 200 draws, so anything
    // below 180 means the output space is far smaller than 10^6 (a short digit
    // string, a constant, a clamped counter) rather than merely unlucky.
    const codes = new Set(Array.from({ length: 200 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(180);
  });

  it('honours an explicit length', () => {
    expect(generateOtpCode(4)).toMatch(/^\d{4}$/);
    expect(generateOtpCode(8)).toMatch(/^\d{8}$/);
  });
});

describe('deliverOtp with no provider configured', () => {
  it('falls back to the console for SMS and says the code was not delivered', async () => {
    const result = await deliverOtp('+919876543210', 'phone', '123456', 'login');
    expect(result.provider).toBe('console');
    expect(result.delivered).toBe(false);
  });

  it('falls back to the console for email as well', async () => {
    const result = await deliverOtp('a@b.com', 'email', '123456', 'staff_login');
    expect(result.provider).toBe('console');
    expect(result.delivered).toBe(false);
  });
});
