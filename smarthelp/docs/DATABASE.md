# The SmartHelp database

A reference for every table, policy and function that exists today, and an
honest account of the ones that do not.

`supabase/migrations/` is the source of truth. `supabase/schema.sql` is a
generated snapshot of it — `npm run db:schema` rewrites the file by
concatenating the migrations in filename order, and it carries a
`GENERATED FILE — do not edit by hand` header saying so. It has no history of
its own, so **do not run it as a migration**: if you paste it into the Supabase
SQL editor instead of the migrations, it will apply a shape that quietly ignores
every later edit to a migration. Run the migrations, then the seed. `docs/SETUP.md`
has the commands and the reasoning.

`lib/supabase.ts` is a *hand-maintained* mirror of the database types. It is not
generated, and it is not this document's source — after changing a migration,
rebuild the snapshot and check the types still describe the database.

Everything below is taken from the migrations, quoted verbatim. Where the
migrations are wrong, or where the planning documents disagree with them, this
file says so rather than smoothing it over.

---

## 1. Inventory

Thirty-one tables and one view. Every one of them has row-level security enabled;
`npm run test:db` asserts exactly that against a live database and fails with the
names of any table that does not.

| Table | What it holds | Migration | Phase |
|---|---|---|---|
| `profiles` | One row per auth user: role, status, name, optional phone | `0001`, amended `0027` | 0 |
| `customers` | The customer-side record: referral code, booking counters, lifetime value | `0001` | 0 |
| `otp_requests` | The OTP ledger: salted hashes, attempt counters, throttle and lockout state | `0001`, widened `0026` | 0 |
| `cities` | Launch cities, with timezone, currency and opening hours | `0002` | 0 |
| `localities` | The neighbourhoods inside a city, with a centre point and a radius | `0002` | 0 |
| `service_categories` | The top-level catalogue grouping | `0003` | 0 |
| `services` | A bookable service, its pricing shape and its duration bounds | `0003` | 0 |
| `service_tasks` | The included/excluded scope contract for a service | `0003` | 0 |
| `service_images` | Gallery images for a service | `0003` | 0 |
| `service_keywords` | Search terms attached to a service | `0003` | 0 |
| `service_areas` | Where a service is offered, with lead time and slot capacity | `0004` | 0 |
| `service_durations` | The duration ladder and its price override per rung | `0004` | 0 |
| `professionals` | The professional record: verification, availability, location, commission, counters | `0005` | 0 |
| `professional_documents` | KYC metadata; the bytes live in Storage | `0005` | 0 |
| `professional_working_hours` | Recurring weekly working windows | `0005` | 0 |
| `professional_time_off` | Ad-hoc absence windows | `0005` | 0 |
| `professional_skills` | Which professional is qualified for which service | `0006` | 0 |
| `addresses` | A customer's saved addresses, with resolved locality | `0008` | 1 |
| `bookings` | The booking: quote, price, status machine, window, OTP state | `0010` | 2 |
| `booking_items` | The priced service lines frozen onto a booking | `0010` | 2 |
| `booking_status_history` | One row per status move, with the actor that made it | `0010` | 2 |
| `professional_schedule` | Reserved working windows held by a booking | `0013` | 5 |
| `coupons` | Discount codes, their rules and their usage caps | `0016` | 2 |
| `coupon_usage` | One row per redemption, per customer | `0016` | 2 |
| `ratings` | One review per completed booking, five sub-scores | `0017` | 2 |
| `payments` | One row per charge attempt: gateway ids, status, refundable remainder | `0014` | 3 |
| `refunds` | One row per refund: amount, route, status, the gateway's id for it | `0015` | 3 |
| `wallets` | One row per customer who has held credit: the balance, as a cache | `0015` | 3 |
| `wallet_transactions` | The wallet ledger: append-only, `balance_after` on every row | `0015` | 3 |
| `audit_logs` | Append-only privileged-write trail | `0024` | 0 |
| `idempotency_keys` | One row per replayable privileged operation | `0024` | 0 |

One view: `public.public_professionals` (`0005`) — verified professionals, a
fixed reviewed column list, no coordinates and no commission.

Two migration files sit outside the phase their number suggests, both for
reasons the file itself records. `0024` is a Phase 9 migration in the delivery
plan but was applied in Phase 0, because the Phase 0 auth routes are already
privileged writes and the Definition of Done requires every one of them to leave
an audit row; its two tables reference no Phase 1–8 table, so it needed no edit.
`0026` and `0027` are follow-ups to Phase 0's own bugs, both about `otp_requests`
and `profiles.phone`. `0007` is data, not schema: the launch city, its twelve
localities, five categories and the catalogue, all as rows an admin can edit.

Enums, for completeness: `user_role` and `user_status` (`0001`), `pricing_type`
(`0003`), `verification_status`, `training_status` and `availability_status`
(`0005`), `address_type` (`0008`), `payment_purpose` (`0010`), `payment_status`
and `payment_method` (`0014`), `refund_status` and `wallet_txn_type` (`0015`).

---

## 2. Identity

### `profiles`

The one row that represents a person. `id` is the `auth.users` primary key
rather than a surrogate, so a profile cannot outlive its auth user, and there is
no column a browser can fill that would let a sign-up invent an identity.

- `id uuid primary key references auth.users(id) on delete cascade`
- `role user_role not null default 'customer'`, `status user_status not null
  default 'active'`
- `full_name text not null`, `locale text not null default 'en-IN'`,
  `avatar_url`, `last_seen_at`
- `phone text` — **nullable**, and `profiles_phone_format` now reads
  `phone is null or phone ~ '^\+?[0-9]{10,15}$'`
- `uniq_profiles_phone` on `(phone)`, `uniq_profiles_email` on `(lower(email))
  where email is not null`, `idx_profiles_role_status` on `(role, status)`

Two of those deserve a note. `phone` was `NOT NULL` until `0027`, and
`handle_new_user()` satisfied it for an account created without a number by
fabricating a placeholder from the user id — `+` plus the first twelve characters
of the UUID. A UUID is hex, so those twelve characters are letters about 99.7% of
the time, the check rejected the row, and **every** signup failed with GoTrue's
one unhelpful line `Database error creating new user`. `0027` stores `NULL`
instead, which is what is actually true; Postgres treats NULLs as distinct, so
`uniq_profiles_phone` still stops two people claiming the same number, and two
phone-less accounts stay distinct. A professional adds and verifies a real number
during onboarding.

The `role` and `status` columns are the only ones a self-service update cannot
touch, and that is not a policy — it is a column-level `grant update (full_name,
email, avatar_url, locale, last_seen_at)`, reinforced by
`guard_profile_privileges()`. Section 4 covers the trigger.

### `customers`

The customer-side record, one per customer profile. Read-only to the browser:
there is no `grant update` on the table at all.

- `profile_id uuid not null unique references public.profiles(id) on delete cascade`
- `referral_code text not null unique`, `referred_by uuid references
  public.customers(id) on delete set null`
- `wallet_id uuid` — a bare column, with the comment `FK added in
  0015_refunds_wallet.sql`. That migration does not exist. The column is
  `NOT NULL`-free and unindexed, and nothing reads it.
- `total_bookings`, `completed_bookings`, `cancelled_bookings` and
  `lifetime_value numeric(12,2)` all default to zero and are meant to move only
  as a side effect of a real booking, from the service role.

`idx_customers_referral` on `(referral_code)` is redundant against the unique
constraint and is harmless. `uniq_customers_referral_per_profile` on
`(referral_code, profile_id)` is weaker than the `unique` on `referral_code`
itself, and was presumably added to satisfy a relationship lookup; it is also
harmless. Codes come from `generate_referral_code(p_profile_id)`, which retries up
to twenty-four times against a 32-character alphabet and raises
`REFERRAL_CODE_EXHAUSTED` if it never finds a free one.

### `otp_requests`

The ledger that all emailed codes pass through. It is in `0001` even though the
specification files it under `0024`, because the login route was its first
consumer; `0024` does not re-create it.

- `target text not null` (E.164 phone, or lowercased email), `channel text` checked
  to `('phone','email')`
- `purpose text` — checked to `('login','staff_login','admin_mfa','signup',
  'password_reset')`, widened by `0026`
- `code_hash text not null`, `salt text not null` — the plaintext never lands here
- `attempts int not null default 0`, `max_attempts int not null default 3`,
  `expires_at timestamptz not null`, `locked_until`, `consumed_at`
- `idx_otp_target` on `(target, purpose, created_at desc)`,
  `idx_otp_open` on `(target, purpose) where consumed_at is null`,
  `idx_otp_open_reset` on `(target, purpose) where consumed_at is null and
  purpose = 'password_reset'`

`0026` is worth reading for one subtlety: the purpose check in `0001` was written
inline and so had no name, which means `0026`'s `drop constraint if exists
otp_requests_purpose_check` matched nothing. It worked, but only by accident — a
named check would not have been dropped.

The table has no insert path for a browser at all: `otp_no_client_access` is a
`for all using (false)` policy, `revoke all … from anon, authenticated`, and
`issue_otp` / `consume_otp` are revoked from `public` and re-granted to
`service_role` alone. A client cannot mint a code, and cannot burn one either.

### `audit_logs`

Append-only, and the enforcement is a trigger rather than a privilege, because
privilege is not enough: `audit_logs_are_immutable()` raises
`AUDIT_LOG_IMMUTABLE` on `before update or delete`, for everyone including the
service role. An audit trail that can be rewritten is not a trail.

- `actor_profile_id uuid references public.profiles(id) on delete set null`,
  `actor_role public.user_role`
- `action text not null`, `entity_type text not null`, `entity_id text`
- `before_state`, `after_state`, `metadata` as `jsonb`; `ip_address`,
  `user_agent`, `request_id` as text
- Four read indexes: `idx_audit_created` on `(created_at desc)`,
  `idx_audit_entity` on `(entity_type, entity_id, created_at desc)`,
  `idx_audit_actor` on `(actor_profile_id, created_at desc)`,
  `idx_audit_action` on `(action, created_at desc)`

`actor_role` is looked up from `profiles` inside `write_audit()` rather than
passed in, so a caller cannot forge the role it acted as.

Note `on delete set null` on the actor: deleting a profile erases who did
something but keeps the action. That is the right trade for a right-to-be-forgotten
account, and it does mean `actor_profile_id` is not a durable identity.

### `idempotency_keys`

One row per `(key, operation, actor_profile_id)` — that triple is the unique
constraint. `request_hash text not null` is the sha256 of the canonical body;
`response_status int` and `response_body jsonb` hold what to replay;
`completed_at` distinguishes in-flight from done.

`idx_idempotency_created` on `(created_at desc)` is the only index, and it is
there for the sweeper rather than for the lookup: the lookup is served by the
unique constraint. The table references no Phase 1 table and is self-contained,
which is why it could ship in Phase 0 ahead of the operations that will use it.

---

## 3. Geography

### `cities`

Reference data, and shaped for a platform that is not only India: `country`
defaults to `India`, `country_code char(2)` to `IN`, `time_zone` to
`Asia/Kolkata`, `default_currency char(3)` to `INR`, `pincode_prefixes text[]` to
`'{}'`.

- `business_hours jsonb not null` — a `{ "mon": { "open": "08:00", "close": "21:00" }, … }`
  document, Sunday 09:00–20:00
- `lat`, `lng` as `numeric(9,6)`, both nullable
- `uniq_cities_name_state` on `(lower(name), lower(state))`, `idx_cities_active`
  on `(is_active)`

### `localities`

The neighbourhood, and the unit that serviceability is actually keyed on.

- `city_id uuid not null references public.cities(id) on delete cascade`
- `lat numeric(9,6) not null`, `lng numeric(9,6) not null` — a locality without a
  centre point cannot be resolved from a coordinate, so these are required
- `radius_km numeric(5,2) not null default 8.00` — how far from its own centre a
  point may be and still count as this locality
- `uniq_locality_per_city` on `(city_id, lower(name))`
- `idx_localities_geo` is `gist (point(lng, lat))`, and `idx_localities_city_active`
  is on `(city_id, is_active)`

The GiST index needs `create extension if not exists btree_gist` (in `0002`),
because `point()` needs the `btree_gist` operator class to be GiST-indexable at
all. `point()` takes `(x, y) = (lng, lat)` — getting that order wrong produces an
index that is silently the wrong shape. **There is no PostGIS**, so `ST_Distance`
is unavailable and the `gist` index serves ordering and bounding-box filtering
only; real distance is Haversine in `lib/geo.ts`. That is a deliberate trade, and
it is recorded in `.planning/STATE.md`.

---

## 4. The catalogue

### `service_categories`

`name`, `slug text not null unique`, `icon_key text not null` (a lucide icon name
resolved in the UI), `image_url`, `sort_order`, `is_active`.
`idx_service_categories_active` is on `(sort_order) where is_active` — the exact
order the landing page asks for.

### `services`

The most constrained table in the schema, and the one every other catalogue table
hangs off.

- `category_id uuid not null references public.service_categories(id) on delete restrict`
  — `restrict`, not `cascade`: deleting a category with services in it must fail
  loudly rather than silently delete the marketplace
- `base_price numeric(10,2) not null check (base_price >= 0)`
- `pricing_type pricing_type not null default 'hourly'`, with
  `per_unit_needs_unit` requiring `unit_label` and `unit_price` whenever the type
  is `per_unit`
- `min_duration_min int not null default 30 check (min_duration_min > 0)` and
  `max_duration_min int not null default 360 check (max_duration_min >= min_duration_min)`
- `prep_minutes int not null default 0` — lead time before a slot can start, so it
  is catalogue data rather than something the slot engine hardcodes
- `max_active_jobs int not null default 1` — the concurrency cap for one
  professional on this service
- `requires_photo_proof boolean`, `materials_included boolean`, `materials_note text`
- `idx_services_category_active` on `(category_id) where is_active` and
  `idx_services_active_order` on `(sort_order, name) where is_active`

`base_price` means three different things depending on `pricing_type` — the
hourly rate, the total, or the per-unit rate — which `0007` states at the insert
and `lib/supabase.ts` does not. It is the least obvious thing about this table.

`created_at` is load-bearing in a way that is easy to miss: `is_serviceable()`
compares `s.created_at <= p_at`, so asking whether a service was offered at a
past instant is answerable even though coverage rows have no history.

### `service_tasks`

The included/excluded list on the service detail screen, and the thing a dispute
is later adjudicated against — which is why `0007` writes the labels as specific,
checkable statements and never "general cleaning".

- `kind text not null check (kind in ('included','excluded'))`, `label text not
  null`, `sort_order`
- `idx_service_tasks_service` on `(service_id, kind, sort_order)`, which is both
  the render order and the dispute filter
- No timestamps, no `updated_at`: a scope change is an audit event, not a
  revision history

### `service_images`

`service_id`, `url text not null`, `alt_text`, `sort_order`, with
`idx_service_images_service` on `(service_id, sort_order)`. The gallery comes from
the `service-media` bucket. **`0007` inserts no rows into it** — the table and its
policies exist, and the seeded services carry only their `image_url` column, so
the gallery on a seeded service is empty until an admin uploads something.

### `service_keywords`

Search terms, unique per service and case-insensitively. Two details in the
migration comment are worth keeping:

- There is **no primary key at all**. The uniqueness guarantee is
  `uq_service_keywords_case_insensitive` on `(service_id, lower(keyword))`, and
  it has to be an index: a `PRIMARY KEY` constraint takes column names only and
  cannot hold an expression, so `primary key (service_id, lower(keyword))` is a
  syntax error. The index gives the same guarantee.
- `idx_service_keywords_kw` on `(lower(keyword))` exists because a lookup
  searching by keyword alone cannot be served by an index keyed on `service_id`
  first.

`0007` inserts no rows here either, so keyword search has no subject until the
catalogue is populated.

### `service_areas`

Where a service is offered. A service is bookable only where an active row
exists, and the key is the locality.

- `locality_id`, `service_id`, both `on delete cascade`
- `lead_minutes int not null default 0` — a per-locality lead time, which may
  exceed the service's own `prep_minutes`; `0007` uses
  `greatest(s.prep_minutes, …)`
- `slot_capacity int not null default 4 check (slot_capacity > 0)`
- `unique (locality_id, service_id)`
- `idx_service_areas_lookup` on `(locality_id, service_id) where is_active` and
  `idx_service_areas_service` on `(service_id) where is_active`

The first of those is the one `is_serviceable()` uses; the second is what a
"who offers this service anywhere" question needs.

### `service_durations`

The ladder: which durations a service can be booked for, and what each costs.

- `minutes int not null check (minutes > 0)`, `unique (service_id, minutes)`
- `price numeric(10,2)` — a flat override, nullable
- `price_multiplier numeric(6,3)` — or a multiplier on the hourly base, nullable
- `duration_pricing_defined`: `price is null or price_multiplier is null`. A row
  may carry a flat price, a multiplier, **or neither** — both null means the
  service's `base_price` applies
- `idx_service_durations_service` on `(service_id, minutes) where is_active`

`0007` fills it from a fixed ladder of 30, 45, 60, 90, 120, 180, 240, 300 and 360
minutes, applied to hourly services within their own duration bounds; flat-priced
services get exactly one row at `max_duration_min` with `price = base_price`; and
per-unit services get the hourly ladder anyway, because the professional spends
time even when the customer is billed per kilogram.

---

## 5. Professionals

### `professionals`

The professional record, and the table with the most money and location in it.
That combination is why the browser does not get a general read on it and the
public view exists instead.

- `profile_id uuid not null unique references public.profiles(id) on delete cascade`
- `verification_status`, `training_status`, `availability_status` — three enums
  from `0005`, none of them updatable by the professional holding the row
- `current_lat`, `current_lng` as `numeric(9,6)`, both nullable, with
  `location_updated_at` to say when
- `service_radius_km numeric(5,2) not null default 12.00 check (service_radius_km > 0)`
- `commission_pct numeric(5,4) not null default 0.2000 check (commission_pct between 0 and 0.5)`
- `rating numeric(3,2) check (rating between 0 and 5)`, `rating_count`
- `total_offers`, `accepted_offers`, `completed_jobs`, `cancelled_jobs`, `no_shows`
  — with `acceptance_rate_positive`: `accepted_offers <= total_offers`
- `experience_months`, `probation_until`, `suspended_reason`, `kyc_verified_at`,
  `onboarded_at`
- `idx_prof_matchable` on `(verification_status, training_status, availability_status)`
  — the matching filter of §9.2, in that order
- `idx_prof_rating` on `(rating desc nulls last) where verification_status = 'verified'`
- `idx_prof_geo` on `gist (point(current_lng, current_lat)) where current_lat is
  not null` — the partial predicate keeps every professional who has never
  reported a location out of the index entirely

The `idx_prof_geo` GiST index inherits the `btree_gist` requirement from `0002`,
and has the same `(x, y) = (lng, lat)` ordering. Like the localities index it is
not a distance operator: there is no PostGIS, so proximity is computed in
TypeScript.

`guard_professional_privileges()` freezes nine columns against self-service edits:
`verification_status`, `commission_pct`, `rating`, `rating_count`,
`employee_code`, `probation_until`, `suspended_reason`, `kyc_verified_at` and
`onboarded_at`. What is left updatable by the professional is
`availability_status`, `is_available_today`, `current_lat`, `current_lng`,
`location_updated_at` and `service_radius_km` — which is precisely the
column-level `grant update` in `0005`.

### `professional_documents`

KYC metadata. The bytes are never in the database: `file_path text not null` is a
**storage path**, and the column comment says so.

- `doc_type text not null check (doc_type in ('aadhaar_front','aadhaar_back',
  'pan','address_proof','selfie','police_verification','training_certificate',
  'bank_passbook'))`
- `unique (professional_id, doc_type)` as `uniq_prof_doc` — one live document per
  type per professional
- `status verification_status not null default 'submitted'`, `rejection_reason`,
  `reviewed_by uuid references public.profiles(id) on delete set null`, `reviewed_at`,
  `expires_at`
- `idx_prof_doc_status` on `(status, created_at) where status in ('submitted','in_review')`
  — the KYC review queue's index, and the partial predicate is what makes it a
  queue rather than a history scan

`guard_professional_document_review()` enforces the split between uploading and
verifying, and its second half is the subtle one: a change to `file_path` or
`doc_type` by anyone who is not trusted, the service role or an admin is refused
outright when the old status is `verified` or `in_review`, with `KYC_DOCUMENT_LOCKED`
and a hint. Swapping the file while keeping `status = 'verified'` would otherwise
defeat the whole review. Replacing a `rejected`, `expired` or `not_submitted`
document is allowed, and silently resets `status` to `submitted` — a re-upload
restarts the review rather than inheriting the old verdict.

### `professional_skills`

Which professional is qualified for which service. §9.2 says this is the table
the matching engine filters on, so it is the one place a "verified to do this"
claim can live.

- `primary key (professional_id, service_id)` — a composite, so the pair is the
  identity
- `proficiency int not null default 3 check (proficiency between 1 and 5)`
- `verified_at timestamptz` — nullable, and only the service role or an admin may
  change it, which `guard_skill_verification()` enforces with
  `SKILL_VERIFICATION_FORBIDDEN`
- `idx_prof_skills_service` on `(service_id)` and `idx_prof_skills_prof` on
  `(professional_id) where verified_at is not null`

This is the only catalogue-adjacent table whose `select` policy is `using (true)`.
The reasoning is in the migration: an id pair and a 1–5 proficiency is not PII,
and it is what the public professional profile renders.

### `professional_working_hours`

Recurring weekly windows. `0005` is deliberate in not enabling RLS on
`professional_skills` here — `0006` creates the table and enables RLS itself, and
naming it in `0005` fails on a fresh database with `relation
"public.professional_skills" does not exist`.

- `weekday smallint not null check (weekday between 0 and 6)`, with the comment
  `0 = Sunday`
- `start_time time not null`, `end_time time not null`, and `valid_range`:
  `end_time > start_time`. A row cannot express an overnight shift, which is a
  real limitation for late-night work and one the slot engine inherits
- `unique (professional_id, weekday, start_time)` — which is also the only index,
  and it serves both the read and the `on conflict do nothing` in `seed.sql`
- No index on `(professional_id)` alone is needed: the unique index leads with it

### `professional_time_off`

Ad-hoc absence, in absolute instants rather than a weekday.

- `starts_at timestamptz not null`, `ends_at timestamptz not null`, `reason text`,
  and `valid_range`: `ends_at > starts_at`
- `idx_time_off_range` on `(professional_id, starts_at, ends_at)` — the only index,
  and it is shaped for "does any absence overlap this window"

`seed.sql` inserts no rows into this table, so the seeded professional works
every day of the week and is never off.

---

## 6. Addresses

### `addresses`

The Phase 1 table, and the most sensitive one a customer owns: it is where they
live, and `access_notes` describes how to get in.

- `customer_id uuid not null references public.customers(id) on delete cascade`
- `locality_id uuid references public.localities(id) on delete set null` — nullable
  only so that deleting a locality cannot fail on the rows that pointed at it, per
  the long column comment. A `NULL` means the address is outside current coverage,
  not that it is broken, and the API answers `coverage: 'not_yet_available'`
- `label text not null default 'Home'`, `address_type address_type not null default 'home'`
- `line1 text not null`, `line2 text`, `area text not null` (the locality name *as
  typed*), `city`, `state`, `pincode text not null`
- `lat numeric(9,6) not null`, `lng numeric(9,6) not null` — both required, because
  a guessed point sends the professional to the wrong building
- `landmark text`, `access_notes text`
- `location_precision text not null default 'locality_centre'`, checked to
  `('exact','locality_centre')` by `precision_known`
- `is_default boolean not null default false`, `created_at`, `updated_at`
- `uniq_default_address` is a partial unique on `(customer_id) where is_default` —
  exactly one default per customer, and partial because `is_default` is nullable
- `idx_addresses_customer` on `(customer_id, created_at desc)`,
  `idx_addresses_locality` on `(locality_id) where locality_id is not null`

`location_precision` is the one to understand. `'exact'` means the browser gave a
pin; `'locality_centre'` means the person typed an area and the system fell back
to the locality's middle. §5.4 makes the professional's approach depend on which
and §9.1 warns the customer to add a landmark in the second case, so the
difference has to outlive the write rather than existing only in the response that
carried it. The column was added after `0008` had already been applied on some
projects, which is why the file also carries an `alter table … add column if not
exists` — `create table if not exists` will not add a column to a table that
already exists.

The checks are cheap here and expensive to debug later, which is the stated
reason for all six: `latitude_in_range`, `longitude_in_range`, `pincode_shape`
(`^[0-9]{6}$`), `line1_present` and `area_present` (`length(btrim(...)) > 0`), and
`precision_known`.

`set_default_address(p_customer_id, p_address_id)` is the whole reason
one-default-per-customer survives concurrency. "Clear all, then set this" as two
statements from a Route Handler can interleave with a second request and leave a
customer with no default at all; inside one function it cannot.

**Locality resolution is not in the database.** The column comment on
`locality_id` says so: the rule lives in `lib/geo.ts`, because it is business
logic with radius semantics and wants unit tests. `0008` also records that §5.3
compares `addresses.area` to `localities.name` rather than joining on a stored
id, and that Phase 1 uses the stored id anyway because it survives a locality
being renamed.

---

## 7. Payments, refunds and the wallet

Money in, and the two ways it goes back out. `refunds` and the two wallet tables
are `0015`; they exist because Phase 2's plan promised that `refund_pending` and
`refunded` become reachable once `payments` does, and because §12.3's other half
— a customer is never left with nothing — needs somewhere to put the money when
the instrument will not take it.

### `payments`

The Phase 3 table, and the only one in the tree whose central column a browser is
deliberately not allowed to write. One row per **charge attempt**, inserted before
the gateway is asked for an order — an attempt nobody can see would otherwise be
impossible: a gateway order with no row behind it is invisible to reconciliation
and to a refund, while a row with no `gateway_order_id` is merely incomplete and
is exactly what the cron looks for.

- `booking_id uuid references public.bookings(id) on delete cascade` — nullable,
  because §12.4's `wallet_topup` (Phase 8) has no booking to point at
- `customer_id uuid not null references public.customers(id) on delete cascade`
  — not null, which is why `POST /api/payments/create-order` calls
  `requireCustomer` before anything else
- `purpose public.payment_purpose not null default 'booking'`, with
  `payments_booking_required` checking `purpose <> 'booking' or booking_id is not
  null`: a booking charge with no booking is a row nobody can reconcile
- `amount numeric(12,2) not null check (amount > 0)`, `currency char(3) not null
  default 'INR'` — rupees to two places, like every money column here, and paise
  arithmetic happens in `lib/money.ts` rather than in SQL
- `gateway text not null default 'razorpay'`, `gateway_order_id text`,
  `gateway_payment_id text`, `gateway_signature text`
- `status public.payment_status not null default 'created'` — §12.1's six states,
  `partially_refunded` included from the start for the same reason `0009` shipped
  the whole `booking_status` enum: adding an enum value later is an `ALTER TYPE`
  that rewrites the table under an `ACCESS EXCLUSIVE` lock
- `method public.payment_method`
- `refundable_amount numeric(12,2) not null default 0 check (refundable_amount >=
  0 and refundable_amount <= amount)` — what is *left* of this charge to refund,
  so the CHECK is the backstop that stops a double refund over-drawing the
  original amount
- `failure_reason text` — the gateway's own words, written before the create-order
  route refuses with `402 PAYMENT_FAILED`, which is what lets the checkout screen
  say what actually happened
- `idempotency_key text` — the same value passed to `withIdempotency()`. The
  ledger is pruned by the §25.11 wallet-expiry cron; this column is what keeps
  "one booking, one payment" true after it is gone, so it carries its own unique
  index
- `captured_at`, `created_at`, `updated_at`

Two partial unique indexes, both partial on purpose — a webhook-created or
cron-created row has no order id and no idempotency key, and two `NULL`s must not
collide in a table expected to hold exactly one such row per booking for a long
time:

| Index | On | Predicate |
|---|---|---|
| `uniq_payments_gateway_order` | `(gateway, gateway_order_id)` | `gateway_order_id is not null` |
| `uniq_payments_idem` | `(idempotency_key)` | `idempotency_key is not null` |
| `idx_payments_status` | `(status, created_at desc)` | — serves the cron's `status in ('created','pending') and created_at < now() - '10 minutes'` |
| `idx_payments_booking` | `(booking_id)` | — |

`trg_payments_touch` is the ordinary `touch_updated_at()` trigger.

**`gateway_signature` is evidence, not a log field.** The column comment says
`evidence for disputes; never logged` (§12.2), and `REDACTED_KEYS` in
`lib/audit.ts` carries the same name so it cannot reach an audit row by being put
in a metadata object by accident. It is passed to `confirm_booking_payment()` for
storage and nowhere else — it is not in `GET /api/payments/[id]`'s projection.

#### RLS

| Policy | Verb | Using |
|---|---|---|
| `payments_select_own` | `select` | `customer_id = current_customer_id()` **or** `is_staff(['admin','super_admin','ops'])` |

Plus `revoke all on public.payments from anon` and `grant select … to
authenticated`.

**There is no `insert` policy and no `update` policy at all**, and that is the
point rather than an omission: a browser that could insert a payment could set
`status = 'success'` directly. The `for select`-only shape is written out
explicitly (rather than left as an absence) for the same reason the `*_no_delete`
policies exist — so `pg_policies` shows a deliberate verb list. The service role
is the only writer, which is why every route that reads a payment goes through
`getPaymentForCaller()`: **RLS protects the browser and PostgREST, not the
service-role path**, since every Route Handler reaches Postgres through
`createServerClient()` and bypasses RLS entirely.

The staff set is `['admin','super_admin','ops']` rather than the
`['admin','super_admin']` every policy in `0001`–`0024` uses, because `ops` holds
`refund.execute` and cannot exercise it against a row it may not read. `support`
holds `refund.request` and is deliberately outside — a support agent can request a
refund they cannot see. That is recorded as an open question rather than widened
here.

### `refunds`

One row per refund, however it is paid back — to the gateway instrument or, when
that instrument cannot take it, to the wallet. The row is written **before** the
gateway is asked, the same ordering `payments` uses on the way in and for the
same reason: a gateway refund with no row behind it is invisible to every screen
in the product and it is created with money attached.

- `payment_id`, `booking_id`, `customer_id` — all `not null`, all
  `references … on delete cascade`. The customer and the currency are read from
  the payment rather than supplied by the request, so a caller cannot name
  somebody else's account.
- `amount numeric(12,2) not null check (amount > 0)`, `currency char(3) not null
  default 'INR'`
- `status public.refund_status not null default 'requested'` — the whole ladder
  ships (`requested`, `approved`, `rejected`, `completed`, `failed`), because
  `approved`/`rejected` are Phase 6's approval console (§25.10) writing into a
  table that already has a place for them, and adding an enum value later is an
  `ALTER TYPE` that rewrites the table under an `ACCESS EXCLUSIVE` lock
- `route text not null default 'gateway' check (route in ('gateway','wallet','mixed'))`
  — which of the two ways the money went back. "The customer got their money"
  is two different facts when a dispute is opened about it later.
- `reason_code text not null`, `note text`
- `gateway_refund_id text` — persisted **before** completion, so a process that
  dies between the gateway's answer and `complete_booking_refund()` leaves a row
  the `refund.processed` webhook can match on and finish
- `requested_by`, `processed_by`, `approved_by` → `public.profiles(id)` on
  delete set null
- `requested_at`, `completed_at`, `created_at`, `updated_at`

| Index | On | Predicate |
|---|---|---|
| `uniq_active_refund_per_payment` | `(payment_id)` | `status in ('requested','approved')` |
| `idx_refunds_booking` | `(booking_id, created_at desc)` | — |
| `idx_refunds_customer` | `(customer_id, created_at desc)` | — |
| `idx_refunds_status` | `(status, created_at desc)` | — the staff list filters on this first |

The unique index is partial on purpose: one *active* refund per payment, and a
partial refund after a completed one is a legitimate second row, which
`unique (payment_id)` would refuse. `trg_refunds_touch` is the ordinary
`touch_updated_at()`.

#### RLS

| Policy | Verb | Using |
|---|---|---|
| `refunds_select_own` | `select` | `customer_id = current_customer_id()` **or** `is_staff(['admin','super_admin','ops'])` |

Plus `revoke all on public.refunds from anon` and `grant select … to
authenticated`, and — as on `payments` — **no insert and no update policy**: a
browser that could insert a refund could set `status = 'completed'` and hand
itself money.

### `wallets`

The balance, as a *cache*. `wallet_transactions` below is the truth; this row is
what `apply_wallet_delta()` keeps in step with it.

- `customer_id uuid not null unique references public.customers(id) on delete
  cascade` — one wallet per customer, which is what makes `get_or_create_wallet()`
  a single statement rather than a read and a write
- `balance numeric(12,2) not null default 0 check (balance >= 0)`
- `created_at`, `updated_at`
- `customers.wallet_id uuid references public.wallets(id)` — the column shipped
  in `0001` with a comment promising a foreign key that `0015` adds. Every
  existing row was null, so the constraint could be added to a live table
  without a backfill.

There is deliberately **no touch trigger** here. `apply_wallet_delta()` is the
only writer that changes a balance and it sets `updated_at` itself; a trigger
would also fire on `get_or_create_wallet()`'s conflict clause, which writes
nothing — an "updated" timestamp that moves when nothing moved is worse than one
that only moves for money.

#### RLS

| Policy | Verb | Using |
|---|---|---|
| `wallets_select_own` | `select` | `customer_id = current_customer_id()` |

Plus `revoke all on public.wallets from anon` and `grant select … to
authenticated`. No insert policy, no update policy: the service role is the only
writer, and a browser that could write its own balance could write itself money.

### `wallet_transactions`

The ledger, append-only, and the table §12.4's `apply_wallet_delta()` writes in
the same statement as the balance. Every row is a positive movement plus the
balance it produced, which is what makes the ledger auditable: a reader can
re-run it and check it against `wallets.balance` without trusting either one.

- `wallet_id uuid not null references public.wallets(id) on delete cascade`
- `type public.wallet_txn_type not null` — `'credit'` or `'debit'` and nothing
  else. Direction is the whole of what this column is for; *what* the movement
  was for is `ref_type`/`ref_id`. A `'refund'` value would make direction
  ambiguous at exactly the point where an ambiguous direction costs money.
- `amount numeric(12,2) not null check (amount > 0)` — direction is never the
  sign, so a negative amount is refused by the column rather than by a caller
- `balance_after numeric(12,2) not null` — §12.4's own INSERT omits this column,
  which is amendment (1) to the specification's function
- `ref_type text not null`, `ref_id text` — `'refund'` / `<refunds.id>`, split on
  the first colon, both halves kept because "a credit happened" without "for
  which refund" is not evidence
- `description text not null`, `created_at`
- `idx_wallet_txn_wallet on (wallet_id, created_at desc)`

#### RLS

| Policy | Verb | Using |
|---|---|---|
| `wallet_txn_select_own` | `select` | `exists (select 1 from public.wallets w where w.id = wallet_id and w.customer_id = current_customer_id())` |
| `wallet_txn_no_update` | `update` | `using (false)` — §12.4's outright block |
| `wallet_txn_no_delete` | `delete` | `using (false)` — §12.4's outright block |

Plus `revoke all on public.wallet_transactions from anon` and `grant select … to
authenticated`. There is no insert policy either — `apply_wallet_delta()` is
`security definer`, and a browser that could insert a row could forge a
`balance_after`.

What the two `using (false)` policies buy, precisely: `authenticated` holds only
`select` on this table, so an update or delete is refused with
`permission denied for table wallet_transactions` before row-level security is
consulted at all. The policies are still written out, as they are on
`audit_logs`, so that `pg_policies` shows a deliberate verb list rather than an
absence — and so the refusal survives a grant being widened later. This is the
one place where the "one policy per verb" convention of section 8 is spelled out
as an explicit *no* rather than left out: §12.4 names both blocks.

---

## 8. Row-level security

Every table in `public` has RLS enabled, and `test/db.rls.test.ts` proves that by
querying `pg_class` for any `relrowsecurity = false` and failing with the names.
What that test does **not** do is stated in section 10.

### The helper predicates

Three functions carry almost every policy, all defined `security definer` and
owned by `postgres`, which has `BYPASSRLS`. Without `security definer` they would
recurse through the very policies that call them.

- **`public.current_customer_id()`** — `select id from public.customers where
  profile_id = auth.uid()`. The caller's own customer row, or `NULL`. This is
  what scopes every `addresses` policy, and `NULL` is the load-bearing part: with
  no `auth.uid()` it is `NULL`, and `NULL = NULL` is false in a `using` clause,
  so an anonymous session matches nothing without needing a separate rule.
- **`public.current_professional_id()`** — `select id from public.professionals
  where profile_id = auth.uid()`. Defined in `0005`, not `0001`, because
  `professionals` did not exist yet, and `0001` says so in a comment. `0000`'s
  bucket policies and `0025`'s depend on this ordering.
- **`public.is_admin()`** — `is_staff(array['admin','super_admin'])`. The other
  two are `is_staff(p_roles public.user_role[])`, which requires
  `status = 'active'` as well as the role, and `is_ops()`, which is
  `is_staff(array['admin','super_admin','ops','support']))`. Both helpers also
  require `active`, so a suspended staff account loses its staff policies without
  anything having to revoke them.

`current_role()` and `current_status()` are the same shape without the role
filter, and `is_trusted_session()` is a fourth thing worth naming: true only for a
direct SQL session with no JWT claim set — `psql`, the SQL editor, a migration
run. PostgREST always sets the claim, so from a browser it can never be true, and
it is what lets migrations and the seed do privileged work while the trigger
guards still refuse every browser request.

### The policy-per-verb convention

Every table carries one policy per verb, named `*_select_own`, `*_insert_own`,
`*_update_own`, `*_delete_own` or `*_no_delete` / `*_no_insert`. There are no
`for all` policies on identity tables — they are written out per verb so that a
refusal is always a specific `using (false)` rather than an absence. The
consequence you can see in `pg_policies` is 80 policies across the tables and
storage objects — 69 on tables, 11 on `storage.objects` — and the `for all`
policies that do exist are all `*_admin_write` or `*_write_own` on catalogue and
reference data.

Every policy is created inside a `do $$ … exception when duplicate_object then
null; end $$;` block. That is what makes the migrations re-runnable against a
live project, and it means a policy is never silently replaced — a re-run is a
no-op, so changing a policy requires editing the body, not just the name. There
are 80 policies in total across the thirty-one tables and `storage.objects`, and
no `drop policy` statement anywhere — count them from `pg_policies`, not from
this sentence.

### What is deliberately not readable

**`addresses`** has `revoke all on public.addresses from anon` and no policy an
anonymous session can satisfy. The catalogue is world-readable; an address is
not. Staff read addresses through the service role in a Route Handler, which
enforces ownership in the handler and is what lets support tooling see one — a
browser session cannot take that path.

**The private buckets** have no read policy at all. `kyc-documents` is the
clearest case: a professional can insert and update their own document under
their own folder prefix, and there is deliberately **no `select` policy**, so a
signed-in professional cannot read the object back with the anon key. `chat-media`,
`support-media` and `invoices` have no client policies whatsoever — a bucket with
no policy is unreadable through the client API, which is the correct default for
every one of them until the phase that owns them writes participant-scoped
policies.

Two other distinctions are worth stating plainly, because they are easy to assume
away:

- `otp_requests`, `audit_logs` and `idempotency_keys` all have `revoke all …
  from anon`. `audit_logs` keeps its `grant select … to authenticated` on purpose
  — revoking the table grant instead would make the `audit_read_staff` policy
  decorative, because nothing would be left for it to filter.
- `public.public_professionals` is a plain view, so it is evaluated with the
  view owner's rights and is **not** subject to the RLS policies on
  `professionals` and `profiles`. That is the design: `professionals` holds live
  coordinates and the commission rate and is not generally readable by the
  browser, and the view is a fixed, reviewed column list filtered to
  `p.status = 'active' and pr.verification_status = 'verified'`. Its own `where`
  clause is the filter.

### The privilege guards

RLS decides which *rows* a session may touch. It says nothing about which
*columns*, and in two places that matters enough to need a trigger.

- `guard_profile_privileges()` raises `PROFILE_PRIVILEGE_CHANGE_FORBIDDEN` when
  `role` or `status` changes and the session is not trusted, the service role or
  an admin. A signed-in user can edit their own profile and can never promote
  themselves, unblock themselves or re-activate themselves.
- `guard_professional_privileges()` does the same for the nine columns in
  section 5, with `PROFESSIONAL_PRIVILEGE_CHANGE_FORBIDDEN`.
- `guard_professional_document_review()` and `guard_skill_verification()` are
  described in section 5.

All four share the same escape hatch — `is_trusted_session() or auth.role() =
'service_role' or is_admin()` — and all four are `security definer`, so they can
read `profiles` to evaluate it.

> **Known gap.** `guard_profile_privileges()` distinguishes an admin from
> everyone else, not the owner from an admin. An admin can set any role,
> including `super_admin`. Nothing exposes that today — there is no
> role-management API — but whoever builds the admin role-management screen has to
> refuse `super_admin` explicitly, or the owner stops being unique.

---

## 9. Functions

| Function | Returns | EXECUTE |
|---|---|---|
| `current_role()` | `user_role` | granted to `anon`, `authenticated` (`0001`) |
| `current_status()` | `user_status` | default `PUBLIC` — not revoked |
| `is_staff(p_roles user_role[])` | `boolean` | granted to `anon`, `authenticated` (`0001`) |
| `is_admin()` | `boolean` | default `PUBLIC` — not revoked |
| `is_ops()` | `boolean` | default `PUBLIC` — not revoked |
| `is_trusted_session()` | `boolean` | default `PUBLIC` — not revoked |
| `current_customer_id()` | `uuid` | default `PUBLIC` — not revoked |
| `current_professional_id()` | `uuid` | granted to `anon`, `authenticated` (`0005`) |
| `is_serviceable(p_locality_id, p_service_id, p_at)` | `boolean` | granted to `anon`, `authenticated` (`0004`) |
| `set_default_address(p_customer_id, p_address_id)` | `uuid` | granted to `authenticated`, `service_role` (`0008`) |
| `issue_otp(...)` | `uuid` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only |
| `consume_otp(p_target, p_purpose, p_code)` | `text` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only |
| `write_audit(...)` | `uuid` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only |
| `claim_idempotency_key(...)` | table | **revoked** from `public`, `anon`, `authenticated`; `service_role` only |
| `complete_idempotency_key(...)` | `void` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only |
| `create_booking(...)` | `bookings` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0028`) |
| `cancel_booking(...)` | `bookings` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0028`) |
| `transition_booking(...)` | `bookings` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0028`) |
| `confirm_booking_payment(...)` | `payments` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0014`, body superseded by `0015`) |
| `get_or_create_wallet(p_customer)` | `uuid` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0015`) |
| `apply_wallet_delta(p_wallet, p_type, p_amount, p_ref, p_desc)` | `numeric` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0015`) |
| `record_booking_refund(...)` | `refunds` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0015`) |
| `complete_booking_refund(...)` | `refunds` | **revoked** from `public`, `anon`, `authenticated`; `service_role` only (`0015`) |

The two rows are different in kind and the difference is the whole point. The
predicate helpers keep Postgres's default `PUBLIC` EXECUTE grant, which is why the
migrations bother with explicit `grant execute` on some of them and not others —
the explicit ones are belt and braces. The nine ledger and write-path functions
are revoked from `public` and re-granted, so a browser cannot reach them at all.

Four functions are **not** reachable through PostgREST regardless of their grant,
because Postgres will not call a `returns trigger` function directly: the four
guards and `touch_updated_at()`. Two more are genuinely callable by anyone and are
worth knowing about: `generate_referral_code(p_profile_id)` and
`backfill_profiles()` are `security definer` with the default `PUBLIC` EXECUTE.
Neither leaks anything — `backfill_profiles()` only creates rows for auth users
that have no profile yet, which is what it exists to do — but they are not
service-role-only the way the ledger functions are, and closing them is a decision
nobody has taken. `seed.sql` adds a sixth, `seed_demo_user(...)`, and drops it
again at the end of the file.

### The OTP ledger

`issue_otp(p_target, p_channel, p_purpose, p_code, p_ttl_minutes default 10,
p_max_attempts default 3, p_resend_seconds default 60, p_lockout_minutes
default 15)` issues, and `consume_otp(p_target, p_purpose, p_code)` verifies.
Both are `security definer` and both live in SQL rather than in a Route Handler
because two concurrent requests must not both slip past the throttle.

- The 60-second resend window is checked **inside** `issue_otp`, and a hit raises
  `OTP_THROTTLED`. The errcode is `55000` for a reason worth repeating: it has to
  be a five-character SQLSTATE. `errcode = 'rate_limited'` makes the *raise
  itself* fail with `unrecognized exception condition`, so the caller saw an
  internal error instead of a throttle and the 60-second window was never
  reported.
- Issuing supersedes: only the newest unconsumed code for a `(target, purpose)`
  stays live, and the previous rows are stamped `consumed_at`.
- One salt is generated once, `encode(gen_random_bytes(16), 'hex')`, and used for
  both the stored salt and the hash — `digest(p_code || v_salt, 'sha256')`.
  Hashing against anything else here would make every code unverifiable.
- `consume_otp` returns `'ok' | 'invalid' | 'expired' | 'locked' | 'missing'`, and
  reads the newest unconsumed row `for update`. The counter increment and the
  consumption are one statement each under that lock, so two concurrent correct
  codes cannot both succeed.
- A wrong code increments `attempts`; when the increment reaches `max_attempts`
  the row gets `locked_until = now() + 15 minutes`. The lockout window is
  hard-coded to 15 minutes in the body even though `p_lockout_minutes` is a
  parameter — the parameter is accepted and ignored.

### `is_serviceable()`

The single gate every availability and booking check funnels through: is this
service offered at this locality right now? It joins `service_areas`, `services`
and `localities` and requires all three `is_active`, plus
`s.created_at <= p_at` for the historical case. It is `security definer`, so it
does not depend on the caller's catalogue read access, and it is granted to
`anon` — the answer "no" or "yes" reveals nothing a person could not get from
the catalogue directly.

### Triggers

| Trigger | Function | Effect |
|---|---|---|
| `on_auth_user_created` | `handle_new_user()` | `after insert on auth.users` |
| `trg_profiles_touch`, `trg_customers_touch`, `trg_services_touch`, `trg_professionals_touch`, `trg_addresses_touch` | `touch_updated_at()` | `before update`, sets `new.updated_at = now()` |
| `trg_profiles_guard_privileges` | `guard_profile_privileges()` | `before update on profiles` |
| `trg_professionals_guard_privileges` | `guard_professional_privileges()` | `before update on professionals` |
| `trg_prof_documents_guard` | `guard_professional_document_review()` | `before update on professional_documents` |
| `trg_prof_skills_guard` | `guard_skill_verification()` | `before update on professional_skills` |
| `trg_audit_logs_immutable` | `audit_logs_are_immutable()` | `before update or delete on audit_logs` |
| `trg_payments_touch` | `touch_updated_at()` | `before update on payments` |

`handle_new_user()` is the provisioning path, and it runs as the auth server so
RLS does not apply. It will only ever grant `customer` or `professional` — a
sign-up asking for `admin`, `support`, `ops` or `super_admin` gets `customer` and
nothing else — it refuses to take over a phone number that already belongs to
another profile, it takes `full_name` from metadata and falls back to the local
part of the email, and it creates a `customers` row with a referral code only when
the role is `customer`. `0027` rewrote it to store `NULL` for a missing phone
rather than a fabricated one; that is the one line that changed. `backfill_profiles()`
does the same work for auth users that predate the trigger and returns a count.

Every `drop trigger if exists` precedes its `create trigger`, which is what lets
the migrations re-run against a live project.

### `write_audit` and the idempotency ledger

`write_audit(...)` is the single writer for `audit_logs`: `audit_no_write` is
`with check (false)`, and the function's EXECUTE grant was revoked from `public`
and re-granted to `service_role` alone. A browser must never be able to write an
audit row. It looks `actor_role` up from `profiles` itself rather than trusting
the caller's word for it.

`claim_idempotency_key(p_key, p_operation, p_actor_profile_id, p_request_hash)`
returns a row of `outcome`, `stored_status`, `stored_body` with one of four
values: `'claimed'` (the row is inserted and yours to work on), `'in_flight'`
(same key, same body, still running — the caller must wait, not start a second
write), `'conflict'` (same key, different body, which means the client changed its
mind under a key it had already spent), and `'replay'` (same key, same body,
finished — the stored status and body come back). `complete_idempotency_key(...)`
writes the response and sets `completed_at`.

The `revoke … from public` on these three deserves repeating because it is a trap
rather than a detail: Postgres grants EXECUTE to `PUBLIC` on every new function,
so revoking from `public` also strips it from `service_role`. The Route Handlers
call these through PostgREST *as* `service_role`, and a missing EXECUTE grant is a
hard `permission denied for function`, not a warning. Each `revoke` is therefore
paired with an explicit `grant … to service_role`.

### The booking write paths (`0028`)

`create_booking`, `cancel_booking` and `transition_booking` exist because three
separate PostgREST requests cannot be one transaction. Creating a booking was
previously a booking row, then its `booking_items`, then a status update to
`payment_pending` — three round trips, and a failure between any two of them left
a booking that existed with a total and nothing behind it, or a booking stuck at
`draft` with an item list the customer never agreed to. Each of these functions is
`security definer` and does its whole job in one statement.

| Function | What it does in one transaction |
|---|---|
| `create_booking(...)` | numbers the booking, inserts it, inserts every `p_items` line, moves `draft → payment_pending`, returns the row |
| `cancel_booking(...)` | writes `cancelled_at`, `cancellation_reason_code` and `cancellation_fee`, moves to `cancelled`, returns the row — or `NULL` when `p_expected_version` does not match |
| `transition_booking(...)` | moves status and/or the scheduled window with a version guard, returns the row |

The state machine did not move. All three are ordinary `update`s, so
`guard_booking_transition()` still decides what is legal and still raises
`ILLEGAL_TRANSITION` — which is what the test asserting that
`transition_booking(p_to => 'paid')` on a `draft` booking is refused is there to
prove. A function that writes `status` is a way to *use* §8.2, not a way around it.

**The actor arrives as a parameter, not as a session.** This is the part worth
reading twice. The history trigger records `coalesce(auth.uid(), …)`, and a
service-role request has no `auth.uid()` — so every privileged write in the
database was attributed to `system`. That is not cosmetic: §8.2's history is the
evidence for who did what to a booking, and "somebody" is not evidence.

PostgREST gives no way to set a session variable *and* run the update it belongs to
in one transaction, so each function sets transaction-local settings first and then
performs the writes that read them:

```sql
perform set_config('app.transition_actor', coalesce(p_actor::text, 'system'), true);
perform set_config('app.transition_actor_role', coalesce(p_actor_role::text, 'ops'), true);
```

The third argument `true` is what makes these transaction-local rather than
session-local; without it a `service_role` connection would keep the last actor's
name for the rest of its life, and the next booking would be attributed to whoever
created the previous one. The fallback `'ops'` for a missing role is deliberate and
matches `write_audit`'s convention: an unattributable privileged write is an
operations action, and labelling it `system` is what made this problem invisible in
the first place.

**Version guards are a return value, not an exception.** `cancel_booking` and
`transition_booking` take `p_expected_version` and compare it against the row they
locked. A mismatch is `NULL`, not a raise, because "someone else already moved this"
is an ordinary outcome of two devices and an ordinary answer to give the caller:
the Route Handler turns it into `409 STALE_VERSION`, and the client re-reads. Raising
would produce a 500 and a support ticket instead.

Note what these functions do **not** do: none of them re-price. `p_money` is data the
caller supplies, and it is inserted as given. The authority for a price is
`buildQuote()` in `lib/bookingQuote.ts`, which reads the database; the function's
job is to write a set of numbers atomically, not to decide what they are.

### The payment write path (`0014`)

`confirm_booking_payment(p_payment_id, p_gateway_order_id, p_booking_id,
p_gateway_payment_id, p_gateway_signature, p_note) returns public.payments` sits
beside `0028`'s three because it is the same answer to the same problem: moving
`payments.status = 'success'` and `bookings.status = 'paid'` as two PostgREST
requests reproduces exactly the partial-write bug `0028` exists to fix — a payment
reading `success` against a booking still `payment_pending`, or the reverse.

- **Two callers, one behaviour.** The Razorpay webhook and
  `GET /api/cron/reconcile-payments` both funnel through it, because three writers
  with three behaviours is how a booking ends up `paid` while its payment says
  `pending`.
- **The replay guard is in the `where` clause:** `status in ('created','pending')`.
  A second call with the same arguments updates zero rows and returns `null`, so a
  re-delivered webhook does nothing rather than re-confirming. The caller turns
  `null` into `{ duplicate: true }`.
- **The booking only moves if it is still waiting:** `where status =
  'payment_pending'`. A booking cancelled while the charge was in flight stays
  cancelled — the money did arrive, so the payment is `success` and it becomes a
  refund somebody owes rather than a job that should start. `quote_token` is
  nulled here, which is what makes the token single-use across the payment
  lifecycle.
- **`if not found` is checked before `v_payment` is touched**, because with no row
  matched `into` leaves the record unassigned and a field reference on it raises
  rather than returning null.
- **The actor is deliberately empty.** The function sets
  `app.transition_actor = ''` and `app.transition_actor_role = ''` — a webhook has
  no profile to name, `booking_status_history.actor_id` is nullable, and
  `public.user_role` has no `system` value (adding one would be an `ALTER TYPE` on
  a table with a history row behind every row). The `p_note` carries the
  provenance instead: `"payment confirmed by webhook (payment.captured, pay_…)"`,
  or `"payment reconciled by cron (order order_… is paid)"`.
- **Executes for `service_role` only**, same as `0028`'s three: `revoke all … from
  public, anon, authenticated`, then `grant execute … to service_role`.

It does **not** re-price and does **not** talk to Razorpay. Its job is to write a
set of facts atomically.

### The refund and wallet write paths (`0015`)

Four functions, all `security definer`, all `service_role` only, all the same
shape as `0028`'s: several rows that must agree, moved in one statement, by code
that never talks to Razorpay.

| Function | What it moves |
|---|---|
| `get_or_create_wallet(p_customer) returns uuid` | Creates the wallet if this is the customer's first credit and keeps `customers.wallet_id` pointing at it. One statement, because `wallets.customer_id` is `unique` *and* `customers.wallet_id` references it: two concurrent refunds that each read "no wallet yet" would produce two rows or leave the FK dangling. `on conflict … do update … returning` is the shape that returns the **existing** row — `do nothing` returns nothing, and a follow-up `select` can miss a row a concurrent transaction has not committed yet. |
| `apply_wallet_delta(p_wallet, p_type, p_amount, p_ref, p_desc) returns numeric` | The balance and its ledger row, or neither. Both amendments below. |
| `record_booking_refund(...) returns refunds` | Inserts the refund and hops the booking to `refund_pending` **only when its status is `paid` or `cancelled`** — the two legal predecessors `0011` allows. The conditional hop is the point: a request nobody has approved must not strand a paid booking in a state that says the money is going back, so the hop happens here and execution is what makes it real. It also refuses an amount above `payments.refundable_amount` before the row exists. |
| `complete_booking_refund(...) returns refunds` | Refund → `completed` with `completed_at`, booking `refund_pending → refunded`, `payments.refundable_amount` down and `payments.status` → `partially_refunded` or `refunded`, in one transaction. **This is what makes §8.2's two refund states reachable**, which is what Phase 2's plan promised. The replay guard is `status in ('requested','approved')`: a re-delivered `refund.processed` webhook updates zero rows and returns `NULL` rather than refunding twice. |

#### §12.4's `apply_wallet_delta`, with two amendments

The specification's function does not run against the specification's schema, and
both mismatches are in the migration header:

1. **`balance_after` is written.** §24.9 declares the column `NOT NULL` and
   §12.4's INSERT omits it, so as written the function raises `not-null
   violation` on its first call.
2. **The balance is read `FOR UPDATE` and checked before the write.** §12.4's
   `RAISE WALLET_OVERDRAFT … using errcode = 'check_violation'` sits behind the
   column's own non-deferred `CHECK (balance >= 0)`, which fires first and makes
   the named error unreachable there.

The column `CHECK` stays as the backstop for a path that writes `wallets`
without going through the function — a redundant constraint that fires first is
a feature in a codebase whose philosophy is that the database half is the one
that matters. `p_amount` is strictly positive in the function and in the column
alike: direction is `p_type`, never a negative amount.

#### `confirm_booking_payment()`, superseded

`0015` re-declares it with **one** extra assignment — `refundable_amount = amount`
on the capture — and backfills `status = 'success' and refundable_amount = 0`.
`0014`'s own comment says the refund path walks that column down, and nothing
ever raised it: every captured payment carried a remainder of zero, which
satisfies `refundable_amount <= amount` while being a remainder no refund could
be drawn from. The body is therefore re-declared rather than edited into `0014`,
because `0014` is already applied and a migration that changed under its own
ledger would stop meaning what the ledger says it means. `refundablePaise()` in
`lib/refundServer.ts` reads that column as the authority, in paise.

### The `search_path` convention

Every function that calls `gen_random_bytes`, `digest`, `crypt` or `gen_salt`
declares `set search_path = public, extensions`. On Supabase those live in the
`extensions` schema, not `public`, and without the second entry the failure is
`function gen_random_bytes(integer) does not exist` **at call time**, on a
database where the migration applied without complaint. Naming a schema that does
not exist is harmless on a plain Postgres, which is why the same files work in
both places. `docs/SETUP.md` has the fuller note.

Today that means `issue_otp`, `consume_otp`, `seed.sql`'s `seed_demo_user`, and
`supabase/seed.sql`'s own `set search_path`. Every other function uses
`set search_path = public`.

---

## 10. Storage buckets

Six buckets, created by `0000` and policy-ed by `0025`. `docs/SETUP.md` has the
setup view with size limits and MIME types; this is the access view, which is the
part that matters for RLS.

| Bucket | Bucket `public` | Who can read through the client API | Who can write |
|---|---|---|---|
| `service-media` | yes | anyone (`service_media_public_read`) | admins only |
| `pro-photos` | yes | anyone (`pro_photos_public_read`) | admins, or a professional in their own folder |
| `kyc-documents` | no | **nobody — there is no select policy** | admins, or a professional in their own folder |
| `chat-media` | no | service role only | service role only |
| `support-media` | no | service role only | service role only |
| `invoices` | no | service role only | service role only |

The folder convention is what makes the write policies possible without a
`professionals` join: `pro_photos_insert_own` checks
`(storage.foldername(name))[1] = auth.uid()::text`, and `kyc_insert_own` checks
`(storage.foldername(name))[1] = public.current_professional_id()::text`. Objects
are therefore named `<profileId>/<​filename>` and
`<professionalId>/<docType>/<file>` by the upload route, and the first path
segment is the identity.

Storing KYC documents as a *path* rather than a URL is what makes the missing
read policy possible at all — there is nothing to leak, because nothing
addressable is stored.

The bucket rows live in `0000` and their policies in `0025` for a reason that is
worth knowing before you touch either: a policy body is checked when the policy is
**created**, not when it runs, and these call `public.is_admin()` (from `0001`) and
`public.current_professional_id()` (from `0005`). Applying in filename order with
the policies in `0000` therefore failed at the very first file with `function
public.is_admin() does not exist`. `docs/SETUP.md` covers the rest of the ordering
convention.

---

## 11. What is not here yet

Everything in this section is deferred on purpose, and each deferral is recorded
in `ROADMAP.md`, in `.planning/`, or in a comment in the migration that would
otherwise have carried it. Nothing here is an oversight.

### Named deferrals from Phase 1

| Deferred | Why | Lands in |
|---|---|---|
| `block_address_delete_with_future_bookings()` | It references `bookings`, which does not exist, and a migration naming a table that does not exist fails to apply. Reachable data loss window: none, since nothing references an address yet | Phase 2 |
| `professional_schedule` as an input to slot availability | §9.1 lists "not already reserved" as an input; the table is created with `bookings` | Phase 5 |
| Service-level aggregate rating on catalogue cards | `ratings` rows are written when a booking is reviewed | Phase 2 |
| Checkout behind the service-detail CTA | `/customer/checkout` is Phase 2; the CTA routes somewhere real rather than being a dead button | Phase 2 |
| `platform_settings` rows (`instant_lead_minutes`, `max_booking_minutes`) | Read from `lib/constants.ts` defaults until the table lands | Phase 6 |

`block_address_delete_with_future_bookings()` is the one worth restating, because
`0008` is otherwise a complete file and it is easy to miss the absence: §24.6
defines it, it is not in the schema, and the migration says so at the bottom with
the reason. It ships with the booking tables.

### What each later phase adds, and does not have yet

None of this exists. The table is written in the vocabulary of the §31.1 phase
list that `ROADMAP.md` reproduces unchanged, so that a reader can see the gap
without this document inventing table names the specification has not chosen yet.
The only names quoted are ones the repository itself already uses.

| Phase | Scope it will add | What the schema has to make room for |
|---|---|---|
| 2 | Quote engine, booking create, cancel/reschedule, coupons, invoice stub, `bookings` state machine | **Delivered.** `bookings`, `booking_items`, `booking_status_history`, `booking_number_seq`, the price and quote-token snapshots, and the four write-path functions in §9. `block_address_delete_with_future_bookings()` and `ratings` land here |
| 3 | Razorpay orders, webhook, verify, refunds, wallet ledger, reconciliation cron | The wallet that `customers.wallet_id` already points at. `0015_refunds_wallet.sql` is named in a comment in `0001` and does not exist |
| 4 | KYC upload, verification workflow, working hours, offers inbox, accept/decline, arrive, OTP, complete | No new table is strictly required for the verdict: `professional_documents.status`, `rejection_reason`, `reviewed_by` and `reviewed_at` already carry it, and `idx_prof_doc_status` is already the queue's index. What is missing is the signed-URL route and the review screen |
| 5 | Candidate ranking, offer fan-out, advisory locks, reassignment cascade, search sweeper | `professional_schedule`, the one availability input §9.1 asks for that Phase 1 cannot honour. `lib/availability.ts` isolates it behind a single input parameter |
| 6 | Dashboard, bookings, KYC review, services, pricing, payments, coupons, disputes, support, audit, settings | `platform_settings`, whose `instant_lead_minutes` and `max_booking_minutes` are read from `lib/constants.ts` defaults until the table lands |
| 7 | Channels, presence, chat, notification dispatcher, templates, reminders | Notification and chat state. The `chat-media` bucket has no client policy at all, on the stated grounds that the phase which owns it writes participant-scoped policies first |
| 8 | Recurring, wallet top-up, referrals, favourites, surge, invoices/PDF, PWA | Recurring schedules and an invoice record. The `invoices` bucket exists and is private with no policy |
| 9 | Security review, RLS audit, load test, accessibility pass, legal pages, runbook | Nothing new |

Two gaps are visible *today*, in columns that are live but point at nothing:
`customers.wallet_id` is a bare `uuid` whose comment names a migration that was
never written, and the `customers` / `professionals` counter columns
(`total_bookings`, `completed_bookings`, `cancelled_bookings`, `lifetime_value`,
`total_offers`, `accepted_offers`, `completed_jobs`, `cancelled_jobs`,
`no_shows`) all default to zero and are meant to move only as a side effect of a
real booking. They are readable as though the tables behind them existed; they do
not, and the service role is the only thing that can write them today.

`audit_logs.action` and `entity_type` are free text, and their column comments use
`'booking.create'`, `'refund.execute'`, `'bookings'` and `'payments'` as examples.
Those are notation, not an allow-list, and every one of them names a table that
does not exist yet.

### Other things the migrations reference but do not contain

- `0015_refunds_wallet.sql`, `0019_support.sql`, `0019` / `0020_chat_notifications.sql`,
  `0012`, `0021` — future migrations named in comments in `0000` and `0001`.
- `0009`–`0023` and `0028` do not exist. `ROADMAP.md` says why: the numbering is
  not contiguous because these were developed alongside the reference SmartPOS
  project, and nothing is missing between `0007` and `0024`.
- `professional_schedule`, `ratings`, `platform_settings`, `bookings` — see above.

---

## 12. What is verified, and what is not

`npm run test:db` runs 24 tests against a real database and skips loudly without
one. It is not a substitute for reading the migrations, but it does prove some
things nothing else can.

### Proven by `npm run test:db`

- RLS is enabled on every table in `public` — asserted by querying `pg_class` for
  `relrowsecurity = false` and failing with the names.
- The nine tables the code imports exist.
- `profiles` has at least one policy, and **no** `for select … using (true)` on it.
  That second assertion is named as the single most damaging policy mistake
  available here.
- The six buckets exist in `storage.buckets`.
- The five demo accounts are confirmed email logins with an `auth.identities` row,
  so they can actually sign in.
- The OTP ledger: stores a 64-character hex hash and a 32-character hex salt and
  neither contains the code; salts each code separately; accepts the right code and
  refuses a wrong one; refuses the same code twice; ignores a code issued for a
  different purpose; raises `OTP_THROTTLED` inside the 60-second window; keeps only
  the newest code live; locks on the third wrong attempt and reports `'locked'` on
  the fourth; reports an expired code as `'expired'` rather than `'wrong'`.
- `audit_logs` refuses both `UPDATE` and `DELETE` with `AUDIT_LOG_IMMUTABLE`.
- `idempotency_keys` claims once, returns `in_flight` while running, `conflict` on
  a changed body, and `replay` after completion.
- A new auth user created through `admin.createUser` comes out with a usable
  profile: `phone` is `NULL` rather than fabricated, the name and status are right,
  a `customer` gets a `customers` row, a `professional` does not, a signup cannot
  grant itself a staff role, a signup cannot take over an existing phone number,
  and two phone-less accounts stay distinct. Seven of these need
  `SUPABASE_SERVICE_ROLE_KEY` and skip without it.

### Not proven

- **What each policy admits for most tables.** The bulk of this file runs as the
  migration owner, which has `BYPASSRLS`. Those tests assert that RLS *exists* and
  that the grants are in place; they do not assert that customer A cannot read
  customer B's row. `addresses` is the exception — see below — because it is the one
  table where a leak is unrecoverable. For everything else, `npm run db:verify` signs
  in as each demo account over the anon key, which is real but not exhaustive.
- **`is_serviceable()` and the trigger guards.** No test in `test/db.rls.test.ts`
  calls them. Both are exercised through fakes elsewhere, and a fake cannot see a
  policy body.
- **The bucket policies.** The tests check the buckets exist; they do not check
  that a professional can write their own folder, that `kyc-documents` has no read
  policy, or that `service_media_admin_write` refuses a non-admin.
- **The catalogue seed.** Nothing asserts the catalogue is present or bookable.
  `npm run db:verify` signs in; it does not check coverage.
- **Migration ordering.** Applying the files in filename order is verified by
  having been done; there is no test that re-applies them, and no test that a
  *re-run* is a no-op.
- **`public_professionals` returning only verified professionals.** Nothing asserts
  the view's `where` clause.

### Proven by impersonation: `addresses`

`addresses` holds where a person lives and how to get in, so its policies are
asserted by *admission* rather than by existence. `sqlAsRole()`
(`test/helpers/dbEnv.ts`) drops the connection to the `authenticated` role and sets
the JWT claims PostgREST would have set, inside a transaction it always closes:

```ts
const asOwner = await sqlAsRole(ownerProfileId, `select count(*) from public.addresses …`);
const asOther = await sqlAsRole(otherProfileId,  `select count(*) from public.addresses …`);
const asAnon  = await sqlAsRole(null,              `select count(*) from public.addresses;`);
```

`1 / 0 / 0` is the assertion: the owner reads their row, another signed-in customer
does not, and an anonymous visitor sees nothing.

Setting `request.jwt.claim.role` is not optional bookkeeping. `is_trusted_session()`
reads it and treats an *empty* setting as "this is the server", so a user simulated
without it would be treated as the service role and every ownership check would pass
for the wrong reason.

Two behaviours are worth stating because they are easy to assume wrongly:

- An `insert` that names somebody else's `customer_id` **raises**
  (`row-level security`), because the policy's `WITH CHECK` rejects it.
- An `update` or `delete` of a row the policy filters out affects **zero rows and
  raises nothing**. The tests count the affected rows through a CTE rather than
  expecting a throw, because the absence of an error is not evidence the write
  happened.

`set_default_address()` is covered here too: it is `SECURITY DEFINER`, so it checks
ownership itself, and the test asserts it raises `ADDRESS_NOT_OWNED` when a different
customer calls it with someone else's address.

### Discrepancies found while writing this

Four, all of them documentation rather than schema:

1. **The catalogue is 23 services, not 20.** `0007_service_catalogue_seed.sql`
   inserts six Cleaning, five Kitchen, four Laundry, four Household and four
   Appliance services. Its own header says "twenty services", and so does the
   Phase 1 section of `ROADMAP.md` and `01-PLAN.md`. No code reads that number.
2. **`0007`'s coverage comment is off by one.** It says "the ten core localities
   carry the full catalogue; the three outer localities carry Cleaning and Kitchen
   only" — ten plus three is thirteen, and there are twelve. Nine carry the full
   catalogue; `Electronic City`, `Yelahanka` and `Bannerghatta Road` are the outer
   three. The `where` clause implements the latter, so the data is right and the
   prose is not.
3. **`seed.sql`'s header says "This file creates FOUR auth.users"**, immediately
   above a table listing five and code that creates five. `docs/SETUP.md` says five,
   which is correct. The same header names
   `NEXT_PUBLIC_SUPARTHELP_OWNER_LOGIN` — misspelt, and the wrong variable
   besides: the server reads `SMARTHELP_OWNER_LOGIN`, and never a
   `NEXT_PUBLIC_` one.
4. **`schema.sql`'s own header is stale.** It says "Phase 0 … covers migrations
   0000-0007. Phases 1-9 append 0008-0028". `0008` and `0024`–`0027` are all
   present in the file it heads. The header is a static string in
   `scripts/build-schema.mjs`, so it will stay wrong until someone edits the
   script.

Separately, the test counts in `README.md` and `docs/SETUP.md` were behind the code.
The suite is now **273 tests**: 243 that need nothing beyond the code, and 30 that run
against a real database. The database count went from 24 to 30 when the `addresses`
isolation tests above were added.
