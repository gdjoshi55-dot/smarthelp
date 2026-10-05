# SmartHelp features

A walkthrough of what a person can actually do in SmartHelp today, screen by
screen, and an honest list of what is not there yet.

SmartHelp is a service marketplace for home services. Three surfaces exist:

| Surface | Route | What it is for |
|---|---|---|
| Public catalogue | `/`, `/services`, `/services/[slug]` | Finding a bookable service and seeing real slots |
| Customer | `/customer` | Placeholder shell. Role-gated, no product behind it |
| Professional and staff | `/professional`, `/admin` | Placeholder shells. Role-gated, no product behind them |

Of those three, **one is built**. The public catalogue and the sign-in flows are
real: the pages read the same read model the API serves, they work without
JavaScript, and the slot list is computed from the professionals' working hours.
`/customer`, `/professional` and `/admin` are role-gated placeholder shells that
show a signed-in user their role and the sections their role grants, so the
access model can be exercised before there is anything behind it. They are not
the product, and nothing in this document should be read as describing a
dashboard you can work in.

---

## 1. Public catalogue (Phase 1, built)

### 1.1 Landing, `/`

Server-rendered and `force-dynamic`, because two of the numbers on it are live
data — the count of verified professionals and the featured list — and a cached
landing page would go on quoting last month's figures.

What is on the page, in order:

- **Hero.** A headline, three check-marked lines (the third is a live count of
  served localities in the covered city), the search box, the location chip and
  the location banner.
- **Hero search** (`HeroSearch`). One input that answers two different
  questions. A word goes to `/services?q=`; six digits is a pincode, and a
  pincode is a *location*, not a service, so it goes to `/services?area=` and
  the server decides whether we cover it. The component does not fetch. It
  submits, and the answer page owns the fetch, so a shared link and a click
  produce the same thing. The placeholder is built from the first covered
  locality, so it names a real place rather than "your area".
- **Location chip** and **banner**. See §1.5.
- **Coverage card.** Desktop only (`hidden lg:block`). The verified-professional
  count, city and state, how many localities are live, and the first eight
  locality names as chips with a `+N more` tail. There is no mobile
  equivalent of this card.
- **Category section.** Each category as a link to `/services?category=slug`
  with its service count. The whole section is omitted when there are no
  categories.
- **Popular services.** Six featured services in a 2/3/4-column grid. The area
  badge is deliberately suppressed here (`showAreaBadge={false}`): on a page
  where there is no location, "Not in your area" would be a badge about
  nothing.
- **How it works and Why SmartHelp.** Four steps and four reasons, both static
  copy in `app/page.tsx`. `How it works` has the id `how-it-works`, which the
  header and footer link to.
- **Coverage strip.** "Do we come to your street?", every covered locality as a
  chip, and a button to `/services`.
- **Professional band.** "Become a SmartHelp professional" → `/login?tab=signup`.
- **Footer.** `PublicFooter`, four columns of links, plus a line that states
  prices are estimates.

Structured data is emitted as JSON-LD: a `LocalBusiness` node and one `Service`
node per featured service.

> **Caveat on that JSON-LD.** The `LocalBusiness` node carries
> `aggregateRating.ratingValue: '4.8'`, hard-coded in `app/page.tsx`, whenever
> there is at least one featured service — and its `reviewCount` is the sum of
> the featured services' rating counts, which is `0` today because no
> `ratings` rows exist until Phase 2. So the landing page currently advertises a
> 4.8 average with a review count of zero. The detail page's JSON-LD does not
> have this problem: it emits `aggregateRating` only when a real rating exists.
> The landing node should be brought in line with it.

A signed-in visitor is not redirected away from `/`. There is no server-side
session reader in this app, so `PublicHeader` reads the browser's auth context
and offers "Your dashboard" (professional) or "Your account" instead of
guessing.

### 1.2 Catalogue, `/services`

The page renders the whole catalogue on the server with `availableOnly: false`
and no location, because a location only exists in the visitor's browser — from
`localStorage` or a geolocation prompt — and a server-rendered page has not got
one. The browser then asks again with a location as soon as it has one. Two
requests in that order, on purpose: a page that waits for a prompt before
showing a single service shows nothing to everyone who declines.

`CatalogueBrowser` is the client half. Search text and the category are client
state; the list itself comes from the server on every change that could alter
it. A stale answer is discarded by an incrementing request id, so a slow
response to an old question cannot overwrite a newer list.

| Control | Behaviour |
|---|---|
| Search field | 200 ms debounce, so a six-letter word is one request. Spinner inside the field while in flight |
| Category pills | `CategoryPills` with `onSelect`, so they filter in place rather than navigate. `aria-pressed` on each |
| Filters button | Toggles an inline panel. `aria-expanded` on the button |
| Price filter | A range slider, `₹100` to the highest base price in the current result set, in `₹100` steps. Pushing it to the top clears it |
| Job length filter | Any / Under 1 hr / 1 hr or more / Half day, as pills with `aria-pressed` |
| Clear filters | Appears only while a filter is active |
| Show services not yet in *locality* | Appears only once a locality is resolved |

The price and job-length filters are **client-only**. They are not sent to
`/api/services` and not written to the URL, because nothing in the API contract
describes them; a filtered catalogue narrowed in the browser is faster and the
query stays cacheable. `q`, `category` and `area` *are* written to the address
bar with `router.replace(..., { scroll: false })`, so the back button means what
it says and a filtered catalogue is a link somebody can send.

> **The area toggle is inverted from what you would expect, and from what the
> component's own comment says.** `CatalogueBrowser`'s docstring claims that
> `availableOnly` "defaults to true" with a location. The page passes
> `initialAvailableOnly={false}`, so the full catalogue — including services we
> do not serve in the visitor's locality — is shown by default, and the
> checkbox is ticked by default. That is a defensible default (the catalogue
> route is asked for the full list and the server owns the decision about what to
> hide), but the comment contradicts the code and should be corrected.

Four states, all present:

| State | What renders |
|---|---|
| Loading | A `Loader2` spinner inside the search field. There is no skeleton and no skeleton component is used on this page |
| Empty | `SearchX` icon, "Nothing matches that search", and either the count of services hidden for coverage or "Try a different word, or clear the filters." When coverage is the cause and a locality is known, a "Show them anyway" button |
| Error | A red banner with `role="alert"` carrying the API's own message, or a generic "We could not load the catalogue. Please try again." |
| Populated | The grid of `ServiceCard` |

> **There is no retry button.** The Phase 1 definition of done asks for
> "loading, empty, error, success and retry states" per feature, and the retry
> state is the one that is missing. The error banner offers no way back; the
> only thing that re-runs the fetch is changing a control, which is not a
> recovery path for a person who did nothing wrong. `components/ui/skeleton.tsx`
> exists and is unused, so a skeleton grid is also still on the table.

When the out-of-area services are being shown, a footnote under the grid says
how many there are and which locality they are out of.

### 1.3 Service detail, `/services/[slug]`

Server-rendered from the same read model, so the page is indexable and works
without JavaScript. `generateMetadata` produces per-service title, description
and Open Graph image; an unknown slug is a `notFound()`.

- **Breadcrumb.** `nav[aria-label="Breadcrumb"]` through `/services` and the
  category to the service, with `aria-current="page"` on the leaf.
- **Image.** A single `aspect-video` image from `service.image_url`, `alt` from
  the first image row's `alt_text` falling back to the service name.
- **Header.** The service name, the rating line, the duration range ("1 hr" or
  "1 hr to 1 hr 30 min"), and a "Not in your area" line where the locality does
  not serve it. Then the short description.
- **Scope.** `ServiceTasks`, rendered from `service_tasks` — see §1.4.
- **Materials.** A note when `materials_note` is set, or when materials are not
  included, with a written fallback sentence. Omitted entirely when materials
  are included and there is no note.
- **Booking card.** `BookingPanel` in a sticky aside — `lg:sticky
  lg:top-20 lg:self-start`, so "sticky booking bar" means a sticky right column
  at `lg` and nothing at all below it. See §1.6.

> **What the detail page does not have, against the plan.** The plan named a
> *gallery*; what exists is one hero image. `service.images` is fetched and used
> only for `alt_text`. There is no carousel, no thumbnail strip, no second
> image.
>
> There is also no custom `not-found.tsx`, so a bad slug gets Next's default
> 404 rather than anything in the SmartHelp chrome.
>
> The "Not in your area" line in the header is, in practice, dead. It is
> conditioned on `service.serviceable?.ok === false`, and on the server render
> `serviceable` is `null` because no location was supplied. Nothing on this page
> refetches the service: `BookingPanel` calls `/api/availability/estimate` and
> `SlotPicker` calls `/api/availability`, neither of which updates the detail
> payload. So the chip never appears. The out-of-area case is currently surfaced
> in the slot picker instead, as an amber panel (§1.7).
>
> A smaller inconsistency: the visible description prefers `short_description`
> over `description`, while the JSON-LD prefers `description`. The two can
> therefore disagree.

### 1.4 Scope: included and excluded

`ServiceTasks` renders two lists from `service_tasks` and nothing is hardcoded,
which is the point: a scope list that disagrees with the database is a support
ticket and a refund.

- **What's included** is a collapsible, open by default, with a Show/Hide
  toggle and `aria-expanded`.
- **What's not included** is always open with a static heading, on the argument
  that somebody looking for what is *not* included should not have to find it.
- Included carries a green tick; excluded carries a muted cross **and** a
  line-through. The two tones are never mixed in one list, and neither state is
  signalled by colour alone.

The whole section is omitted when the service has no `service_tasks` rows.

### 1.5 Location

A person gives their locality in one of three ways. What the screens need is
the *query string* of whichever they used, not a locality they resolved
themselves, so resolution is the server's job.

**`PublicLocationContext`** holds the input (`area`, `lat`, `lng`), the answer
the API handed back, and four actions. Design points that are worth knowing:

- The **input** is persisted to `localStorage` under
  `smarthelp.publicLocation.v1`, so somebody who types their area once and then
  clicks through to a service is not asked again. A corrupt or unparseable
  store is ignored rather than thrown; the worst case is being asked again.
  Private browsing refusing the write is caught too.
- The **answer** is not persisted. It is a cache of a server decision, and a
  stale one is worse than a re-fetch.
- `setArea` **drops the old pin**. A geolocation fix from one neighbourhood
  vouching for a locality in another is how somebody gets sent to the wrong
  building.
- `reportSummary` accepts a summary only for the *current* query. Somebody who
  typed a new area while the old request was in flight is not told about a
  locality they have moved away from.
- A first visit with **no location is a valid state**, not an error.

**The chip** is the control: it says which locality the results are for, and it
is how you change your mind. Clicking it opens a single text input ("Area or
locality, e.g. Indiranagar"), a **Set** button, a **Near me** button and
Cancel. The `X` inside the chip clears the location. The chip also renders the
`problem` string when the last attempt produced no locality.

**Browser geolocation** is never requested on load — a browser that asks the
moment somebody arrives is a browser that gets refused, and after that the chip
is decoration. It is requested only when **Near me** is pressed, with
`enableHighAccuracy: false`, an 8-second timeout and a 5-minute
`maximumAge`; the fix is rounded to six decimal places. A declined prompt is
treated as a choice rather than a failure, and the copy points at the typed
area instead.

**The banner** renders the server's own sentence and nothing when there is no
location. Silence is the right answer to a question nobody has asked yet, and a
nag about it on a first visit is the wrong first impression. Its tone is amber
when the locality did not resolve and blue when it did, and it appends the
distance when the match came from coordinates.

**How a locality is resolved** (`lib/geo.ts`, pure, no imports):

1. **A named locality beats coordinates.** Somebody who typed "HSR Layout" and
   then let a tower in Jayanagar locate them meant HSR Layout, and preferring
   the tower would put the service at the wrong address. Coordinates are the
   fallback for "Near me", where no name exists at all.
2. Name matching is exact after normalisation (case, whitespace, commas) and
   then falls back through the comma-separated parts and finally a
   prefix-on-a-word-boundary, so "HSR" finds "HSR Layout" and "HS" finds
   nothing. A city name narrows the search when the address names one, which is
   what keeps "Kalyan Nagar" in Bengaluru from colliding with a namesake.
   There is no fuzzy fall-through: a wrong locality silently hides services
   rather than showing a wrong one, and a wrong answer here is much harder to
   notice.
3. A point resolves to the nearest active locality whose own `radius_km` the
   point is inside. The radius is per locality because coverage is not circular
   in the real world — an outer locality may legitimately be a wide spread of
   low-rise blocks.
4. **A point outside every radius resolves to nothing.** SmartHelp never picks
   the closest row and hopes; the caller says "not yet available". A resolution
   that cannot be explained is not a resolution, so `describeResolution` /
   `describeLocation` are part of the return path rather than a debug aid.
5. There is no PostGIS. `0002` indexes `point(lng, lat)` with `btree_gist` and
   stops, so distance is Haversine in TypeScript over the handful of locality
   rows a city has. Haversine rather than the law of cosines, which loses
   precision at exactly the sub-kilometre distances this product cares about.

> **Saved addresses are API-only.** `addresses` exists (migration `0008`) with
> full RLS, the five address endpoints exist
> (`GET`/`POST /api/customers/me/addresses`, `PUT`/`DELETE /[id]`,
> `POST /[id]/default`), and `addressId` is a first-class location form on
> `/api/services` and `/api/availability` — it requires a session, and the row
> is read through the caller's own `customers` row so another customer's address
> is indistinguishable from one that does not exist. **No component passes
> `addressId`.** There is no saved-address picker in any screen; the Phase 1
> plan's `LocationSelector` with saved addresses, geolocation and locality
> search became a chip with two of those three.

### 1.6 The booking card

`BookingPanel` is duration, then the instant estimate, then the slots.

- **Estimated total**, from `priceForDuration`, with the unit label
  (`/ hour`, `/ <unit_label>`) and the line "An estimate. The final price is
  confirmed before you pay."
- **Duration chips** — `DurationPicker` — each carrying the price *for that
  duration*, not the headline rate. The whole point of choosing two hours
  instead of one is seeing what two hours costs.
- **As soon as possible**, a separate request to `/api/availability/estimate`.
  It is separate from the slots on purpose: the answer for *today* is not the
  answer for the selected date, and folding them into one fetch would make the
  headline ETA change every time somebody picked a day, which reads as a bug.
  Changing the duration clears the selected slot and refetches the estimate, so
  a stale number is never quoted next to a new price.
- **Slot picker** — §1.7.
- **Booking for**, the locality the card is pricing, and the location chip so
  it can be changed in place.
- **The primary action.** A disabled button that reads "Select a slot to
  continue" or "Continue with {slot}", with "Booking and payment arrive in the
  next release" under it.

> **That disabled button is a deferral, not a bug**, and it is recorded in
> `ROADMAP.md`. Checkout is Phase 2. The card is honest about the last step
> rather than opening a dead flow, which is the right call — a button labelled
> "Continue" that goes nowhere is worse than one that says what it will do. But
> it does mean the Phase 1 exit criterion is reachable only up to the slot: a
> customer can find a bookable service at their address and see real slots, and
> cannot yet book it.
>
> Note also that this card's "Booking for" line reads from the location
> *context's* summary, and nothing on the detail page publishes one — only
> `CatalogueBrowser` calls `reportSummary`. So that line reads "Location not set"
> even after a successful availability fetch has told the server which locality
> it is. The slot picker picks up the right time zone from its own response, so
> the times are right; the label under the button is not.

### 1.7 The slot picker

Seven days of chips, from today. "Today" and "Tomorrow" are literal; the rest
are short weekday and date labels in the city. The current day is computed in
the **city's** time zone, not the browser's, so a visitor in another time zone
does not start on the wrong day. Each chip carries `aria-pressed`.

The fetch is keyed on `(service, duration, date, location)`, and a response
whose request id is stale is thrown away — three of those four can change while
a request is in flight, and a slot list belonging to the previous duration is
worse than a spinner.

Six states, all of which exist:

| State | What renders |
|---|---|
| No location | "Add your area or share your location to see when somebody can reach you." |
| Loading | Spinner and "Checking availability for {duration}" |
| Uncovered area | Amber panel, `MapPinOff` icon, and the server's own sentence. A 422 whose `details.reason` is `outside_coverage` |
| Other error | Red panel with the server's message |
| Served, nothing bookable | "No slots for {duration} on this day — bookings need {lead} notice. Try another day." The lead time is quoted from the response |
| Served, slots | The grid |

The results container is `aria-live="polite"` with `aria-busy` while in flight,
so a screen reader is told when the answer changes without being interrupted
mid-sentence.

**Why the server never hides a slot.** `computeSlots` returns every candidate
start inside a merged working window, including the ones it will not offer, with
`bookable: false` and a `reason`: `lead_time`, `no_professional_available` or
`at_capacity`. The reasoning is in the code and it is worth repeating: dropping
them would make an empty day indistinguishable from a broken query, and it would
give the client nothing to say when somebody asks why 10:00 is not on the list.
The server never hides a slot it cannot explain.

**What the client then does with them.** It renders `bookable ||
reason !== 'lead_time'`. So:

- `at_capacity` and `no_professional_available` slots **are shown**, greyed out
  and `disabled`, with a `title` of "Fully booked at this time" or "Nobody is
  free at this time". Somebody who can see that 14:00 is at capacity understands
  the day better than one handed a shorter list with no explanation.
- `lead_time` slots **are hidden**. That is a deliberate client-side filter, and
  it is the one thing in this component that contradicts its own docstring, which
  says "Slots that exist but are not bookable are shown greyed with their
  reason" without the exception.
- A slot with `remaining === 1` also carries "1 left" in amber.

`remaining` is `min(professionals free for the whole window, slot_capacity)`.
Working windows are unioned across the eligible professionals, half-open
intervals are used (a job ending at 11:00 does not block one starting at 11:00),
and the grid is walked from each window's own start snapped forward to the next
30-minute boundary, so a 09:07 window yields 09:30 and not 09:07.

One input is not wired to a table yet. §9.1 lists "not already reserved" among
the inputs, and that is `professional_schedule`, created with `bookings` in
Phase 2 and consumed by matching in Phase 5. It arrives as `busy` on each
professional and as `reservations` for the day; today the caller fills the first
from `professional_time_off` and leaves the second empty. The algorithm does not
need to know which is which.

---

## 2. Accounts and sign-in (Phase 0, built)

One page at `/login`, with three tabs over five routes. Everyone signs in with
an **email address and a password**. There is no phone step in sign-in.

| Tab | How you reach it | What it does |
|---|---|---|
| Login | Default. `?tab=login` | One POST to `/api/auth/sign-in`. One request, one session |
| Sign Up | The second tab. `?tab=signup`, which is what the landing page's professional band links to | Email, password, then a six-digit code emailed to that address |
| Forgot password | A link on the Login tab, and `?tab=forgot`. **It has no button in the tab strip** | A code is emailed, the password is changed, the old one stops working |

The tab strip renders Login and Sign Up only. `forgot` is a third value of the
page's `Tab` type reached by link, which is a small inconsistency in a component
that otherwise copies SmartPOS's login page exactly.

The page is a deliberate port of SmartPOS's: same shell, same gradient, same
card, same tab strip, same icon-in-input fields, same "the form is replaced by a
code screen" behaviour, same toast feedback, same footer. What a person sees
here should be something they already know how to use. Three things differ, each
for a stated reason: there is no Migrate tab (SmartHelp has no legacy rows to
migrate), the password rule is SmartHelp's own (eight characters with a letter
and a number, matching `validatePassword` so nothing is only discovered
server-side after the code is already in the inbox), and the code screen has a
resend button.

**The code screen** replaces the form. Six slots in two groups of three with a
separator, a "Verify & Continue" button, Cancel, and a Resend button that
counts down from the server's `resendInSeconds` before it re-enables. A wrong
code clears the input, because six digits sitting in the box looking correct
would tell the person they are further along than they are. Switching tabs
clears the password, the confirmation and any pending sign-up or reset state, so
nothing leaks into the next tab.

**Sign-up** holds the name, phone, email and password client-side and sends
none of it: nothing exists until the code is proven. Only then does
`/api/auth/sign-up/complete` create the account and hand back a session. That is
why there is a "Confirm password" field beyond what SmartPOS has — without it a
typo in the password would be discovered only after the address was proven. The
account type is chosen here ("I need services" / "I offer services") and sets
the role at `/api/auth/sign-up/start`. Phone is optional, validated by a mirror
of `normalizePhone`, and null is what a new account genuinely has.

`?next=` is honoured for the redirect after sign-in, and is accepted only if it
starts with `/` and not `//`. The query string is read off `window.location`
rather than through `useSearchParams`, because `useSearchParams` would put the
whole page behind a Suspense boundary to read two parameters.

### 2.1 Why the codes are issued in SQL

Sign-up and password-reset codes are issued, rate-limited and verified by
`issue_otp` and `consume_otp` in
`supabase/migrations/0001_core_identity.sql`, not in a Route Handler. The
reason is a race: two concurrent requests must not both slip past the
60-second resend throttle, and a check-then-write in a handler cannot prevent
that while a SQL function holding the row can.

The stored code is a salted SHA-256 hash, so the plain code never reaches the
database. The policy is one live code per address per 60 seconds, three wrong
attempts, a ten-minute TTL, and a lockout after that.

### 2.2 Anti-enumeration

Sign-in responses are deliberately identical for a known and an unknown
address, and the password-reset route answers the same way whether or not the
account exists. The code screen never says whether an address is registered.
Neither can be used to discover who has an account.

With no SMTP configured at all, the code is written to the server log and
returned as `devCode` in the response, which is how the flow is run on a laptop.
It is never echoed once a real provider is set.

### 2.3 Session, and what the browser trusts

`AuthContext` establishes the session in one place — on mount and on any auth
event — and reads the profile, role, capabilities and sections from
`/api/auth/me`. Two rules hold it together: the role comes from the server, so
a tampered `localStorage` entry changes nothing, and capabilities are derived by
the same `lib/roles.ts` the Route Handlers use, so the UI can hide what the API
would refuse anyway. The context is a convenience for rendering; it is never the
enforcement, which is RLS plus the Route Handler guards.

`AppOrSetupMessage` sits in the root layout and replaces the entire app with
`NotConfigured` when the browser cannot reach Supabase at all. A missing
`.env.local` is the most common first-run problem, and it used to surface as an
unhandled runtime error with a stack trace: technically accurate, and useless to
whoever is trying to start the project.

> **Two auth routes have no UI.** `/api/auth/staff-sign-in` (staff sign-in with
> an optional MFA code), `/api/auth/professional/apply`, and the older
> `/api/auth/send-otp` + `/api/auth/verify-otp` pair all exist, and
> `AuthContext` still exposes `requestOtp` and `verifyOtp` for the last two —
> but no component calls any of them. Staff sign in with the same email and
> password as everybody else; the MFA step and the professional application
> route are reachable only from a script.

---

## 3. Role shells (partly built)

`/customer`, `/professional` and `/admin` exist and are genuinely role-gated.
They are **not product**. Each one renders a role-specific set of sections, all
of which either read a column the account already has or say plainly that the
thing behind them has not been built. They exist so the access model can be
exercised end to end before there is anything behind it.

**`AuthGuard`** is the one place a page decides whether it may render. While the
session probe is in flight nothing renders, because a redirect fired before the
session is known bounces a signed-in user to `/login` — the kind of bug that
only shows up on a slow connection. Then: no session means
`/login?next=…`; the wrong role means that role's own home, with a guard
against redirecting to the page you are already on, which would spin forever; and
a missing capability means a card that says the area needs a permission the
account does not have. It accepts a *list* of roles, because the staff shell is
deliberately shared and a single-role guard at `/admin` would send ops and
support to the page they are already standing on, forever.

**`RoleShell`** is the frame: a skip link, the wordmark and role label, the
account's name and phone or email, Sign out, and a sidebar built from the
`sections` array `/api/auth/me` returned — which is derived from the role in
the database, so a role cannot gain a tab by patching `localStorage`. Every
section after the first links to `#`.

| Route | Roles | What is actually there |
|---|---|---|
| `/customer` | `customer` | A "Book a service" section whose **Browse services button is disabled** and titled "Arrives in Phase 1"; a hard-coded "No bookings yet"; two stats read from the `customers` row; the referral code with the promise that you both get ₹100; four quick links that all go to `#` |
| `/professional` | `professional` | A verification-status banner with five copy variants driven by `professionals.verification_status` (not started, in review, verified, rejected, expired); "Today's jobs" with a status chip; a KYC explainer listing three document types; the rating and review count; an earnings panel |
| `/admin` | `admin`, `ops`, `support`, `super_admin` | A greeting by local hour; a table of the caller's `sections`, each marked "Permission granted"; a "Your access" panel showing role, status and section count; a restricted-areas note that varies on `hasCapability('role.manage')` and links nowhere |

> **`/customer` is stale.** The catalogue it says "arrives in Phase 1" is built,
> public, and needs no account. That button should link to `/services`.
>
> **`/professional` has a phase-number error in its copy.** "Availability and
> scheduling arrive in Phase 3." `ROADMAP.md` has Payments in Phase 3 and the
> professional app — KYC, working hours, offers inbox — in Phase 4, which is
> what the same page's KYC section says correctly two panels down.
>
> **`/admin`'s marketplace toggle is local-only.** For `super_admin` there is a
> "Marketplace live / paused" checkbox. It is `useState` and nothing else: no
> request, no write, no `platform_settings` row. It resets on reload, and no
> other screen reads it. The page says so under the control, and it is recorded
> as a Phase 6 deferral in `ROADMAP.md`.
>
> **The referral reward is copy only.** "When they complete a booking, you both
> get ₹100" is a Phase 8 feature described on a Phase 0 shell. There is no
> referral endpoint and no wallet.

---

## 4. Bookings

### 4.1 What is still not built

From `ROADMAP.md`. The rows that are **user-visible** gaps are marked; Phase 2
rows are updated in place rather than deleted, so the sequence stays legible.

| Feature | Lands in | Why it is not here |
|---|---|---|
| **Checkout and payment behind the service-detail CTA** — *user-visible* | Phase 2 | **Built.** `/customer/checkout` prices from the database, takes a saved address, and creates a booking in `payment_pending`. Payment itself is Phase 3: the flow stops at "pay next", which is why the CTA says so rather than pretending |
| **Service-level aggregate rating on catalogue cards** — *user-visible* | Phase 2 | `ratings` rows are written when a booking is reviewed. `ServiceSummary.rating` is `null` and every card and detail page reads "New". The reviews exist and are readable; the catalogue aggregate does not |
| Booking creation, quote engine, cancel/reschedule, coupons, invoice stub, `bookings` state machine | Phase 2 | **Built** — see §4.1. Not built: nothing consumes `quoteToken` for payment, and there is no consolidated `bookingView` read model |
| Tax, platform fee, surge and the commission split | Phase 2–3 | **Partly built.** Tax, platform fee and the commission split are in `buildQuote()` and stored on the booking. Surge is Phase 3, and `lib/catalogue.ts` still does line-price arithmetic only — which is fine, because nothing calls it for a total any more |
| Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation | Phase 3 | Not started |
| Professional KYC upload and the verification workflow | Phase 4 | The `kyc-documents` bucket exists and is private. No form |
| Professional working hours, offers inbox, accept/decline, arrive, on-site OTP, complete | Phase 4 | `/professional` is a shell |
| Matching engine, candidate ranking, offer fan-out, advisory locks, reassignment cascade | Phase 5 | Not started |
| `professional_schedule` overlap term in slot availability | Phase 5 | The input parameter exists and is left empty; see §1.7 |
| Admin console: dashboard, bookings, KYC review, services, pricing, payments, coupons, disputes, support, analytics, notifications, settings, audit | Phase 6 | `/admin` is a shell with a local toggle |
| `platform_settings` rows (`instant_lead_minutes`, `max_booking_minutes`) | Phase 6 | Read from `PLATFORM_DEFAULTS` in `lib/constants.ts`, which reads env vars. An admin changing a default needs a deploy today |
| Realtime channels, presence, chat, notification dispatcher, templates, reminders | Phase 7 | Not started |
| Recurring, wallet top-up, referrals, favourites, surge, invoices and PDFs, PWA | Phase 8 | The referral promise is already on `/customer`; nothing is wired to it |
| Security review, RLS audit, load test, accessibility pass, legal pages, runbook | Phase 9 | See §5 for what has been checked so far |
| `block_address_delete_with_future_bookings()` | Phase 2 | **Built** — it needed `bookings`, which now exists |
| Saved-address picker in the UI | Phase 2+ | **Built.** `/customer/checkout` and the booking detail page both use the five endpoints |
| Service image gallery (second image, carousel, thumbnails) | Not scheduled | Only `image_url` is rendered. See §1.3 |
| Mobile navigation on the public chrome | Not scheduled | See §5 |
| Retry state on the catalogue error banner | Not scheduled | See §1.2 |

---

### 4.2 Booking, end to end (built)

What a customer can do today, and the four places where the interesting decisions
are. `docs/API.md` §4.4 has the wire format and `docs/DATABASE.md` §8 has the
functions; this is the behaviour.

**Price it, then keep the price honest.** The catalogue's instant estimate is not a
quote. Checkout calls `POST /api/bookings/quote`, which reads `services`,
`service_durations` and `coupons` and returns a `QuoteBreakdown` plus a signed
`quoteToken` good for fifteen minutes. Creating a booking recomputes the quote and
re-checks the slot — a booking can sit in a tab, and the availability that was
offered ten minutes ago has to still be true when the button is pressed. A token
that was forged, or that belongs to a different cart, is refused before anything is
written. So is a client-supplied `basePrice`; it is rejected rather than ignored,
because an engine fed a browser's price quotes whatever the browser says.

**Paying is Phase 3, and the flow says so.** A created booking is
`payment_pending`, and the detail page says what that state means — the booking is
held, the slot is reserved, taking payment is the next release, nothing is needed
from the customer yet. There is no payment step behind the button, and saying so is
the honest alternative to a button that would go nowhere. A booking number is issued
at create time so a customer can be told what to quote before any money moves.

**Reschedule is a server decision, not a button.** The booking detail page renders
"Reschedule" only when the API's `reschedulable` flag says so. That flag comes from
`RESCHEDULABLE_STATUSES` in `lib/status.ts`, which the route and the page both read —
one list, because a UI that decides this for itself will happily offer reschedule on
a booking the database then refuses, after the customer has already picked a new
slot. A professional who has already set off blocks it regardless of status.

**A booking is written whole or not at all.** `create_booking`, `cancel_booking` and
`transition_booking` are `security definer` functions, so the booking, its item
lines and its first status change land in one transaction. This also fixed an
audit problem rather than only a durability one: privileged writes carry no
`auth.uid()`, so every status change in the history used to be attributed to
`system`. Each function now takes the actor as a parameter and sets it
transaction-locally, so the history can name the customer who asked.

Two things a reader should know are still missing: nothing consumes `quoteToken` for
payment, and there is no consolidated `bookingView` — detail pages assemble their
payload from several queries, which is correct but is more than one call's worth of
work per page.

---

## 5. Accessibility and responsiveness

What follows is what is in the components as they are written. There has been no
screen-reader pass, no automated audit and no device testing, so the claims are
about the markup, not about the experience.

### 5.1 Keyboard

| Thing | What was done |
|---|---|
| `ServiceCard` | A `Link`, not a `div` with an `onClick`. Focusable, shareable, opens in a new tab. Focus ring is explicit |
| `CategoryPills` | Renders `button` with `aria-pressed` when it filters in place, and `Link` with `aria-current="page"` when it navigates. A link that cancels its own navigation is a control pretending to be a link, and screen readers announce it as one |
| `DurationPicker` | `role="radiogroup"` with `role="radio"`, `aria-checked`, roving `tabIndex`, and Arrow Left/Right that both moves the selection and moves focus to it — which is what a radio group does. Three buttons and a tab order is a worse experience for the same markup |
| Day chips, slot chips, filter pills, area toggle, tabs | `aria-pressed` / `aria-checked` / `aria-expanded` where the visual state is a selection |
| Filter disclosure | `aria-expanded` on the button that opens the panel |
| `RoleShell` | A real skip link, `sr-only` until focused |

Search fields on the public pages and the location input have `sr-only` labels.

> **Two keyboard problems.**
>
> The `X` that clears the location is a `<span role="button" tabIndex={0}>`
> **inside** the chip's `<button>`. Nested interactive content inside a button
> is invalid HTML, and it is announced inconsistently — the outer button's own
> activation swallows the inner one's click handler in some engines. It has a
> keyboard handler, so it can be reached, but it should not be inside the
> button.
>
> The login page's `<label>` elements have no `htmlFor` and the inputs have no
> `id`, so they are not programmatically associated with their fields. Clicking
> a label does not focus the input and a screen reader announces the field
> without its name.
>
> Also: the reason for an unbookable slot is carried in `title` on a `disabled`
> button. A disabled button is not focusable and `title` is not reliably
> surfaced on touch, so "Fully booked at this time" is effectively unavailable to
> anybody not using a mouse.

### 5.2 Status is never colour alone

Every state in the catalogue pairs its colour with a word or an icon:
"Not in your area" is text plus `MapPinOff`; an excluded task is an X icon
*and* a line-through *and* the "What's not included" heading; a professional's
verification state is a coloured banner, a distinct icon and a word; an
unbookable slot is grey *and* `disabled` *and* carries "1 left" on its
bookable neighbour. The location banner changes tone by coverage, but it also
changes what it says.

Announcements use `aria-live="polite"` with `aria-busy` on the slot results, so
a screen reader hears the new answer without being cut off; `role="alert"` on
the catalogue error; `role="status"` on the location banner, the chip's problem
text, and the auth guards' loading panels.

Decorative icons are `aria-hidden="true"` throughout `components/catalogue`.
A handful in the role shells and the login page are not.

### 5.3 Responsiveness

Breakpoints used across the catalogue: default (mobile) 2-column grids, `md`
3-column, `lg` 4-column, and 2-column for the slot grid at default rising to 4
at `sm`. Stacked where the content is prose. The day strip and the filter panel
scroll horizontally rather than wrapping.

> **Below 768 px the public header has no navigation.** `PublicHeader`'s `<nav>`
> is `hidden md:flex` and there is no mobile menu, no disclosure and no
> hamburger. At 390 px the header is the wordmark, Log in and Get help; the only
> other navigation on the page is the footer. **How it works** and **For
> professionals** are unreachable from the header on a phone.
>
> The landing page's coverage card is `hidden lg:block`, so the verified
> professional count and the locality list are desktop-only, and the service
> detail page's booking card stops being sticky below `lg` — which is correct for
> a phone, but it means the slot list is no longer reachable from a fixed bar at
> any width.

### 5.4 What could not be verified

- No screen-reader run. Every claim above is from the markup.
- No automated audit (axe, Lighthouse) and no colour-contrast check.
- No testing at 390 / 768 / 1280 px on real devices. The breakpoints are Tailwind
  classes, which is evidence of intent and not evidence of a layout.
- No `prefers-reduced-motion` handling. Nothing needs it today — the only
  animation in the catalogue is `animate-spin` on Lucide's loaders — but no
  reduced-motion block exists, so the first component with a transition that
  matters will need one.
- No keyboard-tab pass over the catalogue in a browser. The handlers are in the
  components; the tab order is not something this document can claim.
- `next/next/no-img-element` is disabled in four places and catalogue images are
  plain `<img>`: cards use `loading="lazy"`, the detail hero does not, which is
  correct, but none of them are sized by the optimiser.
- Toasts on `/login` come from `react-hot-toast`, whose live-region semantics
  were not checked here.
- `docs/DATABASE.md` and `docs/API.md` are named in the Phase 1 plan and do not
  exist. So does `components/ui/EmptyState.tsx`, and the catalogue's empty and
  error states are bespoke markup instead.
