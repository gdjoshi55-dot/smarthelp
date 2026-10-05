import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueQuoteToken, quoteTokenAgrees, verifyQuoteToken } from '@/lib/quoteToken';

/**
 * §7.2's `quoteToken`, asserted as a small security primitive.
 *
 * The token's whole value is that it distinguishes "the engine said this total"
 * from "the browser said this total", so these tests are written as forgery
 * attempts rather than as round trips. A round trip proves the happy path; what
 * matters is that every way of editing the string is refused, and that editing a
 * character anywhere in it — including the signature — is enough.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` comes from `vitest.config.ts`, which is also what
 * makes "no key configured" testable: the module reads it per call rather than
 * caching, so deleting it here affects only this file's remaining tests.
 */

const ITEMS = [
  { serviceId: '2f2d0b8e-6a3c-4a1e-9f5a-1c2b3d4e5f60', durationMinutes: 60, quantity: 1 },
];

describe('the quote token', () => {
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  const issue = (over: Partial<Parameters<typeof issueQuoteToken>[0]> = {}) =>
    issueQuoteToken({
      items: ITEMS,
      couponCode: null,
      bookingType: 'scheduled',
      total: 613.6,
      ...over,
    });

  it('reads back what it signed', () => {
    const token = issue()!;
    const claims = verifyQuoteToken(token);

    expect(claims).not.toBeNull();
    expect(claims!.total).toBe(613.6);
    expect(claims!.bookingType).toBe('scheduled');
    expect(claims!.couponCode).toBeNull();
    expect(claims!.items).toEqual(ITEMS);
  });

  it('expires fifteen minutes out, per §7.2, and not a second sooner', () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0);
    const claims = verifyQuoteToken(issue({ now })!, now + 899_000);

    expect(claims).not.toBeNull();
    expect(claims!.exp).toBe(Math.floor(now / 1000) + 900);
    // At the boundary it is already spent: a quote offered for exactly its TTL is
    // a quote that expires while the customer is still typing their address.
    expect(verifyQuoteToken(issue({ now })!, now + 900_000)).toBeNull();
  });

  it('refuses a total edited in the payload, because the signature covers the number', () => {
    const [body, signature] = issue()!.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    // 61.36 instead of 613.60 — the sort of edit a request body makes easy and a
    // signature is the only thing standing against.
    forged[2] = 61.36;
    const edited = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;

    expect(verifyQuoteToken(edited)).toBeNull();
  });

  it('refuses a token signed with a different key, which is what forgery looks like', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-different-key-entirely';
    const foreign = issue()!;

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    expect(verifyQuoteToken(foreign)).toBeNull();
  });

  it('refuses a truncated or padded signature instead of throwing', () => {
    const token = issue()!;
    const [body, signature] = token.split('.');

    // A length mismatch makes `timingSafeEqual` throw, and a thrown verification is
    // not an answer this function owes its caller.
    expect(verifyQuoteToken(`${body}.${signature!.slice(0, -4)}`)).toBeNull();
    expect(verifyQuoteToken(`${body}.${signature}extra`)).toBeNull();
    expect(verifyQuoteToken(`${body}.`)).toBeNull();
    expect(verifyQuoteToken(body!)).toBeNull();
    expect(verifyQuoteToken(`${body}.${signature}.${signature}`)).toBeNull();
    expect(verifyQuoteToken('not-a-token')).toBeNull();
  });

  it('is not issued at all without a signing key, and never verifies with one', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(issue()).toBeNull();

    // A token signed while a key existed must stop verifying the moment the key
    // goes, rather than being accepted unverified.
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    const token = issue()!;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(verifyQuoteToken(token)).toBeNull();
  });

  describe('agreeing with the request that presents it', () => {
    const claims = verifyQuoteToken(issue()!)!;
    const request = {
      items: ITEMS,
      couponCode: null,
      bookingType: 'scheduled' as const,
      total: 613.6,
    };

    it('agrees with the cart it was issued for', () => {
      expect(quoteTokenAgrees(claims, request)).toBe(true);
    });

    it('ignores item order, because a cart is a set', () => {
      const two = [
        ITEMS[0],
        { serviceId: '3a3c4d5e-7b4d-4b2f-8f60-2d3e4f5a6b71', durationMinutes: 30, quantity: 2 },
      ];
      const claimsTwo = verifyQuoteToken(issue({ items: two })!)!;

      expect(quoteTokenAgrees(claimsTwo, { ...request, items: [...two].reverse() })).toBe(true);
    });

    it('disagrees about a total, a coupon, a booking type, a duration and a quantity', () => {
      // Without these, a token would prove only that *a* quote existed once.
      expect(quoteTokenAgrees(claims, { ...request, total: 61.36 })).toBe(false);
      expect(quoteTokenAgrees(claims, { ...request, couponCode: 'SAVE20' })).toBe(false);
      expect(quoteTokenAgrees(claims, { ...request, bookingType: 'instant' })).toBe(false);
      expect(
        quoteTokenAgrees(claims, { ...request, items: [{ ...ITEMS[0], durationMinutes: 90 }] })
      ).toBe(false);
      expect(
        quoteTokenAgrees(claims, { ...request, items: [{ ...ITEMS[0], quantity: 2 }] })
      ).toBe(false);
      expect(
        quoteTokenAgrees(claims, {
          ...request,
          items: [...ITEMS, { ...ITEMS[0], serviceId: '4b4c5d6e-8c5e-4c3f-9061-3e4f5a6b7c82' }],
        })
      ).toBe(false);
    });

    it('is not defeated by float noise on an otherwise identical total', () => {
      // `613.6` and `613.60` are the same money. A `===` on floats would reject
      // half of every real quote.
      expect(quoteTokenAgrees(claims, { ...request, total: 613.6 + 613.6 - 613.6 })).toBe(true);
    });
  });
});