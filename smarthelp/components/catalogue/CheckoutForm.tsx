'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck, Tag } from 'lucide-react';
import { PriceBreakdown } from './PriceBreakdown';
import { SavedAddressPicker } from './SavedAddressPicker';
import { AddressForm } from './AddressForm';
import { usePublicLocation } from './PublicLocationContext';
import { durationLabel } from '@/lib/catalogue';
import { formatBookingWhen } from './bookingFormat';
import type { AddressListResult } from '@/lib/addressClient';
import {
  quoteBooking,
  createBooking,
  createIdempotencyKey,
  BookingApiError,
  type QuoteResult,
} from '@/lib/bookingClient';

/**
 * Checkout (§20.5).
 *
 * ## Where the money on this screen comes from
 *
 * `POST /api/bookings/quote`. Not the catalogue, and not `priceForDuration` from
 * the service card. The card's figure is an estimate computed for a public page
 * with no coupon, no address and no engine version; this screen is the one where
 * the customer agrees to a number, so it asks the server what the number is, and
 * renders whatever comes back. The re-quote is debounced because a coupon field
 * is a keystroke and a quote per keystroke is a request per keystroke.
 *
 * ## The idempotency key is minted once per attempt, not per click
 *
 * `useRef` rather than `useState`, so re-renders never mint a new one. That is
 * the whole point: `POST /api/bookings` requires `Idempotency-Key`, and a key
 * regenerated on every render would turn a double-click on a slow connection into
 * two bookings. The key is regenerated only when an attempt genuinely fails and
 * the customer is told to try again.
 *
 * A `PRICE_CHANGED` keeps the same key on purpose — nothing was written, and the
 * key is scoped to the payload, which did not change.
 *
 * ## The address gate
 *
 * `ready` needs an `addressId`, so this screen has to know whether the customer has
 * a saved address. It did not, and the two states it could not tell apart were a
 * customer with addresses and a customer with none: the latter got a permanently
 * disabled Confirm button and a sentence telling them to pick something that was
 * not there, because the only way to create an address lived on no page. The
 * picker now reports the list it loaded, and `AddressForm` is rendered in its
 * place when that list is empty. It is rendered *only* then — somebody with saved
 * addresses has a question to answer, and a form in front of the picker would be
 * a second way to do what the picker already does.
 */

const QUOTE_DEBOUNCE_MS = 300;

export function CheckoutForm({
  serviceId,
  serviceName,
  durationMinutes,
  durations,
  slotStart,
  slotForDurationMinutes,
}: {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  /** The lengths the service actually offers, from its catalogue row. */
  durations: number[];
  slotStart: string | null;
  /** The length the pre-chosen slot was picked for, if there is a slot. */
  slotForDurationMinutes: number | null;
}) {
  const router = useRouter();
  const { addressId } = usePublicLocation();

  // The service's own lengths, not a fixed ladder. A hardcoded
  // [30, 60, 90, 120, 180] offered a 30-minute button for a service whose shortest
  // booking is 90, and the offer was refused by the quote it then displayed — the
  // worst of both: a choice the screen made and the server rejected. When the
  // catalogue row has no list (a service that only takes its base duration) the one
  // length we were given is the whole menu.
  const offered = durations.length > 0 ? durations : [durationMinutes];
  const [duration, setDuration] = useState(durationMinutes);
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');
  const [notes, setNotes] = useState('');
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [priceMoved, setPriceMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The saved addresses, as the picker loaded them, plus the counter that re-reads
  // them. Both belong here because the picker is the component that already asks
  // for the list — and it renders nothing when there is nothing to pick, so it
  // cannot report that itself. Fetching it again from here would be the same
  // request twice on one screen.
  const [addressList, setAddressList] = useState<AddressListResult | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const handleLoaded = useCallback((result: AddressListResult) => {
    setAddressList(result);
  }, []);

  const handleAddressCreated = useCallback(() => {
    // The form has already selected the new address, which is what unblocks
    // `ready`. This re-reads the list so the picker — which rendered nothing a
    // moment ago — shows it, rather than leaving a saved address with no control
    // on the screen that just saved it.
    setRefreshToken((token) => token + 1);
  }, []);

  // Only the empty list, and only while nothing is selected. An address that exists
  // and has not been chosen yet is a question, and the picker is what asks it.
  const needsAddressForm =
    addressList !== null && addressList.addresses.length === 0 && !addressId;

  // One key per attempt. See the note above.
  const idempotencyKey = useRef<string>(createIdempotencyKey());

  const item = useMemo(
    () => [{ serviceId, durationMinutes: duration }],
    [serviceId, duration]
  );

  const requote = useCallback(async () => {
    setQuoteError(null);
    try {
      const result = await quoteBooking({
        items: item,
        couponCode: appliedCoupon || null,
        bookingType: slotStart ? 'scheduled' : 'instant',
      });
      setQuote(result);
      // A successful quote clears the "the price moved" banner: the customer has
      // now been shown the new number, which is the only thing that banner wanted.
      setPriceMoved(false);
    } catch (e) {
      setQuote(null);
      if (e instanceof BookingApiError) {
        setQuoteError(e.message);
        // An invalid coupon is the common case and deserves its own answer.
        if (e.code === 'COUPON_INVALID' || e.code === 'VALIDATION_ERROR') {
          setAppliedCoupon('');
          setCouponCode('');
        }
      } else {
        setQuoteError('We could not price this booking right now.');
      }
    }
  }, [item, appliedCoupon, slotStart]);

  useEffect(() => {
    const timer = setTimeout(requote, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requote]);

  async function confirm() {
    if (!addressId || !quote) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const result = await createBooking(
        {
          addressId,
          bookingType: slotStart ? 'scheduled' : 'instant',
          scheduledStartAt: slotStart,
          items: item,
          couponCode: appliedCoupon || null,
          notes: notes.trim() || null,
          // The total the customer agreed to. The server refuses with the fresh
          // breakdown if it has moved, rather than charging the new figure silently.
          expectedTotal: quote.quote.total,
          // The signed quote this figure came from, when the server issued one.
          // Proof of provenance for the booking row; not what the price is held by.
          quoteToken: quote.quoteToken ?? null,
        },
        idempotencyKey.current
      );
      router.push(`/customer/bookings/${result.booking.id}?created=1`);
    } catch (e) {
      if (e instanceof BookingApiError && e.code === 'PRICE_CHANGED') {
        // Nothing was written. Show the new breakdown and let them decide.
        setPriceMoved(true);
        await requote();
      } else if (e instanceof BookingApiError && e.code === 'STALE_VERSION') {
        setSubmitError(e.message);
        await requote();
      } else if (e instanceof BookingApiError && (e.code === 'NETWORK_ERROR' || e.code === 'INTERNAL_ERROR')) {
        // The request may or may not have landed, which is exactly what the key
        // is for: retrying with the same key returns the one booking either way.
        setSubmitError(
          'We could not confirm that. Press the button again — you will not be charged twice.'
        );
      } else if (e instanceof BookingApiError) {
        setSubmitError(e.message);
        const field = e.fields?.addressId;
        if (field) setSubmitError(field);
      } else {
        setSubmitError('We could not create this booking.');
      }
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(addressId) && quote != null && !busy;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">Where should we come?</h2>
          <p className="mt-1 text-xs text-gray-600">
            A booking is written against one of your saved addresses, and the server checks it is
            yours.
          </p>
          <div className="mt-3">
            <SavedAddressPicker onLoaded={handleLoaded} refreshToken={refreshToken} />
          </div>
          {needsAddressForm ? (
            <AddressForm onCreated={handleAddressCreated} />
          ) : addressList !== null && !addressId ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Pick a saved address to continue.
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">How long do you need?</h2>
          <p className="mt-1 text-xs text-gray-600">{serviceName}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {offered.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setDuration(minutes)}
                aria-pressed={duration === minutes}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                  duration === minutes
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-blue-400'
                }`}
              >
                {minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}
              </button>
            ))}
          </div>
          {slotStart ? (
            <>
              <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                Chosen time: <strong>{formatBookingWhen(slotStart)}</strong>
              </p>
              {slotForDurationMinutes != null && slotForDurationMinutes !== duration ? (
                // Not a warning about money — the price above is already the new
                // one — but the slot was offered for a different length, and that
                // length is part of what made it free. Say so rather than letting
                // the confirm button fail with a bare "no slot".
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  That time was picked for a {durationLabel(slotForDurationMinutes)} job. A{' '}
                  {durationLabel(duration)} job may not fit it — if it does not, we will say so
                  before anything is booked.
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              No time was chosen, so this will be booked as an instant request.
            </p>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Tag className="h-4 w-4 text-gray-400" aria-hidden="true" />
            Coupon code
          </label>
          <div className="mt-2 flex gap-2">
            <input
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              placeholder="Optional"
              aria-label="Coupon code"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm uppercase focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <button
              type="button"
              onClick={() => setAppliedCoupon(couponCode.trim())}
              disabled={!couponCode.trim()}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Apply
            </button>
          </div>
          {appliedCoupon ? (
            <p className="mt-2 text-xs text-emerald-700">Applied: {appliedCoupon}</p>
          ) : null}
          {quoteError ? (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {quoteError}
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <label className="text-sm font-semibold text-gray-900" htmlFor="booking-notes">
            Anything we should know?
          </label>
          <textarea
            id="booking-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Gate code, parking, what is wrong with the appliance…"
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </section>
      </div>

      <div className="lg:col-span-2">
        <div className="sticky top-4 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">Price</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Priced by our engine, including platform fee and GST.
          </p>

          <div className="mt-4">
            {quote ? (
              <PriceBreakdown breakdown={quote.quote} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-gray-600">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Pricing this booking…
              </p>
            )}
          </div>

          {priceMoved ? (
            <p role="alert" className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The price changed while you were deciding. This is the new total — check it before
              confirming.
            </p>
          ) : null}

          {submitError ? (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {submitError}
            </p>
          ) : null}

          <button
            type="button"
            onClick={confirm}
            disabled={!ready}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Confirming…
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Confirm booking
              </>
            )}
          </button>

          <p className="mt-3 text-xs text-gray-500">
            Free cancellation up to 24 hours before the start time. The exact fee for your booking
            is shown before you cancel, never after.
          </p>
        </div>
      </div>
    </div>
  );
}