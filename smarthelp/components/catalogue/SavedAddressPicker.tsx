'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Home } from 'lucide-react';
import { usePublicLocation } from './PublicLocationContext';
import {
  addressToApply,
  selectedAddressId,
  shouldClearAddress,
  type AddressSelectionState,
} from './savedAddressSelection';
import { fetchAddresses, type AddressListResult, type SavedAddress } from '@/lib/addressClient';

/**
 * Pick a saved address, for somebody who has already saved one (§5.2).
 *
 * A saved address is the *best* answer to "where are you?", and it is the only
 * one that identifies the customer: the server can check an `addressId` against
 * their own rows and answer "not found on your account" for somebody else's,
 * which it cannot do for a typed area. Phase 1 built the endpoint, the RLS and
 * the `addressId` the routes read — and the other half of that gap, creating one,
 * is `AddressForm`.
 *
 * Three states, and only one of them is a control:
 *
 * - **Signed out, or the fetch fails.** Renders nothing. This sits on the public
 *   catalogue, where most visitors are not signed in, and a sign-in prompt inside
 *   a location chip is a nag on a page that works perfectly well without one.
 * - **Signed in with no saved addresses.** Renders nothing. Offering a picker
 *   with one empty option is worse than not offering one. Checkout is the one
 *   place that has to do better than nothing, so it renders `AddressForm` in this
 *   component's place — which is what the loaded list being reported upward is
 *   for, since this component renders nothing precisely when there is nothing to
 *   pick.
 * - **Signed in with at least one.** Renders the select, pre-selected to their
 *   default, because the default is what they meant last time — and writes that
 *   same address into the location context, because a control that shows one
 *   answer while the page uses another is worse than no control at all. Which
 *   address that is, and when it may be overwritten, is decided by
 *   `savedAddressSelection.ts` (pure, and tested there); this component only
 *   runs the decision and renders the `<select>` it names.
 *
 * An address outside the service area is selectable rather than hidden, and
 * marked as not yet available. Hiding it would leave somebody who knows their
 * house is out of zone wondering whether SmartHelp can see it at all; the honest
 * sentence is on the server, and it arrives as the locality summary.
 *
 * The bearer token this used to attach by hand is now resolved once in
 * `lib/addressClient.ts`. It was added here after a bug: without it the route
 * answered 401, a non-ok response returns quietly rather than reporting anything,
 * and the visible result was a picker showing no saved addresses on a page the
 * user was signed in to.
 */

const OTHER = '__other__';

/**
 * `useLayoutEffect` where there is a DOM, `useEffect` on the server.
 *
 * The decision made below has to land in the same commit that rendered the list
 * provoking it, *before the browser paints*. `CheckoutForm` hears the list
 * through `onLoaded` and renders "Pick a saved address to continue." whenever
 * the location holds no id — a frame of that notice over the address this effect
 * is about to apply is a flicker nobody should see, and React warns about
 * `useLayoutEffect` during server rendering, so the server keeps the passive one.
 */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function SavedAddressPicker({
  className = '',
  onLoaded,
  refreshToken = 0,
}: {
  className?: string;
  /**
   * The list that was loaded, once it has loaded.
   *
   * Reported so a parent that has to act on the difference between "no saved
   * addresses" and "signed out" can be told — this component renders nothing in
   * both cases, and cannot report that itself. Only a *successful* load fires it:
   * a 401 is not the same fact as an empty list, and a parent told otherwise
   * would offer a visitor who cannot sign in an address form.
   */
  onLoaded?: (result: AddressListResult) => void;
  /**
   * Bump to re-read the list.
   *
   * How a newly saved address reaches this select. The alternative — remounting
   * the component with a `key` — throws away the state it already has to make the
   * server answer the same question twice.
   */
  refreshToken?: number;
}) {
  const { addressId, selectAddress, setArea, area, hasLocation, clear } = usePublicLocation();
  const [options, setOptions] = useState<SavedAddress[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);

  // Held in a ref so a caller passing an inline arrow cannot re-run the fetch on
  // every render. The effect below must depend on `refreshToken` and nothing else.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  const load = useCallback(async (signal: AbortSignal) => {
    // A 401 means signed out, which is a normal state on a public page rather than
    // a failure worth showing anybody, so it is caught below rather than rendered.
    const result = await fetchAddresses(signal);
    setOptions(result.addresses ?? []);
    setDefaultId(result.defaultAddressId ?? null);
    return result;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((result) => onLoadedRef.current?.(result))
      .catch(() => {
        // An aborted or failed fetch leaves `options` null, which renders nothing.
      });
    return () => controller.abort();
  }, [load, refreshToken]);

  // One decision per list that arrives: a refresh after saving an address is a
  // new list, and so a new decision. The guard is the module's `settled` latch —
  // once a list has been answered, later changes to the context (picking another
  // row, typing an area, clearing) are the customer's own and are never
  // re-answered with the default.
  const decidedFor = useRef<SavedAddress[] | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (options === null || decidedFor.current === options) return;
    decidedFor.current = options;
    const state: AddressSelectionState = {
      hasLocation,
      addressId: addressId ?? null,
      optionIds: options.map((option) => option.id),
      defaultId,
      settled: false,
      loaded: true,
    };
    // A dead id with nothing to replace it with has to go: while it is held,
    // checkout shows no form and no notice and enables Confirm for a row that
    // no longer exists (the module's `shouldClearAddress` note is the story).
    if (shouldClearAddress(state)) {
      clear();
      return;
    }
    const next = addressToApply(state);
    if (next) selectAddress(next);
  }, [options, hasLocation, addressId, defaultId, clear, selectAddress]);

  if (!options || options.length === 0) return null;

  // The value shown is the value the location will hold once this component's
  // effect above has run — one decision, two renderings of it. `null` from the
  // module is the typed-area answer, which is this select's "somewhere else".
  const selected =
    selectedAddressId({
      hasLocation,
      addressId: addressId ?? null,
      optionIds: options.map((option) => option.id),
      defaultId,
      settled: false,
      loaded: true,
    }) ?? OTHER;

  return (
    <div className={className}>
      <label htmlFor="saved-address" className="sr-only">
        Saved address
      </label>
      <div className="relative">
        <Home
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-600"
          aria-hidden="true"
        />
        <select
          id="saved-address"
          value={selected}
          onChange={(event) => {
            const next = event.target.value;
            if (next === OTHER) {
              setArea(area ?? '');
            } else {
              selectAddress(next);
            }
          }}
          className="w-full appearance-none rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.isDefault ? ' (default)' : ''} — {option.formatted}
              {option.coverage === 'not_yet_available' ? ' · not yet available here' : ''}
            </option>
          ))}
          <option value={OTHER}>Somewhere else — type an area</option>
        </select>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Prices and slots are checked against the address you book for.
      </p>
    </div>
  );
}