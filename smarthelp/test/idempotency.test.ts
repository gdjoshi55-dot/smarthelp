import { describe, expect, it } from 'vitest';
import { canonicalize, hashPayload, readIdempotencyKey } from '@/lib/idempotency';

/**
 * The ledger itself is tested against a live database in
 * `test/db.booking.test.ts` — that is where `claim_idempotency_key` and its
 * three other outcomes are exercised for real. What is here is the part that
 * decides *what* gets hashed, because that decision is not in the database: a
 * canonicaliser that treats two identical requests as different turns every
 * double tap into a 409, and one that treats two different requests as the
 * same silently replays the wrong booking.
 */

function header(key: string | null): Request {
  return new Request('https://smarthelp.test/api/bookings', {
    method: 'POST',
    headers: key === null ? {} : { 'idempotency-key': key },
  });
}

describe('canonicalize', () => {
  it('is insensitive to key order at every depth', () => {
    const a = canonicalize({ b: 2, a: 1, nested: { z: 1, y: [{ q: 1, p: 2 }] } });
    const b = canonicalize({ a: 1, nested: { y: [{ p: 2, q: 1 }], z: 1 }, b: 2 });
    expect(a).toBe(b);
  });

  it('drops undefined members rather than stringifying them', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('keeps array order, because order is meaning in a lines array', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('tells apart payloads that differ only in a value', () => {
    expect(hashPayload({ durationMinutes: 60 })).not.toBe(hashPayload({ durationMinutes: 90 }));
    expect(hashPayload({ durationMinutes: 60 })).not.toBe(hashPayload({}));
  });
});

describe('hashPayload', () => {
  it('is a stable sha256, so the same request hashes the same on every retry', () => {
    const value = { addressId: 'a', lines: [{ serviceId: 's', durationMinutes: 60 }] };
    expect(hashPayload(value)).toBe(hashPayload(value));
    expect(hashPayload(value)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not change because the client reformatted its JSON', () => {
    const parsed = { addressId: 'a', durationMinutes: 60, couponCode: null };
    expect(hashPayload(parsed)).toBe(hashPayload({ ...parsed }));
  });
});

describe('readIdempotencyKey', () => {
  it('returns null when the header is absent or blank', () => {
    expect(readIdempotencyKey(header(null))).toBeNull();
    expect(readIdempotencyKey(header('   '))).toBeNull();
  });

  it('accepts a uuid, trims, and keeps the case a client sent', () => {
    const key = '550e8400-e29b-41d4-a716-446655440000';
    expect(readIdempotencyKey(header(key))).toBe(key);
    expect(readIdempotencyKey(header(`  ${key}  `))).toBe(key);
    expect(readIdempotencyKey(header('AbC.def-1234:5678'))).toBe('AbC.def-1234:5678');
  });

  it('refuses a key too short to be unique, or unusable as a ledger key', () => {
    // A short key is refused rather than silently extended: two clients that
    // both send "1" would share a ledger row and one would be told its booking
    // was a replay of a stranger's.
    for (const bad of ['1', 'short', 'has space in it', 'x'.repeat(129), 'semi;colon']) {
      expect(() => readIdempotencyKey(header(bad)), bad).toThrow();
    }
  });

  it('reports a bad key as a validation failure, not a crash', () => {
    try {
      readIdempotencyKey(header('nope'));
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.name).toBe('ApiHttpError');
      expect(e.code).toBe('VALIDATION_ERROR');
      expect(e.status).toBe(400);
      expect(e.details.fields.idempotencyKey).toBeTruthy();
    }
  });
});