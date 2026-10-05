/**
 * Availability re-checked on the booking routes (§9.1 applied to Phase 2).
 *
 * The engine itself is Phase 1's pure `lib/availability.ts`; this is the thin
 * server adapter that turns a booking's own facts — service, address, start
 * time, duration — into the arguments it needs.
 *
 * Why re-check at all, given nothing reserves capacity until Phase 5 assigns a
 * professional: because the day it does, this is the difference between a
 * promise and a booking. Today it almost never fails, and it is cheap.
 */

import { ApiHttpError } from './api';
import { getAvailability, resolveServiceability } from './availabilityServer';
import { getGeography } from './catalogueServer';
import type { Serviceability } from './catalogue';

export interface BookingSlotCheck {
  serviceId: string;
  localityId: string | null;
  /** ISO instant the booking starts at. */
  startAt: string;
  durationMinutes: number;
}

/**
 * Confirm the requested window is one the engine would actually offer.
 *
 * A failure here is `NO_SLOT_AVAILABLE` with the engine's own `reason`, which is
 * the difference between "10:30 is taken" and "that day is not offered here".
 * A booking with no locality cannot be checked, and is allowed through: the
 * address already carries `location_precision`, and Phase 5 is where an
 * unserviceable pin gets refused.
 */
export async function assertSlotAvailable(check: BookingSlotCheck): Promise<void> {
  if (check.localityId == null) return;

  const geography = await getGeography();
  const locality = geography.localities.find((l) => l.id === check.localityId);
  if (!locality) return;

  const city = geography.cities.find((c) => c.id === locality.city_id);

  const serviceability: Serviceability = await resolveServiceability(check.serviceId, {
    id: locality.id,
    name: locality.name,
    cityName: city?.name ?? null,
    timeZone: city?.time_zone ?? 'Asia/Kolkata',
  });

  // Not offered here at all is a different answer from "that slot is gone", and
  // §9.1 says so: an empty slot list would read as a busy calendar.
  if (!serviceability.ok) {
    throw new ApiHttpError(
      'SERVICE_UNAVAILABLE',
      'This service is not offered at that address yet.',
      422,
      { reason: serviceability.reason }
    );
  }

  const date = new Date(check.startAt).toISOString().slice(0, 10);

  const result = await getAvailability({
    serviceId: check.serviceId,
    serviceable: serviceability,
    date,
    duration: check.durationMinutes,
  });

  // The engine returns wall-clock labels in the city's zone, so the comparison
  // is on the instant, not on a string built in this process's zone.
  const wanted = new Date(check.startAt).getTime();
  const match = result.day.slots.find((slot) => new Date(slot.start).getTime() === wanted);

  if (!match) {
    throw new ApiHttpError('NO_SLOT_AVAILABLE', 'That time is no longer available. Pick another.', 422, {
      requestedStart: check.startAt,
    });
  }

  if (!match.bookable) {
    // The engine's own `reason` is what makes this actionable: `lead_time` means
    // they picked too soon, `at_capacity` means the day is full, and
    // `no_professional_available` is Phase 5's problem to solve.
    throw new ApiHttpError('NO_SLOT_AVAILABLE', messageForReason(match.reason), 422, {
      reason: match.reason,
      requestedStart: check.startAt,
    });
  }
}

/** Turn the engine's reason into a sentence a person can act on. */
function messageForReason(reason: string | null): string {
  switch (reason) {
    case 'lead_time':
      return 'That is too soon to book. Please pick a later time.';
    case 'at_capacity':
      return 'That slot is fully booked. Please pick another time.';
    case 'no_professional_available':
      return 'No professional is free at that time. Please pick another.';
    default:
      return 'That time is no longer available. Pick another.';
  }
}