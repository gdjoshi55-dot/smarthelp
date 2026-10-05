'use client';

import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { SlotPicker } from './SlotPicker';
import { formatDateTime } from './bookingFormat';
import type { LocationQueryInput } from '@/lib/catalogueClient';
import {
  rescheduleBooking,
  BookingApiError,
  type RescheduleResult,
} from '@/lib/bookingClient';

/**
 * Moving a booking to a different time (§11.3).
 *
 * ## The two things this gets right that a reschedule form usually does not
 *
 * **It sends the version the customer was shown.** `POST …/reschedule` matches on
 * `bookings.version`, so two devices rescheduling the same booking cannot both
 * win. A `STALE_VERSION` comes back carrying `details.currentVersion`, and this
 * panel says so rather than retrying — a retry against a version nobody has read
 * is how a booking ends up moved to a slot the customer never chose.
 *
 * **It checks the address on the booking, not the one in the browser.** The
 * `location` override on `SlotPicker` is what makes that true. Slots for
 * somebody's current pin would offer a time a professional could not reach.
 *
 * The grid itself is `SlotPicker` unchanged, rather than a second slot grid. It
 * already distinguishes "we do not serve this area" from "we do, and the day is
 * full", and duplicating that logic here is how the two screens start disagreeing.
 */

interface ReschedulePanelProps {
  bookingId: string;
  /** The version the customer read, and the one the optimistic lock matches. */
  version: number;
  /** From the booking's own item row. */
  serviceId: string;
  durationMinutes: number;
  /** The booking's frozen address, not the session's location. */
  location: LocationQueryInput | null;
  onRescheduled: (result: RescheduleResult) => void;
}

export function ReschedulePanel({
  bookingId,
  version,
  serviceId,
  durationMinutes,
  location,
  onRescheduled,
}: ReschedulePanelProps) {
  const [slot, setSlot] = useState<{ start: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rescheduleBooking(bookingId, slot.start, version);
      onRescheduled(result);
      setSlot(null);
    } catch (e) {
      if (e instanceof BookingApiError && e.code === 'STALE_VERSION') {
        // Somebody else moved it first. The stale answer carries the current
        // version, so the fix is a refresh of what is on screen, not a resend.
        setError(
          'This booking was just changed somewhere else. Reload the page to see the new time.'
        );
      } else if (e instanceof BookingApiError && e.code === 'ILLEGAL_TRANSITION') {
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : 'We could not move this booking.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-gray-400" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-gray-900">Move to another time</h3>
      </div>
      <p className="mt-1 text-xs text-gray-600">
        Free until a professional is assigned. After that, §11.3 charges the same fee as a late
        cancellation.
      </p>

      <div className="mt-3">
        <SlotPicker
          service={{ id: serviceId }}
          durationMinutes={durationMinutes}
          onSelect={setSlot}
          selected={slot}
          location={location}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={confirm}
        disabled={busy || !slot}
        className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Moving…' : slot ? `Move to ${slot.label || formatDateTime(slot.start)}` : 'Pick a time'}
      </button>
    </div>
  );
}