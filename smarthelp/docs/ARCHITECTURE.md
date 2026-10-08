# Architecture

How the code is arranged, and why. `docs/SETUP.md` covers getting it running,
`docs/DATABASE.md` covers the schema, `docs/API.md` covers the endpoints and
`docs/FEATURES.md` covers what a person can do. This document covers the shape:
what runs where, what talks to what, and which decisions were deliberate.

Read it if you are about to add a route, move logic between the browser and the
server, or change how a request is authenticated.

---

## 1. The shape of it

SmartHelp is **one Next.js 14 App Router application**. There is no separate API
service, no worker process and no queue. The Route Handlers under `app/api/` run
in the same Node runtime, in the same process, as the pages that call them.

That is the single most load-bearing decision in the repository, and everything
else follows from it: there is no network hop between the page and its data, no
second deployment to keep in step, and no service boundary to defend with a
second set of credentials. The cost is that anything requiring a privileged
network position — a long job, a fan-out, a retry sweep — has nowhere to go yet,
and is written as a function the request awaits.

```
                    ONE DEPLOYMENT

  Next.js 14 · App Router · Node runtime

  app/**/page.tsx            app/api/**/route.ts
  Server Components          Route Handlers
  and 'use client'           21 files, 24 handlers
        │                           │
        │      every one of them     │
        │      declares nodejs and   │
        │      force-dynamic         │
        └────────────┬──────────────┘
                     │
                     ▼
                  lib/  —  the only shared layer
                     │
        ┌────────────┴──────────────┐
        ▼                           ▼
   PostgREST / Auth              Storage
   (Supabase project)            (6 buckets)
```

Three product surfaces are served from that one deployment:

| Surface | Routes | State |
|---|---|---|
| Public catalogue | `/`, `/services`, `/services/[slug]` | Built |
| Customer | `/customer` | Role-gated placeholder shell |
| Professional and staff | `/professional`, `/admin` | Role-gated placeholder shells |

The two role shells are client components behind `AuthGuard`, which exists so
the access model can be exercised before there is a product behind it. Nothing
in this document should be read as describing a dashboard that works.

### Runtime facts that are load-bearing

Every one of the 21 Route Handler files declares:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

No route is cached, no route runs on the Edge runtime, and no route is eligible
for static optimisation. Both are deliberate:

- `force-dynamic` because the catalogue carries live counts — verified
  professionals, availability status, a booking total — and a cached response
  would keep quoting numbers that have moved.
- `nodejs` because `lib/supabaseServer.ts` reads `process.env` at call time and
  the database client is Node-only.

The three public pages declare `dynamic = 'force-dynamic'` for the same reason;
they are Server Components that read the same read model the API serves, so the
first paint is real data rather than a spinner over a fetch.

---

## 2. Data flow

Two Supabase clients exist, plus a third factory that has no caller in the
product today. All of them read the same project.

```
   BROWSER                    SERVER                        SUPABASE
   ───────                    ──────                        ────────

   │                              │                         │
   │ fetch('/api/services')       │                         │
   ▼                              │                         │
   Route Handler                  │                         │ PostgREST + Auth
   │                              │                         │
   │ validateX(body)              │                         │
   │                              │                         │
   │ requireAuth(req)             │                         │ auth.getUser(token)
   │                              │                         │
   │ service-role query           │                         │ RLS bypassed
   │                              │                         │
   │ audit()                      │                         │
   ▼                              │                         │
   ok(data) | error envelope      │                         │
```

The auth path runs alongside it: `contexts/AuthContext.tsx` holds a session from
the anon key through `supabase.auth.*` and never touches a table, and
`requireAuth()` on the server turns the bearer token that request carries into
the same Supabase session, then reads the `profiles` row behind it.

### The browser client — `lib/supabase.ts`

Anon key only, so every query it makes is subject to RLS, which is the point.
Three properties are worth knowing:

- **Built lazily behind a `Proxy`.** `createClient` throws when the URL is
  missing, and a throw at module scope takes down the prerender of every page
  that transitively imports the file — including `next build` itself. A missing
  key should be one clear message at the moment a caller asks, not a wall of
  unrelated build errors.
- **Environment lookups are literal on purpose.** `process.env.NEXT_PUBLIC_URL`
  is written out in full rather than through an index, because Next only inlines
  a value it can see spelled out. `process.env[key]` compiles to a lookup on the
  `{}` that stands in for `process.env` in the browser and reads `undefined` for
  every key. `test/env-inlining.test.ts` guards the pattern, because it is a bug
  that sits green through a build and the whole mocked suite.
- **Auth only.** No component reads a table through it. Ten files import from
  this module, but eight of them take `import type` — `UserRole`, `Address`,
  `TablesUpdate` — which is erased at compile time and pulls no client into the
  bundle. Exactly two import the client: `contexts/AuthContext.tsx`, for the
  session, and `components/ui/ImageUpload.tsx`, for a storage upload. Neither one
  selects from a table.

`app/layout.tsx` wraps every route in `AppOrSetupMessage`, which reads
`supabaseConfigError()` and swaps the whole app for a setup screen. A missing
`.env.local` reads as a setup step rather than a crash on every route at once.

### The server client — `lib/supabaseServer.ts`

`createServerClient()` carries the service-role key, which **bypasses RLS**. That
is the central trade in the codebase:

- **It buys** simple, predictable queries. The catalogue is public reference
  data whose policies already admit `anon`; reading it as the service role simply
  skips a round trip of policy evaluation. The address handlers can filter to the
  caller's own `customer_id` in one place, in the query, instead of relying on a
  policy to do it.
- **It costs** the guarantee that the database is the last line of defence. A
  handler that forgets its ownership filter leaks the row. This is why the
  ordering rule in the module header is not advice:

  ```
  authenticate  →  authorise  →  act
  ```

  `requireAuth()` first, always, before any service-role query touches a private
  row. The docstring says the key must never be imported by a client component
  and never used before the caller is authorised; the second half is the one that
  actually matters and the one that is easy to break in a hurry.

`createRequestClient(accessToken)` builds a third client: anon key, but with the
caller's own bearer token, so queries run *as the caller* with RLS active. It
exists for the case where RLS should keep doing the work — "list a customer's own
bookings without a hand-written filter". **Nothing in `app/` calls it.** It is
mocked in four test files and used nowhere else. See the discrepancies section
below for the comment that claims otherwise.

### What runs where

| Concern | Browser | Server only |
|---|---|---|
| Session, sign-in, sign-out | yes | no |
| Capability table (`lib/roles.ts`) | yes | yes |
| Availability algorithm | yes (pure, `now` injected) | yes |
| Catalogue and geo resolution | yes (types only) | yes (the queries) |
| Validation | re-implemented per form | yes, authoritative |
| Audit writes | never | yes |
| Anything service-role | never | yes |

`lib/availability.ts` and `lib/geo.ts` are deliberately isomorphic. They are pure,
import nothing from a server module, and take the clock as a parameter, so the
same code answers in a Route Handler, in a Server Component and in a unit test.
The availability client types in `lib/catalogueClientTypes.ts` are compositions of
the server's own types rather than copies, so a change to the payload type
propagates to the browser without anyone remembering to update two files.

### Import boundaries worth enforcing

`lib/` is not one directory; it is three, and the split is load-bearing.

```
browser-safe         server-only                   straddles the boundary
lib/roles.ts         lib/supabaseServer.ts         lib/api.ts
lib/constants.ts     lib/validation.ts             lib/catalogueClient.ts
lib/geo.ts           lib/catalogueServer.ts
lib/availability.ts  lib/availabilityServer.ts
lib/catalogue.ts     lib/addressServer.ts
lib/utils.ts         lib/otp.ts
lib/supabase.ts      lib/audit.ts
lib/catalogueClientTypes.ts   lib/authServer.ts
                       lib/sessionServer.ts
                       lib/owner.ts
```

The rule is that a browser-safe module imports nothing from a server-only one.
`lib/validation.ts` currently breaks it: its header says "The same functions are
imported by client components, so a field can be checked in the form and again on
the server", but it imports `createServerClient`, and no component imports it.
`app/login/page.tsx:66` mirrors `normalizePhone` by hand instead, which works and
is what the code actually does — but it means the header is describing an
intention rather than a fact, and a form that forgets the mirror loses the
early check.

`lib/api.ts` and `lib/catalogueClient.ts` are the two that straddle it.
`AuthContext` imports `readApiError` from `lib/api.ts`, which imports
`NextResponse` from `next/server`. Next resolves that, so it works — but the
envelope module is not cleanly separable, and the client half of the browser API
is one import away from pulling server code into a bundle.

---

## 3. Request lifecycle

Every Route Handler is wrapped in `handle()` from `lib/api.ts`, which is the only
place a request id is minted and the only place an unexpected throw becomes a
response.

```
  browser
    │  Authorization: Bearer <access token>
    ▼

  handle(req, name, fn)
  ────────────────────────
    requestId = req.headers['x-request-id'] ?? crypto.randomUUID()

    try
      1  parse    validateX(body)  →  explicit allow-list
      2  authn    requireAuth(req, roles?)
                   └→ profiles row — the role the database holds
      3  authz    can(role, capability)  /  ownership filter
      4  act      service-role query, joins in TypeScript
      5  audit    audit() on every state change
      6  answer   ok(data) | created(data)
    catch ApiHttpError   its code, status, message, details
    catch anything else  console.error(`[id] name failed:`)
                        then INTERNAL_ERROR 500, generic text

    response header:  x-request-id
```

### The request id

`handle()` reads `x-request-id` or generates a UUID, and writes it back on the
response header. The id is passed *into* `fn`, which is how an audit row and a
log line end up carrying the same string. Two properties matter:

- **Nothing sensitive is logged.** The catch branch logs `e?.message`, never the
  request body, never a token, an OTP, a password or a payment secret.
- **The 500 body is deliberately vague.** `'Something went wrong on our side.
  Please try again.'` with the real `requestId` — the detail goes to the log line,
  not to the client.

`err()` is the one gap: it is the hand-written error helper and it hardcodes
`requestId: 'server'`, because it is not called from inside `handle()`. Any route
that returns `err()` directly rather than throwing is shipping an error without a
correlation id. No route does today, which is why it is a note rather than a
bug.

### Where authorisation actually happens

Three layers, checked in this order. The first is a schema property, so it holds
even if the code is wrong:

1. **Column and table grants, plus RLS.** The database refuses what the caller may
   not see. `addresses` has no `anon` grant at all and no policy an anonymous
   session could satisfy, because `current_customer_id()` is null without an
   `auth.uid()` and `NULL = NULL` is false in a `using` clause.
2. **`requireAuth()` / `requireCapability()`.** Resolves the bearer token, then
   loads the `profiles` row, so the role is the one the database holds and never
   one the client asserted. Refuses a missing, expired or unprofiled token, and
   `deleted` / `suspended` / `blocked` accounts.
3. **The capability table.** `can(role, capability)` reads `lib/roles.ts`, which is
   imported by both the browser and the handlers so the two cannot disagree about
   who may do what. There is no role hierarchy: every capability is an explicit
   grant, and `super_admin` holds `'*'` which `capabilitiesFor()` expands, because
   a client that tested `capabilities.includes('role.manage')` would read `'*'`
   as a denial and lock the owner out.

Ownership is never a parameter. `customer_id` is not in any validator's
allow-list and cannot be reached from a payload; the caller is resolved from the
token and their `customers` row, and every query is filtered to it.

---

## 4. The tree

```
app/
  layout.tsx                  Root layout. AuthProvider + AppOrSetupMessage +
                              Toaster. The setup screen lives here so a missing
                              .env.local reads as one message on every route.
  page.tsx                    Public landing. Server Component, force-dynamic.
                              Reads getLanding() — the same read model the API
                              serves, so a card here and GET /api/landing agree.
  login/page.tsx              Client. Sign-in, sign-up, OTP and password reset in
                              one form. Mirrors normalizePhone by hand.
  services/
    page.tsx                  Server. The catalogue, rendered from getCatalogue().
                              First read is deliberately location-free.
    [slug]/page.tsx           Server. One service, with tasks, images, durations.
  customer|professional|admin/
    page.tsx                  Client placeholder shells behind AuthGuard.

  api/                        21 files, 24 handlers. All nodejs + force-dynamic.
    auth/                     12 files, 13 handlers: sign-in, sign-up, OTP,
                              password reset, refresh, me (GET + PUT).
    services/route.ts         The catalogue.
    services/[slug]/route.ts  One service.
    service-categories/       Categories with counts.
    landing/                  Everything the landing page needs, one round trip.
    availability/             Slots for one service, one day, one duration.
    availability/estimate/    Instant price estimate, no date.
    customers/me/addresses/   GET + POST; [id] PUT + DELETE (2 handlers);
                              [id]/default POST.

lib/
  # Isomorphic — no server-only import
  roles.ts                    The capability table. The one place permissions
                              live. Client and server both read it.
  constants.ts                Slot granularity, OTP policy numbers, route paths,
                              PLATFORM_DEFAULTS. Anything a business can change
                              belongs in a database row, not here.
  geo.ts                      Locality resolution. Pure, imports nothing.
  availability.ts             The slot algorithm. Pure, clock injected.
  catalogue.ts                Presentation helpers and payload shapes: prices,
                              durations, ratings, display labels.
  catalogueClientTypes.ts     The exact Route Handler payloads, composed from the
                              modules the routes build them with.
  utils.ts                    cn(), formatCurrency(), formatDate().

  # Server-only — never import from a client component
  supabaseServer.ts           createServerClient() (service role, bypasses RLS)
                              and createRequestClient() (anon + caller's token).
  validation.ts               Field primitives, one validator per payload, and
                              requireAuth / requireCapability / requireStaff /
                              requireAdmin.
  api.ts                      The envelope: ok, created, noContent, err,
                              validationError, ApiHttpError, handle, readApiError.
  audit.ts                    audit() through the write_audit() RPC, plus redact()
                              and clientIp().
  owner.ts                    The super_admin bootstrap allow-list. Reads only the
                              server-only variable, never the NEXT_PUBLIC_ one.
  authServer.ts               Phone-first identities, synthetic .invalid addresses,
                              the generateLink token_hash handshake.
  sessionServer.ts            A correct password becomes a granted session, with
                              the role and status gates applied from the database.
  otp.ts                      Code generation, salted-hash ledger, SMTP delivery.
  catalogueServer.ts          The catalogue read model. One place that knows how
                              to answer "what can be booked, and where".
  availabilityServer.ts       Gathers the rows the slot algorithm decides from.
  addressServer.ts            The address write model: who may read it, what the
                              locality becomes, what the first address does.

contexts/AuthContext.tsx      Session, profile, role, capabilities, and the sign-in
                              flows. A convenience for rendering — never the
                              enforcement.

components/
  auth/                       AuthGuard (the one place a page decides whether it
                              may render), RoleShell, AppOrSetupMessage,
                              NotConfigured.
  catalogue/                  The public surface: CatalogueBrowser, SlotPicker,
                              BookingPanel, DurationPicker, LocationChip,
                              PublicLocationContext, PublicChrome.
  ui/                         shadcn primitives, mostly unused. ImageUpload is
                              unreferenced and points at a bucket that does not
                              exist here.

supabase/
  migrations/                 0000–0008, 0024–0027. The source of truth. Every file
                              is idempotent.
  schema.sql                  Generated from the migrations by db:schema. Never
                              hand-edited.

scripts/                      Node, no psql. _db.mjs is the shared plumbing: read a
                              value out of .env.local and open a connection.
                              apply-migrations.mjs keeps a ledger so a re-run is
                              safe. build-schema.mjs regenerates schema.sql.
                              db-check, verify-seed, describe-auth, verify-smtp.

test/                         15 files, 273 tests. Mocked by default; db.rls.test.ts
                              needs a live database.
```

---

## 5. Design decisions and what they cost

| Decision | Why | What it costs |
|---|---|---|
| **One Next.js deployment, no separate API service** | No network hop between page and data; no second deploy; no second set of credentials to defend | No place for long jobs or retries. Anything slow is awaited inside a request, and the answer is a `limit` or a deferral |
| **Service-role client in every handler** | Ownership lives in one place — the query — rather than in a policy per table; the catalogue skips policy evaluation entirely | RLS stops being the backstop for handler bugs. The cost is paid in the ordering rule, and one forgotten filter is a leak |
| **No middleware** | Next middleware would have to re-implement the session read to be worth having; `AuthGuard` and `requireAuth()` already read the role from the database | A signed-in role shell renders a spinner before it redirects. There is no server-side gate on `/customer`, `/admin` or `/professional` — the gate is the handler and the policy |
| **Availability derived, never stored** | A stored boolean goes stale the moment a professional's hours, time off or capacity changes. The derivation is a pure function with the clock injected, so it is testable at the interesting cases ("an hour ago", "midnight in Asia/Kolkata") | Every availability read does the work. Fine at this size, not at Phase 5 volume |
| **The pure/server split in `availability.ts` / `availabilityServer.ts`** | The algorithm is where the bugs live, so it gets a clock parameter and no I/O; the row-gathering is the boring part that can be replaced when the data shape changes | Two files to keep in step for one feature |
| **No PostGIS** | `0002_geo.sql` indexes `point(lng, lat)` with `btree_gist` and stops there. A city has a handful of localities | Distance is Haversine in TypeScript. A "find every address within 2 km" query across a growing table becomes a real problem |
| **No `anon` grant on `addresses`** | An address is where somebody lives, and `access_notes` describes how to get in. No grant, and no policy an anonymous session could satisfy | Staff support tooling has to go through a handler. That is the intended cost |
| **`is_trusted_session()` as the discriminator** | `coalesce(current_setting('request.jwt.claim.role', true), '') = ''` is true only when no role claim is attached. PostgREST always sets it, so it can only be true for a session with no user — a direct database connection, which is the migration runner and the seed | A privilege check now depends on a GUC that is set by PostgREST rather than by Postgres. The test helper has to imitate PostgREST carefully to avoid a false pass |
| **`set search_path = public` on every function** | A `security definer` function that resolves names through the caller's `search_path` is a hijack waiting to happen. The two pgcrypto functions use `public, extensions` because that is where `digest()` lives | Every function must remember it. A forgotten `search_path` on a new function is a silent exposure |
| **Hand-maintained `Database` types in `lib/supabase.ts`** | Only the current phase's tables are declared, so the type errors point at real work rather than at eight phases of tables that do not exist | Regeneration is a manual diff. `Relationships: []` is asserted by a shim rather than regenerated, because supabase-js rejects the type without it and degrades silently to `never` |
| **The migration-owner connection in tests** | `SUPABASE_DB_URL` is what a project gives you, and `pg` avoids a `psql` dependency that is not installed on a typical Windows dev box | **It bypasses RLS.** The suite can assert that a policy *exists* and that grants are in place; it cannot assert what a policy *admits*. That is what `sqlAsRole()` exists to fix — see below |
| **Hand-written validators, no zod and no ORM** | An explicit allow-list with length caps is easier to audit than a schema string, and a field absent from the list is a field the route cannot write | One function per payload, and the client half has to mirror it by hand where the import is not possible |

---

## 6. Build and test

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `start` | Production build |
| `npm run lint` / `typecheck` | `next lint` / `tsc --noEmit` |
| `npm test` | The whole suite. Database tests skip loudly without a connection |
| `npm run test:db` | `test/db.rls.test.ts` alone |
| `npm run db:migrate` | Apply outstanding migrations, in filename order, against a ledger |
| `npm run db:seed` | Apply `supabase/seed.sql` |
| `npm run db:schema` | Rebuild `supabase/schema.sql` from the migrations |
| `npm run db:check` / `db:status` / `db:verify` / `db:auth-schema` | Reachability, migration status, sign-in as each demo account, `auth` schema columns |
| `npm run smtp:verify` | TLS handshake and AUTH round trip, sends nothing |

Migrations are the source of truth and `schema.sql` is generated from them. After
changing a migration, run `db:schema` and then check that the types in
`lib/supabase.ts` still describe the database.

`next.config.mjs` is empty. There is no image domain allowlist, no rewrite, no
header set — the app adds no `Cache-Control` of its own beyond what
`force-dynamic` and `cache: 'no-store'` already imply.

### The test split

Two suites with different jobs.

**Mocked — 243 tests across 14 files.** Validators, the envelope, the role table,
the OTP policy, the owner allow-list, the `NEXT_PUBLIC_` inlining guard, the pure
modules, and the Route Handlers against a fake service-role client. The fake
records every table a route touched, so a test can assert *which row was written*
rather than merely that something was.

`vitest.config.ts` supplies placeholder credentials in `process.env`, because the
Route Handler tests import modules that read them at module scope, and maps `@`
to the project root. `.env.local` is deliberately **not** loaded: the suite must
not quietly pass against a real project, and `test/helpers/dbEnv.ts` reads the
file itself where a real connection is genuinely wanted.

The fake always succeeds, which is the whole reason the second suite exists — a
failure inside GoTrue is exactly what the signup bug in `README.md` was, and a
fake client cannot see it.

**Live database — 30 tests in `test/db.rls.test.ts`.** Whether RLS is enabled on
every table in `public`, whether any policy exposes every profile, whether the
six buckets exist, whether the OTP ledger salts, throttles, locks and expires,
whether the audit trail refuses to be edited, whether `addresses` stays private
to its owner across sessions, and whether `admin.createUser` provisions a usable
account.

### `sqlAsRole()` and what the live suite still cannot prove

Most of the live suite connects as the migration owner, which has `BYPASSRLS`.
That is enough to assert a policy *exists* and the grants are in place. It cannot
answer the question that actually matters for a table like `addresses`: does
customer A's session reach customer B's row?

`test/helpers/dbEnv.ts:127` answers it by impersonating instead:

```ts
await c.query('begin');
await c.query('set local role authenticated');
await c.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
await c.query('select set_config($1, $2, true)', ['request.jwt.claim.role', role]);
await c.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', userId]);
```

Four details carry the whole mechanism:

- **`set local role authenticated`** drops the owner privileges for the
  transaction, so RLS applies.
- **The claims blob** is what PostgREST would have set, so `auth.uid()` resolves.
- **`request.jwt.claim.role` is not redundant.** `is_trusted_session()` reads that
  specific GUC and treats an *empty* setting as "this is the server, trust it".
  Leaving it unset would make every impersonated user look like the service role,
  and the ownership checks would pass for the wrong reason.
- **`set_config(..., true)` is transaction-local**, and the transaction is always
  closed. The connection is shared across the file, so a leaked open transaction
  would leave the next test running as `authenticated` and answering the wrong
  question.

Why it matters: a forbidden `select` returns no rows rather than raising, so the
assertions count rows — which is also how the failure presents in production.

What remains unproven, and cannot be closed by this suite:

- **The remaining policies.** Address isolation is now covered through
  `sqlAsRole()` — six tests, including the update, delete and insert paths and the
  `security definer` RPC — but the catalogue, geography, skills and document
  policies are still only asserted to exist.
- **The trigger guards.** The `touch_updated_at()` triggers and the OTP and audit
  guards are exercised only through the fake client, which cannot see a trigger
  firing or a `security definer` function's privilege context. The partial unique
  index behind `is_default` *is* asserted live, because that is a constraint the
  database refuses outright.
- **The bucket policies.** The tests check the buckets exist; they do not check
  that a professional can write their own folder, that `kyc-documents` has no
  read policy, or that `service_media_admin_write` refuses a non-admin.
- **Migration idempotence.** Applying in filename order has been done; no test
  re-applies them, and none asserts that a re-run is a no-op.

---

## 7. Where this is going

`.planning/ROADMAP.md` holds the full phase table and the deferrals. In short:

Phases 0 through 3 are done — schema, auth, roles, OTP ledger, the catalogue and
availability surface, bookings and pricing, and now payments, refunds and the
wallet. The public pages and the catalogue routes are Phase 1's, the booking
surface is Phase 2's, and the money paths (orders, webhook, reconciliation cron,
refunds, wallet ledger) are Phase 3's. Phases 4 through 9 — the professional app,
matching, the admin console, realtime, growth features and the launch hardening
pass — are planned and have nothing built for them yet.

Three architectural consequences are already visible and will only harden as the
phases land:

- **`bookings` brings `professional_schedule`.** §9.1 lists "not already
  reserved" among the availability inputs, and it is the one input not wired. It
  arrives as `busy` per professional and `reservations` per day; the algorithm
  does not need to know which is which, which is why the seam was left open.
- **`platform_settings` replaces `PLATFORM_DEFAULTS`.** Values that are constants
  today are rows an admin can change without a deploy.
- **`vercel.json` declares exactly one cron: `/api/cron/reconcile-payments`,
  every 30 minutes** — Phase 3's only worker (§25.11), guarded by the
  three-channel `CRON_SECRET` check that answers 503 when the secret is unset.
  The seven schedules that used to sit beside it have no handlers and belong to
  Phases 5, 7 and 8; they are recorded here as prose so removing them from the
  strict-JSON file loses nothing: `search-sweeper` (`*/2 * * * *`), `recurring-
  generate` (`7 2 * * *`), `service-reminders` (`*/15 * * * *`), `demand-index`
  (`*/5 * * * *`), `rating-reminders` (`13 19 * * *`), `payout-run`
  (`23 3 * * 1`) and `wallet-expiry` (`41 2 * * *`). Each one re-enters
  `vercel.json` with its own phase, beside the route that actually handles it —
  a declared cron with no handler is a scheduled 404.

## 8. Discrepancies found while writing this

Six, five of them documentation or comments rather than behaviour.

1. **`createRequestClient()` has no caller.** `lib/supabaseServer.ts` defines it
   and `lib/catalogueServer.ts:30` says the address write paths "run on a
   request-scoped check". They do not: `app/api/customers/me/addresses/**` calls
   `createServerClient()` and filters by `customer_id` in the query, which the
   route's own comment describes accurately. The factory is mocked in four test
   files and unused in the product.
2. **The test counts disagree three ways.** `README.md` and `docs/SETUP.md` say
   162 total (138 mocked, 24 database). `docs/DATABASE.md` says 258. The suite
   is **273 tests across 15 files, 30 of them against a database** — a full run
   passes. The database figure is the one that moved: `test/db.rls.test.ts` and
   `test/helpers/dbEnv.ts` gained the `sqlAsRole` work and are uncommitted.
3. **`vercel.json` scheduled eight cron paths that did not exist.** Closed by
   Phase 3: it now declares exactly one — `/api/cron/reconcile-payments`, whose
   handler exists and fails closed when `CRON_SECRET` is unset. The other seven
   schedules are prose in §7 until their phases build the handlers.
4. **`lib/validation.ts` describes an import pattern the code does not use.** The
   header says client components import the same validators; none do, and the
   module imports `createServerClient`. `app/login/page.tsx:66` mirrors
   `normalizePhone` by hand instead.
5. **Two comments point at files that do not exist.** `lib/supabase.ts` refers to
   `lib/queries.ts` and regenerates into `lib/database.types.ts`; neither file is
   in the repository. The types are inline in `lib/supabase.ts` and the
   regeneration command is the one to run when a phase adds a table.
6. **`docs/DATABASE.md` is behind the suite twice.** It says
   `test/db.rls.test.ts` "contains no addresses test" and that the `addresses`
   policies "are therefore unproven against a live database"; there are now six,
   including one that asserts `set_default_address()` raises `ADDRESS_NOT_OWNED`
   for somebody else's row. It also puts the total at 258. Both statements describe
   the suite before the `sqlAsRole()` work landed.