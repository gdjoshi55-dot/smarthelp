# API reference

Every endpoint SmartHelp exposes is a Next.js Route Handler under `app/api/`.
There are 21 route files and 24 handlers: 13 under `app/api/auth/`, 6 for the
catalogue, and 5 for a customer's addresses.

They all answer in one envelope. A client that knows how to read the envelope
knows how to read every endpoint in the product, including the ones that do not
exist yet.

| Area | Base path | Auth |
|---|---|---|
| Authentication | `/api/auth/*` | Anonymous except `/me`, `/sign-out`, `/professional/apply` |
| Catalogue | `/api/services/*`, `/api/availability/*`, `/api/landing`, `/api/service-categories` | Anonymous; a session only when `addressId` is passed |
| Addresses | `/api/customers/me/addresses*` | Customer session required |

Everything in this document was read from the source. Where behaviour and a
comment disagree, the code wins and the disagreement is called out.

---

## 1. The envelope

Two shapes, and no third.

**Success.** `ok(data)` and `created(data)` from `lib/api.ts`:

```json
{
  "success": true,
  "data": {}
}
```

`created()` is `ok()` with a 201. `noContent()` exists for a 204 but no route
calls it.

**Failure.** `ApiErrorBody` from `lib/api.ts`:

```json
{
  "success": false,
  "error": "That address was not found on your account.",
  "code": "NOT_FOUND",
  "details": {
    "fields": { "pincode": "Enter a six-digit pincode" }
  },
  "requestId": "6f1b1f0e-6d2a-4a8f-9c31-9a5b2f7d1e04",
  "timestamp": "2026-02-11T09:14:22.418Z"
}
```

`details` is present only when there is something to add. For a validation
failure it is `{ fields: { <field>: <message> } }`, keyed by the field name the
caller sent, so a form can put each message under its own input.

### The client contract

Read `code` to decide what to do. Read `error` to say.

That division is deliberate and worth respecting. `code` is stable enough to
branch on — `OTP_EXPIRED` means ask for a new code, `SERVICE_UNAVAILABLE` means
render a coverage banner rather than an error boundary. `error` is human-facing
copy, written to be shown to a person, and the house rule is that it is never
generic when the server knows better. The only generic message in the system is
`handle()`'s own `INTERNAL_ERROR`, which is the one case where the server
genuinely does not know.

`readApiError(res)` in `lib/api.ts` pulls `{ message, code, details }` out of any
response and is what the client uses. `lib/catalogueClient.ts` wraps it in an
`ApiRequestError` that adds `status` and a `fields` getter, and separates a
network failure (`NETWORK_ERROR`, status 0) from an API answer, because the two
need different copy and only one is worth retrying.

### `requestId` and the `x-request-id` header

Every handler body runs inside `handle(req, name, fn)`. `handle()` reads
`x-request-id` from the request, or generates a UUID if the caller did not send
one, then sets it on the response. A caller that sends `trace-abc-123` gets
`trace-abc-123` back on every response from that handler, which is how a request
is followed from the browser to the log line.

Two honest caveats:

- `err()` writes `requestId: 'server'` — a placeholder (`lib/api.ts:93`). Any route
  that returns an error via `err()` or `validationError()` instead of throwing
  `ApiHttpError` therefore reports a `requestId` that is not the real one. Every
  route in the product currently throws instead, so this is latent rather than
  live, but it is a trap for the next one.
- The six hand-written "wrong method" handlers (`GET` on the auth POST routes)
  answer `{ success, error, code }` and nothing else: no `requestId`, no
  `timestamp`, no `x-request-id` header. They are the only responses in the
  product that are not the envelope.

`timestamp` is `new Date().toISOString()` at the moment the error was built, so
it is a server clock reading, not the instant the request arrived.

### What `handle()` does with a throw

An unexpected throw becomes a clean `500` with `code: 'INTERNAL_ERROR'` and the
copy `'Something went wrong on our side. Please try again.'` rather than an HTML
error page. Before that, it logs one line:

```
[<requestId>] <handler name> failed: <error message>
```

The rule is that the log records the request id and the error message and nothing
else — no token, no OTP, no password, no payment secret. An `ApiHttpError` is not
logged at all; it is a deliberate answer and is returned as it was thrown,
including its own `status` override and `details`.

---

## 2. Error codes

Every code in the `ApiErrorCode` union, with the status `STATUS_BY_CODE` gives
it. The last two columns say where it is actually raised today; most of these
belong to phases that have not been built.

| Code | Status | Raised when |
|---|---|---|
| `VALIDATION_ERROR` | 400 | A field failed `lib/validation.ts`. `details.fields` is keyed by field name. Also used with a status override of 409 or 422 in two places — see the notes below. |
| `UNAUTHENTICATED` | 401 | No bearer token, an expired or unknown token, a token with no profile, or credentials that do not match an account. |
| `FORBIDDEN` | 403 | Authenticated, but not allowed: wrong role for the route, no customer profile, suspended, blocked or deleted account. `details` carries `{ required, actual }` or `{ capability }`. |
| `NOT_FOUND` | 404 | No such service by slug, no such service id, or no such address on this account. |
| `INVALID_STATE` | 409 | The request is well-formed but conflicts with the row's current state. Currently: unsetting the only default address. |
| `STALE_VERSION` | 409 | Optimistic concurrency on a versioned row. Phase 2. |
| `ASSIGNMENT_TAKEN` | 409 | A professional was taken by another offer while this one was open. Phase 5. |
| `PRICE_CHANGED` | 409 | The quote no longer matches the catalogue price. Phase 2. |
| `IDEMPOTENCY_CONFLICT` | 409 | A spent idempotency key replayed with a different body. Not reachable yet — see §6. |
| `ILLEGAL_TRANSITION` | 409 | A booking state-machine step that is not legal. Phase 2. |
| `ADDRESS_IN_USE` | 409 | A referenced address was deleted. Deferred to Phase 2, when `bookings.address_id` exists. |
| `ACCOUNT_EXISTS` | 409 | The email is already registered. Sign-up only. |
| `PAYMENT_FAILED` | 402 | The gateway declined. Phase 3. |
| `PAYMENT_NOT_VERIFIED` | 402 | A checkout's `order_id|payment_id` signature did not verify. Phase 3. |
| `SERVICE_UNAVAILABLE` | 422 | The locality is covered but this service does not run there. |
| `NO_SLOT_AVAILABLE` | 422 | Nothing bookable on the requested day. Not raised today: `/api/availability` answers 200 with `slots: []` instead. |
| `PROFESSIONAL_UNAVAILABLE` | 422 | A named professional cannot take the job. Phase 5. |
| `SECOND_APPROVER_REQUIRED` | 422 | An above-limit refund whose requester is also the executor — the second approval must come from a different staff member. Phase 6. |
| `OTP_INVALID` | 422 | The code is wrong, or was not recognised. |
| `OTP_EXPIRED` | 422 | The code was issued and has timed out (`OTP_TTL_MINUTES`, 10). |
| `OTP_LOCKED` | 429 | `OTP_MAX_ATTEMPTS` wrong answers. `details.retryAfterSeconds` is 900. |
| `RATE_LIMITED` | 429 | A code was issued within `OTP_RESEND_SECONDS` (60). `details.retryAfterSeconds` is 60. |
| `INTERNAL_ERROR` | 500 | Anything unhandled. Also used with a 502 override for a mail or SMS delivery failure. |

### Codes that disagree with their status

Three places where `code` and the HTTP status tell a client different stories.
A client branching on `code` and a client branching on status will behave
differently, so these are worth knowing about:

| Where | What happens |
|---|---|
| `PUT /api/auth/me` | An email already taken by another account is reported as `VALIDATION_ERROR` with status **409**. `STATUS_BY_CODE['VALIDATION_ERROR']` is 400, so this is a deliberate override. |
| `GET /api/availability` | An unresolvable locality raises `VALIDATION_ERROR` with status **422**, not `SERVICE_UNAVAILABLE`. The route's own docstring says it should be `SERVICE_UNAVAILABLE`, and so does the Phase 1 plan. See §5.3. |
| Every mail/SMS failure | `INTERNAL_ERROR` with status **502**, not 500. |

---

## 3. Auth model

Three layers, in the order they are checked.

**Ownership is never a parameter.** `customer_id` is not in any validator's
allow-list and cannot be reached from a payload. The caller is resolved from the
bearer token and their `customers` row, and every query is filtered to it.

**`requireAuth(req, roles?)`** reads the `Authorization: Bearer <token>` header,
resolves the user through Supabase Auth, then loads `profiles` so the role is the
one the database holds — never one the client asserted. It refuses:

| Condition | Result |
|---|---|
| No `Bearer` prefix | 401 `UNAUTHENTICATED`, `'Please sign in to continue.'` |
| Token invalid or expired | 401 `UNAUTHENTICATED`, `'Your session has expired. Please sign in again.'` |
| No `profiles` row for the id | 401 `UNAUTHENTICATED`, `'No profile exists for this login. Contact support if this is unexpected.'` |
| `status = 'deleted'` | 403 `FORBIDDEN`, `'This account has been deleted.'` |
| `status` is `suspended` or `blocked` | 403 `FORBIDDEN`, `'This account is suspended. Contact support@smarthelp.test to appeal.'` |
| `roles` given and the role is not in it | 403 `FORBIDDEN`, with `details: { required, actual }` |

On success it returns an `AuthContext` with `userId`, `email`, `phone`, `role`,
`status`, the whole `profile`, and `accessToken`.

**The header is the only thing that authenticates a call.** The Supabase browser
client persists its session to `localStorage`, not to a cookie, so
`credentials: 'include'` carries nothing a route can check — a fetch that sends it
without the header is anonymous, and answers "Please sign in to continue." on a page
whose user is visibly signed in. `lib/sessionHeaders.ts` owns the browser's half:
`authorizationHeader()` returns `{ authorization: 'Bearer <access_token>' }`, or no
header at all when nobody is signed in, and re-reads the session per call so a token
that `autoRefreshToken` has just rotated is never sent stale. Both authenticated
browser call sites — `lib/bookingClient.ts` and `SavedAddressPicker` — use it, and a
test asserts it on every verb.

**Capability checks are explicit grants, not a hierarchy.** `lib/roles.ts` holds
the table, and `can(role, capability)` reads it. The same table is imported by the
browser to decide what to render and by the Route Handlers to decide what to
allow, so the two cannot disagree.

`requireCapability()`, `requireStaff()` and `requireAdmin()` exist in
`lib/validation.ts`, but **no route calls them today.** The only authorisation
a route actually performs is the role check inside `requireAuth`, the
`allow: 'staff'` gate on `/api/auth/staff-sign-in`, and the hard-coded role list
in `/api/auth/verify-otp`. That is sufficient for Phase 1, where there is one
privileged surface, but it means the capability table is currently exercised by
the UI rather than by the API.

### Anonymous versus authenticated

The catalogue is public reference data and its RLS policies already say `anon`, so
`/api/landing`, `/api/service-categories`, `/api/services`,
`/api/services/[slug]`, `/api/availability` and `/api/availability/estimate` are
all readable with no session.

The exception is the `addressId` query parameter. An `addressId` names a private
row, so passing one puts the request on the authenticated path whether or not the
rest of the endpoint does:

- No token → 401 `UNAUTHENTICATED`.
- A signed-in account with no `customers` row → **403 `FORBIDDEN`**, `'Addresses
  are a customer feature. This account has no customer profile.'`
- A signed-in customer's `addressId` that is not theirs → 404 `NOT_FOUND`, the
  same answer as an id that does not exist. An address id is a small enumerable
  thing, so the route does not confirm existence.

That 403-not-404 distinction is the point. A professional hitting
`/api/customers/me/addresses` gets told addresses are not a thing their account
has, rather than an empty list that reads as "you have not saved any places yet".

---

## 4. Endpoint reference

Every handler sets `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`.

Field rules below are from `lib/validation.ts`. The shared primitives, which
explain most of the defaults:

| Primitive | Rule |
|---|---|
| `str(value, field, opts)` | Trimmed unless `trim: false`. `min` defaults to 1, `max` to 255. |
| `optionalStr(value, field, opts)` | `undefined`, `null` and `''` all become `null`. `max` defaults to 500. |
| `int(value, field, opts)` | Coerced from string; must be a finite integer. |
| `uuid(value, field)` | Exactly 36 characters matching a UUID, lowercased. |
| `email(value, field)` | Trimmed, lowercased, ≤254 characters. |
| `oneOf(value, field, allowed)` | Must be one of the listed strings. |
| `normalizePhone(value, field)` | 10–20 characters, spaces/dashes/brackets stripped, must reduce to `[6-9]` plus 9 digits, returned as `+91…` under `DEFAULT_PHONE_COUNTRY_CODE`. |
| `password(value, field)` | 8–200 characters, `trim: false`, at least one letter and one digit. |
| `otpCode(value, field)` | 4–8 characters, spaces and dashes stripped, digits only. |
| `readJson(req)` | Throws `VALIDATION_ERROR` `'Expected a JSON object body.'` on anything that is not a JSON object. |

### 4.1 Authentication

#### `POST /api/auth/sign-in`

Email and password, for every role. This is the route the sign-in form uses.

| | |
|---|---|
| Auth | Anonymous |
| Capability | None. `allow: 'any'` |

**Body** — `validateSignIn`:

| Field | Type | Rules |
|---|---|---|
| `email` | string | Required, ≤254, lowercased |
| `password` | string | Required, 8–200, not trimmed, ≥1 letter and ≥1 digit |

**200** — `SessionGrant`:

```json
{
  "session": { "access_token": "...", "refresh_token": "...", "expires_at": 1770000000 },
  "profile": { "role": "customer", "full_name": "...", "email": "...", "...": "..." },
  "role": "customer",
  "roleLabel": "Customer",
  "capabilities": []
}
```

`profile` is the whole `profiles` row with `role` overridden to the effective role
after the owner bootstrap. `roleLabel` comes from `ROLE_LABELS`.

> `capabilities` here is `CAPABILITIES[role]` — the raw table row, not the
> expanded list. For a `super_admin` that is the literal `['*']`, exactly the
> wildcard `/api/auth/me` deliberately avoids. A client that tests this array with
> `includes` will read the owner as having no capabilities. Prefer
> `GET /api/auth/me`, or run the `sign-in` array through `capabilitiesFor()`.

**Failures** — `VALIDATION_ERROR` 400 (`details.fields`); `UNAUTHENTICATED` 401
for no match, no profile, or a wrong password (one message for all three, because
distinguishing them turns sign-in into a way to discover which addresses are
registered); `FORBIDDEN` 403 when the profile is not `active`; `INTERNAL_ERROR`
500 when Supabase is not configured.

Also writes an `auth.login` audit row, and may write `auth.owner_bootstrap` if the
login is the one in `SMARTHELP_OWNER_LOGIN`.

#### `POST /api/auth/staff-sign-in`

The same body, the same 200 shape, but `allow: 'staff'`.

| | |
|---|---|
| Auth | Anonymous |
| Capability | `isStaffRole(role)` — `admin`, `ops`, `support`, `super_admin` |

Identical to `/sign-in` except that a `customer` or `professional` gets 403
`FORBIDDEN` `'This sign-in is for the operations team.'` where `/sign-in` would
have handed back a working session. It exists for admin entry points that must
never fall through to a customer dashboard. `GET` → 405.

#### `POST /api/auth/sign-up/start`

Proves the mailbox and stops there: no auth user, no profile, no password.

| | |
|---|---|
| Auth | Anonymous |

**Body** — `validateSignUpStart`:

| Field | Type | Rules |
|---|---|---|
| `email` | string | Required, ≤254, lowercased |
| `role` | string | `customer` or `professional`. Defaults to `customer` |
| `full_name` | string | Required, 2–120 characters |

> `full_name` is validated and then **discarded**. The route destructures only
> `{ email, role }`. The name reaches the profile from
> `/api/auth/sign-up/complete`, which requires `full_name` again. A caller must
> send it here to pass validation and it has no effect.

**200**

```json
{
  "channel": "email",
  "target": "de*****@smarthelp.test",
  "expiresInSeconds": 600,
  "resendInSeconds": 60,
  "devCode": "123456"
}
```

`target` is masked. `devCode` is present only when `deliverOtp` returned
`provider === 'console'`, i.e. no SMTP configured, and is never echoed once a real
mailbox could have received the code.

**Failures** — `VALIDATION_ERROR` 400; `ACCOUNT_EXISTS` 409 with
`details.fields.email`; `RATE_LIMITED` 429 with
`details.retryAfterSeconds: 60`; `INTERNAL_ERROR` **502** if delivery throws.
`GET` → 405.

Writes an `auth.signup_code_requested` audit row recording the channel, purpose
and role — deliberately not the typed name.

#### `POST /api/auth/sign-up/complete`

The verified half. The only thing that creates an auth user.

| | |
|---|---|
| Auth | Anonymous |
| Capability | None. A staff role is rejected by the validator |

**Body** — `validateSignUpComplete`:

| Field | Type | Rules |
|---|---|---|
| `email` | string | Required, ≤254, lowercased |
| `role` | string | `customer` or `professional`. Defaults to `customer` |
| `full_name` | string | Required, 2–120 characters |
| `code` | string | 4–8 digits, spaces and dashes stripped |
| `password` | string | 8–200, not trimmed, ≥1 letter and ≥1 digit |
| `password_confirm` | string | Optional. If present it must equal `password` exactly |
| `phone` | string | Optional. Blank is `NULL`, not a fabricated value. Given, it must be a valid mobile number |

**201** — the same `SessionGrant` shape as `/sign-in`.

The sequence matters: verify the code, re-check that the email is still free
(it may have registered since `/start`, and the ledger holds one open code per
target and purpose), create the user with `email_confirm: true`, then perform a
real password sign-in so that a signup reporting success has been proven end to
end.

**Failures** — `VALIDATION_ERROR` 400; `OTP_INVALID` 422; `OTP_EXPIRED` 422;
`OTP_LOCKED` 429 with `details.retryAfterSeconds: 900`; `ACCOUNT_EXISTS` 409
(both from the pre-check and from a `createUser` failure whose message matches
`/already|registered|exists/i`); `INTERNAL_ERROR` 500. `GET` → 405.

#### `POST /api/auth/password-reset/start`

| | |
|---|---|
| Auth | Anonymous |

**Body** — `validatePasswordResetStart`: `email` only, required, ≤254, lowercased.

**200**, always:

```json
{
  "channel": "email",
  "target": "de*****@smarthelp.test",
  "expiresInSeconds": 600,
  "resendInSeconds": 60
}
```

The response is identical whether the address is registered, unknown, suspended,
or already inside the 60-second resend window. Nothing is sent in the first three
cases, and `devCode` is absent. That is the protection — not the delay a real
send takes, but the fact that the answers are the same. The comment in the route
is explicit that the identical response is the control.

**Failures** — only `VALIDATION_ERROR` 400 and `INTERNAL_ERROR` **502** on a
delivery throw. Note that a throttle here is **not** a 429, unlike
`/api/auth/send-otp`: it returns the same 200. `GET` → 405.

#### `POST /api/auth/password-reset/complete`

| | |
|---|---|
| Auth | Anonymous |

**Body** — `validatePasswordResetComplete`: `email`; `code` (4–8 digits);
`password` (8–200, not trimmed, ≥1 letter and ≥1 digit); `password_confirm`
optional, must match if present.

**200** — `{ "email": "...", "reset": true }`. No session is issued: the person
signs in with the new password.

Order is code, then account, then write. Checking the account first would let
someone with no code learn whether an address is registered.

**Failures** — `VALIDATION_ERROR` 400; `OTP_INVALID` / `OTP_EXPIRED` 422;
`OTP_LOCKED` 429; `UNAUTHENTICATED` 401 if no profile exists, using the *same*
message as sign-in; `FORBIDDEN` 403 if the profile is not `active`. `GET` → 405.

#### `PUT /api/auth/refresh`

| | |
|---|---|
| Auth | Anonymous |

**Body** — `refresh_token`, required, 20–400 characters.

**200** — `{ "session": { "access_token", "refresh_token", "expires_at" } }`.

A server-side refresh, for a caller that cannot hold a Supabase client: a cron, a
webhook retry, a native shell. The browser refreshes on its own through
`supabase-js` and does not need this route.

**Failures** — `VALIDATION_ERROR` 400; `INTERNAL_ERROR` 500 if Supabase is not
configured; `UNAUTHENTICATED` 401 if the refresh token is rejected.

#### `GET /api/auth/me`

| | |
|---|---|
| Auth | Required — `requireAuth` |

**200**

```json
{
  "profile": { "full_name": "...", "role": "customer", "locale": "en-IN", "...": "..." },
  "role": "customer",
  "roleLabel": "Customer",
  "capabilities": [],
  "sections": ["home", "bookings", "wallet", "support", "favourites", "profile"],
  "home": "/customer",
  "customer": { "id": "...", "referral_code": "...", "total_bookings": 0, "completed_bookings": 0, "lifetime_value": 0 },
  "professional": null,
  "serverNow": "2026-02-11T09:14:22.418Z"
}
```

`profile` is the row with `id` stripped. `capabilities` is
`capabilitiesFor(role)` — **expanded**, so a `super_admin` gets all 24 capabilities
and never the `'*'` wildcard. `customer` and `professional` are each nullable:
the two `select`s run in parallel and one of them is normally absent. This is the
call the client makes after any sign-in, and it also updates `last_seen_at`.

**Failures** — `UNAUTHENTICATED` 401; `FORBIDDEN` 403; `INTERNAL_ERROR` 500 if
the profile read fails.

#### `PUT /api/auth/me`

| | |
|---|---|
| Auth | Required — `requireAuth` |

**Body** — `validateUpdateMe`. Every field optional, but at least one must be
present.

| Field | Type | Rules |
|---|---|---|
| `full_name` | string | 2–120 characters |
| `email` | string or `null` | ≤254, lowercased. `null` becomes `''` |
| `avatar_url` | string | ≤1024 characters |
| `locale` | string | One of `en-IN`, `hi-IN`, `ta-IN`, `te-IN`, `ml-IN`, `kn-IN`, `mr-IN` |

`role` and `status` are not in the allow-list, so they are not reachable from the
payload. The column grant on `profiles` excludes them and the
`guard_profile_privileges()` trigger rejects the change regardless.

**200** — `{ "profile": { ... } }`, the updated row.

**Failures** — `VALIDATION_ERROR` 400, including `'Nothing to update'` for an
empty payload and, with a **409** status override, `'Another account already uses
that email address.'` for Postgres `23505`. Also 401 and 403 as above.

Writes a `profile.update` audit row with the before and after values of exactly
the patched fields.

#### `POST /api/auth/sign-out`

| | |
|---|---|
| Auth | Required — `requireAuth` |

**Body** — none. The access token in the `Authorization` header is revoked.

**200** — `{ "revoked": true | false }`. `false` means the revoke returned an
error; that is logged as a warning and the request still succeeds, because an
already-revoked session is a success from the user's point of view. The browser
also clears its local copy, but that is the cosmetic half.

**Failures** — `UNAUTHENTICATED` 401; `FORBIDDEN` 403.

#### `POST /api/auth/send-otp`

The phone-code flow. Public by design, because the caller has no session yet; the
abuse control is the ledger itself, enforced in SQL by `issue_otp` and
`consume_otp` so two concurrent requests cannot both slip through the throttle.

| | |
|---|---|
| Auth | Anonymous |

**Body** — `validateSendOtp`:

| Field | Type | Rules |
|---|---|---|
| `channel` | string | Required. `phone` or `email` |
| `purpose` | string | Defaults to `login`. One of `login`, `staff_login`, `admin_mfa`, `signup`, `password_reset` |
| `phone` | string | Required when `channel` is `phone`. Normalised to `+91…` |
| `email` | string | Required when `channel` is `email` |

Two cross-field rules on top: `purpose: 'login'` requires `channel: 'phone'`, and
`purpose: 'staff_login'` requires `channel: 'email'`.

For `channel: 'phone'` with `purpose: 'login'` the route also reads two fields the
validator does not touch: `body.role`, which is honoured only when it is exactly
`'professional'` and otherwise becomes `'customer'`, and `body.full_name`, which is
trimmed, sliced to 120 and defaults to `'SmartHelp member'`. On first contact for
that phone, `ensureAuthUserForPhone` creates the auth user and profile, so this
route doubles as phone sign-up. Staff roles are never accepted.

**200**

```json
{
  "channel": "phone",
  "target": "+919876543210",
  "expiresInSeconds": 600,
  "resendInSeconds": 60,
  "devCode": "123456"
}
```

The phone is returned in full — a person reading it back to themselves learns
nothing they did not just type. The email is masked. `devCode` is present only
when the provider is `console`.

**Failures** — `VALIDATION_ERROR` 400, including the two channel/purpose
mismatches; `RATE_LIMITED` 429 with `details.retryAfterSeconds: 60`;
`INTERNAL_ERROR` **502** on delivery failure. `GET` → 405.

#### `POST /api/auth/verify-otp`

| | |
|---|---|
| Auth | Anonymous |

**Body** — `validateVerifyOtp`: the same `channel`, `purpose`, `phone` or `email`
as `/send-otp`, plus `code` (4–8 digits). It also reads the same unvalidated
`role` and `full_name` as `/send-otp`, for the phone branch.

**200** — `{ "tokenHash": "...", "email": "...", "channel": "phone" }`.

A `token_hash`, not a session. The decision — is this code good — stays on the
server, where the ledger, the attempt counter and the lockout are; the browser
exchanges the token for a session with
`supabase.auth.verifyOtp({ token_hash, type: 'email' })`.

On the email channel the account must already exist and must already hold a staff
role; this is the MFA step. The route also calls `promoteOwnerIfAllowListed`, which
is the only place in the API that can make an account `super_admin`.

**Failures** — `VALIDATION_ERROR` 400; `OTP_INVALID` 422 (also the fallback for an
unrecognised outcome); `OTP_EXPIRED` 422; `OTP_LOCKED` 429 with
`details.retryAfterSeconds: 900`; `UNAUTHENTICATED` 401 `'No account exists for
that email address.'` on the email channel; `FORBIDDEN` 403 when the account is
not staff or not active.

#### `POST /api/auth/professional/apply`

| | |
|---|---|
| Auth | Required — `requireAuth` |
| Capability | None enforced. The route hard-codes `customer`, `professional`, or an admin role |

Turns a signed-in account into a professional. Idempotent by design: applying
twice updates the same application rather than creating a second one, because
`professionals.profile_id` is unique and a duplicate would leave a row in the KYC
queue that nobody will ever review. It returns 201 on the first application and
200 on a repeat.

**Body** — `validateProfessionalApply`:

| Field | Type | Rules |
|---|---|---|
| `experience_months` | integer | Defaults to 0. 0–600 |
| `service_ids` | string[] | 1–40 UUIDs, de-duplicated. Each must be an active service |
| `documents` | object[] | Defaults to `[]`. `{ doc_type, file_path }` |
| `documents[].doc_type` | string | One of `aadhaar_front`, `aadhaar_back`, `pan`, `address_proof`, `selfie`, `police_verification`, `training_certificate`, `bank_passbook` |
| `documents[].file_path` | string | 3–512 characters |

There is deliberately no `bio`: `professionals` has no such column, and
validating a field the route would then drop is worse than not accepting it.

**200 / 201**

```json
{
  "professionalId": "…",
  "verificationStatus": "submitted",
  "services": ["…"],
  "documents": 2,
  "nextStep": "Your documents are queued for review. We will notify you within 48 hours."
}
```

`verificationStatus` starts at the column default `not_submitted` and only
leaves that state here if at least one document was supplied. A re-application
after `rejected` or `expired` resets the verdict to `submitted` and leaves the
professional's history alone. A `customer` is promoted to `professional` and
their `customers` row is deleted in the same request — the promotion is
one-way and audited. `documents` in the response is a count, not the array.
`professional_skills` is replaced wholesale, because a remove is an un-insert.

**Failures** — `VALIDATION_ERROR` 400, including `'One of the services you picked
is no longer offered.'` with `details.fields.service_ids`; `FORBIDDEN` 403 for a
role that is neither customer, professional nor admin; `UNAUTHENTICATED` 401.

### 4.2 Catalogue

All six are anonymous-readable. `resolveLocationForRequest` runs on five of them
(landing does not take a location), and it is the single place that turns a query
into a locality. `lat` and `lng` must be given together or not at all;
`addressId`, when given, must be a UUID and must belong to the caller.

The `LocationSummary` every catalogue response carries is worth reading once:

| Field | Type | Meaning |
|---|---|---|
| `localityId` | string \| null | `null` when no locality resolved |
| `localityName` | string \| null | |
| `cityName` | string \| null | |
| `timeZone` | string \| null | Falls back to `DEFAULT_TIMEZONE` |
| `matchedBy` | `'area'` \| `'coordinates'` \| `'saved_address'` \| null | How it decided |
| `distanceKm` | number \| null | Set for a coordinate match |
| `message` | string | Banner copy, always a sentence |
| `addressId` | string \| null | Echoed when an `addressId` was used |

#### `GET /api/landing`

| | |
|---|---|
| Auth | Anonymous |
| Query | **None.** |

**200** — `LandingResponse`, i.e. `LandingData` plus `serverNow`:

```json
{
  "categories": [ … ],
  "featured": [ … ],
  "coverage": { "city": "Bengaluru", "state": "Karnataka", "localities": ["…"] },
  "verifiedProfessionals": 12,
  "servedLocalities": 12,
  "serverNow": "2026-02-11T09:14:22.418Z"
}
```

`featured` is capped at 6 by `getLanding`'s default. One request instead of four:
categories, featured services, where we operate, and how many verified
professionals there are.

> The browser helper `fetchLanding(location)` appends `area`, `lat` and `lng` to
> this URL, and the route ignores every one of them — `getLanding()` takes no
> arguments and no query parameters. Harmless today, but a client cannot use the
> landing payload to tell a visitor what is available near them.

#### `GET /api/service-categories`

| | |
|---|---|
| Auth | Anonymous |
| Query | **None.** |

**200** — `{ "categories": CategorySummary[] }`, where each is
`{ id, name, slug, iconKey, imageUrl, sortOrder, serviceCount }`.

Separate from `/api/services` because the landing page and the catalogue both
need the pills on their own, and a category list is the one catalogue query that
cannot be filtered, paged or searched.

#### `GET /api/services`

| | |
|---|---|
| Auth | Anonymous. A session is required if `addressId` is passed |
| Query | `parseCatalogueQuery` |

| Parameter | Type | Default | Rules |
|---|---|---|---|
| `q` | string | — | 1–80 characters |
| `category` | string | — | 1–80 characters. A category slug |
| `availableOnly` | `true`/`false`/`1` | `true` **when a locality resolved**, otherwise `false` | Only the exact string `true` or `1` is true; any other non-empty value is false |
| `addressId` | string | — | UUID. Requires a session and ownership |
| `lat` + `lng` | number | — | Both or neither. −90..90 and −180..180 |
| `area` | string | — | 2–120 characters |
| `city` | string | — | 2–120 characters |

**200** — `CatalogueResponse`:

```json
{
  "services": [ … ],
  "location": { …LocationSummary… },
  "availableOnly": true,
  "serverNow": "…"
}
```

`availableOnly` echoes what the server actually applied, so the grid can say
"hiding 4 services not in your area" without guessing whether the list it was
given is complete. Each `ServiceSummary` is
`{ id, slug, name, shortDescription, imageUrl, category: { id, name, slug, iconKey },
pricingType, basePrice, unitLabel, unitPrice, minDurationMinutes,
maxDurationMinutes, prepMinutes, sortOrder, durations, professionals: { total,
online }, rating, serviceable }`.

Two honest notes on this payload. `rating` is `null` until `ratings` rows exist,
which they do not until Phase 2 — the UI is meant to render that as "New". And
`serviceable` is `null` on every card when no location was sent, because
"available where?" is a question the client has to ask, not one it may assume.

**Failures** — `VALIDATION_ERROR` 400 on any bad parameter;
`UNAUTHENTICATED` 401 or `FORBIDDEN` 403 or `NOT_FOUND` 404 when `addressId` is
passed and fails any of those checks.

#### `GET /api/services/[slug]`

| | |
|---|---|
| Auth | Anonymous. A session is required if `addressId` is passed |
| Query | The same location parameters as `/api/services` |

`slug` is the path segment, URL-decoded by the router; the client helper encodes
it with `encodeURIComponent`.

**200** — `DetailResponse`:

```json
{
  "service": { …ServiceDetail… },
  "location": { …LocationSummary… },
  "serverNow": "…"
}
```

`ServiceDetail` extends `ServiceSummary` with `description`, `materialsIncluded`,
`materialsNote`, `requiresPhotoProof`, `maxActiveJobs`, `images: { url, altText }[]`,
`tasks: { kind: 'included' | 'excluded', label, sortOrder }[]`,
`durationOptions: { minutes, price, priceMultiplier }[]` and `keywords`.

**Failures** — `NOT_FOUND` 404 `'That service is not available.'` for an unknown
slug **or** a deactivated one. `is_active` hides it from search, and the one
honest answer to a direct link to a retired service is that it is not there.
`VALIDATION_ERROR` 400 on a bad location parameter; the same `addressId` failures
as `/services`.

#### `GET /api/availability`

The slots for one service, one day, one duration.

| | |
|---|---|
| Auth | Anonymous. A session is required if `addressId` is passed |
| Query | `parseAvailabilityQuery` |

| Parameter | Type | Default | Rules |
|---|---|---|---|
| `serviceId` | string | **Required** | UUID |
| `date` | string | Today in the city's zone | `YYYY-MM-DD`, must exist, must not be in the past |
| `duration` | integer | The service's minimum | 15–720 |
| `professionalId` | string | — | UUID |
| `addressId` | string | — | UUID. Session and ownership required |
| `lat` + `lng` | number | — | Both or neither |
| `area` | string | — | 2–120 characters |
| `city` | string | — | 2–120 characters |

A location is **required**: no `addressId`, no coordinates and no `area` is a
`VALIDATION_ERROR` naming which parameter is missing.

`date` is refused rather than answered with an empty slot list when it is in the
past, because an empty list reads as "fully booked" and a past date reads as a
mistake the person can act on.

**200** — `AvailabilityResponse`, i.e. `AvailabilityResult` with the nested
`location` widened to `LocationSummary`, plus `serverNow`:

```json
{
  "service": { "id": "…", "name": "…", "slug": "…", "minDurationMinutes": 60, "maxDurationMinutes": 240 },
  "location": { …LocationSummary… },
  "durationMinutes": 120,
  "validDurations": [60, 90, 120, 180],
  "serviceable": { "ok": true, "localityId": "…", "localityName": "…", "cityName": "…", "timeZone": "Asia/Kolkata", "leadMinutes": 120, "slotCapacity": 3, "reason": null, "matchedBy": "area" },
  "day": {
    "date": "2026-02-12",
    "timeZone": "Asia/Kolkata",
    "durationMinutes": 120,
    "slots": [
      { "start": "2026-02-12T04:30:00.000Z", "end": "…", "label": "10:00", "durationMinutes": 120, "remaining": 2, "bookable": true, "reason": null }
    ],
    "bookableCount": 6,
    "maxRemaining": 3,
    "leadMinutes": 120,
    "serverNow": "…"
  },
  "serverNow": "…"
}
```

`day.slots` carries **every** candidate, bookable or not, on a
`SLOT_GRANULARITY_MIN` (30 minute) grid. `reason` is `lead_time`,
`no_professional_available` or `at_capacity` on a slot that is not bookable, and
`null` on one that is. `remaining` is the number of professionals free for the
whole window, capped by `service_areas.slot_capacity`; the client filters on
`remaining > 0` and the server never hides a slot it cannot explain.
`validDurations` is there so a `duration` out of the ladder is recoverable by the
client rather than a dead end. `day.leadMinutes` is the lead that actually gated
this day, and it is `0` when the day is today — a same-day booking is dispatched
the moment it is paid, so today's slots start at the next free professional
window rather than after the works' lead.

Note there are two different `location` fields and they are deliberately different
types. The nested one inside `AvailabilityResult` is the *resolved* locality and
only exists because the request got past the coverage gate; the top-level one is
the banner summary and answers for the refused case too, which is why its
`localityId` is nullable.

**Failures** — `VALIDATION_ERROR` 400 on any bad parameter or a missing location;
`NOT_FOUND` 404 if the `serviceId` is not an active service;
`SERVICE_UNAVAILABLE` **422** if the locality is covered but this service does
not run there, with `details: { locality, reason }`;
`UNAUTHENTICATED` 401 / `FORBIDDEN` 403 / `NOT_FOUND` 404 for a bad `addressId`.

> **The one real discrepancy in the Phase 1 endpoints.** When the locality itself
> cannot be resolved — a place SmartHelp does not serve — the route throws
> `VALIDATION_ERROR` with a status override of **422** and
> `details: { location, reason: 'outside_coverage' }`. The route's own docstring
> says this should be `SERVICE_UNAVAILABLE` (422), and §7 of the Phase 1 plan says
> the same. As written, a client branching on `code` sees `VALIDATION_ERROR` for
> the same 422 that means `SERVICE_UNAVAILABLE` when a *service* is the problem.
> Branch on `status === 422` plus `details.reason`, not on `code` alone, until
> this is fixed.

Note also that a day with nothing bookable is **not** an error: it is 200 with
`slots: []` and `bookableCount: 0`. `NO_SLOT_AVAILABLE` exists in the code union
and is never raised.

#### `GET /api/availability/estimate`

"As soon as possible", for the instant-booking card.

| | |
|---|---|
| Auth | Anonymous. A session is required if `addressId` is passed |
| Query | |

| Parameter | Type | Default | Rules |
|---|---|---|---|
| `serviceId` | string | **Required** | UUID |
| `duration` | integer | — | 15–720. Must be a whole number |
| `addressId` | string | — | UUID. Session and ownership required |
| `lat` + `lng` | number | — | Both or neither |
| `area` | string | — | 2–120 characters |
| `city` | string | — | 2–120 characters |

A location is required, as on `/api/availability`. There is no `date` parameter —
the estimate is always about now.

**200** — `InstantEstimateResponse`:

```json
{
  "etaMinutes": 45,
  "prosAvailable": 2,
  "start": "2026-02-11T09:30:00.000Z",
  "reason": null,
  "etaLabel": "in 45 min",
  "location": { …LocationSummary… },
  "serviceable": { "ok": true, "…": "…" },
  "serverNow": "…"
}
```

`etaMinutes` is measured from now, not from midnight, so it is a number of
minutes a person can read. `etaLabel` is always a complete sentence — `in 45 min`,
`in 2 hr`, or `No slots today` — so the card has nothing left to invent.
`serviceable` is absent on the "no locality" answer.

**Failures** — `VALIDATION_ERROR` 400 only, with `details.fields.duration` for an
out-of-range duration. Everything else is a 200:

| Situation | Answer |
|---|---|
| Locality does not resolve | `etaMinutes: null`, `prosAvailable: 0`, `etaLabel: 'No slots today'`, no `serviceable` |
| Covered, but the service is not offered there | `etaMinutes: null`, `etaLabel: 'Not offered in {locality}'`, with `serviceable` |
| Covered and offered, nothing free today | `etaMinutes: null`, `etaLabel: 'No slots today'`, with `serviceable` |

The first row is the weakest copy in the set: a visitor outside coverage is told
"No slots today" rather than "we are not in your area yet", even though
`location.message` in the same payload says exactly that. A client that prefers
the honest sentence should render `location.message`.

> Both `fetchAvailability` and `fetchEstimate` in `lib/catalogueClient.ts` send
> the duration as **`durationMinutes`**, and both server routes read **`duration`**.
> The parameter is silently ignored today, so the duration picker has no effect on
> either call. Nothing rejects the unknown key.

### 4.3 Addresses

All five require a session **and** a `customers` row, via `requireCustomer()`.
A signed-in account without one gets 403 `FORBIDDEN` `'Addresses belong to a
customer account. This account does not have one.'` — never a 404, and never an
empty list.

`loadOwnedAddress()` is the ownership gate, and it answers 404 `NOT_FOUND` `'That
address was not found on your account.'` for both an address that is not yours and
one that does not exist.

Every write leaves an audit row with `lat` and `lng` stripped out by
`auditSafeAddress`, so an address is recorded as a set of changed field names
rather than as a point someone lives at.

Every address in a response is an `AddressView`:

```
{ id, label, addressType, line1, line2, area, city, state, pincode, lat, lng,
  landmark, accessNotes, isDefault, locality: { id, name } | null,
  coverage: 'covered' | 'not_yet_available', formatted, createdAt, updatedAt }
```

`coverage` is `'covered'` only when the locality has an active `service_areas` row.
A locality can exist with no coverage, and an address in it is a real place where
nobody can be booked — that is what the badge is for. `formatted` is
`line1, line2, area, city, pincode` with the empty parts dropped.

#### `GET /api/customers/me/addresses`

| | |
|---|---|
| Auth | Required — customer |

**200** — `{ "addresses": AddressView[], "defaultAddressId": string | null }`.

Ordered default first, then oldest. `defaultAddressId` is the `is_default` row's
id, or `null` when the customer has no addresses.

**Failures** — 401, 403.

#### `POST /api/customers/me/addresses`

| | |
|---|---|
| Auth | Required — customer |

**Body** — `validateAddressInput`:

| Field | Type | Rules |
|---|---|---|
| `label` | string | Defaults to `'Home'`. 1–40 characters |
| `address_type` | string | Defaults to `home`. One of `home`, `work`, `other` |
| `line1` | string | Required. 1–200 characters |
| `line2` | string | Optional → `null`. ≤200 characters |
| `area` | string | Required. 2–120 characters |
| `city` | string | Required. 2–120 characters |
| `state` | string | Required. 2–120 characters |
| `pincode` | string | Required. Exactly 6 digits |
| `lat` + `lng` | number | Optional, but both or neither. −90..90 and −180..180 |
| `landmark` | string | Optional → `null`. ≤160 characters |
| `access_notes` | string | Optional → `null`. ≤500 characters |
| `is_default` | boolean | Optional. `true` or the string `"true"` |

`customer_id` is not in the allow-list and cannot be reached from a payload.

`lat`/`lng` are optional even though the column is `not null`: someone who
declines the browser's location prompt and types an area has no coordinates to
give. The server then stores the resolved locality centre and answers
`locationPrecision: 'locality_centre'`, so the form can say the professional will
get the centre of the area instead of pretending the pin is exact.

**201** — `{ "address": AddressView, "location": …LocationSummary-ish…,
"locationPrecision": 'exact' | 'locality_centre' }`.

The `is_default` handling is the one subtle part. The first address a customer
saves is born default without being asked. An explicit `is_default: true` on a
later address cannot be honoured by the insert, because
`uniq_default_address` would trip and fail the write — so the row is inserted with
`is_default: false` and the switch happens immediately afterwards through the
`set_default_address` RPC, which clears the previous holder in the same
transaction.

**Failures** — `VALIDATION_ERROR` 400, including the pairing rule
`'Give both coordinates, or neither'` on whichever of `lat`/`lng` is missing, and
`'We could not match "{area}" to a service area. Pick a locality from the list, or
share your location.'` with `details.fields.area` when no locality can be resolved.
The address is refused rather than stored, because `lat`/`lng` are `not null` and
a guessed point is how a professional ends up at the wrong building. Plus 401 and
403.

Note `POST` and `PUT` on this route read the body with a local `readBody()` that
returns `{}` on malformed JSON, rather than `readJson()`. A body that is not JSON
therefore produces field errors rather than `'Expected a JSON object body.'` —
unlike every other route in the product.

#### `PUT /api/customers/me/addresses/[id]`

| | |
|---|---|
| Auth | Required — customer |

**Body** — `validateAddressPatch`. Same fields as `POST`, all optional, at least
one required or `VALIDATION_ERROR` `'Nothing to update'`. `id` and `customer_id`
are not reachable.

**200** — `{ "address": AddressView, "location": … | undefined,
"locationPrecision": … | undefined }`.

`location` and `locationPrecision` are present only when the patch could have
moved the address — a changed `area`, a changed `city`, or new coordinates. The
locality is then recomputed, and a coordinate in the payload wins over a changed
area name, because the stored pin belongs to the *old* area and carrying it across
would leave the address attached to the locality it just moved out of.

`is_default` is not honoured through a plain update. `is_default: true` goes
through the `set_default_address` RPC after the write, and `is_default: false` on
the current default is **refused** with 409 `INVALID_STATE` `'Your default address
cannot be unset. Make another address the default first.'` rather than silently
ignored, because leaving someone with no default after they asked to remove one is
worse than telling them no.

**Failures** — `VALIDATION_ERROR` 400; `INVALID_STATE` 409; `NOT_FOUND` 404;
401; 403.

#### `DELETE /api/customers/me/addresses/[id]`

| | |
|---|---|
| Auth | Required — customer |

**Body** — none.

**200** — `{ "deleted": true, "id": "…" }`.

If the deleted address was the default, the oldest surviving address is promoted
through `set_default_address`. The partial unique index does not require *a*
default, but leaving a customer with several addresses and no default makes the
next booking ambiguous.

**Failures** — `NOT_FOUND` 404; 401; 403.

`ADDRESS_IN_USE` does **not** exist yet. `bookings.address_id` arrives in Phase 2,
and at that point this becomes a 409 when a booking references the row rather than
a delete that breaks a past visit. Recorded in `0008_addresses.sql` and in
`.planning/ROADMAP.md`.

#### `POST /api/customers/me/addresses/[id]/default`

| | |
|---|---|
| Auth | Required — customer |

**Body** — none.

**200** — `{ "address": AddressView }`. Note the narrower payload: no `location`,
no `locationPrecision`, because nothing about the address moved.

The whole switch is one RPC. "Clear the old one, then set the new one" as two
statements from a request handler can interleave with a second request and leave
the customer with no default at all. The ownership check is repeated here even
though the RPC also checks it: the RPC's check exists to make the function safe
to call directly, and a route that skipped its own check would answer 200 for
somebody else's address id with a row the caller then cannot read anyway.

**Failures** — `NOT_FOUND` 404; 401; 403.

---

## 4.4 Bookings

Phase 2. Every write here goes through a `security definer` function in the
database rather than through a sequence of PostgREST requests — `docs/DATABASE.md`
§9 has why, and the short version is that a booking, its item lines and its first
status change have to land together or not at all.

### `POST /api/bookings/quote`

Unauthenticated. Body:

```json
{
  "items": [{ "serviceId": "<uuid>", "durationMinutes": 60, "quantity": 1 }],
  "couponCode": null,
  "bookingType": "scheduled"
}
```

**200** — `{ "quote": QuoteBreakdown, "durationMinutes": 60, "expiresInSeconds": 900, "quoteToken": "…" }`.

The request carries intent, not money: `basePrice`, `pricingType` and
`durationPrice` are rejected rather than ignored, because a pricing engine fed a
client-supplied price is a pricing engine that quotes whatever the browser says.

`quoteToken` is §7.2's signed token — `base64url(payload).base64url(hmac)`, keyed
with `SUPABASE_SERVICE_ROLE_KEY`, valid fifteen minutes. It is `null` when the server
has no signing key, which changes nothing about the price: the token proves where a
total came from, it does not decide what the total is. See "The token is checked,
not trusted" below for what the create route does with it.

### `POST /api/bookings`

Authenticated as a customer. Requires an `Idempotency-Key` header.

Body: `addressId`, `bookingType`, `items`, `scheduledStartAt` / `scheduledEndAt`
(or omitted for `instant`), `notes`, `couponCode`, `expectedTotal`, `quoteToken`.

**201** — `{ "booking": BookingView, "breakdown": QuoteBreakdown }`.

In the order the checks happen, because the order is the point:

1. **The address must be yours.** `bookings.customer_id` is a `customers.id`, and
   the address is looked up with `.eq('customer_id', customer.id)` — a row read
   without that filter would answer 201 for somebody else's address id.
2. **The price is recomputed** by `buildQuote()` from `services`,
   `service_durations` and `coupons`. Nothing the client sent about money survives.
3. **The slot is re-checked** against availability for *every* service on the
   booking, not just the first, because a two-service booking is only bookable if
   both can be done in the window.
4. **`quoteToken`, if present, is verified and must describe this request.**
5. **`expectedTotal`, if present, must equal the fresh total.**

Steps 4 and 5 are different checks and neither replaces the other.
`expectedTotal` is optional, so a client can omit it — which is exactly why the
token's claims are compared against the request (booking type, coupon, item list,
total) instead of merely being signature-checked. A signature alone proves *some*
quote was issued; without the comparison, a genuine token for a ₹500 cart would
verify against a different cart submitted with no `expectedTotal` at all, and the
token would be attesting to nothing.

**The token is checked, not trusted.** Missing is fine — a client that never called
the quote endpoint is still priced honestly by step 5 — but a token that is forged,
tampered with, expired, or issued for a different cart is refused before anything is
written. The two refusals are deliberately different codes, because from the
customer's side they are different problems:

| Token problem | Status | Code |
|---|---|---|
| Forged, malformed or expired | 400 | `VALIDATION_ERROR`, `details.fields.quoteToken` |
| Genuine, but for a different cart or total | 409 | `PRICE_CHANGED` — "refresh the price to continue" |

### `GET /api/bookings`, `GET /api/bookings/[id]`

**200** — a list, or one booking. The detail payload carries a `reschedulable`
boolean, computed on the server from the status the customer actually has rather
than from the statuses the customer UI thinks are allowed. A UI that decides this
for itself is a UI that offers "reschedule" on a booking the database will refuse,
and the resulting error arrives after the customer has already picked a new slot.

### `POST /api/bookings/[id]/cancel`

Body: `reasonCode` (an enum, not free text), `notes`. Returns the cancelled booking.

The fee is computed server-side from §11.1's bands against the scheduled start, and
the reason, the fee and the status are written in one statement. `notes` is stored in
the history row's note, not on the booking: `bookings.cancellation_notes` was a
column nothing read, and a cancellation's free text belongs with the record of why
the cancellation happened.

### `POST /api/bookings/[id]/reschedule`

Same shape as create for the new window, except the `Idempotency-Key` header is
optional here: a reschedule is not a payment event, so a client that sends no key is
served rather than refused. A key that *is* sent is honoured, so a double-tap on a
slow connection replays the stored body instead of re-checking a second slot.

Only `RESCHEDULABLE_STATUSES` may move, and a professional who has already set off
blocks it regardless of status. The window is version-checked against the `version`
the client read — which is required rather than defaulted, because defaulting it to
the current value makes the check agree with itself and proves nothing.

---

## 4.5 Payments

Phase 3 (§25). Four routes plus a webhook and a cron. **Every path that writes
`payments.status = 'success'` goes through `confirm_booking_payment()` (0014)**
— the webhook, the reconciliation cron, and now `POST /api/payments/verify`.
The webhook and the cron prove gateway truth with the webhook header signature;
verify proves it with the Checkout `handler`'s `order_id|payment_id` signature,
which is HMAC-SHA256 under the same server-only key secret. No route trusts a
status a client can choose — the signature is the gate — and the function's
`status in ('created','pending')` guard means any two of them racing still make
one write.

`docs/DATABASE.md` has the table, its RLS and the two functions this section's
routes call.

### `POST /api/payments/create-order`

Authenticated as a customer. **Requires `Idempotency-Key`** — `readIdempotencyKey`
refuses a missing one before anything is looked up, and `withIdempotency(…
required: true)` refuses it again at the ledger.

Body: `{ "bookingId": "<uuid>", "expectedTotal": 613.59 }`. `expectedTotal` is
optional; the amount charged is **never** read from it.

**201** — `{ "paymentId": "…", "orderId": "order_…", "keyId": "rzp_live_…",
"amount": 613.59, "currency": "INR" }`.

The order of the checks is the same discipline as `POST /api/bookings`, because
a refund-able row must not exist for a request that was going to be refused:

1. `requireCustomer` — `payments.customer_id` is a `customers.id` and is not
   null, so a professional or an admin with no customer row is refused outright.
2. **Ownership** — `getBookingForCaller`. The service role bypasses RLS, so a
   booking id would otherwise be a number a caller simply chooses.
3. **State** — `payment_pending` only. A paid or cancelled booking answers
   `409 INVALID_STATE` naming which one it is, so no booking ever gets a second
   order.
4. **`quote_token IS NOT NULL` — presence, not freshness.** A null token answers
   `409 INVALID_STATE` telling the customer to re-quote. Freshness is
   deliberately *not* checked: the token's 15-minute `exp` would either reject a
   `payment.captured` arriving late or force a re-quote that charges a total the
   customer did not agree to. What is asserted is Phase 2's attestation — *this
   booking was priced by our engine from a signed quote*. The payment nulls the
   token inside `confirm_booking_payment`, which makes it single-use across the
   payment lifecycle; this route never clears it, because a retry after an
   abandoned checkout has to find it still there.
5. **`expectedTotal`, if present, must equal `bookings.total_amount` in paise** —
   `409 PRICE_CHANGED` with `{ previousTotal, currentTotal }`. The booking's own
   figure wins; a client's figure is never stored and never charged.
6. `createBookingOrder()` — insert the row, ask the gateway for an order, store
   its id, write one audit row.

Steps 2–5 are read-only and deliberately happen *before* the ledger claim:
`claim_idempotency_key()` marks a key claimed the moment it is spent, so a
refusal inside `run()` would leave `completed_at` null and every later retry on
that key answering `in_flight`.

**Failures** — `VALIDATION_ERROR` 400 (bad `bookingId`/`expectedTotal`, missing
key); `UNAUTHENTICATED` 401; `FORBIDDEN` 403 (someone else's booking);
`INVALID_STATE` 409; `PRICE_CHANGED` 409; `PAYMENT_FAILED` **402** when the
gateway refused the order — the message is the gateway's own words, stored in
`payments.failure_reason` before the route refuses, so the checkout screen can
show what actually happened; `SERVICE_UNAVAILABLE` 422 when `RAZORPAY_KEY_ID`
or `RAZORPAY_KEY_SECRET` is unset (no row is written — that is a configuration
refusal, not a failed charge); `INTERNAL_ERROR` 500 when the order id could not
be stored (the row stays `created` for the cron to reconcile).

### `POST /api/payments/verify`

Authenticated as a customer. Body: `{ razorpay_order_id, razorpay_payment_id,
razorpay_signature }`.

**200** — `{ "verified": true, "status": "success", "paymentId": "…" }`.

**This is the confirmation path a browser can reach, and it is safe because the
signature is the gate.** The `handler` payload carries a signature over
`order_id + '|' + payment_id` made with the **key** secret — a server-only value
— so a signature that verifies proves Razorpay issued the pair for this
checkout; a successful Checkout only reaches the `handler` after authorisation.
The route verifies that signature, looks the row up, and runs it through
`getPaymentForCaller` (the signature is not ownership). If the row is still
`created`/`pending` and has a booking, it calls `confirm_booking_payment()` —
the **same single writer** the webhook and the cron use — which moves the
payment to `success` and the booking to `paid` in one transaction, and writes a
`payment.callback.confirmed` audit row with the customer as the actor. A `null`
return is the function's replay guard: a concurrent webhook won, so the row is
re-read for its real status. A row already `success` is left alone and reported.

The signature here is HMAC-SHA256 over `order_id + '|' + payment_id` with the
**key** secret — a different message and a different key from the webhook's
header signature. Both live in `lib/razorpaySignature.ts`.

This closes the loop the pre-write version could not: on a deployment Razorpay's
webhook cannot reach (a laptop, a preview) and with `CRON_SECRET` unset, no
writer ever ran and the screen sat at "Confirming payment…" forever. Now the
browser's subsequent `GET /api/payments/[id]` poll reads `success` and the
screen reaches `paid`.

**Failures** — `VALIDATION_ERROR` 400; `UNAUTHENTICATED` 401; `FORBIDDEN` 403;
`NOT_FOUND` 404; `PAYMENT_NOT_VERIFIED` **402** on a signature mismatch;
`SERVICE_UNAVAILABLE` 422 when `RAZORPAY_KEY_SECRET` is unset.

### `GET /api/payments/[id]`

Authenticated as a customer. **200** — `{ "payment": { id, bookingId, status,
amount, currency, method, failureReason, capturedAt, createdAt, updatedAt } }`.

This is what the checkout screen polls, so it is one query, one ownership check
and nothing else: no booking join, no child rows, no gateway call. The ownership
check is required even though `payments` has a select-own RLS policy, because
every Route Handler reaches Postgres through the service role and the service
role bypasses RLS — without it, a payment id a caller chose would read any
payment in the table.

The payload is a projection. `gateway_signature` is dispute evidence under
§12.2 and belongs in the database and (redacted) in the audit trail, not in a
browser response; `idempotency_key` is server state. `amount` is rupees, like
every other money figure this API returns.

**Failures** — `VALIDATION_ERROR` 400; `UNAUTHENTICATED` 401; `FORBIDDEN` 403;
`NOT_FOUND` 404.

### `POST /api/webhooks/razorpay` — unauthenticated, signature-authenticated

The primary authority on whether money arrived (§12.1, §30.1). It is the path
Razorpay calls; when it cannot reach this deployment, `POST /api/payments/verify`
confirms the same checkout through the same writer. Razorpay sends no
bearer token, so the credential is the HMAC over the bytes it sent, and the
order of operations is the whole defence:

1. `await req.text()` — **the first thing that touches the body.**
2. read `x-razorpay-signature`; missing ⇒ `400 VALIDATION_ERROR`.
3. read `RAZORPAY_WEBHOOK_SECRET` at request time; unset or still the
   `.env.example` placeholder ⇒ `422 SERVICE_UNAVAILABLE`. It fails closed: a
   deployment that *looks* configured and silently accepts every delivery is
   worse than one that says it is not.
4. `verifyRazorpaySignature(rawBody, secret, signature)`; false ⇒ `400`.
5. **Only then** `JSON.parse(rawBody)`.

| Event | Effect |
|---|---|
| `payment.captured` | amount/currency/order checked **paise against paise**, then `confirm_booking_payment()` — `payments.status='success'` and `bookings.status='paid'` in one transaction. A re-delivered webhook hits the function's `status in ('created','pending')` guard, updates zero rows and answers `{ duplicate: true }`. |
| `payment.failed` | `payments.status='failed'` with the gateway's `error_description`. **The booking stays `payment_pending` with its quote intact** — a declined card is a state the customer can leave by paying again. |
| `refund.processed` | the row is found by `refunds.gateway_refund_id` and finished through `complete_booking_refund()` — refund `completed`, booking `refunded`, `payments.refundable_amount` drawn down, in one transaction. A re-delivery hits the function's `status in ('requested','approved')` guard and answers `{ duplicate: true }`; an id we never wrote answers `400` with a `refund.webhook.mismatch` audit row. |
| anything else | `{ ignored: true }`, so the gateway stops re-delivering an event nothing handles. |

Two refusals worth naming: an order we never created and an amount that does
not match the row both answer `400` with **zero writes** plus a
`payment.webhook.mismatch` audit row, because neither is something a delivery
should be able to decide. `p_gateway_signature` is passed to the RPC and stored
on the row; it never reaches an audit row (`REDACTED_KEYS` in `lib/audit.ts`
carries it).

Every path writes one audit row with `actorProfileId: null` — a webhook has no
profile to name.

### `GET /api/cron/reconcile-payments`

The earliest cron (§25.11); Phase 7 added two more, and all three now share the one
`assertCronSecret` guard (§4.9). A customer who paid while the webhook was down
is invisible to every route and every screen: the booking sits
`payment_pending` and no human inside the product can tell "paid but unreported"
from "never paid". This pass looks at payments still waiting more than 10
minutes and asks the gateway, once per row, what happened.

**Guard — three channels, in precedence, and it fails closed:** `Authorization:
Bearer …`, then `x-cron-secret`, then `?secret=`. `CRON_SECRET` unset ⇒ **503
`SERVICE_UNAVAILABLE`** (a deliberate deviation from the usual `if (secret)`
pattern, which runs unauthenticated when the variable is missing); mismatch ⇒
401. The two reminder crons use the same guard, factored into `lib/cronGuard.ts`.

| Gateway says | Write |
|---|---|
| order `paid` | `confirm_booking_payment`, audit `payment.reconciled`, a `BOOKING_CONFIRMED` notification (§4.9) |
| order `expired` | `payments.status='failed'`, audit `payment.failed`; the booking stays `payment_pending` so the customer can pay again |
| still `created` / `attempted` / `partially_paid` | **no write**, counted `stillPending` |
| unreachable / 5xx / rate-limited / unreadable | **no write**, counted `unreachable` |

The fourth row is the load-bearing one: writing rows because the gateway
answered 503 would *confirm payments that never happened*.

**200** — `{ resolved, failed, stillPending, unreachable }`, or all zeros when
nothing is waiting.

**Both alert conditions** are a `payment.reconcile.alert` audit row plus a
`console.warn` — `lib/audit.ts` is this phase's loud channel and inventing a
notification pathway is out of scope:

1. `unreachable > 0` for the pass.
2. a `stillPending` row older than **60 minutes** (`RECONCILE_STALE_MINUTES`),
   a second threshold above the 10-minute scan window so a customer who simply
   has not paid yet never alerts while a payment stuck for an hour does.

Only bookings still `payment_pending` are in scope — a cancelled booking's
stuck payment is an operator problem, not a confirmation machine. The reconcile
call has no `gateway_payment_id` or signature to store (an order fetch does not
see the payment), so both are null and the note names the order id.

**Failures** — 503 (unset); `UNAUTHENTICATED` 401 (mismatch).

---

## 4.6 Refunds and the wallet

Phase 3's other half (§12.3, §12.4, §25.10). The rules live in
`lib/refundServer.ts`; the routes are doorways onto them. `docs/DATABASE.md` has
`refunds`, `wallets` and `wallet_transactions`, and the four functions these
routes call (0015).

### `POST /api/refunds`

Authenticated as staff. **Requires the `refund.request` capability** — `support`,
`admin` and `super_admin` hold it; `customer` and `professional` do not.

Body: `{ "paymentId": "<uuid>", "amount": 1500, "reasonCode": "goodwill", "note": "…" }`.
`amount` is **rupees**; it is converted to paise exactly once, in
`lib/refundServer.ts`.

**201** — the refund executed and the money moved:
`{ "refund": { id, status: "completed", route, amount, gatewayRefundId, … } }`.

**202** — a refund above `supportRefundLimit` (default ₹1500) is **created,
`requested`, and not executed**: `{ "refund": { status: "requested", … },
"heldForApproval": true }`. Phase 6's approval console (§25.10) is what executes
it; nothing in this phase does. That is the line that makes the capability check
meaningful, and `202` versus `201` is how a client tells "money moved" from
"queued" without parsing a sentence.

**Route follows the payment.** A payment with a `gateway_payment_id` refunds
through Razorpay (`route: "gateway"`); one without refunds to the customer's
wallet (`route: "wallet"`). If the gateway *definitively refuses*, the same
amount is credited to the wallet and the refund completes as `route: "wallet"`
with a `refund.ops_ticket` audit row — §12.3's "a customer is never left with
nothing". An *unreachable* gateway is not treated the same way: the request may
already have been processed, so nothing is credited and the row waits for a
human.

**Failures** — `VALIDATION_ERROR` 400 (bad amount, more than the payment can
still cover); `UNAUTHENTICATED` 401; `FORBIDDEN` 403 (no `refund.request`);
`NOT_FOUND` 404; `INVALID_STATE` 409 (payment not attached to a booking).

### `GET /api/refunds`

Authenticated. Staff see the table, optionally narrowed by `?customerId=` and
`?status=`; a customer sees only their own, and a `customerId` they pass is
ignored in favour of the one resolved from their session. **200** —
`{ "refunds": [ … ] }`. The projection carries no `gateway_signature`.

### Cancelling a paid booking

`POST /api/bookings/[id]/cancel` refunds automatically when money was actually
captured: the captured amount less §11.1's cancellation fee goes back. An
automatic refund is **never held for approval, at any size** (`planRefund({ auto:
true })`) — there is no human asking for it, and a cancelled booking must not be
stranded waiting for an approver. The response carries `autoRefund`, or `null`
when nothing was captured.

---

## 4.7 The professional app

Phase 4. Every route below authenticates through `requireProfessional` or its
verified twin `requireVerifiedProfessional` — the caller's `professionals` row is
resolved from `profile_id`. A signed-in account with no `professionals` row gets
403 `FORBIDDEN` `'This action belongs to a professional account. This account does
not have one.'`; an **unverified** professional calling any job route gets 403
`FORBIDDEN` `'Your identity is not verified yet. Upload your documents to start
taking jobs.'` with `details.verificationStatus`. The unverified gate applies to
the inbox and every job verb; the availability, KYC and location routes use the
plain professional gate.

Two rules hold across the whole section. **Ownership is re-checked in the route**,
because the service role bypasses RLS — a cross-professional id is a 404 with zero
writes, never a 403 that confirms the row exists. And **one function shapes every
booking payload**: `stripProBooking` removes `otp_hash`, the OTP counters and
`otp_verified_at` at every stage, and hides the exact address, notes and customer
name until the job is accepted (§14.3). So `JSON.stringify(body)` for any of these
routes contains neither `otp_hash` nor a plaintext code (P4-10).

### `GET` / `PUT /api/professionals/me/working-hours`

| | |
|---|---|
| Auth | Required — professional |
| Action | `professionals.working_hours.list` / `professionals.working_hours.replace` |

`PUT` **replaces the whole week** in one call. **Body** — `{ hours: [ { weekday,
startTime, endTime } ] }`, `weekday` `0`–`6` (0 = Sunday), times `HH:MM` (optionally
`:SS`) within `00:00–24:00`. **200** — `{ "hours": [ { id, weekday, startTime,
endTime, isActive } ] }`, read back from the database rather than echoed.

The two rules a column check cannot express are enforced here as field errors
(`VALIDATION_ERROR` 400): a window may not fall outside `00:00–24:00`, and two
windows on the same weekday may not overlap. A raw `23P01` never reaches the
client — a database integrity error becomes `PROFESSIONAL_UNAVAILABLE` 422
`'Those hours clash with something already on your calendar…'`. Plus the
professional `FORBIDDEN` 403 and 401.

### Time off

All three filter by the caller's `professionals.id`, so professional A can never
read, delete or edit professional B's time off.

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/professionals/me/time-off` | `professionals.time_off.list` |
| `POST` | `/api/professionals/me/time-off` | `professionals.time_off.create` |
| `DELETE` | `/api/professionals/me/time-off?entryId=` | `professionals.time_off.delete` |

`POST` body — `{ startsAt, endsAt, reason? }` (`reason` ≤200 chars). Times are
normalised to UTC so two callers cannot disagree. **201** — `{ "timeOff": { id,
startsAt, endsAt, reason } }`. An overlapping block is refused **before** the
insert with 409 `INVALID_STATE` `'You already have time off that overlaps those
dates.'`; a database integrity error becomes `PROFESSIONAL_UNAVAILABLE` 422.
`DELETE` answers 404 `NOT_FOUND` `'That time off was not found on your account.'`
for both a missing id and one that is not yours, and **200** `{ "removed": true }`
otherwise.

### `GET` / `POST /api/professionals/me/availability`

| | |
|---|---|
| Auth | Required — professional |
| Action | `professionals.availability.get` / `professionals.availability.set` |

**GET 200** — `{ "availabilityStatus": "online" \| "offline" \| "busy" \| "break",
"isAvailableToday": boolean }`. **POST body** — `{ online: boolean }`; the browser
may say only "online" or "offline", never name a status, so `busy` and `break`
(which the matching engine sets) cannot be forged. **200** echoes the stored
values. Missing `online` ⇒ `VALIDATION_ERROR` 400; a vanished row ⇒ 404. This is
the phase's one optimistic control — the Switch moves first and the response is
what decides whether it stays moved.

### `POST /api/professionals/me/location`

| | |
|---|---|
| Auth | Required — professional |
| Action | `professionals.me.location` |

**Body** — `{ lat, lng }`. The writer half of the track read. The throttle is
stateless: a ping within `proLocationThrottleSeconds` (30) of the stored
`location_updated_at` is dropped and answers **200** `{ "updated": false }` with
no write; otherwise the coordinates are stored with a **server** timestamp and the
answer is `{ "updated": true }`. A skew on the device's clock therefore cannot
make its pin look fresher or staler than it is.

### `POST /api/kyc-documents/upload-url`

| | |
|---|---|
| Auth | Required — professional |
| Action | `kyc.upload_url` |

**Body** — `{ docType, filename, contentType, size }`. `docType` is one of
`identity`, `address`, `selfie`; `contentType` is on the bucket's MIME allow-list;
`size` is ≤ 5 MB. **200** — `{ path, token, signedUrl }`, where `path` is built
**server-side** as `${professionalId}/${docType}/${filename}` and never taken from
the body — a client that could name the folder could write into another
professional's slot. `filename` is sanitised (separators and `..` replaced) but
keeps its extension. Size and MIME are checked against the **declared** values, a
courtesy refusal that yields a readable message (`VALIDATION_ERROR` 400 `'Use a
photo or PDF under 5 MB.'`); a signed URL cannot enforce bytes, and the bucket's
`file_size_limit`/`allowed_mime_types` are the real backstop. A storage failure is
`INTERNAL_ERROR` 500.

### `GET` / `POST /api/professionals/me/kyc`

| | |
|---|---|
| Auth | Required — professional |
| Action | `professionals.kyc.get` / `professionals.kyc.submit` |

**GET 200** — `{ verificationStatus, kycVerifiedAt, documents: [ { id, docType,
filePath, status, rejectionReason, reviewedAt, createdAt } ] }`. The payload has
**no internal reviewer-note field** — there is none to select.

**POST body** — `{ docType, filePath }`, where `filePath` is the object the
signed-URL route minted. The path must start with the caller's own
`${professionalId}/` or `VALIDATION_ERROR` 400. The write is an upsert on
`(professional_id, doc_type)`, so a re-upload after a rejection replaces the row;
a document already verified or in review is locked by the `0005` trigger and
surfaces as 409 `INVALID_STATE` `'That document is already under review…'`.
**201** — `{ "document": { … } }`.

### `POST /api/admin/professionals/[id]/kyc/[docId]/decision`

| | |
|---|---|
| Auth | Required — `admin`, `super_admin`, `ops` |
| Action | `admin.kyc.decision` |

Ships **without a UI** (D2); Phase 6 builds the review queue on it. **Body** —
`{ verdict: 'verified' \| 'rejected', note? }`. A verdict that is not one of the
two is 422 `VALIDATION_ERROR` (not 400): the body is well-formed JSON with a
present-but-wrong value. A document that does not belong to the professional in
the path is 404 `NOT_FOUND`. The write and the roll-up are one RPC — any required
document `rejected` ⇒ the professional is `rejected`; all required documents
`verified` ⇒ `verified` + `kyc_verified_at`. **200** — `{ verificationStatus }`.
An audit row names the admin. A customer token gets 403 with zero writes.

### `GET /api/professionals/offers`

| | |
|---|---|
| Auth | Required — **verified** professional |
| Action | `professionals.offers.list` |

Runs `run_matching_sweep()` first (the Phase 5 engine, D4), lazily expires the
caller's stale offers, then reads the live ones. The sweep expires every stale
offer globally, ranks the candidates for every waiting booking, broadcasts one
offer to every eligible professional under an advisory lock, and refunds any search
that closed empty —
all before this read returns, so opening the inbox is what drives the marketplace
forward until the §25.11 cron exists. **200** — `{ "offers": [ { id, bookingId,
serviceName, scheduledStartAt, scheduledEndAt, area, quotedPrice, expiresAt } ],
"serverNow": "…" }`. `id` is a `booking_assignments.id`, not a booking id. The
payload carries **no phone, full address or customer name** — the §14.3 privacy
gate. A past-TTL offer is refused at read and is never in the list.

### `POST /api/professionals/offers/[id]/accept`

| | |
|---|---|
| Auth | Required — **verified** professional |
| Action | `professionals.offers.accept` |

**Body** — none. Ownership is re-checked (a cross-pro id is 404 with zero writes).
The RPC is a compare-and-set under the §9.4 advisory lock: a second tap, an expired
offer, a stale id, or another professional having accepted the booking first makes it
affect zero rows ⇒ 409 `ASSIGNMENT_TAKEN`; on success it withdraws every other live
offer and writes the winner onto `bookings.professional_id`. An overlap with another
job raises `PROFESSIONAL_UNAVAILABLE` ⇒ 409. **200** — `{ "job": ProBooking }` with the
address now unlocked. An audit row records the acceptance.

### `POST /api/professionals/offers/[id]/decline`

| | |
|---|---|
| Auth | Required — **verified** professional |
| Action | `professionals.offers.decline` |

**Body** — `{ reason? }` (≤200 chars). The decline records the reason as a
tombstone (`rejected`), then — the Phase 5 cascade — calls `match_booking` for the
booking so the job is re-broadcast to the ranked candidate list immediately rather
than sitting until the next inbox open. **200** — `{ "declined": true,
"reassigned": boolean }`, where `reassigned` is true when a fresh offer went out
and false when the field was empty (the booking then stays `searching`, and is
cancelled `no_professional_available` with a full refund if its window has
already closed). An offer no longer live is 409 `INVALID_STATE`; a cross-pro id is
404 with zero writes.

### `GET /api/professionals/me/jobs`

| | |
|---|---|
| Auth | Required — professional |
| Action | `professionals.jobs.list` |

The professional's live jobs — `accepted`, `on_the_way`, `arrived`, `otp_verified`
and `in_progress` — owner-filtered, oldest window first. **200** — `{ "jobs":
ProBooking[], "serverNow": "…" }`. Uses the plain professional gate (not the
verified one): an unverified professional simply has no live jobs. The payload is
`stripProBooking(…, 'accepted')`, so the address is present and `otp_hash` is not.

### `GET /api/professionals/me/earnings`

| | |
|---|---|
| Auth | Required — professional |
| Action | `professionals.earnings.list` |

The professional's `professional_earnings` ledger, one row per completed job,
owner-filtered, newest first. Uses the plain professional gate (not the verified
one): an unverified professional has no jobs, so a gate would only hide an empty
ledger. **200** — `{ "summary": { lifetimeGross, lifetimeNet, heldNet,
availableNet, paidNet, reversedNet, counts }, "earnings": [ { id, bookingId,
bookingNumber, serviceName, grossAmount, commissionAmount, netAmount,
bonusAmount, status, availableAt, reversedReason, createdAt } ], "serverNow":
"…" }`. The summary is a paise-exact sum of the returned rows (via `lib/money.ts`),
not a stored or second figure, so the total can never disagree with the list.
Money arrives as JSON numbers, converted at the same boundary. `bookingNumber`
and `serviceName` are resolved from `bookings` / `booking_items` and fall back to
`null` if the booking is gone. The caller's id filters the query and nothing
else, so a cross-professional id is an empty ledger by construction.

### Job execution: arrive, OTP, complete, no-show

All four are `requireVerifiedProfessional`, owner-checked, and reuse an `:id` that
is a **booking** id.

| Method | Path | Action |
|---|---|---|
| `POST` | `/api/professionals/jobs/[id]/arrive` | `professionals.jobs.arrive` |
| `POST` | `/api/professionals/jobs/[id]/otp` | `professionals.jobs.otp` |
| `POST` | `/api/professionals/jobs/[id]/complete` | `professionals.jobs.complete` |
| `POST` | `/api/professionals/jobs/[id]/no-show` | `professionals.jobs.no_show` |

**`arrive`** — body `{ lat, lng, overrideReason? }`. The distance is computed on
the **server** against the booking's frozen `address_snapshot`; outside
`defaultArrivalRadiusM` (100 m) — or when the address has no coordinates — it is
refused with 422 `VALIDATION_ERROR` and `details` carrying `distanceM`/`radiusM`
unless an `overrideReason` is present. An override writes an audit row **before**
the RPC. A wrong state is 409 `ILLEGAL_TRANSITION`; a concurrent change is 409
`STALE_VERSION`. **200** — `{ "job": ProBooking }`.

**`otp`** — body `{ code }` (the 4-digit service code). Calls
`verify_service_otp`, which compares the SHA-256 digest in constant time and, on
success, stamps `otp_verified_at`/`started_at`/`ends_at` from the server clock.
**Every failure — wrong, expired or locked — returns the same generic 403**
`OTP_INVALID` with a byte-identical body; distinguishing them would turn the
endpoint into an oracle. Which of the three it was reaches the log only. A code of
the wrong shape is `VALIDATION_ERROR` 400. **200** — `{ "job": ProBooking }` with
the server's `startedAt`/`endsAt` for the timer to anchor on.

**`complete`** — no body. Body-less by contract: the route reads the booking's
current `version` itself and hands it to `complete_job`. Moves `in_progress →
completed`, stamps `ended_at`/`actual_duration_minutes` from the server clock,
closes the schedule window, bumps `completed_jobs` and inserts exactly one pending
`professional_earnings` row (idempotent on retry). A job that is not running is
409 `ILLEGAL_TRANSITION`; a row that moved is 409 `STALE_VERSION`. **200** —
`{ "job": ProBooking }`.

**`no-show`** — body `{ reason }` **required** (`VALIDATION_ERROR` 400 without).
Writes the reason into the transition note and an audit row. **Touches no refund
and no wallet** — a professional never cancels their own job into money moving
back (hard rule 2; the live-DB test proves the absence of `refunds`/`wallets`/
`wallet_transactions` rows). An illegal origin is 409 `ILLEGAL_TRANSITION`.
**200** — `{ "job": ProBooking }`.

### `GET /api/bookings/[id]/track`

| | |
|---|---|
| Auth | Required — the customer or the owning professional |
| Action | `bookings.track` |

The live view both sides poll (15 s). `auth` is resolved first, then ownership is
one function (`getBookingForTrack`): a customer and the owning professional read
it, and **anyone else gets the same 404 as a booking that does not exist** — the
payload carries the professional's coordinates, so confirming a stranger's job id
is real is a reference check nobody needs.

**200** —

```
{ booking: ProBooking, status, presentation, timeline: [ { status, at } ],
  startedAt, endsAt, serverNow, remainingSeconds, extensionAvailable: false,
  extendedMinutes: 0, proLocation: { lat, lng } | null,
  otpExpiresAt?, otpGenerationsRemaining? }
```

`remainingSeconds` is `endsAt − serverNow`, computed in the handler — the device
clock is never consulted. `extensionAvailable` is hard-coded `false` and
`extendedMinutes` `0` (D5: extensions are deferred, but the shape is final).
`proLocation` is the professional's `current_lat`/`current_lng` when a
`location_updated_at` within `proLocationFreshMinutes` (15) exists, else `null`;
**no ETA is ever derived**. `otpExpiresAt` and `otpGenerationsRemaining` appear
only for a **customer** caller **and only while the booking is `arrived`** — the
code itself is never here. `booking` is shaped by `stripProBooking`, so `otp_hash`
and the OTP counters can never appear.

### `POST /api/bookings/[id]/otp/regenerate`

| | |
|---|---|
| Auth | Required — **customer** (a professional token is refused) |
| Action | `bookings.otp.regenerate` |

Legal only at `arrived` (else 409 `INVALID_STATE` `'A start code can only be
issued once the professional has arrived.'`) and only while
`otp_generations < otpMaxGenerations` (3) — generation 1 is the first mint, and the
fourth call is 409 `INVALID_STATE` `'New code limit reached — ask support.'`.

**200** — `{ code, expiresAt }`. This response is **the single plaintext moment of
the code's life**: the client caches it in `sessionStorage`, and only its SHA-256
digest reaches `bookings.otp_hash`, so it can never be read back. Nothing here is
logged.

## 4.8 The admin console

The admin console is Phase 6's staff surface: the `/admin` shell and the ~33 Route
Handlers under `app/api/admin/**`. They share one authorisation model. A request
carries a bearer token; every handler opens with `requireAuth` — or
`requireCapability`, which calls it first — and that resolves the caller from the
token and loads their profile, so the role is the one the database holds and never
one the client asserted.

Reads pass `requireAuth(req, [...STAFF])`, an allow-list of staff roles, and name
**no** capability. That allow-list is `['admin','ops','support','super_admin']`
everywhere except the raw-KYC reads and the KYC verdicts, which are
`['admin','super_admin','ops']` and so exclude `support`. Writes call
`requireCapability(req, capability)`, which asks the same explicit table
`lib/roles.ts` hands the client; there is no role hierarchy, so a capability is a
flat grant. A caller who fails either gate is `FORBIDDEN` 403 with zero writes.

Every handler runs through `handle()`, so an unexpected throw is a clean
`INTERNAL_ERROR` 500 carrying an `x-request-id`, and every success is the standard
envelope — `ok()` and `created()` in `lib/api.ts`, i.e. `{ "success": true,
"data": … }`. Reads use the **service-role** client, which bypasses RLS, so scope
is the route's job: the read modules in `lib/adminServer.ts`, `lib/supportServer.ts`,
`lib/auditServer.ts` and `lib/adminCatalogServer.ts` filter explicitly, and a
cross-tenant or unknown id resolves to `null` there and becomes a **404 with no
write** — the D3 decision, never a 403 that confirms a row exists. State-changing
writes leave one `audit_logs` row through `write_audit()` (`lib/audit.ts`), which
redacts secrets on the way in; an audit failure is logged loudly but does not fail
the business action.

Two Phase 7 staff surfaces live with this console but are documented in §4.9: the
notification-template editor (`/api/admin/notification-templates`, gated by
`notification.manage`) and the read-only staff view of a booking's chat. The bell and
the chat a customer or professional uses are §4.9 too — they are not admin surfaces,
but they share the same page.

### `GET` /api/admin/dashboard

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

The operations overview (§20.11). Counts only. **200** — `{ bookings: { today,
completedToday, cancelledToday, awaitingProfessional, inProgress }, gmvToday,
professionals: { total, verified, online, pendingKyc }, refunds: { pendingApproval } }`.
`awaitingProfessional` is `paid`/`searching` bookings; `inProgress` is the seven
live statuses (`assigned`…`extension_requested`). `gmvToday` is the day's gross
booking value in **rupees**, excluding `cancelled`, `draft` and `payment_pending`;
"today" is the platform zone (`Asia/Kolkata`), computed as an instant. `pendingKyc`
counts `professional_documents` awaiting a verdict (`submitted`/`in_review`);
`pendingApproval` counts `refunds` rows still `requested`. Failures:
`UNAUTHENTICATED` 401, `FORBIDDEN` 403.

### `GET` /api/admin/bookings

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

The booking queue (§20.12). Filters are validated before the service-role query
runs: `status` must be one of the 18 `BookingStatus` values, `q` is a booking-number
substring (≤ 40 chars), `from`/`to` are `created_at` instants, and paging comes from
`parsePaging` (default 25, max 100). **200** — `{ bookings: [ { id, bookingNumber,
status, bookingType, customerName, professionalName, serviceName, totalAmount,
currency, scheduledStartAt, createdAt } ], total, limit, offset }`, newest first. A
bad `status` or date is `VALIDATION_ERROR` 400; a `q` that matches no profile simply
yields an empty page. Missing auth is 401, non-staff 403.

### `GET` /api/admin/bookings/[id]

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

One booking with its whole evidentiary trail. **200** — `{ booking, customer,
professional, items, history, assignments, payments, refunds }` (the raw rows;
`booking_status_history` oldest-first, `booking_assignments` newest-offer-first). A
malformed id is `VALIDATION_ERROR` 400; an id that matches nothing is `NOT_FOUND`
404 and writes nothing.

### `POST` /api/admin/bookings/[id]/cancel

| | |
|---|---|
| Auth | Required — capability write |
| Action | `booking.cancel.any` |

Held by `ops`, `admin`, `super_admin`; **not** `support`, which is why a support
agent cancels by asking ops. Body — `{ reasonCode?, note?, chargeCustomer? }` (all
optional; `reasonCode` ≤ 60 chars defaults to `'ops_cancelled'`, `note` ≤ 500,
`chargeCustomer` defaults `false`). The fee is computed with the same
`quoteCancellation()` the customer path uses, so the two can never disagree. Because
an ops cancellation is not the customer's fault, the **default is to waive** (§11.2:
`cancelledBy: 'ops'` → fee 0); `chargeCustomer: true` applies §11.1's ladder instead.
The RPC `admin_cancel_booking` (0034) withdraws the holding professional and releases
their calendar in the same statement. **200** — `{ booking, fee, refund, waived,
band }`. An unknown id is `NOT_FOUND` 404; a move §8.2 forbids (a completed job, a
booking already refunded) surfaces as `ILLEGAL_TRANSITION` 409, never a 500. Writes
audit `booking.cancel_admin` with the before/after status and the fee metadata. The
local body reader tolerates a missing body (it becomes `{}`), so these writes do
**not** 400 merely for an absent body.

### `POST` /api/admin/bookings/[id]/assign

| | |
|---|---|
| Auth | Required — capability write |
| Action | `booking.assign` |

Held by `ops`, `admin`, `super_admin`. Body — `{ professionalId, note? }`
(`professionalId` a required uuid, `note` ≤ 500). The professional must be
**verified**: an unverified one is refused here with `PROFESSIONAL_UNAVAILABLE` 422
*before* the RPC, so the console shows a readable message instead of an `outcome`
string (the RPC re-checks under its advisory lock regardless). `admin_assign_booking`
(0034) raises an ordinary `offered` assignment with the platform's `offerTtlMinutes`
(a `platform_settings` row, default 15) — **ops raises the chance; it does not forge
an acceptance**, and the professional still accepts through the normal flow. Assign
is legal only before the professional is on the way, else `INVALID_STATE` 409.
**200** — `{ bookingId, professionalId, assignmentId }` (`assignmentId` null when
none was raised). `NOT_FOUND` 404 for a missing booking or professional. Audits
`booking.assign_admin`. Body reader tolerates an absent body.

### `GET` /api/admin/professionals

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

The professional roster (§20.13). Filters: `verificationStatus` (one of six),
`availabilityStatus` (`offline`/`online`/`busy`/`break`), a `q` name substring
(≤ 80, resolved against `profiles` first, so an unmatched name is an empty page
rather than a full one), `pendingKyc` (`1`/`true`, the review queue's join over
`professional_documents`), paginated. **200** — `{ professionals: [ { id, name,
phone, email, employeeCode, verificationStatus, availabilityStatus,
isAvailableToday, rating, completedJobs, totalOffers, acceptedOffers, createdAt } ],
total, limit, offset }`. Bad enum values are `VALIDATION_ERROR` 400.

### `GET` /api/admin/professionals/[id]

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

One professional's file: `{ professional, profile, documents, skills,
recentBookings }` (the last ten bookings, shaped like the list item). A missing id is
`NOT_FOUND` 404 and writes nothing. This route carries document **metadata** only;
the bytes are a separate, narrower read below.

### `GET` /api/admin/professionals/[id]/kyc

| | |
|---|---|
| Auth | Required — KYC allow-list (excludes `support`) |
| Action | `['admin','super_admin','ops']` |

The review payload: the professional, their profile, their declared skills, and each
uploaded document **with a short-lived signed read URL** (TTL 300 s, `getKycReview`
in `lib/adminServer.ts`). The `kyc-documents` bucket is private with no select policy,
so this route is the **only** path to the bytes, and the role check happens before any
URL is minted. A document whose object has since gone still returns a row with
`signedUrl: null`, because a reviewer needs to see that something was uploaded and
lost, not a blank page. A missing professional is `NOT_FOUND` 404 and mints nothing.
`support` gets `FORBIDDEN` 403.

### KYC verdicts

| Method | Path | Action |
|---|---|---|
| `POST` | `/api/admin/professionals/[id]/kyc/[docId]/decision` | `['admin','super_admin','ops']` |
| `POST` | `/api/admin/professionals/kyc/bulk-decision` | `['admin','super_admin','ops']` |

Both use the staff allow-list (`admin`, `super_admin`, `ops`) rather than a
capability; both write one audit row per document.

The **single** endpoint (documented in §4.7 too; it shipped in Phase 4 without a UI)
takes `{ verdict: 'verified' | 'rejected', note? }`. A present-but-wrong `verdict` is
`VALIDATION_ERROR` **422**, not 400 — well-formed JSON with a bad value — and
`details.fields` is still attached so the client's field-error path works. A document
that does not belong to the professional named in the path is `NOT_FOUND` 404. The
verdict write and the roll-up are one RPC (`kyc_document_decision`): any required
document `rejected` ⇒ the professional is `rejected`; all required documents
`verified` ⇒ `verified` with `kyc_verified_at`. The reviewer's note is prose the route
owns, stored as `rejection_reason` on rejection and cleared on verification. **200** —
`{ verificationStatus }`. Audits `kyc.document_verified` / `kyc.document_rejected`.

The **bulk** endpoint takes `{ professionalIds: [uuid], verdict, note? }`; the unit is
the **professional**, not the document: for each id, every document still awaiting a
verdict (`submitted`/`in_review`) gets one `kyc_document_decision` call — the same RPC,
so the roll-up rule is identical. An empty list or more than **100** ids is
`VALIDATION_ERROR` 422, a malformed uuid is 400, a bad verdict is 422, and a `rejected`
verdict with no `note` is 422 (a rejection must carry a reason the professional can act
on; the note is applied to every document it rejects). **200** — `{ verdict, results: [
{ professionalId, verificationStatus, documentsProcessed } ] }`. Audits carry
`metadata.bulk: true` so the trail shows how the verdict arrived.

### `POST` /api/admin/professionals/[id]/suspend

| | |
|---|---|
| Auth | Required — capability write |
| Action | `pro.suspend` |

Held by `admin` and `super_admin` only; `ops` can read the roster but not pull someone
off the marketplace. Body — `{ suspended?: boolean, reason? }` (`suspended` defaults
true). Suspension is two rows and both matter: `profiles.status` becomes `suspended` —
which is what `requireAuth` reads, so the professional cannot sign in — and
`professionals.suspended_reason` records why, with availability forced
`offline`/`is_available_today false` so they cannot be a matching candidate. A reason
is required when suspending (`VALIDATION_ERROR` 400 if missing/too long). Reactivation
clears the reason and restores the profile to `active`, but **does not put them back
online** — that is theirs to choose. **200** — `{ professionalId, suspended,
profileStatus }`. `NOT_FOUND` 404 for a missing id. Audits `professional.suspend` /
`professional.reactivate`.

### `GET` /api/admin/refunds

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

The refunds console (§22, §25.10). Any staff member reads the queue; only
`refund.execute` runs one. Filters: `status`
(`requested`/`approved`/`rejected`/`completed`/`failed`), a booking-number substring
`q` (≤ 40; refunds carry no user-facing number, so it resolves against `bookings`
first), a `requested_at` window, paginated. **200** — `{ refunds: [ { id, bookingId,
bookingNumber, customerId, customerName, amount, currency, status, route, reasonCode,
note, requestedById, requestedByName, processedById, completedAt, requestedAt } ],
total }`, newest first. Money leaves as rupees. Bad filters are `VALIDATION_ERROR`
400.

### `POST` /api/admin/refunds/[id]/execute

| | |
|---|---|
| Auth | Required — capability write |
| Action | `refund.execute` |

Held by `ops`, `admin`, `super_admin` (a `support` agent can **request** a refund
under `refund.request` but cannot execute one). Body — `{ note? }` (≤ 500). §25.10's
approver: an above-limit refund was left `requested` by the customer/refund path
precisely so an approver could stamp it, and this route is that stamp.

The row must exist or it is `NOT_FOUND` 404; the payment behind it must exist or
`NOT_FOUND` 404; a row that is not `requested` or `approved` is `INVALID_STATE` 409
(`'A <status> refund cannot be executed.'`).

**The second-approver rule (§22):** the amount is compared, in paise, to
`supportRefundLimit` (`platform_settings`, default ₹1500). When the refund is
**above** the limit **and** `refund.requested_by` equals the caller's own id, the
route answers `SECOND_APPROVER_REQUIRED` **422** — dual approval requires a second
person, so the same staff member cannot both request and approve. Otherwise execution
is delegated to `executePendingRefund` (`lib/refundServer.ts`), which stamps
`status: 'approved'` and `approved_by` **before** the money moves (so an approval is
never implied by a completed refund alone), then goes gateway-first,
wallet-on-a-definite-refusal, and raises an ops ticket if the gateway is unreachable.
It audits `refund.approved_and_completed` (plus `refund.wallet_fallback` or
`refund.ops_ticket` where those branches fire). **200** — `{ refund }`.

### Services (catalogue editor)

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/admin/services` | `['admin','ops','support','super_admin']` |
| `POST` | `/api/admin/services` | `service.manage` |
| `GET` | `/api/admin/services/[id]` | `['admin','ops','support','super_admin']` |
| `PATCH` | `/api/admin/services/[id]` | `service.manage` |
| `POST` | `/api/admin/services/[id]/areas` | `service.manage` |
| `PATCH` | `/api/admin/services/[id]/areas/[areaId]` | `service.manage` |
| `DELETE` | `/api/admin/services/[id]/areas/[areaId]` | `service.manage` |
| `POST` | `/api/admin/services/[id]/durations` | `service.manage` |
| `PATCH` | `/api/admin/services/[id]/durations/[durationId]` | `service.manage` |
| `DELETE` | `/api/admin/services/[id]/durations/[durationId]` | `service.manage` |

`service.manage` is held by `admin` and `super_admin` only. The list filters by `q`,
`categoryId` and `isActive`, paginated; the detail returns `{ service, categoryName,
durations, areas }`, with each area carrying its `localityName`.

The write validators mirror what the booking-quote engine reads, so a service the
console saves can be quoted. A `per_unit` service **must** carry a `unitLabel` and
`unitPrice`, and `maxDurationMin` may not be shorter than `minDurationMin` (400
otherwise). Creating a service derives the **slug** from the name and uniquifies it
against the table, so no one types `computer-repair` by hand; `POST` also accepts an
inline `durations` array. A duration rung must carry either a `price` or a
`priceMultiplier` (400 without). Adding an area requires both the service and the
named **locality** to exist (`NOT_FOUND` 404 for either). **201** on creations
(`{ service }` / `{ duration }` / `{ area }`), **200** on updates; deletes answer
`{ deleted: true }`.

All six write paths check existence first, so a bad id is `NOT_FOUND` 404 with no
write. One precision point: on the `areas/[areaId]` and `durations/[durationId]`
`PATCH`/`DELETE` verbs, the `:id` in the path is **not** cross-checked — the key is
the area/duration id in the sub-path. Every write audits (`service.create`/`update`,
`service.area.create`/`update`/`delete`, `service.duration.create`/`update`/`delete`).

### Pricing rules and the cancellation ladder

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/admin/pricing-rules` | `['admin','ops','support','super_admin']` |
| `POST` | `/api/admin/pricing-rules` | `pricing.manage` |
| `PATCH` | `/api/admin/pricing-rules/[id]` | `pricing.manage` |
| `DELETE` | `/api/admin/pricing-rules/[id]` | `pricing.manage` |
| `GET` | `/api/admin/cancellation-policies` | `['admin','ops','support','super_admin']` |
| `POST` | `/api/admin/cancellation-policies` | `pricing.manage` |
| `PATCH` | `/api/admin/cancellation-policies/[id]` | `pricing.manage` |
| `DELETE` | `/api/admin/cancellation-policies/[id]` | `pricing.manage` |

`pricing.manage` is `admin`/`super_admin` only. These are the §7.1 surge-window editor
and the §11.1 cancellation-ladder editor.

A **pricing rule** has a `scope` of `global`/`category`/`service`; the validator pairs
the scope with its target id (`categoryId` for category scope, `serviceId` for service
scope) so the table's `pricing_rule_scope_target` constraint is never the thing that
rejects it a level deeper. `multiplier` is 0.01–100, `daysOfWeek` runs `0`–`6`,
`startMinute`/`endMinute` are minutes of the day (0–1439) and may not be equal.
**PATCH carries the same full validated shape as POST and replaces the whole rule**.
The winning multiplier is resolved by the pure `resolveSurgeMultiplier` — narrower
scope wins, then higher `priority`, then oldest — so the dialog and the engine agree.
(Note: the rule editor is built and stored, but nothing yet *applies* a surge
multiplier inside `buildQuote`; see §7 and `docs/FEATURES.md` §8.)

A **cancellation policy** row is a ladder band. `hoursBefore` is the band **ceiling**
(`null` = the unbounded "≥ 24 h" row), kept that way so the console and
`quoteCancellation()` can never disagree about which band a request falls in.
`feeType` is `free`/`percentage`/`fixed`; a `percentage` may not exceed 100, a `free`
band charges 0, and the arrival band (`appliesWhenArrived`) must have **no** hour
ceiling (400 otherwise). A fixed fee is stored paise-exact.

Both families check existence first: a missing id is `NOT_FOUND` 404 with no write on
`PATCH`/`DELETE`. **201** on create, **200** on update, `{ deleted: true }` on delete.
Each write audits (`pricing_rule.*`, `cancellation_policy.*`).

### Coupons

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/admin/coupons` | `['admin','ops','support','super_admin']` |
| `POST` | `/api/admin/coupons` | `coupon.manage` |
| `GET` | `/api/admin/coupons/[id]` | `['admin','ops','support','super_admin']` |
| `PATCH` | `/api/admin/coupons/[id]` | `coupon.manage` |

`coupon.manage` is `admin`/`super_admin` only. **There is no delete verb** — a coupon
is deactivated via `isActive`, not removed. The list filters by a `code` substring `q`
and a derived `status` (`active` = enabled **and** not past `valid_to`; `expired` =
past `valid_to`), paginated. The detail adds `maxDiscountPctOfTotal`,
`applicableServices`, `applicableCities` and the actual `coupon_usage` rows (the row's
`usage_count` is only a cache; `coupon_usage` is the truth).

The validators mirror what `loadCoupon`/`lib/pricing.ts` enforce on the customer path,
so a coupon the console saves is one the cart cannot quietly ignore. `code` is
uppercased and ≤ 32 chars; `discountValue` is a `percentage` (≤ 100) or `fixed`
rupees; `validTo`, when given, must fall **after** `validFrom`; `applicableCities` are
six-digit pincodes. On `PATCH` the console sends `discountType` and `discountValue`
**together** (the update helper throws if only one arrives), so a value can never be
re-typed under the wrong unit. **201** on create, **200** on update; `NOT_FOUND` 404 on
an unknown id; a missing JSON body is `VALIDATION_ERROR` 400. Audits
`coupon.create`/`coupon.update`.

### Disputes

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/admin/disputes` | `['admin','ops','support','super_admin']` |
| `POST` | `/api/admin/disputes/[id]/resolve` | `dispute.resolve` |

`dispute.resolve` is `ops`/`admin`/`super_admin`. A dispute is "this outcome is wrong
and I want it adjudicated", distinct from a support ticket's "help me" — the two only
share the screen. The list filters by `status`
(`open`/`investigating`/`resolved`/`rejected`) and a booking-number substring `q`,
paginated.

The resolve body is `{ status: 'investigating' | 'resolved' | 'rejected', resolution? }`
(≤ 2000). `open` is a filterable status but **not** an adjudication decision.
`resolved_by` and `resolved_at` are stamped by the server, not the caller, and
reopening to `investigating` clears the stamp, so "resolved" and "resolved by X at T"
can never disagree. The dispute must exist first (`NOT_FOUND` 404 with no write); a bad
status is `VALIDATION_ERROR` 400. **200** — `{ dispute }`. Audits `dispute.resolve`.

### Support tickets

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/admin/support` | `['admin','ops','support','super_admin']` |
| `GET` | `/api/admin/support/[id]` | `['admin','ops','support','super_admin']` |
| `PATCH` | `/api/admin/support/[id]` | `ticket.write` |
| `POST` | `/api/admin/support/[id]/messages` | `ticket.write` |

The read gate is the staff allow-list; writes need `ticket.write` (held by all four
staff roles). The list filters by `status` (`open`/`pending`/`resolved`/`closed`),
`priority` (`low`/`normal`/`high`/`urgent`), `assignedTo` and a `subject` substring
`q`, paginated. The detail returns `{ ticket, messages }`, the thread oldest-first.

`PATCH` moves **only** the triage fields — `status`, `priority`, `assignedTo`,
`resolution` — and `resolved_at` is derived by the server module: it is stamped once
when a ticket reaches `resolved`/`closed` (a re-save does not move it) and cleared
when one is reopened to `open`/`pending`, so a "resolved at" cannot disagree with the
status. `POST messages` body is `{ body (1–4000), isInternal? }`; `isInternal` is
stored, not derived, marking a staff-only note. A message on a missing ticket is
`NOT_FOUND` 404 with no write. `PATCH` answers `{ ticket, messages }`; the message
answers **201** `{ message }`. Audits `support.update`, and `support.note` (internal)
or `support.reply` (public) for messages.

### Settings

| | |
|---|---|
| Auth | `GET` — staff read; `PUT` — capability write |
| Action | `GET` `['admin','ops','support','super_admin']`; `PUT` `role.manage` |

`GET` is a staff read (support needs `supportRefundLimit` to know when a refund needs
a second approver). **200** — `{ settings }`, the resolved `platform_settings`, every
key filled from `PLATFORM_DEFAULTS` when the row is missing.

`PUT` requires **`role.manage`** (`admin`/`super_admin` only — these are platform-wide
numbers, the same class of change as a role grant). It writes **only the keys present
in the body**, each validated against the type its entry in `PLATFORM_SETTING_KEYS`
declares (a number ≥ 0, or a string 1–200), so a partial save cannot blank the rest.
Unknown keys are collected; if **no** recognised key remains the request is
`VALIDATION_ERROR` 400 (`'No recognised settings to update'`), and an empty body is
400 (`'Nothing to update'`). **200** — `{ settings, updated: [key…] }`. The whole
batch is audited as one `settings.update` event carrying the per-key before/after.

### `GET` /api/admin/audit

| | |
|---|---|
| Auth | Required — capability read |
| Action | `audit.read` |

`audit.read` is held by `admin` and `super_admin` **only** — unlike every other read
on this page, this one is **not** open to `ops`/`support`, because the trail names
actors and carries before/after state. Filters: an `action` **substring** (so `refund.`
catches the whole family), an `entityType`/`entityId` pair, an `actorProfileId`, and a
`created_at` window. Paging defaults to **50**, max **200**. **200** — `{ logs: [ { id,
actorProfileId, actorName, actorRole, action, entityType, entityId, before, after,
metadata, ipAddress, requestId, createdAt } ], total }`, newest first. The
`before`/`after`/`metadata` blobs are carried through untouched — they were redacted on
the way in — so the viewer shows exactly what was recorded. Bad filters are
`VALIDATION_ERROR` 400.

### `GET` /api/admin/localities

| | |
|---|---|
| Auth | Required — staff read, no capability |
| Action | `['admin','ops','support','super_admin']` |

The picker behind the service-areas editor. Any staff member reads it; only
`service.manage` can attach one. Returns **only active** localities, capped at 100,
name-ordered, with an optional `q` name substring (≤ 60): **200** — `{ localities: [
{ id, name, city } ] }`. `city` is the resolved city name (empty string when the city
row is gone). Bad `q` is `VALIDATION_ERROR` 400.

---

## 4.9 Notifications and chat

Phase 7. Two read surfaces a person's own account owns (their bell and their
booking chat), one admin surface over the message catalogue, and two reminder
crons. The dispatcher that writes notification rows is not an endpoint — it is
called from the lifecycle routes and the crons, and is described at the end of
this section.

### `GET` /api/notifications

| | |
|---|---|
| Auth | Required — any signed-in account |
| Action | `notifications.list` |

The bell's page and its badge. **Scoped to the caller's own `recipient_id`** — there
is no id in the path and no way to ask for someone else's rows. Defaults to the
`in_app` channel, because that is the surface "read" means anything for; `?channel=`
names another channel to see the delivery history (a debug or support view).
`unreadOnly=true` filters to unread; paging defaults to **25**, max **100**.

**200** — `{ items: [ { id, channel, code, title, body, status, bookingId, readAt,
createdAt } ], unread, total }`. `unread` is counted over `in_app` rows regardless of
the requested channel — an unread email is not a bell item. A `channel` that is not
one of the five is **200** with `{ items: [], unread: 0, total: 0, ignoredChannel }`
rather than a silent empty page.

### `POST` /api/notifications/[id]/read

| | |
|---|---|
| Auth | Required — any signed-in account |
| Action | `notifications.read` |

Marks one notification read, **scoped to the caller**: a guessed id returns the same
**404** as an id that never existed (`NOT_FOUND`), so the endpoint is not a way to
probe whose notifications exist. **200** — `{ id, status, readAt }` (`status` becomes
`read`).

### `POST` /api/notifications/read-all

| | |
|---|---|
| Auth | Required — any signed-in account |
| Action | `notifications.readAll` |

The companion to the per-id read, and a **documented addition** (§25.9 names only the
per-id endpoint): clearing a badge one request per row is the kind of thing that works
in a demo and disappoints in production. Marks every unread `in_app` row for the
caller. **200** — `{ marked }`.

### `POST` / `DELETE` /api/notifications/push-token

| | |
|---|---|
| Auth | Required — any signed-in account |
| Action | `notifications.pushToken` / `notifications.pushToken.delete` |

The push-token registry (table `notification_devices`, a documented addition — §24.11
has no home for the token). **There is no FCM/APNs provider yet**, so registering a
token does not by itself deliver anything; it fills the registry a later integration
reads. `POST` validates `token` (8–4096) and `platform` (`web`/`ios`/`android`,
default `web`) and upserts on `(profile_id, token)`, refreshing `last_seen_at` on a
repeat: **201** — `{ device }`. `DELETE` forgets a token on sign-out, scoped to its
owner — the complement of the registration: **200** — `{ removed: true }`. A
token-less body is `VALIDATION_ERROR` 400.

### `GET` /api/bookings/[id]/chat

| | |
|---|---|
| Auth | Required — the two participants, or staff (read-only) |
| Action | `bookings.chat` |

A booking's thread and its history. The thread is created lazily the first time it is
read, and **only for a booking that has both participants**. A booking with no assigned
professional has no chat, and the answer is the same **404** a stranger gets, so the
endpoint is not a way to discover which bookings exist. Staff may read a thread but are
not participants in it. **200** — `{ thread, messages, canPost }`, where `canPost` is
`false` for staff. Message shape: `{ id, threadId, senderId, senderName, kind, body,
imagePath, readAt, createdAt }`.

### `GET` / `POST` /api/chat/threads/[id]/messages

| | |
|---|---|
| Auth | `GET` — participants or staff; `POST` — participants only |
| Action | `chat.messages.list` / `chat.messages.post` |

`GET` returns the same `{ thread, messages, canPost }` shape by thread id; anyone who
is neither a participant nor staff gets the same **404** as a thread that does not
exist. `POST` appends a message: only the two participants may post — staff who may
read are refused **403** (`FORBIDDEN`) — and a `system` message is server-only, so a
client that asks for one is refused **403** rather than trusted. A `text` message needs
a non-empty `body` (≤ 4000) and an `image` message needs an `imagePath` (≤ 1024);
empty is `VALIDATION_ERROR` 400. Posting to a closed thread is `INVALID_STATE` **409**.
**201** — `{ message }`. The thread's `last_message_at` moves in the same action.

### `GET` /api/admin/notification-templates

| | |
|---|---|
| Auth | Required — staff read |
| Action | `['admin','ops','support','super_admin']` |

The message catalogue behind `/admin/notifications` (§25.10). Any staff member reads it
(support needs to know what a customer was sent). Filters: `code`, `channel`, `locale`,
`isActive`; paging defaults to **100**, max **200**. **200** — `{ templates, total }`,
ordered by code then channel.

### `PUT` /api/admin/notification-templates/[id]

| | |
|---|---|
| Auth | Required — capability write |
| Action | `notification.manage` |

**`notification.manage`** is held by `admin`/`super_admin` only (D6): a template is what
every customer in the product reads, so it sits with the same class of change as a role
grant. Writes **only the fields present** — a partial save cannot blank the rest — so
`subject` (≤ 200, email only), `body` (≤ 4000), `variables` (a list of token names), and
`isActive` are each optional. `updated_by` is stamped from the caller, never passed. An
empty patch is `VALIDATION_ERROR` 400 (`'Nothing to update'`). **200** — `{ template }`.
The change is audited as `notification_template.update` with the before/after copy.

### Reminder crons

| | |
|---|---|
| Auth | `CRON_SECRET` — fails closed |
| Action | `cron.service-reminders` / `cron.rating-reminders` |

Two new schedules alongside the payment reconciliation cron (see §4.5). Both are `GET`,
both go through the one `assertCronSecret` guard — an unset `CRON_SECRET` is a **503**
(`SERVICE_UNAVAILABLE`), never a silent skip — and both are thin shells over a
`security definer` SQL function that does the whole pass in one transaction:

- `/api/cron/service-reminders` → `run_service_reminders()`. `SERVICE_ENDING_SOON` for
  an `in_progress` job ending within 15 minutes; `NEW_JOB_REMINDER` for an
  `assigned`/`on_the_way`/`arrived` job starting within 60 minutes (a second, disjoint
  15-minute window is de-duplicated separately). Both to the professional.
- `/api/cron/rating-reminders` → `run_rating_reminders()`. `RATING_REMINDER` for a
  customer whose booking completed today (Asia/Kolkata).

Both return **200** — `{ sent }`. The reason the pass lives in SQL is that these codes
are Realtime-only (`['in_app','push']`), and for those channels *writing the row is the
delivery* — so the advisory lock, the idempotency guard and the inserts share one
transaction and the lock actually holds. `vercel.json` schedules rating reminders once
a day. Service reminders need a 15-minute cadence, which the Vercel **Hobby** plan does
not allow (2 cron jobs, each at most once per day), so that route is not in
`vercel.json`: point an external scheduler at
`GET /api/cron/service-reminders?secret=$CRON_SECRET` every 15 minutes (cron-job.org, a
GitHub Actions schedule, or Supabase `pg_cron` + `pg_net` all work and cost nothing).

### The dispatcher (`lib/notifications.ts`)

Not an endpoint. `dispatch()` turns an event into one `notifications` row per channel
and moves each through `queued → sent | failed`; it is the **only** place a notification
row is written (the SQL reminder pass is the one documented exception, above). It never
throws — a booking is confirmed whether or not the mail server is up (§28.4), and a
failed delivery is recorded with its `error` rather than hidden. Delivery honesty (D1):
`in_app` and `push` are `sent` because writing the row is the delivery; `email` is
`failed` ("SMTP is not configured") when `SMTP_*` is unset; `sms`/`whatsapp` are
`failed` ("no SMS provider configured") because no provider is wired. Every code except
`OTP_LOGIN` also writes one `in_app` row.

The lifecycle routes call one hook each (`lib/notificationHooks.ts`) right after the
write they already make: confirm → `BOOKING_CONFIRMED`; accept → `PRO_ACCEPTED`; on the
way / arrive / OTP-start / complete → the matching `PRO_*` / `SERVICE_*`; cancel →
`BOOKING_CANCELLED`; refund execute → `REFUND_PROCESSED`; KYC verdict →
`KYC_APPROVED`/`KYC_REJECTED`; support reply → `TICKET_UPDATE`; a matching round that
offers a job → `NEW_OFFER` (`lib/matchingServer.ts` calls an optional `onOffered`
seam, so the engine is unaware of notifications and its unit tests still pass with a
fake database).

### Realtime channels (§27.1)

The browser subscribes through the anon client in `lib/supabase.ts` (`hooks/use-realtime.ts`).
Realtime applies RLS exactly as REST does, so a subscriber receives only rows its role
may SELECT — this widens *delivery*, never *visibility*.

| Channel | Table | Event |
|---|---|---|
| `booking:{id}` | `bookings` | UPDATE, `id=eq.{id}` |
| `me:{profileId}` | `notifications` | INSERT, `recipient_id=eq.{profileId}` |
| `chat:{threadId}` | `chat_messages` | INSERT, `thread_id=eq.{threadId}` |
| `pro:{id}` | Presence | the professional's `{lat,lng}` |

Polling is the baseline and Realtime is the accelerator (D4, §27.3): the bell polls
every 15 seconds and the chat the same, so a channel that never connects degrades the
latency, not the feature.

---

## 5. Idempotency

**Used by `POST /api/bookings` and `POST /api/payments/create-order`.**

The machinery is all there. Migration `0024_audit_idempotency.sql` creates
`idempotency_keys` with one row per `(key, operation, actor_profile_id)`, a
`request_hash`, and the stored `response_status` and `response_body`. Two
`security definer` functions do the work:

`claim_idempotency_key(p_key, p_operation, p_actor_profile_id, p_request_hash)`
returns one of four outcomes:

| Outcome | Meaning |
|---|---|
| `claimed` | The key was free. Insert it and do the work. |
| `replay` | Same key, same body hash, already completed. Return `stored_status` and `stored_body` verbatim — do not redo the work. |
| `in_flight` | Same key, same body, `completed_at` is still null. A concurrent request holds it. |
| `conflict` | Same key, different body hash. The client changed its mind under a key it had already spent. |

`complete_idempotency_key(p_key, p_operation, p_actor_profile_id, p_status,
p_body)` stamps the response onto the row and sets `completed_at`.

Both functions are revoked from `public`, `anon` and `authenticated` and granted
only to `service_role`, which is right: the key ledger is server state, not
something a browser should hold. The table has RLS with owner-scoped `select`,
`insert` and `update` policies and a `delete` policy that is `using (false)`.

The type mirror has the signature (`lib/supabase.ts`) and there is a real-database
test for all four outcomes in `test/db.rls.test.ts`.

**No Route Handler calls either function.** A search across `app/api/` for
`claim_idempotency_key` or `complete_idempotency_key` returns nothing. So
`IDEMPOTENCY_CONFLICT` is unreachable today, and no endpoint in the product is
safe to retry blindly.

The two places that *look* like idempotency are not it, and it is worth being
precise:

- `POST /api/auth/professional/apply` is idempotent by construction — it finds the
  existing `professionals` row and updates it — rather than by a key.
- `POST /api/customers/me/addresses/[id]/default` is safe to retry because
  `set_default_address` is a transaction, not because a key stops the second call.

Idempotency keys belong to booking creation and payment, which is where a
duplicate costs real money: `POST /api/bookings` in Phase 2 and
`POST /api/payments/create-order` in Phase 3 both require one.

---

## 6. Direct Supabase from the browser

**No client component reads a table.** Every read the browser makes goes through
a Route Handler, and that is not an accident of the current code — the schema
makes it the only option for the private data. The one table-shaped thing the
browser does directly is **subscribe** (§4.9): a Realtime channel pushes rows the
anon client may SELECT, and every one of those is re-fetched through a Route
Handler before it is shown, so the read path is still the API's.

The anon client in `lib/supabase.ts` is imported by exactly three files outside
the API:

| File | What it does |
|---|---|
| `contexts/AuthContext.tsx` | `supabase.auth.getSession()`, `onAuthStateChange`, `verifyOtp({ token_hash })`, `setSession`, `signOut`. Auth only, no tables |
| `components/ui/ImageUpload.tsx` | `supabase.storage.from('menu-images')` to upload and to read back a URL. No tables |
| `hooks/use-realtime.ts` | `.channel(...).on('postgres_changes', …)` for the §27.1 channels, and Presence. Subscriptions only — no direct `from(table).select()` |

The catalogue could go direct. `services`, `service_categories`, `localities`,
`cities` and `service_areas` are world-readable and their policies say `anon`, so
`/api/services` and friends are not access control — they are convenience. They
earn their keep in three places: the slot engine needs the professional working
windows and time off in one round trip, `serviceable` and `coverage` need
joins the anon client would have to make by hand, and `availability.write`-style
privilege has to be somewhere enforceable later. When the edge cache arrives,
these are the routes to put behind it.

**Addresses have no anon grant at all.** `0008_addresses.sql` runs
`revoke all on public.addresses from anon` and grants
`select, insert, update, delete` only to `authenticated`. There is no policy an
anonymous session could satisfy either, because `current_customer_id()` is null
without one. So an address cannot be read from the browser with the anon key by
any means, and `/api/customers/me/addresses*` is the only way in.

The service-role client is used inside the address routes rather than the caller's
session. That is a deliberate choice, stated in the route: RLS would enforce the
same isolation for an `authenticated` session, but using the service role keeps
the ownership rule in one place — in the `eq('customer_id', customer.id)` filter
in the query — rather than split between a policy and a query.

One thing that used to be worth knowing: `components/ui/ImageUpload.tsx` targeted a
storage bucket called `menu-images`, a SmartPOS name — dead code carried over from
the reference project. Phase 6 deleted it, so there is nothing to wire up by mistake.
SmartHelp's six buckets are `service-media`, `pro-photos`, `kyc-documents`,
`chat-media`, `support-media` and `invoices`.

---

## 7. Not built yet

So nobody goes looking. Cross-checked against `.planning/ROADMAP.md`.

**Each row notes what has since been delivered and what is still open.** The error
codes a delivery needs were already defined in `lib/api.ts`, which is one reason the
union is so much longer than the route table.

| Phase | Not built | Error codes reserved for it |
|---|---|---|
| 2 — Booking & pricing | **Delivered**: quote, create, list, detail, cancel, reschedule, invoice stub, coupons and the `bookings` state machine. Still open: there is no `bookingView` consolidated read model | `INVALID_STATE`, `ILLEGAL_TRANSITION`, `STALE_VERSION`, `ADDRESS_IN_USE` — `PRICE_CHANGED` is now in use |
| 3 — Payments | **Delivered**: order create, webhook, verify, `GET /api/payments/[id]`, the reconcile cron (§4.5). Still open: refunds, the wallet ledger and the approval console on top of them | `PAYMENT_FAILED`, `PAYMENT_NOT_VERIFIED` |
| 4 — Professional app | **Delivered**: KYC signed-upload trio, the verification workflow and staff verdict endpoint, working hours and time off, availability, the offer ledger (accept/decline), the job verbs (arrive, on-site OTP, complete, no-show) and the customer track/OTP read (§4.7). Still open: the earnings **page** and payouts (Phase 8), extensions, ETA and any professional-facing refund path | `PROFESSIONAL_UNAVAILABLE`, `ASSIGNMENT_TAKEN` are now in use |
| 5 — Matching engine | **Delivered**: `run_matching_sweep` is invoked by the offers read, `rank_candidates` / `match_booking` drive the ranked offer and the reassignment cascade, and an exhausted search is cancelled and auto-refunded (§4.7). Still open: distance/rating scoring (needs `earthdistance` and the ratings roll-up), the true §25.11 cron, the 30-minute arrived hold and the `professional_schedule` slot-picker input | `ASSIGNMENT_TAKEN`, `PROFESSIONAL_UNAVAILABLE` |
| 6 — Admin console | **Delivered**: dashboard, bookings (list/detail/cancel/assign), professionals (roster/detail/KYC review/bulk verdict/suspend), refunds (+ execute, with the second-approver rule), services/areas/durations, pricing rules, cancellation policies, coupons, disputes, support tickets, settings, audit, localities (§4.8). Still open: the notifications dispatcher and analytics report pages (Phase 7), and the payout run (Phase 8) | `SECOND_APPROVER_REQUIRED` is now in use |
| 7 — Realtime | **Delivered**: the §27.1 channels and professional Presence, booking chat (lazy thread, participants-only, staff read-only), the notification bell + dispatcher + template editor, and the two reminder crons (§4.9). Still open: a real push transport (no FCM/APNs provider, so `push` rows are `sent` but nothing is delivered to a device) and an SMS provider | — (reuses `FORBIDDEN`, `NOT_FOUND`, `INVALID_STATE`, `VALIDATION_ERROR`, `SERVICE_UNAVAILABLE`) |
| 8 — Growth | Recurring, wallet top-up, referrals, favourites, surge, PDF invoices, PWA | — |
| 9 — Hardening | Edge caching for `/api/service-categories`, load and accessibility passes | — |

Concretely, the gaps a reader is most likely to trip over:

- **No booking endpoint exists.** — **Superseded by Phase 2.** This was written when
  `/customer/checkout` was a deliberate Phase 1 deferral: the service-detail CTA
  pointed at a real destination rather than a dead button. The endpoints now exist
  (§4.4).
- **No professional-facing API exists at all.** — **Superseded by Phase 4.**
  `/api/auth/professional/apply` is still the Phase 0 write, but the whole
  professional surface now exists (§4.7).
- **The admin API exists as of Phase 6 (§4.8).** There is still **no
  role-management endpoint** — no route writes `profiles.role` — which is what keeps
  the known gap in `README.md` open: the `guard_profile_privileges()` trigger lets an
  *admin* set `super_admin`, because it distinguishes admin from everyone else rather
  than owner from admin. Whoever builds the admin role-management screen must refuse
  `super_admin` explicitly.
- **`platform_settings` is read as of Phase 6.** `0033` creates and seeds it, and
  `getPlatformSettings()` (`lib/settingsServer.ts`) is the one typed reader: the quote
  path (`loadPricingSettings()` in `lib/bookingQuote.ts`), the settings route and the
  bookings-assign route all read it, falling back to `PLATFORM_DEFAULTS` when a row is
  missing. So `taxRate`, `commissionPct`, `platformFee`, `offerTtlMinutes` and
  `supportRefundLimit` are now editable rows. (`/api/availability` still does not push
  out today's first slot: a same-day booking is dispatched immediately
  (`leadMinutesForDay` in `lib/availability.ts`), so only future days gate on the
  works' lead.)
- **Service-level aggregate ratings are always `null`.** `ratings` rows are written
  when a booking is reviewed, which is Phase 2.
- **No caching headers anywhere.** Every route sets `dynamic = 'force-dynamic'`.

### Unused code noticed while reading

Not bugs, but worth a ticket so they are not mistaken for behaviour:

| Symbol | Where | Why it is unused |
|---|---|---|
| `noContent()` | `lib/api.ts` | No route returns a 204 |

Everything else this table once listed has since been used. As of Phase 6,
`requireCapability()` is the write-gate on every mutating route — the admin console
*and* the customer/refund paths (`booking.create`, `booking.cancel.own`,
`refund.request`) call it — `parsePaging()` pages every admin list, and `isUuid()`
validates item ids in the quote and create paths. `requireStaff()` / `requireAdmin()`
no longer exist, `send-otp` imports `maskEmail()` from `lib/authServer.ts` instead of
keeping a copy, and `components/ui/ImageUpload.tsx` was deleted.