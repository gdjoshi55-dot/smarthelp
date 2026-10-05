import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAvailability, fetchEstimate } from '@/lib/catalogueClient';
import { parseAvailabilityQuery } from '@/lib/validation';

/**
 * The client/server seam for the availability query.
 *
 * These two halves were written separately and drifted: the client sent
 * `durationMinutes` while `parseAvailabilityQuery` read `duration`, so every
 * duration other than the service default was silently ignored and the duration
 * picker appeared to do nothing. Nothing caught it, because each side was tested
 * against its own idea of the parameter rather than against the other.
 *
 * So these tests do the one thing that actually pins the contract: build the URL
 * the client would really send, then hand it to the server's real parser and
 * assert the value arrives. A rename on either side now fails here.
 */

const SERVICE_ID = '00000000-0000-4000-8000-00000000abcd';
const AREA = 'HSR Layout';
const TODAY = new Date('2026-03-04T00:00:00Z');

/**
 * The client sends a root-relative path, so it needs a base to become a URL.
 * The route then parses exactly this object, which is the seam under test.
 */
const BASE = 'http://localhost:3000';
const urlOf = (raw: string) => new URL(raw, BASE);

/** Captures the URL `request()` was called with, and answers the envelope. */
function stubFetch() {
  const seen: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    seen.push(url);
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { seen, spy };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAvailability', () => {
  it('sends a duration the server parser actually reads', async () => {
    const { seen } = stubFetch();

    await fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA, durationMinutes: 120 });

    const parsed = parseAvailabilityQuery(urlOf(seen[0]), TODAY);
    expect(parsed.duration).toBe(120);
  });

  it('does not send a duration it means the server to ignore', async () => {
    const { seen } = stubFetch();

    await fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA, durationMinutes: 90 });

    // Belt and braces: the wire name is `duration`. If someone re-adds the
    // plural, the parse above still passes but this does not.
    expect(urlOf(seen[0]).searchParams.get('durationMinutes')).toBeNull();
    expect(urlOf(seen[0]).searchParams.get('duration')).toBe('90');
  });

  it('carries the location through to the parser', async () => {
    const { seen } = stubFetch();

    await fetchAvailability({
      serviceId: SERVICE_ID,
      date: '2026-03-05',
      durationMinutes: 60,
      lat: 12.9116,
      lng: 77.6389,
    });

    const parsed = parseAvailabilityQuery(urlOf(seen[0]), TODAY);
    expect(parsed.location.lat).toBeCloseTo(12.9116);
    expect(parsed.location.lng).toBeCloseTo(77.6389);
    expect(parsed.location.area).toBeUndefined();
  });

  it('carries a typed area through to the parser', async () => {
    const { seen } = stubFetch();

    await fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA, durationMinutes: 45 });

    expect(parseAvailabilityQuery(urlOf(seen[0]), TODAY).location.area).toBe(AREA);
  });

  it('omits the parameter entirely when no duration was chosen', async () => {
    const { seen } = stubFetch();

    await fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA });

    expect(urlOf(seen[0]).searchParams.has('duration')).toBe(false);
    expect(parseAvailabilityQuery(urlOf(seen[0]), TODAY).duration).toBeUndefined();
  });

  it('sends the date it was given', async () => {
    const { seen } = stubFetch();

    await fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA });

    expect(parseAvailabilityQuery(urlOf(seen[0]), TODAY).date).toBe('2026-03-05');
  });
});

describe('fetchEstimate', () => {
  it('sends a duration the server parser actually reads', async () => {
    const { seen } = stubFetch();

    await fetchEstimate({ serviceId: SERVICE_ID, area: AREA, durationMinutes: 180 });

    const url = urlOf(seen[0]);
    expect(url.searchParams.get('durationMinutes')).toBeNull();
    expect(url.searchParams.get('duration')).toBe('180');
  });
});

describe('the error path', () => {
  it('turns a network failure into a retryable message, not an API error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(
      fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA })
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('carries the machine-readable code through for the availability screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'No slots for 3 h on that day',
          code: 'NO_SLOT_AVAILABLE',
          details: { reason: 'outside_coverage' },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(
      fetchAvailability({ serviceId: SERVICE_ID, date: '2026-03-05', area: AREA, durationMinutes: 180 })
    ).rejects.toMatchObject({ code: 'NO_SLOT_AVAILABLE', status: 422 });
  });
});
