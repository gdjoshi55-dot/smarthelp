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
| Served, nothing bookable | The engine's own sentence for `day.reason`, not a guess. See "**Why a day is empty**" below |
| Served, slots | The grid |

The results container is `aria-live="polite"` with `aria-busy` while in flight,
so a screen reader is told when the answer changes without being interrupted
mid-sentence.

**Why a day is empty.** `day.reason` says which of these it is, and the copy
follows it:

| `day.reason` | What it means | What the customer reads |
|---|---|---|
| `lead_time` | Every slot on the day falls inside the notice period, or the day has passed | "bookings need {lead} notice. Try another day." — or "every slot for this day has already passed" when the lead is 0 |
| `at_capacity` | The day is full | "that day is fully booked. Try another day." |
| `no_professional_available` | There is cover, but not at any hour the customer asked for | "nobody is free at that time. Try another day." |
| `no_working_hours` | Nobody's schedule covers that weekday | "nobody is working that day. Try another day." |
| `no_professional_on_shift` | The professionals who do the work are eligible, but none is on shift today | "nobody is free for this service today. Try another day." |
| `no_eligible_professional` | Nobody here holds the skill and is verified and trained | "We do not have a professional for this service in your area yet" — and deliberately *not* "try another day", because another day would not help |

The notice period is quoted **only** when the notice period is what refused
the day. It used to be quoted for every empty day, which is how a professional
who was working that day came to read as unavailable: the service area carried
an hour's notice, the day was empty, and the customer was told to wait out a
notice period that had nothing to do with it.

**Presence gates today only.** A professional's live `availability_status`
(`online`, `busy`) is a dispatch signal for *today* — it says they are around
now. It is not a schedule, and applying it to future days emptied the calendar
of professionals who were working. So presence filters the pool for today
only, and future days are driven by `professional_working_hours`. The two
counts are kept apart, which is what lets the engine tell "nobody here does
this work" (`no_eligible_professional`) from "everybody who does is off shift
right now" (`no_professional_on_shift`).

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
| `/professional` | `professional` | A verification-status banner with five copy variants driven by `professionals.verification_status` (not started, in review, verified, rejected, expired); "Today's jobs" **now read live from `GET /api/professionals/me/jobs`**; the availability card **now read live from `GET /api/professionals/me/availability` with a link into `/professional/availability`**; a KYC explainer listing three document types that **links into `/professional/kyc`**; the rating and review count; an earnings panel that stays prose (Phase 8) |
| `/admin` | `admin`, `ops`, `support`, `super_admin` | A greeting by local hour; a table of the caller's `sections`, each marked "Permission granted"; a "Your access" panel showing role, status and section count; a restricted-areas note that varies on `hasCapability('role.manage')` and links nowhere |

> **`/customer` is stale.** The catalogue it says "arrives in Phase 1" is built,
> public, and needs no account. That button should link to `/services`.
>
> **`/professional`'s phase-number copy was wrong, and Phase 4 fixed it.** The
> availability card used to say "Availability and scheduling arrive in Phase 3"
> while `ROADMAP.md` puts the professional app — KYC, working hours, offers inbox —
> in Phase 4. It now reads the real availability state and links into the page.
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
| **Checkout and payment behind the service-detail CTA** — *user-visible* | Phase 2 | **Built.** `/customer/checkout` prices from the database, takes a saved address, creates a booking in `payment_pending` and then opens Razorpay Checkout over the order the server just made — see §4.3 |
| **Service-level aggregate rating on catalogue cards** — *user-visible* | Phase 2 | `ratings` rows are written when a booking is reviewed. `ServiceSummary.rating` is `null` and every card and detail page reads "New". The reviews exist and are readable; the catalogue aggregate does not |
| Booking creation, quote engine, cancel/reschedule, coupons, invoice stub, `bookings` state machine | Phase 2 | **Built** — see §4.2. `quoteToken` is now consumed by `POST /api/payments/create-order`, which asserts its presence. Still missing: there is no consolidated `bookingView` read model |
| Tax, platform fee, surge and the commission split | Phase 2–3 | **Partly built.** Tax, platform fee and the commission split are in `buildQuote()` and stored on the booking. Surge is Phase 3, and `lib/catalogue.ts` still does line-price arithmetic only — which is fine, because nothing calls it for a total any more |
| Razorpay orders, webhook, verify, reconciliation | Phase 3 | **Built** — see §4.3. Still open: refunds, the wallet ledger and the approval console on top of them |
| Professional KYC upload and the verification workflow | Phase 4 | **Built** — the signed-upload trio, the stepper and the admin verdict endpoint; see §6.1 |
| Professional working hours, offers inbox, accept/decline, arrive, on-site OTP, complete | Phase 4 | **Built** — the four professional screens and the job-execution spine; see §6 |
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
are. `docs/API.md` §4.4 has the wire format and `docs/DATABASE.md` §9 has the
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

**A created booking is held, not charged.** The booking lands `payment_pending`
with a slot reserved and a booking number, so a customer can be told what to quote
before any money moves. Taking the money is §4.3 — it happens on the same screen,
one step later, rather than inside `POST /api/bookings`, because a booking that
exists without a payment is a normal state the cron reconciles and a payment that
exists without a booking is a bug.

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

One thing a reader should know is still missing: there is no consolidated
`bookingView` — detail pages assemble their payload from several queries, which is
correct but is more than one call's worth of work per page.

---

### 4.3 Paying, end to end (built)

What the customer does, what the server does, how the three writers of `paid`
agree, and what the cron covers when they cannot. `docs/API.md` §4.5 has the
wire format and `docs/DATABASE.md` §7 has the table and RLS; this is the
behaviour.

**The customer does three things.** Presses *Confirm booking* on the checkout
screen, completes Razorpay's own window, and — if the window is closed without an
answer — presses the button again. The booking is created first and held in the
screen rather than navigated on, so a dismissed window pays for *that* booking
rather than making a second one.

**The server makes an order and a row, in that order.** `POST /api/payments/create-order`
inserts the `payments` row *before* it asks Razorpay for an order: a gateway order
with no row behind it would be invisible to reconciliation and to a refund, while a
row with no `gateway_order_id` is merely incomplete and is exactly what the cron
looks for. It refuses a booking that is not `payment_pending`, a booking with no
`quoteToken`, a `expectedTotal` that no longer matches, and it requires an
`Idempotency-Key` — so a double-tap on a slow connection creates one charge attempt.
The amount comes from `bookings.total_amount`; a client's figure is never read.

**The window opens with the key id the server returned**, from
`https://checkout.razorpay.com/v1/checkout.js`, loaded on demand and never bundled.

**The handler callback may start work and may not conclude it.** This is §12.1's
hard rule and the one a payment UI gets wrong most often: Razorpay's `handler`
fires the instant the window closes, while the authoritative write may still be
in flight. So the callback does exactly two things — fires
`POST /api/payments/verify` (which confirms the booking through the single
writer) and begins polling `GET /api/payments/[id]`. The display state is derived
only from the polled `payments.status` through `paymentDisplayState()`, and
`paid` is reachable only from `success` (or the refund states). A handler payload
fed straight into that function yields `confirming`, and
`test/paymentClient.test.ts` asserts it.

**Loading, error, retry and an honest timeout are all real states.** A `402
PAYMENT_FAILED` shows the gateway's own words, because the server stored them in
`payments.failure_reason` before refusing. Polling gives up after ~30 seconds into
a "still confirming" state where pressing the button asks the row *again* rather
than ordering a second charge. Nothing anywhere claims success it has not read.

**Three writers, one function: `confirm_booking_payment()`.** `paid` is written
in exactly one place — the `0014` SQL function — which moves
`payments.status = 'success'` and `bookings.status = 'paid'` in one transaction
and guards on `status in ('created','pending')`, so any two writers racing still
make one write. It has three callers:

- **`POST /api/payments/verify`** — the customer's own checkout. Its credential
  is the Checkout `handler`'s signature over `order_id|payment_id` under the
  server-only key secret, so a valid signature proves Razorpay issued the pair
  *and* authorisation succeeded. This is the path that closes the loop on a
  deployment Razorpay cannot route to (a laptop, a preview): without it the row
  sat at `created` and the screen said "Confirming payment…" forever.
- **`POST /api/webhooks/razorpay`** — the one unauthenticated route in the tree.
  Its credential is HMAC-SHA256 over the exact bytes Razorpay sent — read with
  `req.text()` before any parse, checked before `JSON.parse`, refused with 400 if
  it does not match. It compares paise against paise before confirming, and it is
  also the only path for `payment.failed` and `refund.processed` (`payment.failed`
  marks the *payment* failed and leaves the booking `payment_pending`, because a
  declined card is a state the customer can leave by paying again).
- **`GET /api/cron/reconcile-payments`** — the gap, below.

Each writer leaves one audit row and `gateway_signature` never reaches any of
them.

**The cron covers the gap.** A customer who paid while every other writer was
unreachable is invisible to every screen. `GET /api/cron/reconcile-payments`
looks at payments still waiting past ten minutes, asks the gateway once per row,
and writes through the *same* `confirm_booking_payment()` the other two call.
Anything that is not a usable gateway answer is counted `unreachable` and left
untouched — writing rows because the gateway answered 503 would confirm payments
that never happened. It is guarded by `CRON_SECRET` over three channels and
answers 503 when the variable is unset.

**Live end-to-end verification is a documented manual step**, in `docs/SETUP.md`
under *Razorpay keys, and the live check that is deliberately manual*. The suite
performs no network call by design (03-CONTEXT decision 1: the signature verifier
is pure and tested with synthetic signatures, the transport is mocked), so the one
thing nobody can automate is a real card and a real gateway signature turning a
booking `paid`.

---

### 4.4 Refunds and the wallet (built)

What money does when it goes back. `docs/API.md` §4.6 has the wire format;
`docs/DATABASE.md` has `refunds`, `wallets` and `wallet_transactions`. The rule
this section describes is the one a support agent actually operates, and the
surface is deliberately the API and nothing else (03-CONTEXT decision 3): there
is no refund screen in this phase, because a console that executes money without
Phase 6's approval workflow behind it would be the wrong half of the feature
first.

**A refund is one of two things, decided by size.** At or below the
`supportRefundLimit` (₹1500 by default) it runs: the money is returned and the
call answers `201`. Above it, the refund is *created and held* — `status:
'requested'`, `202`, `heldForApproval: true` — and nothing moves. Phase 6's
approval console (§25.10) is what executes it. The capability check and the
limit are the same rule seen at two scales: `refund.request` lets support *ask*,
and only amounts that cannot go wrong are allowed to *act*.

**The money goes back the way it came.** A payment that carries a
`gateway_payment_id` is refunded through Razorpay; one without is credited to the
customer's wallet. When the gateway *refuses outright*, the amount falls back to
a wallet credit, and the refund is recorded as `route: 'wallet'` with an ops
ticket — the customer is not the one who should absorb a gateway's decision. A
gateway that merely does not answer is left alone: the request may already have
gone through, and crediting a wallet on top would pay twice.

**A cancelled booking refunds itself.** `POST /api/bookings/[id]/cancel` looks
for captured money, subtracts the cancellation fee and returns the rest — and it
does so **without approval, at any size**. There is no human in that loop and
there should not be one: a cancellation the customer initiated must not strand
their money behind an approver. The one amount that matters for the disclosure at
the point of cancellation is the fee, not the refund — the customer is told what
the cancellation *costs* before they confirm, and the refund is the remainder.

**The wallet is a ledger, not a number.** `apply_wallet_delta()` writes the
balance and its `wallet_transactions` row together, in one transaction, and
refuses an overdraft by name rather than letting the column's `CHECK` answer for
it (`WALLET_OVERDRAFT`, SQLSTATE 23514). Direction is the entry's `type`, never
the sign of the amount, so a credit of `-5` and a debit of `0` are both refused
before anything is written. Two credits arriving at once serialise on the row and
both land — `test/db.wallet.test.ts` asserts each of these against a live project,
and only runs once 0015 is applied.

**The webhook owns `completed`.** `refund.processed` finds the row by
`gateway_refund_id` and finishes it through `complete_booking_refund()` — refund
`completed`, booking `refunded`, `payments.refundable_amount` drawn down, all in
one transaction. A re-delivery is a `{ duplicate: true }` and a refund id the
gateway knows but this server never wrote is a `400` and a `refund.webhook.mismatch`
audit row, because an unknown refund id is not something to guess about. As
everywhere in §12.1, no `gateway_signature` is ever written to an audit row.

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

---

## 6. The professional app (Phase 4, built)

Phase 4 turns `/professional` from a shell into four working screens — the
availability editor, the KYC stepper, the offers inbox and the phone-first job
detail — and builds the server spine they stand on: the offer ledger, the
signed-upload KYC trio, the geofenced arrival, the service OTP and completion.
The customer's booking page gains the live timer and the start-code card through
the deferred track endpoint. Every route here reads the database through the
service role; the browser never talks to `booking_assignments` or `otp_hash`
directly.

### 6.1 KYC, from upload to a verified badge

`POST /api/kyc-documents/upload-url` mints a Supabase **signed upload URL** for
one file. The storage path is the tenant boundary and is built **server-side**
as `${professionalId}/${docType}/${filename}` — never taken from the body — so a
professional cannot name another's folder even if they try. `docType` is on the
three-value allow-list the stepper uses (`identity`/`address`/`selfie`, mapped
onto the `0005` doc-type enum), and the declared size and MIME are checked
against a 5 MB / images-plus-PDF contract. A signed URL cannot enforce bytes, so
the size check is a courtesy refusal with a readable message and the bucket's
`file_size_limit` is the real backstop — the route says so rather than pretending
otherwise.

The browser completes the upload with `uploadToSignedUrl`, then `POST
/api/professionals/me/kyc` records a `status='submitted'` row, upserting on
`(professional_id, doc_type)` so a re-upload after a rejection replaces the file
and restarts review. A verified or already-in-review document is locked by the
`0005` review trigger, which the route surfaces as a 409.

`GET /api/professionals/me/kyc` reports the roll-up `verification_status`
alongside the per-document rows. The payload has no internal reviewer-note field
because `professional_documents` has no such column: "never show internal notes"
is satisfied by there being nothing internal to select. `rejection_reason` is the
feedback *for* the professional, and it is deliberately visible.

The verdict endpoint, `POST /api/admin/professionals/:id/kyc/:docId/decision`, is
**staff-only and ships without a UI** (Phase 6 builds the review queue on it — the
same API-without-UI pattern Phase 3 used for refunds). One RPC applies the verdict
and rolls it up: any required document `rejected` ⇒ the professional is
`rejected`; all required documents `verified` ⇒ `verified` and `kyc_verified_at`
is stamped; otherwise `submitted`. The admin's free-text rejection note is written
by the route, not the RPC, because a note is prose, not a state transition. An
unverified professional never reaches the inbox: `requireVerifiedProfessional`
gates every job route, and the UI shows the amber verification banner instead of
the screen behind it.

### 6.2 Availability

`/professional/availability` is the weekly editor, the time-off list and the one
optimistic control in the phase — the online Switch. The Switch moves first and
the server owns the stored value: `POST /api/professionals/me/availability` accepts
only `online`/`offline` from the browser and never lets a client name `busy` or
`break` (which the matching engine sets), so the response echoes what was stored
for the rollback.

`PUT /api/professionals/me/working-hours` **replaces the whole week** in one call.
A weekly schedule is edited as a set, and a per-window PATCH surface would let a
half-applied week exist between two requests. Two rules the database cannot state
as a column check are enforced in the route: no window may fall outside
00:00–24:00, and two windows on one weekday may not overlap. Both are refused as
field errors, because a raw `23P01` is not something to show a person.

`GET`/`POST`/`DELETE /api/professionals/me/time-off` is the absence list. Every
read and write is filtered by the caller's own `professionals.id`, so one
professional can never read or delete another's. Overlapping time off is refused
by the route before the insert, with a 409, rather than letting a second block sit
silently inside the first.

### 6.3 The offers inbox

An offer is a row in `booking_assignments`: one booking handed to one
professional, expiring in 15 minutes. Two things are structurally impossible and
neither is an application check. A booking cannot have two live offers or
acceptances, because a partial unique index on `booking_id` for the `offered` and
`accepted` states makes a second one unwritable; and one professional cannot
accept two bookings that overlap, because `accept_offer` writes a `reserved`
`professional_schedule` window and the GiST exclusion constraint vetoes the
overlap.

`GET /api/professionals/offers` is the inbox. It runs **Phase 5's**
`run_matching_sweep()` first (Phase 4 shipped only a minimal producer; §7 is the
engine that replaced it whole), which ranks the candidates for every waiting
booking, issues **one** offer per booking under an advisory lock, and refunds any
search that closed empty — so opening the inbox is what drives the marketplace
forward until the §25.11 cron exists. It then **lazily expires** the caller's own
stale offers as a belt, so the countdown on a card is never against an offer the
accept path would refuse. The payload is the OfferCard contract exactly — service
name, window, area only, quoted price, `expiresAt` — and carries no phone, no full
address and no customer name. `stripProBooking(..., 'offered')` enforces the §14.3
privacy gate even before the fields are picked.

`POST …/offers/:id/accept` is the compare-and-set. A second tap, an expired offer
or a stale id makes the RPC affect zero rows ⇒ 409; an overlap with another job
raises `PROFESSIONAL_UNAVAILABLE` ⇒ 409; a cross-professional id is a 404 with
zero writes because ownership is re-checked through the service role before the
RPC. On success the address unlocks — the job is theirs now. `POST …/decline`
records the reason as a tombstone (`rejected`) and then — the Phase 5 cascade —
re-offers the job to the next-ranked professional immediately rather than waiting
for the next inbox open (§7); the response carries `reassigned`, false when the
field was empty.

### 6.4 Job execution: arrive, OTP, complete, no-show

The job-detail screen walks `on_the_way → arrived → otp_verified → in_progress →
completed` through server responses only, and the buttons are derived from the
status so the page cannot offer an action the `0011` state machine forbids.

**Arrival is geofenced.** `POST …/jobs/:id/arrive` computes the Haversine distance
**on the server** against the booking's frozen `address_snapshot`; inside
`defaultArrivalRadiusM` (100 m) the arrival is taken. Outside it — or when the
address carries no coordinates to measure against, which is not the same as "close
enough" — the arrival is refused with a 422 unless a manual override reason is
given. The override is the threat, not the arrival, so its `write_audit` row is
written **before** the RPC: an override that failed downstream is still on the
record.

**The service OTP is the customer's, not the professional's.** The professional's
`POST …/jobs/:id/otp` proves the customer knows the code by typing it; SQL does
the comparison against `bookings.otp_hash` inside `verify_service_otp`, which also
stamps `started_at`/`ends_at` from the server clock in the same statement. A
wrong, expired or locked attempt returns **one generic 403 with the same body** —
distinguishing them to the caller would make the endpoint an oracle. Which of the
three it was reaches the log, and nothing else. The professional can never mint or
see a code.

The plaintext of a service code exists for exactly one moment, in the response of
`POST /api/bookings/:id/otp/regenerate`, which is **customer-only** and only legal
at `arrived`. Only its SHA-256 digest reaches `bookings.otp_hash` (via
`issue_service_otp`), so it can never be read back; generation 1 is the first
mint, and the generation cap is three. The customer's card caches the code in
`sessionStorage` and counts down to the server's expiry. The job starts from the
code the customer can see on their own phone, which is the whole anti-fraud point.

`POST …/complete` is a single multi-effect statement: `in_progress → completed`,
`ended_at`/`actual_duration_minutes` from the server clock, the schedule window
closed, the completed-jobs counter bumped, and exactly one pending
`professional_earnings` row inserted (idempotent on retry). `POST …/no-show`
requires a reason and writes an audit row, and — by hard rule — **touches no
refund and no wallet**: a professional never cancels their own job into money
moving back; that resolution is ops'.

### 6.5 The customer's live view

`GET /api/bookings/:id/track` is the live view both sides poll every 15 seconds,
closing Phase 2's deferral. Two rules decide everything: **the clock is the
server's** (every timer field is computed from the server's `now`, so a phone with
a skewed clock still shows the right "5:20 left"), and **the payload is a
projection, not the row** (it is shaped through `stripProBooking`, so `otp_hash`
and the OTP counters can never appear no matter who asks). Ownership is one
function: a customer and the owning professional both read it, and anyone else
gets the same 404 as a booking that does not exist — the payload carries the
professional's live coordinates, so confirming a stranger's job id is real would
be a reference check nobody needs.

The payload carries `startedAt`, `endsAt`, `serverNow`, `remainingSeconds`,
`extensionAvailable: false` and `extendedMinutes: 0` (extensions are deferred;
the fields ship now so re-enabling later is additive), and `proLocation` — the
professional's coordinates, or `null`. `null` is the honest answer for "we don't
know where they are": no ping yet, a ping too old to be a claim about the present,
or a row with one coordinate and not the other. **No ETA is ever invented** — no
travel model exists, and a made-up number is worse than a missing one. The one OTP
fact the customer needs, `otpExpiresAt`, is lifted out as a top-level field and
only while the booking is `arrived`; the code itself is never here.

### 6.6 The nine decisions, each in one line

- **D1** — `0012` is reclaimed from Phase 5 (the exit criterion is unreachable
  without an assignment row to take); a minimal `sweep_new_bookings` producer
  ships, and Phase 5 replaces it whole.
- **D2** — the admin KYC decision endpoint ships; the admin review UI does not.
- **D3** — the service OTP is minted lazily, customer-gated, at `arrived`; the
  professional's route never sees a plaintext code.
- **D4** — `professional_earnings` ships as a partial `0021`; payout runs, the
  payouts table and the cron stay Phase 8, and the `/professional/earnings` page
  does not ship.
- **D5** — extensions are deferred; the timer payload carries
  `extensionAvailable: false` so the client shape is final now.
- **D6** — tracking ships status, timeline, the OTP-gated timer, `serverNow` and
  `proLocation`; ETA does not.
- **D7** — the geofence radius is a `PLATFORM_DEFAULTS` constant
  (`DEFAULT_ARRIVAL_RADIUS_M`, 100 m); an override requires a reason and audits.
- **D8** — edge-case legs ship detection signals only; hold crons, reassignment
  and late penalties stay Phases 5/9.
- **D9** — no new npm packages, no new crons, no refund UI, no `NEXT_PUBLIC_`
  secrets; `vercel.json` is untouched.

### 6.7 What is deliberately not here

- **No earnings page and no payouts.** The home-page earnings panel stays prose;
  the pending `professional_earnings` row is written by `complete_job` and read by
  nobody until Phase 8.
- **No extension flow.** The timer shows the original window; the client field is
  hard-coded false.
- **No ETA.** `proLocation` is coordinates or `null`, never a number of minutes.
- **No reassignment, ranking or fan-out.** Phase 4's producer made one offer per
  booking to the first eligible professional, no ranking — Phase 5's engine
  replaces it whole (§7).
- **No professional-facing refund or cancel-to-refund path.** A no-show is a
  detection signal; ops owns the resolution.
- Toasts on `/login` come from `react-hot-toast`, whose live-region semantics
  were not checked here.
- `docs/DATABASE.md` and `docs/API.md` are named in the Phase 1 plan and do not
  exist. So does `components/ui/EmptyState.tsx`, and the catalogue's empty and
  error states are bespoke markup instead.

## 7. The matching engine (Phase 5, built)

Phase 4 shipped the offer *ledger* but not the matcher: one line that offered a
paid booking to the first eligible professional in `created_at` order, no ranking.
Phase 5 replaces that producer whole with a ranked engine, a reassignment cascade,
an advisory lock and an exhaustion refund. Migration `0032`, the JS boundary in
`lib/matchingServer.ts`. Phase 6's `0036` then reverses one of Phase 5's decisions —
fan-out is a broadcast, not a round (§7.2) — and Phase 6's admin console (§8) is the
other caller of the same `assign:<booking_id>` lock.

### 7.1 A ranked offer, not a table scan

`rank_candidates` returns the professionals who could take a booking, best first.
Eligibility is the same set Phase 4 used — verified, online, available today,
skilled for every service on the booking, free on the time-off calendar and the
schedule — minus anyone already offered this booking. The order is what the schema
can actually justify: **repeat** first (this professional has completed a job for
this customer before), then **load** (fewest live schedule windows — a busy
professional is offered last), then tenure as a stable tie-break.

**Distance and rating are deliberately absent.** Distance needs the
`earthdistance` extension, which `0002` does not install, and there is no ratings
roll-up until Phase 8. A premium for "nearest" or "highest rated" would therefore
be a fabricated number, so `score` and `distance_km` are written as `null` — the
same honest choice `0012` made when it created the columns. This is the phase's
one visible departure from §9.1's scoring list, and it is recorded rather than
papered over.

### 7.2 Fan-out is a broadcast, and the lock is the choice

§9.1 speaks of "fan-out" — offering one booking to several professionals at once.
`0032` read that as structurally impossible: `uniq_active_assignment_per_booking`
(`0012`) permitted at most one live (`offered`|`accepted`) assignment per booking,
and that index *was* the double-assign guarantee, so the engine offered in rounds.
`0036` (Phase 6) reverses that product decision and makes the broadcast literal.

Many offers may now be live on one booking at the same time. `match_booking` offers
to the **whole ranked candidate list**, best first, instead of `limit 1`, and the
first acceptance wins. The double-accept guarantee moves from the *live* row to the
*accepted* row: `uniq_active_assignment_per_booking` is dropped and
`uniq_accepted_assignment_per_booking` replaces it, so a booking may carry many
`offered` rows but is `accepted` by **at most one professional, ever**.
`uniq_prof_booking_offer` (`0012`) still holds — no professional holds two rows for
the same booking — and the state machine is untouched: `assigned` keeps its meaning
of "dispatched and awaiting an answer", only now many professionals await it.

The lock is what makes the choice deterministic. `match_booking` still runs under
`pg_advisory_xact_lock(hashtext('assign:' || booking_id))`, the same key Phase 4's
`accept_offer`-era code and Phase 6's manual staff assign (`0034`) take, so a
broadcast and a manual action serialise instead of racing for the last offer. An
in-flight round no-ops the next sweep: `match_booking` tops up only once every
offer has been answered. `accept_offer` now takes that lock, writes the winner onto
`bookings.professional_id` (which the matcher deliberately leaves null during a
broadcast), and **withdraws every other live offer on the booking in the same
transaction** — so the job leaves the other inboxes the instant it is taken. Two
accepts racing on different offers resolve cleanly: the lock serialises them, the
first withdraws the second's offer, and the second's compare-and-set then matches
nothing (the route's 409). The round/tombstone columns (`attempt_no`, `round_no`)
stay exactly as the round-based engine used them; a decline or expiry still returns
the booking to `searching` for a fresh broadcast. `test/db.matching.test.ts` keeps
the twenty-concurrent-matchers assertion (exactly one broadcast per round, the
booking `assigned`), and twenty concurrent `match_booking` calls still yield one
offer per eligible professional rather than one per booking.

### 7.3 The reassignment cascade

Phase 4's decline left the booking `assigned` forever, because `0011`'s deployed
transition table had no `assigned -> searching` edge — reassignment did not exist,
so the door had no corridor. `0032` restores that edge (§8.2: "offer expired or
professional declined") and the decline route calls `match_booking` immediately
after tombstoning the offer, so the job is re-offered to the next candidate in the
same request. It never waits for a cron or the next inbox open.

### 7.4 Exhaustion, and the one money path

When the ranked list is empty and the search window (`searchWindowMinutes`, 30
minutes, §16 #20) has closed, the booking walks `searching -> cancelled` with
`cancellation_reason_code = 'no_professional_available'`. The engine stops there;
the refund is a separate, idempotent step in `lib/matchingServer.ts`, because
reaching Razorpay is an HTTP call that must not sit inside a transaction holding
the advisory lock. It is the Phase 3 cancel-of-paid auto-refund, extracted into
one shared `refundCapturedBooking`, called with **fee 0** — nobody provided a
service, so no fee is withheld. One money path, reused and already tested.

### 7.5 What is not here yet

- **Distance and rating scoring** — waits on `earthdistance` and the Phase 8
  ratings roll-up.
- **The true §25.11 cron** — the sweep is invoked on the inbox read and is
  idempotent, so the day a scheduler exists it calls the same RPC unchanged.
- **The 30-minute hold at `arrived` and reassign (§16 #20)** — needs the
  location-ping history and a timer.
- **The `professional_schedule` slot-picker input** — the offer path honours
  reservations; the customer-facing slot list still ignores the table.
- **The instant-booking entry path** — Phase 10 (v2.0) builds auto-assign on top
  of this engine.

## 8. The admin console (Phase 6, built)

Phase 6 is §31.1's exit criterion — *ops can run the marketplace without a database
console* — and nothing more. Migrations `0033`–`0037` add the tables the console
needs, `lib/adminServer.ts` is the staff read model, and ~33 Route Handlers under
`app/api/admin/**` plus the `/admin` shell make the operator's daily loop real
(§4.8 has the endpoint reference). Following Phase 3's precedent, sections whose
*surface* belongs to a later phase ship as API-only rather than as screens (D1): the
notification dispatcher and the analytics report pages wait for Phase 7, and the
payout run for Phase 8.

### 8.1 The shell is the role table, not a second copy of it

`app/admin/layout.tsx` renders the sidebar from `ROLE_SECTIONS` in `lib/roles.ts` —
the same table the browser and the Route Handlers already share — so a screen cannot
appear for a role that the server would then refuse. The dashboard is a one-round
board of counts: today's bookings, completed, cancelled, awaiting a professional
(`paid`/`searching`) and in-progress, today's GMV in rupees, the professional counts
(total/verified/online/pending-KYC) and refunds pending approval. "Today" is
`Asia/Kolkata`, computed as an instant.

### 8.2 Reads are broader than capabilities; writes are where they bite

Every console **read** is gated by the staff allow-list
`['admin','ops','support','super_admin']` rather than by a capability — support can
read the booking queue even though it does not hold `booking.read.all`, because
seeing is not acting. Two reads narrow it deliberately: raw KYC documents
(`['admin','super_admin','ops']` — support is excluded from the private bucket) and
the audit viewer (`audit.read`, admin/super_admin only, because the trail names actors
and carries before/after state). Every **write** calls `requireCapability` and names
its grant. Reads run on the service-role client, which bypasses RLS, so each read
module filters explicitly, and a cross-tenant or unknown id is a **404 with zero
writes** — never a 403 that confirms the row exists. This is the Phase 4 rule, applied
to staff (D3). Every state change leaves one redacted `audit_logs` row (D4).

### 8.3 Bookings: ops cancels by waiving, and assign only raises the chance

`POST …/cancel` (`booking.cancel.any`, held by ops/admin/super_admin — not support)
computes the fee with the same `quoteCancellation()` the customer path uses, but
defaults to **waiving** it: an ops cancellation is not the customer's fault, so §11.2
applies fee 0 unless the operator passes `chargeCustomer: true` to invoke §11.1's
ladder. `admin_cancel_booking` (`0034`) withdraws the holding professional and
releases their calendar in the same statement, under the §9.4 lock.

`POST …/assign` (`booking.assign`) is the manual counterpart to Phase 5's matcher and
differs from it in one deliberate way: **ops raises the chance, it does not forge an
acceptance.** The chosen professional must already be verified (an unverified one is
refused 422 before the RPC), the function raises an ordinary `offered` assignment with
the platform's `offerTtlMinutes`, and the professional still accepts through the
normal flow. It is legal only before the professional is on the way.

### 8.4 KYC review, one verdict or a hundred, and suspension

The review payload (`GET …/professionals/[id]/kyc`) is the only path to the private
`kyc-documents` bucket: it mints short-lived (300 s) signed read URLs after the role
check, and a document whose object has vanished still returns with `signedUrl: null`
so the reviewer sees that something is missing rather than a blank page. A single
verdict accepts only `verified`/`rejected` and refuses anything else with **422** (the
body is well-formed JSON with a bad value). Bulk verdicts (`…/kyc/bulk-decision`) are
counted **per professional, not per document** — every still-pending document for each
id gets the same RPC — and a `rejected` batch must carry a reason (422 without) that is
applied to every document it rejects; a batch is capped at 100 professionals.

Suspension (`pro.suspend`, admin/super_admin only) is two rows and both matter:
`profiles.status = suspended` is what blocks sign-in, and
`professionals.suspended_reason` explains it with availability forced offline.
Reactivation restores the profile but **does not put the professional back online** —
that is theirs to choose.

### 8.5 Refunds, and the second approver

Any staff member reads the refund queue; only `refund.execute` (ops/admin/super_admin)
runs one — a support agent can *request* under `refund.request` but not execute.
Execution reuses the one money path (`executePendingRefund`), which stamps `approved`
**before** the money moves, then goes gateway-first, wallet-on-a-definite-refusal, and
raises an ops ticket if the gateway is unreachable.

The rule worth its own paragraph is §22's dual approval. Above `supportRefundLimit`
(default ₹1500, now a `platform_settings` row), the exporter must be someone **other**
than the requester. If the refund's `requested_by` equals the caller's own id, the
route refuses with `SECOND_APPROVER_REQUIRED` **422** — because a second stamp from the
same person is not a second person.

### 8.6 The catalogue, the pricing ladder, and coupons

Services, service areas and durations are CRUD under `service.manage`. Slugs are
**derived from the name and uniquified**, never hand-typed; a `per_unit` service must
carry a unit label and price; a duration rung needs a price or a multiplier; and the
write validators mirror what the quote engine reads, so a service the console saves can
actually be quoted.

`pricing_rules` is the §7.1 surge-window table — a multiplier scoped
global/category/service, optionally bounded by days of the week and a minute-of-day
window, resolved by the pure `resolveSurgeMultiplier` (narrower scope wins, then
priority, then oldest). **It is built and editable but not yet applied**: nothing in
`buildQuote`/`priceQuote` multiplies by a surge factor, and no rules are seeded — "no
surge" is the empty table, which is the prior behaviour. `cancellation_policies` is the
§11.1 ladder as rows, backfilled from the previous constant, with `hours_before` stored
as the band **ceiling** (`null` = the unbounded "≥ 24 h" row) precisely so the console
and `quoteCancellation()` can never disagree about which band a request falls in. Both
are `pricing.manage` (admin only).

Coupons are managed under `coupon.manage` and have **no delete verb** — a coupon is
deactivated via `isActive`, not removed. Update sends `discountType` and
`discountValue` together, so a discount cannot be reinterpreted under the wrong unit.
The row's `usage_count` is only a cache; `coupon_usage` is the truth, and the detail
shows the ledger.

### 8.7 A ticket is "help me"; a dispute is "adjudicate this"

They share a screen and nothing else. A **support ticket** (`ticket.write`) is triaged —
status, priority, assignee, resolution — with an internal (staff-only) message flagged
`is_internal` so it can never be projected to the customer. A **dispute**
(`dispute.resolve`, ops/admin) is a decision: `investigating`/`resolved`/`rejected`,
with `open` filterable but *not* a decision. In both, `resolved_at`/`resolved_by` are
derived server-side, so a "resolved at" stamp can never disagree with the status.

### 8.8 Settings and the audit trail

The settings editor (`GET` staff-read, `PUT` `role.manage`) writes **only the keys in
the body**, each validated against its declared type, so a partial save cannot blank
the rest; the whole batch is one `settings.update` audit event with per-key
before/after. Support needs to read `supportRefundLimit` to know when a refund needs a
second approver, so the read is open and the write is admin-only. The audit viewer
(`audit.read`) filters by a substring `action` — so `refund.` catches the whole family
— plus entity, actor and a date window, and shows the redacted before/after exactly as
recorded.

### 8.9 What is deliberately not here yet

- **The notification dispatcher and analytics report pages** — the dispatcher is
  Phase 7 (§9); the analytics report pages are still deferred.
- **The payout run** (`/admin/payouts/run`) — `payouts` is a Phase 8 table.
- **Role management** — still no endpoint writes `profiles.role`, so the
  `guard_profile_privileges()` gap in `README.md` remains open.
- **Surge application** — the editor exists; the quote path does not multiply by it.
- **A native admin mobile layout** — §20.14 makes the console desktop-only by
  decision.

## 9. Realtime and notifications (Phase 7, built)

Phase 7 is the phase that makes the product feel alive and keeps people told. It is
deliberately modest about transport: three channels carry change, one dispatcher
writes the record of every message, and *nothing depends on the live socket being up*
— polling is the baseline and Realtime is the accelerator.

### 9.1 The bell, and the dispatcher behind it

Every signed-in account has a bell in the header (`components/notifications/`). It
polls a page of its own `in_app` rows every 15 seconds, badges the unread count, and
opens a list that can mark one row read or all of them. Reads are scoped to
`recipient_id` on the server (`GET /api/notifications`), so the bell can only ever
show its owner's mail.

Behind it, `lib/notifications.ts` is the **only writer** of notification rows in the
application. `dispatch(event)` reads the event's plan — one entry per channel, with
the template code — renders each row from the seeded `notification_templates`, and
moves it `queued → sent | failed`. Two rules shape it:

- **It never throws.** A booking confirms whether or not the mail server is up
  (§28.4). A delivery that fails is *recorded as failed*, with its reason, not
  swallowed and not allowed to break the business action.
- **It tells the truth about delivery** (D1). `in_app` and `push` are `sent` because
  writing the row *is* the delivery. `email` is `failed` — "SMTP is not configured" —
  when the `SMTP_*` variables are unset. `sms` and `whatsapp` are `failed` — "no SMS
  provider configured" — because no provider is wired. The row says what actually
  happened, so "the customer was told" is never a claim the data contradicts.

Every code except `OTP_LOGIN` (which is SMS-only) writes an `in_app` row, so the
report of a notification and the bell always agree. Lifecycle routes call one hook
each right after the write they already make, and the matching engine offers a job
through an optional `onOffered` seam — so the engine stays unaware of notifications
and its unit tests pass against a fake database.

### 9.2 Booking chat

A booking gets a thread, created lazily on first read and **only for a booking with
both participants**. The customer and the assigned professional may read and post;
staff may read but not post (D3). A stranger gets the same 404 a nonexistent booking
gets, so a guessed id reveals nothing. Messages are `text` or `image` (`system` is
server-only, and a client asking for one is refused rather than trusted); posting to
a closed thread is a 409. The thread is **not** optimistically updated — the send
awaits the server and re-reads, so what you see is what was stored.

### 9.3 The three channels, and why polling survives

`hooks/use-realtime.ts` subscribes the browser to `booking:{id}` (the booking row
changes), `me:{profileId}` (a notification arrives) and `chat:{threadId}` (a message
arrives), plus a Presence channel for the professional's live position. Realtime
applies RLS exactly as REST does, so a subscriber receives only rows its role may
SELECT — the publication widens *delivery*, never *visibility*.

The decision that keeps this safe (D4): **Realtime is an optimisation.** Every
subscriber has a polling fallback — 15 seconds generally, 5 seconds on the offers
inbox — and each pushed signal triggers a re-fetch through a Route Handler rather
than trusting the payload. A channel that never connects degrades latency, not the
feature; and there is no path where the socket is the only source of truth.

### 9.4 The template editor

`/admin/notifications` (D6, §25.10) lists the seeded catalogue and lets an
`admin`/`super_admin` edit a template's `subject` (email only), `body`, token list
and active flag. The capability is `notification.manage`, held by those two roles
only — a template is what every customer reads, the same class of change as a role
grant. Edits are audited with the before/after copy. The page does not create or
delete templates; the catalogue is seeded by migration.

### 9.5 The reminders

Two crons close the loop on jobs (D5). `run_service_reminders()` messages the
professional when a job is about to end (`in_progress`, ending within 15 minutes) or
about to start (within the hour, de-duplicated across two disjoint windows);
`run_rating_reminders()` asks the customer to rate a job that completed today. Both
run their whole pass — advisory lock, idempotency guard, inserts — **in one SQL
transaction**, because these codes are Realtime-only and for those channels writing
the row is the delivery, so the lock has to mean something. This is the one
documented exception to "the dispatcher is the only writer".

The crons share `lib/cronGuard.ts` with the Phase 3 payment reconciliation, and the
guard **fails closed**: with `CRON_SECRET` unset the endpoint answers 503 rather than
running open.

### 9.6 What is deliberately not here yet

- **A real push transport.** `notification_devices` registers a token, but there is
  no FCM/APNs provider, so a `push` row records intent, not arrival. Wiring the
  provider is the missing half.
- **An SMS provider.** `sms` and `whatsapp` rows are recorded `failed` on purpose.
- **Delivery retries and a dead-letter queue.** A `failed` row is a record, not a
  queue; nothing re-sends it.
- **Analytics report pages** — deferred with the rest of the Phase 6 reporting.
