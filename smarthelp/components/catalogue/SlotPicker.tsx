'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Loader2, MapPinOff } from 'lucide-react';
import { ApiRequestError, fetchAvailability } from '@/lib/catalogueClient';
import type { AvailabilityResponse } from '@/lib/catalogueClientTypes';
import type { LocationQueryInput } from '@/lib/catalogueClient';
import type { LocationSummary } from '@/lib/catalogue';
import { durationLabel } from '@/lib/catalogue';
import { useOptionalPublicLocation } from './PublicLocationContext';

/**
 * The slot picker, the heart of §20.3.
 *
 * A date and the slots for it, fetched per day. The fetch is keyed on
 * `(service, duration, date, location)` and a stale answer is discarded, because
 * three of those four can change while a request is in flight and a slot list
 * that belongs to yesterday's duration is worse than a spinner.
 *
 * Two failures get their own copy, because they are not the same failure:
 *
 *   422, `reason: 'outside_coverage'` — we do not serve this area. The right
 *     answer is the server's sentence, not "no slots available".
 *   200 with zero slots          — we serve the area, and the professionals are
 *     full on that day. "No slots" with the reason the server gave.
 *
 * Slots that exist but are not bookable are shown greyed with their reason. A
 * person who can see that 14:00 is at capacity understands the day better than
 * one handed a shorter list with no explanation.
 */

function todayIn(timeZone: string | null): string {
  // The date the *city* is on, not the browser's, so a visitor in another
  // timezone does not start on the wrong day.
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    } catch {
      // An unknown zone falls through to the browser's own date.
    }
  }
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dayLabel(date: string, timeZone: string | null, index: number): string {
  const when = new Date(`${date}T00:00:00Z`);
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: timeZone ?? 'UTC',
    }).format(when);
  } catch {
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric' }).format(when);
  }
}

/** A fixed location has an answer when any one of the three forms is present. */
function locationIsUsable(location: LocationQueryInput): boolean {
  return (
    !!location.addressId ||
    !!location.area ||
    (location.lat != null && location.lng != null)
  );
}

export function SlotPicker({
  service,
  durationMinutes,
  onSelect,
  selected,
  location,
}: {
  /**
   * Only the id is needed to ask for slots, so only the id is required.
   *
   * Typed loosely on purpose: the catalogue passes a `ServiceSummary`, and the
   * reschedule panel passes a booking's `service_id` from an item row, which is
   * all the booking carries. Demanding the whole summary there would have meant
   * fetching a service by slug just to re-derive a field the picker never reads.
   */
  service: { id: string };
  durationMinutes: number;
  onSelect: (slot: { start: string; label: string }) => void;
  selected: { start: string; label: string } | null;
  /**
   * Overrides the session's location.
   *
   * The public catalogue asks "where are you, right now". A reschedule is not
   * that question: the job happens at the address frozen on the booking, so the
   * slots offered have to be the ones for *that* address — checking somebody's
   * current pin instead would offer a time a professional could not reach.
   */
  location?: LocationQueryInput | null;
}) {
  // The session is optional here: with a fixed location it is not consulted, and
  // a reschedule page has no provider because it has no "where are you" question
  // to ask. Without a fixed location *and* without a session there is nothing to
  // ask the server about, which is a programming error rather than a state to
  // render — so it throws rather than showing an empty week.
  const session = useOptionalPublicLocation();
  if (!session && !location) {
    throw new Error('SlotPicker needs a fixed location or a PublicLocationProvider');
  }

  const area = location ? (location.area ?? null) : (session?.area ?? null);
  const lat = location ? (location.lat ?? null) : (session?.lat ?? null);
  const lng = location ? (location.lng ?? null) : (session?.lng ?? null);
  const hasLocation = location ? locationIsUsable(location) : !!session?.hasLocation;
  const sessionTimeZone = session?.summary?.timeZone ?? null;
  const [date, setDate] = useState(() => todayIn(sessionTimeZone));
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  // The day a person is looking at, unless they have moved it themselves. Tracked
  // so the snap below cannot yank the week out from under a click.
  const chosenDay = useRef(false);

  const timeZone = data?.location.timeZone ?? sessionTimeZone;

  // The first answer says which timezone the location is on, which the initial
  // `date` could not have known: a browser in UTC looking at a booking in
  // Bengaluru starts the week on the wrong day. Once the server has said, the day
  // is corrected — unless the customer has already picked one.
  useEffect(() => {
    const serverZone = data?.location.timeZone;
    if (!serverZone || chosenDay.current) return;
    const correct = todayIn(serverZone);
    setDate((current) => (current === correct ? current : correct));
  }, [data]);

  useEffect(() => {
    if (!hasLocation) {
      setData(null);
      setError(null);
      return;
    }

    const query: LocationQueryInput = { area, lat, lng };
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    fetchAvailability({
      serviceId: service.id,
      date,
      durationMinutes,
      ...query,
    })
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (id !== requestId.current) return;
        setData(null);
        setError(
          caught instanceof ApiRequestError
            ? caught
            : new ApiRequestError('We could not load availability.', 'INTERNAL_ERROR', 0)
        );
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [service.id, durationMinutes, date, hasLocation, area, lat, lng]);

  const days = [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const value = addDays(date, offset);
    return { value, label: dayLabel(value, timeZone, offset) };
  });

  const uncovered = error?.code === 'VALIDATION_ERROR' && error.details?.reason === 'outside_coverage';

  return (
    <div>
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-gray-400" aria-hidden="true" />
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {days.map((day) => (
            <button
              key={day.value}
              type="button"
              onClick={() => {
                chosenDay.current = true;
                setDate(day.value);
              }}
              aria-pressed={date === day.value}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium ${
                date === day.value
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:border-blue-400'
              }`}
            >
              {day.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 min-h-[7rem]" aria-live="polite" aria-busy={loading}>
        {!hasLocation ? (
          <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
            Add your area or share your location to see when somebody can reach you.
          </p>
        ) : loading ? (
          <p className="flex items-center gap-2 text-sm text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking availability for {durationLabel(durationMinutes)}…
          </p>
        ) : uncovered ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            <p className="flex items-center gap-2 font-medium">
              <MapPinOff className="h-4 w-4" aria-hidden="true" />
              {error.message}
            </p>
          </div>
        ) : error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
            {error.message}
          </p>
        ) : data && data.day.slots.filter((slot) => slot.bookable).length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
            No slots for {durationLabel(durationMinutes)} on this day
            {data.serviceable.leadMinutes > 0
              ? ` — bookings need ${durationLabel(data.serviceable.leadMinutes)} notice.`
              : '.'}
            Try another day.
          </p>
        ) : data ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {data.day.slots
              .filter((slot) => slot.bookable || slot.reason !== 'lead_time')
              .map((slot) => {
                const isSelected = selected?.start === slot.start;
                return (
                  <li key={slot.start}>
                    <button
                      type="button"
                      disabled={!slot.bookable}
                      onClick={() => onSelect({ start: slot.start, label: slot.label })}
                      aria-pressed={isSelected}
                      title={slot.bookable ? undefined : reasonLabel(slot.reason)}
                      className={`w-full rounded-lg border px-2 py-2 text-sm font-medium transition ${
                        isSelected
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : slot.bookable
                            ? 'border-gray-300 bg-white text-gray-900 hover:border-blue-400'
                            : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                      }`}
                    >
                      {slot.label}
                      {slot.bookable && slot.remaining === 1 ? (
                        <span className="mt-0.5 block text-[10px] font-normal text-amber-600">
                          1 left
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function reasonLabel(reason: string | null): string {
  if (reason === 'at_capacity') return 'Fully booked at this time';
  if (reason === 'lead_time') return 'Too soon to book';
  if (reason === 'no_professional_available') return 'Nobody is free at this time';
  return 'Not available';
}
