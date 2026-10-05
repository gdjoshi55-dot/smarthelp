import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slot } from '@/lib/availability';

/**
 * `lib/bookingAvailability.ts` — the adapter that re-checks a booking's slot.
 *
 * The engine behind it is tested in `availability.test.ts`; this file is about
 * the decisions the adapter itself makes, and each of them is a decision a
 * customer would notice if it went the other way:
 *
 *   - a booking with no locality cannot be checked, and is let through rather
 *     than refused for a reason it cannot act on;
 *   - "not offered here" and "that time is gone" are different sentences;
 *   - the engine's own `reason` is what turns a 422 into something actionable;
 *   - the comparison is on the instant, because the labels are in the city's
 *     zone and this process is not.
 */

const resolveServiceability = vi.fn();
const getAvailability = vi.fn();
const getGeography = vi.fn();

vi.mock('@/lib/availabilityServer', () => ({
  resolveServiceability: (...args: unknown[]) => resolveServiceability(...(args as [])),
  getAvailability: (...args: unknown[]) => getAvailability(...(args as [])),
}));

vi.mock('@/lib/catalogueServer', () => ({
  getGeography: (...args: unknown[]) => getGeography(...(args as [])),
}));

const { assertSlotAvailable } = await import('@/lib/bookingAvailability');

const LOCALITY_ID = '11111111-1111-4111-8111-111111111111';
const CITY_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const START = '2026-12-01T10:00:00.000Z';

function slot(overrides: Partial<Slot> = {}): Slot {
  return {
    start: START,
    end: '2026-12-01T11:00:00.000Z',
    label: '10:00 AM',
    durationMinutes: 60,
    remaining: 2,
    bookable: true,
    reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  resolveServiceability.mockReset();
  getAvailability.mockReset();
  getGeography.mockReset();

  getGeography.mockResolvedValue({
    cities: [{ id: CITY_ID, name: 'Bengaluru', state: 'Karnataka', time_zone: 'Asia/Kolkata' }],
    localities: [{ id: LOCALITY_ID, city_id: CITY_ID, name: 'Indiranagar', lat: 12.97, lng: 77.64 }],
  });
  resolveServiceability.mockResolvedValue({
    ok: true,
    localityId: LOCALITY_ID,
    localityName: 'Indiranagar',
    cityName: 'Bengaluru',
    timeZone: 'Asia/Kolkata',
    leadMinutes: 60,
    slotCapacity: 3,
    reason: null,
    matchedBy: 'area',
  });
  getAvailability.mockResolvedValue({ day: { slots: [slot()] } });
});

describe('assertSlotAvailable', () => {
  it('passes a slot the engine still offers', async () => {
    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).resolves.toBeUndefined();
  });

  it('lets a booking with no locality through instead of refusing it', async () => {
    await assertSlotAvailable({
      serviceId: SERVICE_ID,
      localityId: null,
      startAt: START,
      durationMinutes: 60,
    });

    // The address carries `location_precision`, and an unserviceable pin is Phase
    // 5's rule. Refusing here would 422 a booking over a locality the customer
    // never chose and cannot see.
    expect(resolveServiceability).not.toHaveBeenCalled();
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it('refuses a service that is not offered at the address at all', async () => {
    resolveServiceability.mockResolvedValue({
      ok: false,
      localityId: LOCALITY_ID,
      localityName: 'Indiranagar',
      cityName: 'Bengaluru',
      timeZone: 'Asia/Kolkata',
      leadMinutes: 0,
      slotCapacity: 0,
      reason: 'service_not_offered',
      matchedBy: 'area',
    });

    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 422 });
  });

  it('refuses a slot that is gone, with the requested instant attached', async () => {
    getAvailability.mockResolvedValue({ day: { slots: [] } });

    // Not the same answer as "not offered here": one of these says come back
    // tomorrow, the other says we cannot reach you at all.
    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).rejects.toMatchObject({ code: 'NO_SLOT_AVAILABLE', status: 422 });
  });

  it('passes the engine reason through so the copy can be specific', async () => {
    getAvailability.mockResolvedValue({
      day: { slots: [slot({ bookable: false, remaining: 0, reason: 'lead_time' })] },
    });

    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).rejects.toMatchObject({
      code: 'NO_SLOT_AVAILABLE',
      details: { reason: 'lead_time' },
    });
  });

  it('matches on the instant, not on the label', async () => {
    // The engine returns wall-clock labels in the city's zone, and a row can
    // carry an offset rather than a `Z`. Comparing strings built in this
    // process's zone compares two representations of the moment and finds
    // nothing, so the same instant spelled two ways has to still match.
    getAvailability.mockResolvedValue({
      day: { slots: [slot({ start: '2026-12-01T15:30:00+05:30', label: '10:00 AM' })] },
    });

    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).resolves.toBeUndefined();
  });

  it('refuses an instant that merely looks like the one asked for', async () => {
    // Half an hour off is a different slot, and treating it as a match would book
    // somebody in for the wrong time.
    getAvailability.mockResolvedValue({
      day: { slots: [slot({ start: '2026-12-01T10:30:00.000Z' })] },
    });

    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).rejects.toMatchObject({ code: 'NO_SLOT_AVAILABLE' });
  });

  it('asks the engine for the booking\'s own duration', async () => {
    await assertSlotAvailable({
      serviceId: SERVICE_ID,
      localityId: LOCALITY_ID,
      startAt: START,
      durationMinutes: 90,
    });

    // A 90-minute booking checked as 60 would pass a slot the professional cannot
    // actually cover, which is the whole reason this re-check exists.
    expect(getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: SERVICE_ID, duration: 90, date: '2026-12-01' })
    );
  });

  it('lets a booking through when the locality has since been deactivated', async () => {
    getGeography.mockResolvedValue({ cities: [], localities: [] });

    await expect(
      assertSlotAvailable({
        serviceId: SERVICE_ID,
        localityId: LOCALITY_ID,
        startAt: START,
        durationMinutes: 60,
      })
    ).resolves.toBeUndefined();

    // The locality is gone from the geography the address points at, so there is
    // no day to check against. Refusing would fail a booking over a catalogue
    // row, which is not the customer's decision to fix.
    expect(getAvailability).not.toHaveBeenCalled();
  });
});