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
import {
  createPaymentOrder,
  verifyPayment,
  fetchPayment,
  paymentDisplayState,
  type CheckoutSignaturePayload,
  type PaymentOrderResult,
} from '@/lib/paymentClient';

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
 *
 * ## What happens after the booking exists (§12.1, §31.2)
 *
 * `POST /api/bookings` used to be the end of this screen: it created a row in
 * `payment_pending` and navigated away, which meant the customer was shown
 * "created" and the money was never asked for. The booking id is now held in a
 * ref instead of being navigated on, and `createPaymentOrder` opens Razorpay
 * Checkout over the order the server just built.
 *
 * Three rules govern the states below, and none of them is an aesthetic choice:
 *
 * 1. **The `handler` callback never renders `paid`.** It fires the instant the
 *    gateway closes its window; the webhook that writes `payments.status` may
 *    still be seconds away. The handler may only start `verifyPayment` (which
 *    writes nothing) and begin polling `fetchPayment`. `paid` is reached solely
 *    through `paymentDisplayState(polledStatus)`.
 * 2. **A poll that never settles says so.** It stops after `POLL_ATTEMPTS` and
 *    shows an honest "still confirming" state where pressing the button asks the
 *    row again — it does not order a second charge. Spinning forever, or
 *    guessing, would both be lies about money.
 * 3. **Every refusal is surfaced in the server's own words.** `402
 *    PAYMENT_FAILED` carries what the gateway said, because the server stored
 *    `payments.failure_reason` before it refused; `409 PRICE_CHANGED` re-quotes.
 *
 * The idempotency key for the *order* follows the same policy as the one for the
 * booking: it is reused when a request may have landed (`NETWORK_ERROR`) and
 * regenerated when the server definitely refused or a poll reported `failed`.
 */

const QUOTE_DEBOUNCE_MS = 300;

/** Loaded on demand, never in the bundle — the gateway's own script. */
const CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** ~30 seconds of polling: long enough for a webhook, bounded so it cannot spin. */
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 15;

/**
 * The subset of Razorpay Checkout's options this screen uses.
 *
 * `amount` is passed as well as `order_id` (both derived from the same server
 * response) rather than fetched from anywhere client-side: the figure the
 * gateway charges is the order's, and this screen never computes one.
 */
interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name?: string;
  handler: (response: CheckoutSignaturePayload) => void;
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    /** Injected by `checkout.js`. Absent until the script has loaded. */
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

/**
 * Where the screen is in the payment, in the only order it can happen in.
 *
 * `creating` is order-create, `checkout` the open gateway window, `confirming`
 * the poll. `timeout` and `payment_failed` are both retryable and mean
 * different things: the first says the row has not settled, the second that it
 * settled as `failed`.
 */
type PayPhase = 'idle' | 'creating' | 'checkout' | 'confirming' | 'paid' | 'timeout' | 'payment_failed';

/**
 * `checkout.js` is on the gateway's CDN, so it may be slow, may be blocked and
 * may already be on the page from an earlier attempt. Rejected rather than
 * resolved on failure: opening `new window.Razorpay` without the constructor is
 * a TypeError, and a customer deserves the sentence instead.
 */
function loadCheckoutScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Razorpay) return Promise.resolve();

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${CHECKOUT_SCRIPT_SRC}"]`
  );

  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('The payment window could not be loaded.'));
    const target = existing ?? document.createElement('script');
    target.addEventListener('load', () => resolve(), { once: true });
    target.addEventListener('error', fail, { once: true });
    if (!existing) {
      target.src = CHECKOUT_SCRIPT_SRC;
      target.async = true;
      document.body.appendChild(target);
    }
  });
}


export function CheckoutForm({
  serviceId,
  serviceName,
  durationMinutes,
  durations,
  slotStart,
  bookingType: bookingTypeProp,
  slotForDurationMinutes,
}: {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  /** The lengths the service actually offers, from its catalogue row. */
  durations: number[];
  slotStart: string | null;
  bookingType?: 'instant' | 'scheduled' | null;
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

  // The payment half. `payNote` is deliberately not an error: it carries the
  // honest "still confirming" and "window closed" sentences, which are neither
  // failures nor successes and would read as an alarm in `submitError`'s red box.
  const [payPhase, setPayPhase] = useState<PayPhase>('idle');
  const [payNote, setPayNote] = useState<string | null>(null);

  // Read from inside Razorpay callbacks, which are closures created once when the
  // window opens and so cannot see React state directly.
  const phaseRef = useRef<PayPhase>('idle');
  useEffect(() => {
    phaseRef.current = payPhase;
  }, [payPhase]);


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

  // The booking, once it exists. Held rather than navigated on, because the
  // booking is the thing the order is for — pressing Confirm again after a
  // dismissed window must pay for *this* booking, not make a second one.
  const createdBookingId = useRef<string | null>(null);
  /** The total frozen on that booking, passed as `expectedTotal` to catch a stale screen. */
  const createdBookingTotal = useRef<number | null>(null);
  /** The order's own key. See the regeneration policy in `openCheckout`. */
  const paymentKey = useRef<string>(createIdempotencyKey());
  /** The payment to ask about again after a timeout. */
  const paymentId = useRef<string | null>(null);

  // Polling is cancelled by bumping the token: a stale loop that wakes up after
  // a newer one started simply returns, so two loops can never both write state.
  const pollToken = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    pollToken.current += 1;
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Unmount (navigation away) must not leave a timer writing into a dead screen.
  useEffect(() => stopPolling, [stopPolling]);


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

  /**
   * One poll, then another, up to `POLL_ATTEMPTS`.
   *
   * A failed *read* is not a failed payment — a dropped connection while the
   * webhook is still in flight must not tell a customer their money is gone —
   * so it is swallowed and retried within the same bound. Only a status the
   * server actually reports ends the loop, and only `paymentDisplayState` decides
   * what that means.
   */
  async function pollPayment(id: string, token: number) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      if (token !== pollToken.current) return;
      if (attempt > 0) {
        await new Promise<void>((resolve) => {
          pollTimer.current = setTimeout(() => {
            pollTimer.current = null;
            resolve();
          }, POLL_INTERVAL_MS);
        });
        if (token !== pollToken.current) return;
      }

      let status: string;
      try {
        status = (await fetchPayment(id)).payment.status;
      } catch {
        continue;
      }
      if (token !== pollToken.current) return;

      const state = paymentDisplayState(status);
      if (state === 'paid') {
        setPayPhase('paid');
        setPayNote(null);
        return;
      }
      if (state === 'failed') {
        // The attempt is over: nothing was captured, and a retry wants its own
        // order rather than a replay of a spent one.
        paymentKey.current = createIdempotencyKey();
        setPayPhase('payment_failed');
        setPayNote('The payment did not go through, and nothing was charged. You can try again.');
        return;
      }
    }

    // Bounded, and honest about it: the row has not settled, so the screen says
    // so instead of claiming either outcome.
    setPayPhase('timeout');
    setPayNote(
      'Still confirming your payment. Nothing is marked as paid until your bank says so — press the button to ask again.'
    );
  }

  /** Cancel any loop in flight, then start a fresh one on `id`. */
  function startPolling(id: string) {
    stopPolling();
    void pollPayment(id, pollToken.current);
  }

  /**
   * Booking creation's refusals, extracted so `confirm` can hand a booking id
   * straight to `openCheckout` without a nested catch.
   */
  async function handleBookingError(e: unknown): Promise<void> {
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
  }

  /**
   * Order → script → window, for a booking that already exists.
   *
   * The order is the server's, so the amount and key on the window come from the
   * response and are never computed here. Each way this can fail leaves the
   * screen where the customer can press again: `idle` plus a sentence, never a
   * dead button.
   */
  async function openCheckout(bookingId: string) {
    setPayPhase('creating');
    setPayNote(null);
    setSubmitError(null);

    let order: PaymentOrderResult;
    try {
      order = await createPaymentOrder(
        { bookingId, expectedTotal: createdBookingTotal.current },
        paymentKey.current
      );
    } catch (e) {
      setPayPhase('idle');
      if (e instanceof BookingApiError) {
        // A network error may have landed, so that key must be reused — a second
        // order on the same key replays the first. Anything the server *refused*
        // wrote nothing for this attempt, so a fresh key is safe (and required
        // once a poll has reported `failed`).
        if (e.code !== 'NETWORK_ERROR') paymentKey.current = createIdempotencyKey();
        // `402 PAYMENT_FAILED` carries the gateway's own words: the server
        // stored `payments.failure_reason` before refusing, so this is not ours
        // to soften into a generic sentence.
        setSubmitError(e.message);
      } else {
        setSubmitError('We could not start the payment. Please try again.');
      }
      return;
    }

    paymentId.current = order.paymentId;

    try {
      await loadCheckoutScript();
    } catch {
      setPayPhase('idle');
      setSubmitError('We could not load the payment window. Check your connection and try again.');
      return;
    }

    setPayPhase('checkout');
    const rzp = new window.Razorpay!({
      key: order.keyId,
      order_id: order.orderId,
      amount: Math.round(order.amount * 100),
      currency: order.currency,
      name: 'SmartHelp',
      handler: (response) => {
        // §12.1's hard rule, in code: the handler may *start* work and must not
        // conclude it. `confirming` is the strongest state it can ask for, and
        // `paid` is reachable only from the polled row below.
        stopPolling();
        setPayPhase('confirming');
        setPayNote('Checking your payment…');
        // Reads only — a signature mismatch here changes nothing about the
        // webhook's authority, and swallowing it leaves the poll to decide.
        void verifyPayment(response).catch(() => {});
        startPolling(order.paymentId);
      },
      modal: {
        ondismiss: () => {
          // Razorpay also closes after a successful payment, at which point the
          // handler has already moved the phase on. Only an unanswered window
          // puts the customer back at the start.
          if (phaseRef.current !== 'checkout') return;
          stopPolling();
          setPayPhase('idle');
          setPayNote(
            'The payment window was closed. Your booking is saved — you can pay for it whenever you are ready.'
          );
        },
      },
    });
    rzp.open();
  }

  async function confirm() {
    if (!addressId || !quote) return;

    // A timeout retries the *same* charge attempt: ask the row again rather than
    // ordering a second one. The row is the only thing that can settle it.
    if (payPhase === 'timeout' && paymentId.current) {
      setPayPhase('confirming');
      setPayNote('Still confirming your payment…');
      startPolling(paymentId.current);
      return;
    }

    let bookingId = createdBookingId.current;
    if (!bookingId) {
      setBusy(true);
      setSubmitError(null);
      setPayNote(null);
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
        bookingId = result.booking.id;
        createdBookingId.current = bookingId;
        createdBookingTotal.current = quote.quote.total;
      } catch (e) {
        await handleBookingError(e);
        setBusy(false);
        return;
      }
      setBusy(false);
    }

    await openCheckout(bookingId);
  }

  // `paying` covers the three states where a second press would be a second
  // charge attempt or a second window; `paid` retires the button entirely rather
  // than offering a retry that would refuse at the server.
  const paying =
    payPhase === 'creating' || payPhase === 'checkout' || payPhase === 'confirming';
  const ready = Boolean(addressId) && quote != null && !busy && !paying && payPhase !== 'paid';

  const buttonLabel = busy
    ? 'Confirming…'
    : paying
      ? 'Processing payment…'
      : payPhase === 'timeout'
        ? 'Check again'
        : payPhase === 'payment_failed'
          ? 'Try again'
          : 'Confirm booking';

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

          {/* Amber, not red: "still confirming" and "window closed" are states, not
              refusals. `payment_failed` is a refusal and gets the red the others do. */}
          {payNote && !submitError ? (
            <p
              role={payPhase === 'payment_failed' ? 'alert' : 'status'}
              className={`mt-4 rounded-lg px-3 py-2 text-sm ${
                payPhase === 'payment_failed'
                  ? 'bg-red-50 text-red-700'
                  : 'bg-amber-50 text-amber-900'
              }`}
            >
              {payNote}
            </p>
          ) : null}

          {payPhase === 'paid' ? (
            <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
              <p className="font-semibold">Payment received — your booking is confirmed.</p>
              <button
                type="button"
                onClick={() => router.push(`/customer/bookings/${createdBookingId.current}`)}
                className="mt-2 rounded-lg border border-emerald-600 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                View booking
              </button>
            </div>
          ) : null}

          {payPhase === 'paid' ? null : (
            <button
              type="button"
              onClick={confirm}
              disabled={!ready}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy || paying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {buttonLabel}
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  {buttonLabel}
                </>
              )}
            </button>
          )}

          <p className="mt-3 text-xs text-gray-500">
            Free cancellation up to 24 hours before the start time. The exact fee for your booking
            is shown before you cancel, never after.
          </p>
        </div>
      </div>
    </div>
  );
}