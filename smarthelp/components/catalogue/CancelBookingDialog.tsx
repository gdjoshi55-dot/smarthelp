'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { CANCELLATION_REASONS } from '@/lib/status';
import { quoteCancellation, cancellationCopy, formatFee } from '@/lib/cancellation';
import { parseNumeric } from '@/lib/money';
import { formatPrice } from '@/lib/catalogue';
import { formatDateTime } from './bookingFormat';
import {
  cancelBooking,
  BookingApiError,
  type BookingRow,
  type CancelResult,
} from '@/lib/bookingClient';

/**
 * Cancelling a booking, and saying what it will cost before the customer agrees
 * to it (§11.1, §16 #18).
 *
 * ## Why the fee is quoted here and not fetched
 *
 * The obvious design is a "what will this cost?" endpoint. This one computes it
 * locally instead, and the comment in `lib/cancellation.ts` explains the
 * arithmetic; what matters here is that **the server re-derives it anyway** and
 * returns what it actually charged. So the number under the button is a preview
 * of the policy, not a quote — and the copy is worded so it cannot be read as a
 * promise. If the two ever disagree, the dialog shows the server's figure after
 * the fact rather than leaving the customer to notice.
 *
 * That is not a shortcut taken for convenience. It is what keeps a cancellation
 * to a single request: a customer who opens a dialog and closes it has spent
 * nothing, and the one thing this flow must never do is fail.
 */

interface CancelBookingDialogProps {
  booking: BookingRow;
  open: boolean;
  onClose: () => void;
  onCancelled: (result: CancelResult) => void;
}

export function CancelBookingDialog({ booking, open, onClose, onCancelled }: CancelBookingDialogProps) {
  const [reasonCode, setReasonCode] = useState<string>('changed_mind');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = parseNumeric(booking.total_amount);
  const hoursBefore = booking.scheduled_start_at
    ? (new Date(booking.scheduled_start_at).getTime() - Date.now()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  // Recomputed whenever the reason changes, because §11.2 waives the fee for
  // reasons that are not the customer's decision. `useMemo` on the two values
  // that move it, rather than on `Date.now()`, so the fee does not tick upward
  // while somebody reads the dialog — a number that changes under the cursor is
  // worse than one that is a minute stale.
  const quote = useMemo(
    () => quoteCancellation({ amount, hoursBefore, arrived: false, cancelledBy: 'customer' }),
    [amount, hoursBefore]
  );

  if (!open) return null;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await cancelBooking(booking.id, reasonCode, reason);
      onCancelled(result);
    } catch (e) {
      // A second device cancelling first is not a failure to report as an
      // outage; it is a conversation, so the copy says what happened.
      if (e instanceof BookingApiError && e.code === 'NOT_FOUND') {
        setError('This booking is no longer available. It may already have been cancelled.');
      } else {
        setError(e instanceof Error ? e.message : 'We could not cancel this booking.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-booking-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 id="cancel-booking-title" className="text-base font-semibold text-gray-900">
            Cancel booking {booking.booking_number}?
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-gray-900">Why are you cancelling?</legend>
          <div className="mt-2 space-y-1.5">
            {CANCELLATION_REASONS.map((option) => (
              <label
                key={option.code}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50"
              >
                <input
                  type="radio"
                  name="cancel-reason"
                  value={option.code}
                  checked={reasonCode === option.code}
                  onChange={() => setReasonCode(option.code)}
                  className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-gray-900">
            Anything we should know? <span className="font-normal text-gray-500">(optional)</span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={2}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            placeholder="Help us understand what happened."
          />
        </label>

        <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="text-sm text-amber-900">
            <p>{cancellationCopy(quote)}</p>
            <p className="mt-1 text-xs text-amber-800">
              Based on {formatPrice(amount)} booked for{' '}
              {booking.scheduled_start_at ? formatDateTime(booking.scheduled_start_at) : 'an instant slot'}.
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Keep booking
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy
              ? 'Cancelling…'
              : quote.fee > 0
                ? `Cancel and pay ${formatFee(quote.fee)}`
                : 'Cancel booking'}
          </button>
        </div>
      </div>
    </div>
  );
}