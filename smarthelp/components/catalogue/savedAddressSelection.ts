/**
 * Which saved address the picker shows, and which one it puts into the location.
 *
 * This is a pure function on purpose. The picker is a client component and the
 * suite runs in a node environment with no DOM, so the one decision worth testing
 * — *is the thing on screen the thing the location is?* — is separated from the
 * `<select>` that renders it.
 *
 * ## Why it existed
 *
 * The picker *showed* the customer's default address while the location context
 * held something else, or nothing. Two failures came out of that:
 *
 * - A first visit, or a cleared location, left the location empty. The availability
 *   screen then asked the server about no location at all and came back with
 *   `400 "We need a location to check availability"` and no slots, while the panel
 *   three lines above showed an address as though it had been chosen.
 * - A typed area was answered with a saved address in the control. The slots were
 *   computed for the typed area and the screen said otherwise.
 *
 * A control that shows one answer while the page uses another is worse than no
 * control, because it reads as though the choice was made.
 *
 * ## What it decided
 *
 * A saved address wins on arrival. Somebody signed in who lands on a service page is
 * booking for themselves, and the address on the account is the only form of the
 * question the server can answer about *them* — a typed area can be anybody's. So
 * the account's default is applied even when the browser still holds an area typed
 * on an earlier visit, which is exactly the case that produced a page full of
 * estimates priced for somewhere the customer had not chosen.
 *
 * It is applied **once per page view** (`settled`). After that the customer is left
 * alone: a person who types an area to book a relative's house, or clears the
 * location to look at a different area, keeps what they chose until they leave. A
 * component that keeps reasserting the default is the same bug wearing a different
 * hat.
 */

export interface AddressSelectionState {
  /** Whether the location context holds any answer at all. */
  hasLocation: boolean;
  /** The address the context is holding, if it is holding one. */
  addressId: string | null;
  /** The ids the server returned. Ids only — nothing here reads an address row. */
  optionIds: string[];
  /** The customer's default, when they have one. */
  defaultId: string | null;
  /**
   * Whether this page view has already made the decision once.
   *
   * What keeps the auto-applied default from becoming the customer's new cage: the
   * first arrival gets their account's address, and everything after that is
   * theirs to change.
   */
  settled: boolean;
  /**
   * Whether the list came back from the server.
   *
   * **Not the same thing as an empty list, and that is the whole point of the
   * field.** A signed-out visitor, a still-loading picker and a customer who has
   * deleted their last address all produce `optionIds: []`, and the first two
   * must not be treated like the third. A 401 leaves the picker's `options` null
   * forever, so an empty list from a signed-out browser is indistinguishable from
   * an empty list from a real one unless something says which it was.
   */
  loaded: boolean;
}

/**
 * The address to fall back to: the default, or the first one saved.
 *
 * The default is what somebody meant last time. The first row is the last resort
 * rather than nothing, because "the address you saved is gone" should leave the
 * page able to price a booking, not dead on a control with no valid selection.
 */
export function fallbackAddressId(state: AddressSelectionState): string | null {
  if (state.defaultId && state.optionIds.includes(state.defaultId)) return state.defaultId;
  return state.optionIds[0] ?? null;
}

/**
 * The value the `<select>` shows. `null` is the "type an area" option.
 *
 * A location that is a typed area or a browser fix is an answer, so it is shown as
 * the "somewhere else" option rather than dressed up as one of the saved rows.
 */
export function selectedAddressId(state: AddressSelectionState): string | null {
  if (state.addressId && state.optionIds.includes(state.addressId)) return state.addressId;
  // An address that is no longer in the list is about to be replaced, so the
  // control shows what it is being replaced with.
  if (state.addressId) return fallbackAddressId(state);
  if (state.hasLocation) return null;
  return fallbackAddressId(state);
}

/**
 * The address to write into the location, or `null` to leave it alone.
 *
 * One case acts, and it acts once:
 *
 * - **The location holds no valid address.** Fall back to the default address, on
 *   arrival. Not only when the location is empty: a typed area left over from an
 *   earlier visit is replaced too, because the question being asked is "where does
 *   this customer want a professional sent", and the account knows the answer. Once
 *   `settled`, nothing is touched — after that the customer is choosing, not arriving.
 *
 * A saved address that is still in the list is never rewritten, however old the page
 * view is: picking the second of three addresses must not be undone by a re-render.
 */
export function addressToApply(state: AddressSelectionState): string | null {
  if (state.settled) return null;
  if (state.addressId && state.optionIds.includes(state.addressId)) return null;
  return fallbackAddressId(state);
}

/**
 * Whether the location is holding an address id that no longer exists and has to be
 * dropped.
 *
 * **`fallbackAddressId` returning `null` was the gap this closes.** With a
 * non-empty list, a dead id is replaced: the fallback is written into the location
 * and the picker stops naming a row that is not there. With an *empty* list there is
 * nothing to replace it with, so `addressToApply` returned `null`, nothing was
 * applied, and the dead id simply stayed. That is worse than a missing address,
 * because it reads as a chosen one:
 *
 * - `CheckoutForm`'s `needsAddressForm` is `… && !addressId`, so a truthy dead id
 *   means no form is rendered and nothing tells the customer to type an address.
 * - The amber "pick a saved address to continue" notice is also gated on there
 *   being no id, so it stays silent.
 * - `ready = Boolean(addressId)`, so Confirm is enabled — and the create route then
 *   refuses the address it is given, with a 404 for a row the customer cannot see
 *   and did not delete.
 *
 * So the id is cleared, which is what lets `AddressForm` render and puts Confirm
 * back on its own terms. There is nothing to lose by clearing: a location holding an
 * `addressId` holds *only* that id — `selectAddress` writes `{ addressId }` and
 * nothing else — so there is no typed area or browser fix in the same location to
 * discard. `settled` is deliberately *not* a gate here. The latch exists to stop
 * the fallback being re-asserted over a customer who has deliberately chosen
 * something else; it must not pin a dead id to the screen. Deleting your only
 * address in another tab, then coming back to this one, is exactly this case, and
 * `settled` would already be `true` by then.
 *
 * Requiring `loaded` is what keeps a signed-out visitor's typed location alive: a
 * 401 leaves the list `null`, which is `loaded: false`, so a stale id in shared
 * storage is left alone rather than cleared by a page that cannot know whether the
 * account still has addresses.
 */
export function shouldClearAddress(state: AddressSelectionState): boolean {
  return state.loaded && state.optionIds.length === 0 && Boolean(state.addressId);
}