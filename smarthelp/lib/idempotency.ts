import { createHash } from 'node:crypto';
import type { NextResponse } from 'next/server';
import { ApiHttpError, err } from './api';
import { createServerClient } from './supabaseServer';

/**
 * Idempotency for the mutating booking routes (§28.2).
 *
 * The ledger and its two SQL functions already exist — `idempotency_keys` from
 * 0024 — and until Phase 2 nothing called them, so `IDEMPOTENCY_CONFLICT` was
 * unreachable. This is the caller.
 *
 * ## Why a booking create needs it at all
 *
 * A customer taps "Pay" on a slow connection. The request is created and paid
 * for; the response is lost. They tap again. Without this, that is two bookings
 * and one professional booked twice, and the second one is discovered by the
 * customer rather than by us. With it, the second tap is told the first one
 * already happened and is handed its result.
 *
 * ## The four outcomes, kept distinct
 *
 * The catalogue has one `IDEMPOTENCY_CONFLICT` code for two genuinely different
 * situations, so the distinction lives in `details.reason`:
 *
 *   claimed   — the key was free. Run the operation, then store what it
 *               actually returned, so a replay is byte-identical.
 *   replay    — the same key, the same body, already completed. Return the
 *               stored status and body with `Idempotent-Replay: true`.
 *   in_flight — the same key, the same body, still running. This is a race, not
 *               a disagreement: 409 with `Retry-After: 2`.
 *   conflict  — the same key with a *different* body. The client changed its
 *               mind under a key it had already spent, and there is no honest
 *               way to answer that.
 *
 * ## What the hash is over
 *
 * The body **after** validation, canonically serialised. That matters in both
 * directions: hashing the raw bytes would let a whitespace change spend a
 * customer's key, and hashing a subset would let two payloads that differ in a
 * real field look like the same request.
 */

const KEY_MIN = 16;
const KEY_MAX = 128;
const KEY_RE = /^[A-Za-z0-9._:-]+$/;

export interface IdempotencyInput<T> {
  /** The `Idempotency-Key` header, or null when the route does not demand one. */
  key: string | null;
  /** Stable per endpoint, e.g. `'bookings.create'`. Part of the ledger's key. */
  operation: string;
  /** The profile id the ledger row belongs to. */
  actorProfileId: string;
  /**
   * The validated request body. Canonicalised and hashed, so it must be the
   * parsed-and-checked value rather than the raw request text.
   */
  payload: unknown;
  /** Refuse a request with no key. True for create and reschedule. */
  required?: boolean;
  /** The work. Runs only on a fresh claim. */
  run: () => Promise<{ status: number; body: T }>;
}

export type IdempotencyOutcome<T> =
  /** The key was claimed and `run` produced this. */
  | { kind: 'executed'; status: number; body: T; headers?: HeadersInit }
  /** A completed duplicate. `body` is the stored one, not a fresh computation. */
  | { kind: 'replay'; status: number; body: unknown; headers: HeadersInit }
  /** Nothing to do but return `response`. */
  | { kind: 'rejected'; response: NextResponse };

/**
 * Stable JSON: object keys sorted at every depth, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the same request and not a conflict.
 *
 * `undefined` members are dropped rather than stringified, matching what
 * `JSON.stringify` would do to them on the wire anyway.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/** sha256 of the canonical form, hex. What `idempotency_keys.request_hash` holds. */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/**
 * Reads and shape-checks the header.
 *
 * 16 characters is the UUID a browser generates and the shortest thing that is
 * unlikely to collide; the cap keeps the ledger from being used as storage.
 */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get('idempotency-key');
  if (raw === null || raw.trim() === '') return null;
  const key = raw.trim();
  if (key.length < KEY_MIN || key.length > KEY_MAX || !KEY_RE.test(key)) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      'The Idempotency-Key header must be 16–128 characters of letters, digits, dot, colon, dash or underscore.',
      400,
      { fields: { idempotencyKey: 'Unusable key' } }
    );
  }
  return key;
}

export async function withIdempotency<T>(input: IdempotencyInput<T>): Promise<IdempotencyOutcome<T>> {
  const key = input.key;

  if (!key) {
    if (input.required) {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'Send an Idempotency-Key header so a retried request cannot create two bookings.',
        400,
        { fields: { idempotencyKey: 'Required' } }
      );
    }
    const out = await input.run();
    return { kind: 'executed', ...out };
  }

  const supabase = createServerClient();
  const requestHash = hashPayload(input.payload);

  const { data, error } = await supabase.rpc('claim_idempotency_key', {
    p_key: key,
    p_operation: input.operation,
    p_actor_profile_id: input.actorProfileId,
    p_request_hash: requestHash,
  });

  if (error) throw error;
  const claim = Array.isArray(data) ? data[0] : data;

  switch (claim?.outcome) {
    case 'replay':
      return {
        kind: 'replay',
        status: claim.stored_status ?? 200,
        body: claim.stored_body,
        headers: { 'Idempotent-Replay': 'true' },
      };

    case 'in_flight':
      // A race, not a disagreement. `Retry-After` says so in a way a client can
      // act on without parsing the body.
      return {
        kind: 'rejected',
        response: err(
          'IDEMPOTENCY_CONFLICT',
          'That request is already being processed. Wait a moment and try again.',
          409,
          { reason: 'in_flight' }
        ),
      };

    case 'conflict':
      return {
        kind: 'rejected',
        response: err(
          'IDEMPOTENCY_CONFLICT',
          'That Idempotency-Key was already used for a different request. Generate a new key.',
          409,
          { reason: 'conflict' }
        ),
      };

    default: {
      const out = await input.run();

      // Store what was *actually* returned, not what was intended. A replay
      // that re-derives its body would be a second computation, and the whole
      // point of the ledger is that a retry gets the first answer.
      const { error: completeError } = await supabase.rpc('complete_idempotency_key', {
        p_key: key,
        p_operation: input.operation,
        p_actor_profile_id: input.actorProfileId,
        p_status: out.status,
        p_body: (out.body ?? null) as object | null,
      });

      // Not fatal. The booking exists and the key is claimed; the worst case is
      // that a later retry is told `in_flight` rather than replayed, which is a
      // message rather than a duplicate.
      if (completeError) {
        console.error('idempotency: could not store the response:', completeError.message);
      }

      return { kind: 'executed', ...out };
    }
  }
}