# Phase 1 — Catalogue & availability · Plan

**Goal:** a customer can find a bookable service at their address and see real
slots. That is the §31.1 exit criterion, verbatim, and it is what every task
below is measured against.

## Where this phase starts from

Already in place, from Phase 0:

- `cities`, `localities` (0002), `service_categories`, `services`,
  `service_tasks`, `service_images`, `service_keywords` (0003),
  `service_areas`, `service_durations` and `is_serviceable()` (0004),
  `professionals` + `professional_working_hours` + `professional_time_off`
  (0005), `professional_skills` (0006).
- The seed: Bengaluru, 12 localities, 5 categories, 20 services, duration
  ladders, scope contracts, and coverage — deliberately uneven, so
  `Electronic City` / `Yelahanka` / `Bannerghatta Road` carry Cleaning and
  Kitchen only and `SERVICE_UNAVAILABLE` is reachable with real data.
- The public endpoints land on top of that schema. No Phase 1 feature invents a
  catalogue column.

Not in place, and needed: `addresses`, locality resolution, the slot engine, the
endpoints, the pages, the components, the tests, the docs.

## Tasks

### 1. `0008_addresses.sql`

- `address_type` enum: `home | work | other`.
- `addresses` exactly as §24.6: `customer_id`, `locality_id`, `label`,
  `address_type`, `line1`, `line2`, `area`, `city`, `state`, `pincode`, `lat`,
  `lng`, `landmark`, `access_notes`, `is_default`, timestamps.
- Checks that cost nothing to enforce and are expensive to debug: latitude and
  longitude in range, a six-digit pincode, `line1`/`area` non-empty.
- `uniq_default_address` partial unique index on `(customer_id) where
  is_default`; `idx_addresses_customer`; `idx_addresses_locality`.
- `touch_updated_at` trigger, matching `services` and `professionals`.
- RLS: one policy per verb, all four scoped to
  `customer_id = public.current_customer_id()`. `revoke all … from anon` — the
  catalogue is world-readable, an address is not.
- **Deferred to Phase 2:** `block_address_delete_with_future_bookings()`. It
  references `bookings`, which does not exist. Recorded in `ROADMAP.md` and in a
  comment in the migration, so it is a known gap rather than a forgotten one.

### 2. Type mirror

- `addresses` `Row` / `Insert` / `Update` and the `address_type` enum in
  `lib/supabase.ts`, hand-maintained like the rest of the file.
- `npm run db:schema` to rebuild `supabase/schema.sql`.

### 3. `lib/geo.ts` — locality resolution (§5.4, step 2)

Pure, no database, no `Intl` surprises:

- `haversineKm(a, b)`.
- `localityForPoint(localities, { lat, lng })` — nearest active locality whose
  distance is within that locality's own `radius_km`. Returns `null` when
  nothing is in range; the caller says "not yet available", and SmartHelp never
  guesses a locality it cannot justify.
- `localityByName(localities, area, city?)` — case-insensitive, trims, tolerates
  "HSR Layout" vs "HSR layout". Name wins over coordinates when both are given,
  because a person who typed the locality meant it.
- `resolveLocality(...)` — the combination, reporting `matched_by` so the address
  form can say how it decided.

### 4. `lib/availability.ts` — the slot engine (§9.1)

A pure function, because this is the logic that decides whether a slot is
offered and it deserves unit tests rather than a browser.

Inputs: date, city time zone, duration, granularity, lead minutes, the merged
working windows of the eligible professionals, their busy windows (time off, and
from Phase 5 reservations), `slot_capacity`, and the server clock.

- Wall-clock slots in the city's zone. `wallClockToInstant` is the standard
  two-pass offset inversion via `Intl.DateTimeFormat`, tested in Asia/Kolkata
  and in a DST zone, because getting this wrong books a cleaning slot for 03:00.
- Every candidate start inside a merged working window appears in the answer,
  with `remaining` and a `reason` when it is not bookable — `lead_time`,
  `no_professional_available`, `at_capacity`. The client filters on
  `remaining > 0`; the server never hides a slot it cannot explain.
- `remaining = min(eligible professionals free for the whole window,
  slot_capacity)`.
- `earliestBookableSlot(...)` for `/api/availability/estimate`.

### 5. Validators (`lib/validation.ts`)

- `validateAddressInput` — the §5.2 field list, with latitude/longitude bounds
  and the pincode rule, and no field the table does not have.
- `validateAddressPatch` — a subset of the above; `customer_id` and `id` are not
  reachable from a payload.
- `parseAvailabilityQuery(url)` — `serviceId`, `date`, `duration`,
  `professionalId`, plus the location, and a rejection of "no location at all"
  with a message that says which parameter is missing.

### 6. Server data layer

- `lib/catalogueServer.ts` — categories with counts, the service list under a
  locality filter, one service by slug with its scope and duration ladder, and
  the landing payload. Also `resolveRequestLocality`, the one place that turns
  `addressId` / `lat+lng` / `area` into a locality row — an `addressId` is only
  honoured for the caller who owns it.
- `lib/availabilityServer.ts` — gathers the rows and calls `computeSlots`.

### 7. Public endpoints

| Route | Answers |
|---|---|
| `GET /api/landing` | Categories, featured services, covered localities, verified professional count |
| `GET /api/service-categories` | Active categories with counts and icon keys |
| `GET /api/services` | `q`, `category`, `addressId`, `lat`, `lng`, `area`, `availableOnly` |
| `GET /api/services/[slug]` | Description, scope, images, durations, serviceability |
| `GET /api/availability` | `{ slots, service, location, serverNow }` |
| `GET /api/availability/estimate` | `{ etaMinutes, prosAvailable }` |

All six are anonymous-readable — the catalogue is public reference data and its
RLS policies already say `anon`. `addressId` is the exception: it requires a
session, because it names a private row.

Failures use the catalogue's own codes. An uncovered locality is
`SERVICE_UNAVAILABLE` (422) naming the locality, which is exactly the path the
Phase 0 seed was shaped to make reachable.

### 8. Address endpoints

`GET` / `POST /api/customers/me/addresses`,
`PUT` / `DELETE /api/customers/me/addresses/[id]`,
`POST /api/customers/me/addresses/[id]/default`.

- Customer-only. A professional or staff account has no `customers` row and gets
  `403` with a message that says so rather than a 404.
- First address becomes the default automatically.
- "Set default" is two statements in one RPC, not two round trips that can
  interleave: `set_default_address(p_customer_id, p_address_id)`.
- Every write leaves an audit row. An address is PII; the trail records which
  fields changed, never the coordinates, which `redact()` in `lib/audit.ts`
  already covers by key name.

### 9. Components

`components/ui/EmptyState.tsx`, `components/service/ServiceCard.tsx`,
`components/site/SiteHeader.tsx`, `components/site/SiteFooter.tsx`,
`components/service/CategoryPills.tsx`,
`components/service/CatalogueBrowser.tsx`,
`components/service/ServiceBookingPanel.tsx`,
`components/booking/DurationPicker.tsx`,
`components/booking/SlotPicker.tsx`,
`components/customer/LocationSelector.tsx` (saved addresses, geolocation,
locality search, and the "not yet in your area" badge).

Every list gets skeleton, empty, error-with-retry and populated states. Every
control either works or is not rendered.

### 10. Pages

- `/` — the public landing (§20.1): header, hero, category pills, popular
  services, how-it-works, the professional band, footer. Replaces the
  redirect-only root; a signed-in account sees "Your dashboard" where an
  anonymous visitor sees "Log in".
- `/services` — the catalogue (§20.2), with `cmdk` search, category chips, a
  filter sheet, and the "Not in your area" badge.
- `/services/[slug]` — the detail screen (§20.3): gallery, rating, from-price,
  duration chips, the included/excluded accordion driven by `service_tasks`, the
  materials note, the sticky bar with live slots and the primary action.

### 11. Tests

- `test/geo.test.ts` — haversine, radius boundary, name matching, refusal to
  guess.
- `test/availability.test.ts` — lead time, working hours, capacity, time off,
  duration bounds, the India/DST wall-clock inversion, empty result.
- `test/routes.catalogue.test.ts` — one happy path and one failure path per
  endpoint, including `SERVICE_UNAVAILABLE` on an uncovered locality.
- `test/routes.addresses.test.ts` — create resolves a locality, the first address
  becomes the default, a non-customer is refused, another customer's address is
  not readable or writable.
- `test/validation.test.ts` — the new validators.
- `test/db.rls.test.ts` — addresses isolation against a real database.

### 12. Docs

`docs/DATABASE.md`, `docs/API.md`, `docs/FEATURES.md` in the house style:
tables, direct, candid about the deferrals above. `README.md` moves from "at
Phase 0" to "Phase 1 complete" with the new endpoint table and test counts.

### 13. Verification

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Then, with
explicit approval, `npm run db:migrate`, `npm run db:seed`, `npm run test:db`,
because those touch the live Supabase project.

## Definition of Done

Per §31.2, per feature: migration written and idempotent; RLS policies covered
by an isolation test; Route Handler with validation, error envelope and audit
where privileged; client wired to the real endpoint with no placeholder buttons;
loading, empty, error, success and retry states; unit tests for the logic and
integration tests for one happy and one failure path; human error copy;
responsive at 390 / 768 / 1280 px, keyboard navigable, no colour-only status;
documented in `docs/`.

## Out of scope

Booking creation, pricing and coupons (Phase 2). Payments (Phase 3).
Professional-side availability editing (Phase 4). Matching and reservations
(Phase 5). Admin service management (Phase 6). Anything under `/admin`,
`/professional`, or the customer shell beyond the location selector.
