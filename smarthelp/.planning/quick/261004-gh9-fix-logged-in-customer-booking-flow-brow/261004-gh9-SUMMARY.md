---
quick_id: 261004-gh9
slug: fix-logged-in-customer-booking-flow-broken
description: A customer with no saved address could reach checkout and not be able to finish
date: 2026-10-04
mode: quick
status: complete
---

# Quick Task 261004-gh9 Summary

Complete. A signed-in customer with zero saved addresses can now save one at
checkout and finish the booking. 524 tests in 28 files pass; typecheck and lint
are clean. Four commits, `3cad3b1` … `353b0be`.

## The bug

Checkout requires an `addressId`, and the only way to get one was an address
that already existed. `POST /api/customers/me/addresses` was built in Phase 1,
with its RLS, `validateAddressInput`, and the `is_default`-on-first-address rule —
and **no component ever called it**. There is no address form anywhere in the
application: `/customer` has no addresses tab, and the picker's own doc comment
claimed "the addresses tab on the Home page is where an address is created",
which was the false belief the bug was built on.

So the customer reached `CheckoutForm` and found the Confirm button permanently
disabled (`ready = Boolean(addressId) && quote != null && !busy`) and, above it,
the sentence "Pick a saved address to continue." — pointing at a list that did not
exist. Nothing had gone wrong on the server. There was simply nothing on the
page that could reach it.

## What shipped

| Area | Change |
|---|---|
| `lib/addressClient.ts` | `fetchAddresses`, `createAddress`, `AddressApiError`; one authenticated transport |
| `components/catalogue/AddressForm.tsx` | the add-address control, built on that transport |
| `components/catalogue/CheckoutForm.tsx` | renders the form when the loaded list is empty; today's behaviour otherwise |
| `components/catalogue/SavedAddressPicker.tsx` | fetches through the transport; reports the list it loaded |
| `test/addressClient.test.ts` | 19 tests on the transport and the payload |

## Decisions worth remembering

- **The picker reports the list; checkout does not fetch it again.** The picker
  already reads `/api/customers/me/addresses` and already returns `null` when
  there is nothing to pick, so it cannot report that itself. `onLoaded` gives the
  parent the list on a *successful* load only — a 401 is not the same fact as an
  empty list, and a parent told otherwise would offer an address form to a
  visitor who cannot sign in and save one.
- **`onLoaded` is held in a ref.** The fetch effect must depend on `refreshToken`
  and nothing else, or a caller passing an inline arrow re-runs the request on
  every render.
- **`refreshToken`, not a `key`.** A newly saved address has to reach a select
  that is already mounted and already holds an empty list. Remounting would throw
  away state to ask the server the same question twice.
- **The transport, not the component, shapes the payload.** `validateAddressInput`
  reads an allow-list that excludes `customer_id`, so the body is built field by
  field and the test asserts the exact key set. The three fields the server spells
  in snake_case (`address_type`, `access_notes`, `is_default`) are translated in
  the one place that knows about them, so a browser form does not.
- **`lat`/`lng` travel as a pair or not at all.** A half-sent point is dropped
  rather than forwarded: the server refuses one, and its own answer for "no
  coordinates" is the centre of the locality it resolved — which it reports back
  as `locationPrecision`, so the honest thing to show is "the centre of your
  area", not a pin nobody supplied.
- **`AddressForm` restates the server's minimums** so a four-digit pincode does
  not cost a request, and so a message can go under the input that caused it. The
  keys are the *wire* names, because that is what the server fails with.

## The test that found a bug in the fix

`omits a blank optional field rather than sending an empty string` failed on its
first run: `...(input.line2 ? ...)` treats `'   '` as present, and
`validateAddressInput` trims it to `''`, so an address saved with a blank
"Building, floor" stored `''` rather than NULL. Every string is trimmed in the
transport now and an empty one is omitted (`353b0be`). That is the argument for
`lib/addressClient.ts` existing at all: the defect was in a spread operator
inside a component, which no test in this repository can reach.

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | ✔ No ESLint warnings or errors |
| `npx vitest run test/addressClient.test.ts` | 19 passed |
| `npx vitest run` | **524 passed, 28 files**, 213 s — no previously-passing test failed |

(`STATE.md` says 489 tests in 25 files; the suite has grown since, to 505 in 27
before this task's 19. Not caused by this task.)

## Deviations from the plan, and where the code disagreed

- **`setDefaultAddress` was not written.** The plan's file list named it; the
  task's own step 1 named only `fetchAddresses` and `createAddress`. Shipping an
  export no component calls is the dead code `STATE.md` already complains about,
  and `SavedAddressPicker`'s three-state behaviour (which the plan also asks to
  keep) has no set-default control in it.
- **`createAddress` returns `{ address, locationPrecision }`, not a bare id.** A
  superset of what the plan asked for, and the plan's own reason for a callback
  — the picker has to show the new address — needs the address, not just its id.
- **The input type is camelCase, the wire is snake_case.** The plan listed the
  input in wire names. The mapping is in `createAddress`, where it is testable,
  rather than in a form field name.
- **The plan's "shared reload path" is a `refreshToken` prop, not a lifted hook.**
  A hook would have to be instantiated twice (once per component) to serve both,
  which is two fetches — the thing the design is trying to avoid.
- **The `SavedAddressPicker` comment about a Home-page addresses tab was
  corrected.** It documented a screen that does not exist, and it is the belief
  the bug was built on.
- **No `lat`/`lng` input in the form.** The plan's field list mirrors
  `validateAddressInput`; collecting a point needs `navigator.geolocation`, and
  the server's behaviour without one is already designed and reported
  (`locationPrecision: 'locality_centre'`). The form says so before saving rather
  than collecting a coordinate it cannot validate.

## Still open — the same dead end, one case over

A customer whose stored `addressId` names a row that has since been **deleted**
gets no address control (the list is empty, `addressId` is truthy, so neither the
form nor the notice renders) and an enabled Confirm button that will 404 on
submit. This predates the fix and is unchanged by it: `SavedAddressPicker` falls
back to the default for *display* only. Fixing it means clearing a stale
selection, which reaches `BookingPanel` and `localStorage` and is a wider change
than this task was scoped to.

## Notes on the commits

`CheckoutForm.tsx` and `SavedAddressPicker.tsx` were **untracked** before this
task, so `2593fa7` also lands the pre-existing Phase 2 content of both files. The
commit says so in its message. No `git add -A`, no `-a` flag, and nothing outside
the five files above was staged; the other 20 modified and 40 untracked paths in
the tree are exactly as they were found.
