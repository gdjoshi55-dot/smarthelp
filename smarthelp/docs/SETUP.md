# Setting up SmartHelp locally

Two things are needed: a Supabase project, and a `.env.local`. Nothing else.

The steps below have been run end to end against a live project. The database
suite, the seed, and real password sign-in for all five demo accounts are
verified.

---

## 1. Prerequisites

- Node 18.17 or newer (the floor for Next 14)
- A [Supabase](https://supabase.com) project — the free tier is enough

`psql` is **not** required. The migration runner, the seed and the database tests
all speak to Postgres through the `pg` driver.

## 2. Environment

```bash
cp .env.example .env.local
```

The keys are the same names as `smartpos-main/.env`, so a working SmartPOS
`.env` is a usable starting point — only the Supabase project, the Razorpay keys
and the owner login differ. See `.env.example` for the full list.

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API (the `anon` / publishable key) |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API — **server only**, never `NEXT_PUBLIC_` |
| `SUPABASE_DB_URL` | Project Settings → Database → Connection string, session mode |
| `SMARTHELP_OWNER_LOGIN` | Whatever you want the owner account to be |
| `SMTP_*` | Your mail provider, for OTP delivery |

`SMARTHELP_OWNER_LOGIN` is the only way a `super_admin` is ever created: an
allow-list of exactly one login, matched against the email or the bare name.
Leave it empty and no owner exists, which is the correct state for a shared
environment.

There is a `NEXT_PUBLIC_SMARTHELP_OWNER_LOGIN` as well, mirroring SmartPOS's
`NEXT_PUBLIC_ALTASOFTWARE_OWNER_LOGIN`, for any owner-only UI. It is
deliberately **not** what the server reads: a `NEXT_PUBLIC_` value is compiled
into the client bundle, and gating a `super_admin` grant on something every
visitor can read is not a control. `lib/owner.ts` says so, and a test enforces
it.

In Auth settings, add your local origin (`http://localhost:3000`) to the allowed
redirect URLs, or the browser will refuse the session after the OTP exchange.

### Codes are emailed

Sign-up and password-reset codes are delivered by email, so `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` must be set for either
flow to complete. `npm run smtp:verify` checks the credentials without sending
anything.

Codes are cached in `public.otp_requests` as a salted SHA-256 hash, rate-limited
to one live code per address per 60 seconds and three wrong attempts. The plain
code never reaches the database.

Check the credentials without sending a mail:

```bash
npm run smtp:verify
```

With no SMTP configured at all the code is written to the server log and returned
as `devCode` in the response, which is how the flow is run on a laptop. It is
never echoed once a real provider is set.

### Razorpay keys, and the live check that is deliberately manual

Payments take three more variables, and the suite never reads them:

| Variable | Where to get it |
|---|---|
| `RAZORPAY_KEY_ID` (or `NEXT_PUBLIC_RAZORPAY_KEY_ID`) | Razorpay Dashboard → Settings → API keys |
| `RAZORPAY_KEY_SECRET` | same page — **server only** |
| `RAZORPAY_WEBHOOK_SECRET` | Dashboard → Settings → Webhooks → the secret for the endpoint pointing at `/api/webhooks/razorpay` |

Leave all three unset and everything still passes: `vitest.config.ts` inlines only
the four Supabase variables, no test performs a network call, and every route
that needs one of them reads it at request time behind a guard that fails closed
(`SERVICE_UNAVAILABLE`, never a 500 out of `timingSafeEqual`). That is CONTEXT
decision 1 — **the signature verifier is a pure module tested with synthetic
signatures, and the transport is mocked, not the logic** — and its accepted
consequence is that the part nobody can verify automatically is this:

> **Manual step, every deployment:** configure the three keys, point a Razorpay
> webhook at `POST /api/webhooks/razorpay` for `payment.captured`,
> `payment.failed` and `refund.processed`, then complete one real checkout and
> confirm the booking reaches `paid` from the *webhook* — not from the checkout
> window. A card that succeeds in the browser while the booking stays
> `payment_pending` means the webhook secret or the endpoint URL is wrong, and no
> amount of green tests would have caught it.

Two environment-level knobs are worth knowing here. `CRON_SECRET` is required by
`GET /api/cron/reconcile-payments`: the route answers 503 when it is unset rather
than running unauthenticated, so a deployment that wants the reconciliation pass
has to set it. Both are read from the environment rather than from
`platform_settings`, in the same pattern as `instant_lead_minutes` and
`maxBookingMinutes`.

## 3. The database

```bash
npm run db:migrate   # applies supabase/migrations/*.sql in filename order
npm run db:seed      # demo accounts and the bookable catalogue
npm run db:verify    # signs in as each demo account for real
npm run db:status    # reports what is outstanding, changes nothing
```

Each file runs in its own transaction, so a failure leaves nothing behind and the
recorded history is what actually applied. What it applied is tracked in
`smarthelp_migrations.schema_migrations` — its own schema, not `public`, because
it is bookkeeping rather than part of the product.

`supabase/migrations/0000`–`0008`, `0024` and `0025` are the whole schema. The
numbering is not contiguous because these were developed alongside the reference
SmartPOS project; there is nothing missing between `0008` and `0024`.

Then rebuild the schema snapshot:

```bash
npm run db:schema
```

This rewrites `supabase/schema.sql` from the migrations. The database types in
`lib/supabase.ts` are maintained by hand, not generated — after changing a
migration, check that the types there still describe the database.

If you paste SQL into the Supabase SQL editor instead, run the files in filename
order and then `supabase/seed.sql`. Do not run `schema.sql` as a migration: it is
a snapshot, so it has no history and will not reflect later edits to the
migrations.

### Ordering, and why it is not just alphabetical

Three of these files cannot run in numeric order as written, which is why the
runner fails on a fresh database if they are changed carelessly:

- `0000` creates the buckets. Its *policies* call `public.is_admin()` (0001) and
  `public.current_professional_id()` (0005), and a policy body is checked when
  the policy is created, not when it runs. The policies therefore live in
  `0025`, and `0000` holds only the bucket rows.
- `0005` does not enable RLS on `professional_skills`; `0006` creates the table
  and enables it there.

### Storage buckets

| Bucket | Public | Holds |
|---|---|---|
| `service-media` | yes | catalogue art, served from a CDN URL |
| `pro-photos` | yes | professional photos |
| `kyc-documents` | no | identity documents, PDFs allowed |
| `chat-media` | no | attachments in a conversation |
| `support-media` | no | attachments on a support ticket |
| `invoices` | no | generated PDFs |

Only the first two are readable without a session. The other four are private,
which is the point of storing KYC documents as a storage *path* rather than a
URL. `kyc-documents` has no read policy at all, so a signed-in professional
cannot read a document back with the anon key.

### pgcrypto

`gen_random_bytes`, `digest`, `crypt` and `gen_salt` live in the `extensions`
schema on Supabase, not `public`. Every function that calls one declares
`set search_path = public, extensions`. Without the second schema the failure is
`function gen_random_bytes(integer) does not exist` at call time, on a database
where the migration applied without complaint.

## 4. Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000. The root page routes you to the shell for your role,
or to `/login`.

## 5. The demo accounts

`supabase/seed.sql` creates five, all with the password `Demo@12345`:

| Role | Login |
|---|---|
| customer | `demo.customer@smarthelp.test` |
| professional | `demo.pro@smarthelp.test` |
| admin | `demo.admin@smarthelp.test` |
| support | `demo.support@smarthelp.test` |
| ops | `demo.ops@smarthelp.test` |

All five sign in at `/login` with that email and password, exactly as a real
account does. Sign-up at the same page takes an email, a password and the
six-digit code that gets emailed to it, and only creates the account once the
code is proven.

The owner (`super_admin`) is **not** seeded. It appears the first time you sign
in with the login in `SMARTHELP_OWNER_LOGIN`; the sign-in route promotes that one
account and no other. That promotion also applies to an owner address that
signed up through the form rather than being seeded, so a `super_admin` created
this way began as a `professional`.

> `seed.sql` is for local work only. Delete it before a real launch — it creates
> accounts with a password published in this file.

## 6. Tests

```bash
npm test          # 273 tests: 243 mocked, plus the 30 below when a database is reachable
npm run test:db   # 30 tests, needs SUPABASE_DB_URL (or a .env.local with it)
```

`npm run test:db` reads `SUPABASE_DB_URL` from the environment or from
`.env.local`, so it needs no extra setup after step 2. Without a connection
string it skips loudly rather than passing quietly — a green suite that never
checked row-level security would be worse than no suite at all. Run
`npm run db:migrate && npm run db:seed` first; the tests need a migrated
database and a seeded account to reference.

It also needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the
seven account-provisioning tests, which call `admin.createUser` for real because
a mocked service-role client cannot reproduce a failure inside GoTrue.

The database tests cover the things a mocked client cannot: that RLS is enabled
on every table in `public` and that no policy exposes every profile, that the
buckets exist, that the OTP ledger throttles, locks, salts and expires as
claimed, that the audit trail refuses to be edited, that one customer can neither
read nor write another customer's address, and that a new auth user comes out of
`admin.createUser` with a usable profile. Most of them run as the migration
owner, so they assert that RLS *exists* — what each policy actually admits is
covered by the real sign-in in `npm run db:verify`.

The address tests are the exception, because "who may read this row" is the entire
question for a table that holds a home address and how to get in. They impersonate a
real signed-in customer — see `sqlAsRole()` in `test/helpers/dbEnv.ts` — so they
prove a customer cannot reach another customer's row rather than merely that the
policy is present.
