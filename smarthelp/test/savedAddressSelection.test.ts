import { describe, expect, it } from 'vitest';
import {
  addressToApply,
  fallbackAddressId,
  selectedAddressId,
  shouldClearAddress,
  type AddressSelectionState,
} from '@/components/catalogue/savedAddressSelection';

/**
 * The rule behind the saved-address picker, tested without a DOM.
 *
 * The bug: the picker *showed* the default address while the location context held
 * something else, or nothing. A signed-in customer therefore saw a booking address
 * on the screen and got `400 "We need a location to check availability"` from the
 * server, with no slots and no way past them. The component is a client component
 * and the suite runs in node with no DOM, so the decision is a pure function and
 * these are its cases.
 */

const HOME = '00000000-0000-4000-8000-00000000aaaa';
const WORK = '00000000-0000-4000-8000-00000000bbbb';
const PARENTS = '00000000-0000-4000-8000-00000000cccc';

function state(over: Partial<AddressSelectionState> = {}): AddressSelectionState {
  return {
    hasLocation: false,
    addressId: null,
    optionIds: [HOME, WORK, PARENTS],
    defaultId: HOME,
    settled: false,
    // A list that came back. Every case below that does not care about this can
    // leave it at the default and keep its meaning, because none of the other
    // three decisions reads it.
    loaded: true,
    ...over,
  };
}

describe('nothing chosen yet', () => {
  it('applies the default address', () => {
    expect(addressToApply(state())).toBe(HOME);
  });

  it('shows that same address', () => {
    expect(selectedAddressId(state())).toBe(HOME);
  });

  it('applies nothing when there are no saved addresses to apply', () => {
    expect(addressToApply(state({ optionIds: [], defaultId: null }))).toBeNull();
    expect(selectedAddressId(state({ optionIds: [], defaultId: null }))).toBeNull();
  });
});

describe('the default has been deleted since it was set', () => {
  it('falls back to the first address that still exists', () => {
    const stale = state({ defaultId: '00000000-0000-4000-8000-00000000dddd' });

    expect(addressToApply(stale)).toBe(HOME);
    expect(selectedAddressId(stale)).toBe(HOME);
  });
});

describe('a saved address is already chosen', () => {
  it('leaves it alone', () => {
    const chosen = state({ hasLocation: true, addressId: WORK });

    expect(addressToApply(chosen)).toBeNull();
    expect(selectedAddressId(chosen)).toBe(WORK);
  });
});

describe('a typed area left over from an earlier visit', () => {
  it('is replaced by the default address on arrival', () => {
    const typed = state({ hasLocation: true, addressId: null });

    // A signed-in customer is booking for themselves, and only a saved address can be
    // checked against their own rows. Pricing and slots for a locality they did not
    // pick is the bug this whole file exists for: the page read "Electronic City" from
    // a previous visit and answered about it as though it were theirs.
    expect(addressToApply(typed)).toBe(HOME);
  });

  it('is replaced by the default even when it looks deliberate', () => {
    // There is no way to tell a typed area from last week from one typed a second
    // ago, and the component decides once on arrival — see the `settled` cases below.
    expect(addressToApply(state({ hasLocation: true, addressId: null }))).toBe(HOME);
  });
});

describe('after the page view has settled', () => {
  it('leaves a typed area alone', () => {
    // Booking a relative's house: the customer typed it, and an effect that keeps
    // reasserting the account's default is the same bug in a new hat.
    const typed = state({ hasLocation: true, addressId: null, settled: true });

    expect(addressToApply(typed)).toBeNull();
  });

  it('leaves a cleared location cleared', () => {
    expect(addressToApply(state({ hasLocation: false, settled: true }))).toBeNull();
  });

  it('leaves a different saved address chosen', () => {
    const chosen = state({ hasLocation: true, addressId: WORK, settled: true });

    expect(addressToApply(chosen)).toBeNull();
  });

  it('still shows the chosen address in the control', () => {
    const typed = state({ hasLocation: true, addressId: null, settled: true });

    // The slots are computed for whatever the location holds, so the control has to
    // show that and not a saved address it is not using.
    expect(selectedAddressId(typed)).toBeNull();
  });
});

describe('a stored address that has been deleted', () => {
  it('is replaced by the default', () => {
    // A `localStorage` `addressId` naming a deleted row used to pin checkout and
    // the catalogue to a 404 with nothing on screen able to change it.
    const stale = state({ hasLocation: true, addressId: '00000000-0000-4000-8000-00000000eeee' });

    expect(addressToApply(stale)).toBe(HOME);
    expect(selectedAddressId(stale)).toBe(HOME);
  });
});

describe('the fallback itself', () => {
  it('prefers the default when it is in the list', () => {
    expect(fallbackAddressId(state({ defaultId: PARENTS }))).toBe(PARENTS);
  });

  it('is the first address when the default is not in the list', () => {
    expect(
      fallbackAddressId(state({ optionIds: [WORK, PARENTS], defaultId: HOME }))
    ).toBe(WORK);
  });

  it('is null when there is nothing saved', () => {
    expect(fallbackAddressId(state({ optionIds: [], defaultId: null }))).toBeNull();
  });
});

describe('a stored addressId with no saved addresses left', () => {
  const DEAD = '00000000-0000-4000-8000-00000000ffff';

  it('is cleared, so CheckoutForm renders AddressForm and Confirm goes off', () => {
    // The empty-list half of the case above. `addressToApply` returns null here —
    // there is nothing to replace the id with — so before this decision existed the
    // dead id stayed in the location, `needsAddressForm` (`… && !addressId`) was
    // false, the amber notice was false, and `ready = Boolean(addressId)` enabled
    // Confirm. The create route then refused the address with a 404 for a row the
    // customer could neither see nor have deleted.
    const empty = state({ hasLocation: true, addressId: DEAD, optionIds: [], defaultId: null });

    expect(shouldClearAddress(empty)).toBe(true);
    // `addressToApply` genuinely has nothing to offer here, which is the whole
    // reason the clear cannot come from that branch.
    expect(addressToApply(empty)).toBeNull();
  });

  it('is cleared even after the page view has settled', () => {
    // Not gated on `settled`, deliberately. The latch exists to stop the fallback
    // being re-asserted over a customer who has chosen something else; it must not
    // pin a dead id to the screen. Deleting your only address in another tab and
    // coming back to this one lands exactly here, with `settled` already true.
    const empty = state({
      hasLocation: true,
      addressId: DEAD,
      optionIds: [],
      defaultId: null,
      settled: true,
    });

    expect(shouldClearAddress(empty)).toBe(true);
  });

  it('is left alone when the list never loaded, because a 401 looks empty', () => {
    // A signed-out visitor's `options` stays null forever, so their `optionIds` is
    // also `[]`. Clearing here would wipe a typed location on a page that never
    // learned whether the account has any addresses at all.
    const signedOut = state({
      hasLocation: true,
      addressId: DEAD,
      optionIds: [],
      defaultId: null,
      loaded: false,
    });

    expect(shouldClearAddress(signedOut)).toBe(false);
  });

  it('does nothing when there is no addressId to begin with', () => {
    const empty = state({ hasLocation: false, addressId: null, optionIds: [], defaultId: null });

    expect(shouldClearAddress(empty)).toBe(false);
  });

  it('applies the fallback instead of clearing when the list is not empty', () => {
    // A stale id with addresses still saved is the older case, and it must keep its
    // own answer: something is better than nothing. Clearing here would send a
    // customer with three saved addresses to an empty form.
    const stale = state({ hasLocation: true, addressId: DEAD });

    expect(shouldClearAddress(stale)).toBe(false);
    expect(addressToApply(stale)).toBe(HOME);
  });
});