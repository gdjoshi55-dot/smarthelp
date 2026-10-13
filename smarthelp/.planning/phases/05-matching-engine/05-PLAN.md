# Phase 5 — Matching engine · Plan

**Status:** in progress (Wave A).
**Exit criterion (§31.1):** *no double assignment under concurrency; exhausted search auto-refunds.*
**Spec:** §9.1 (candidate ranking / fan-out), §9.4 (advisory lock, offer ledger), §8.2
(transitions), §25.11 (crons), §16 edge cases #15/#20.

## What is already in place

Phase 4 shipped the **offer ledger**, not the matcher:

- `booking_assignments` (0012) with `uniq_active_assignment_per_booking` (the
  double-accept guarantee), `accept_offer` / `decline_offer` CAS RPCs, and a
  **minimal producer**, `sweep_new_bookings()`, that makes one offer to the
  first eligible professional in `created_at` order. Its own header says Phase 5
  replaces it whole.
- The booking row already carries every matching column 0010 reserved for this
  phase: `search_started_at`, `search_expires_at`, `matched_at`, `eta_minutes`,
  `assignment_rounds`, and `booking_assignments.attempt_no` / `round_no` /
  `score` / `distance_km` / `was_favourite` / `was_repeat`.
- `professional_schedule` (0013) with the GiST exclusion constraint.
- The offers inbox read invokes `sweep_new_bookings()` server-side (D1), and
  lazily expires the caller's stale offers (Pitfall 6).

So the schema is ready; what is missing is the ranked engine, the reassignment
cascade, the sweeper and the exhaustion refund.

## Decisions

### D1 — Fan-out is round-based, not simultaneous (confidence: HIGH)

`uniq_active_assignment_per_booking` (0012) permits **at most one live
(`offered`|`accepted`) assignment per booking**. The spec's §9.1 "fan-out" to
several professionals at once is therefore structurally impossible without
dropping that guarantee — and dropping it is the opposite of this phase's exit
criterion. Phase 4's own table comment reserves `attempt_no` and `round_no` for
"Phase 5's ranking engine", which is the tell: the engine ranks candidates and
issues offers in **rounds**. A declined or expired offer cascades to the next
candidate in the ranking (a new round); the advisory lock makes concurrent
matchers agree on who is next. This preserves the double-assign guarantee while
still making the ranked choice real. Recorded here because it deviates from a
literal reading of "fan-out".

### D2 — Exhaustion routes through `searching -> cancelled` (confidence: HIGH)

The spec has both `searching -> cancelled` ("`search_expires_at` passed → auto
refund") and `searching -> refund_pending` ("instant SLA exhausted"). The
deployed transition table already permits `searching -> cancelled`, and
`cancelled -> refund_pending` is the single money path Phase 3 built. Rather than
add a second money edge, exhaustion walks `searching -> cancelled`
(`cancellation_reason_code = 'no_professional_available'`) and the existing
cancel-of-paid auto-refund — extracted into one shared helper — pays the money
back. One path, already tested, reused.

### D3 — Ranking uses what the schema actually holds (confidence: MEDIUM)

The spec's §9.1 scores on distance, rating, favourite and repeat. Distance needs
`earthdistance`, which 0002 does not install (0012 records this), and there is
no `favourites` table until Phase 8. So Wave A ranks by what exists and is
truthful: **repeat** (the professional has completed a booking for this
customer — `was_repeat`), then **load** (fewest live `professional_schedule`
windows — a busy professional is offered last), then **tenure**
(`accepted_offers`, then `created_at`, as a stable tie-break). `score` and
`distance_km` are written as `null` rather than as a fabricated number — the
same choice 0012 made. Distance/rating scoring is a later wave, gated on
`earthdistance` and the ratings roll-up.

### D4 — The dead tables (`booking_assignments`) era ends; the sweeper is the entry point

`run_matching_sweep()` is the single producer. Both the offers inbox read and
the (future) cron call it; a sweep first expires every stale offer globally, then
matches every booking that is eligible or waiting. `sweep_new_bookings()` is
dropped.

## Wave A — the engine

### A1. Migration `0032_matching_engine.sql`

1. **Restore the spec's `assigned -> searching` edge.** `create or replace
   enforce_booking_transition()` with the 0011 body, adding `'assigned'` to the
   predecessors of `searching` (spec §8.2 row: "offer expired or professional
   declined"). Nothing else changes; the trigger and immutability guards stand.
2. **`expire_stale_offers(p_now timestamptz default now()) returns setof uuid`** —
   flips `offered` → `expired` where `expires_at <= p_now` and returns the
   affected `booking_id`s. This is the sweeper's first half and replaces the
   inbox's per-caller lazy expiry with a global one (the inbox keeps its own read
   filter as a belt).
3. **`rank_candidates(p_booking_id uuid) returns table(professional_id uuid,
   was_repeat boolean, load int, score numeric)`** — the eligibility gate
   (verified, online, available today, skilled for every service, free on the
   time-off calendar and the schedule), minus any professional who already holds
   an assignment row for this booking (`uniq_prof_booking_offer`), ordered by
   `was_repeat desc, load asc, accepted_offers asc, created_at, id`.
4. **`match_booking(p_booking_id uuid) returns jsonb`** — `pg_advisory_xact_lock`
   on `assign:<booking_id>`; expire that booking's stale offers; branch on the
   booking's state:
   - `paid` → `paid -> searching` (stamp `search_started_at`, `search_expires_at
     = now() + searchWindowMinutes`); then if a candidate exists, `searching ->
     assigned` and make the offer; else leave `searching` (the sweeper retries).
   - `searching` / `assigned` with no live offer (a decline or an expiry) → walk
     `assigned -> searching` when needed; if a candidate exists, offer the next
     round; else if `now() >= coalesce(search_expires_at, now())`, walk
     `searching -> cancelled` with `no_professional_available`; else stay
     `searching`.
   - else `noop`.
   Returns `{ outcome: 'offered'|'searching'|'exhausted'|'noop', booking_id,
     professional_id?, round_no? }` so the caller can refund an exhaustion.
   On an offer: `attempt_no = prior count + 1`, `round_no =
     assignment_rounds + 1`, `score`/`was_repeat` written, `bookings.matched_at`
   and `professional_id` set, `assignment_rounds` bumped, `total_offers` bumped.
5. **`run_matching_sweep() returns setof jsonb`** — `expire_stale_offers()`
   globally, then `match_booking()` for every booking in `paid` (no live
   assignment) or `assigned`/`searching` (no live offer, and either has tombstone
   rounds or its search window has passed). One outcome row per booking.
6. Drop `sweep_new_bookings()`. Grants: the new functions are `security definer`,
   service-role only.

### A2. App mirror

- `lib/status.ts`: add `'searching'` to `assigned`'s successors, so the API
  guard agrees with the restored SQL edge (`test/status.test.ts` walks the pair
  table against the trigger and is the proof they agree).
- `lib/constants.ts`: `PLATFORM_DEFAULTS.searchWindowMinutes` (default 30 —
  §16 #20's hold, and the instant SLA window), mirrored as a constant in the
  migration the same way `offerTtlMinutes` is.

### A3. `lib/refundServer.ts` + cancel route

Extract the cancel route's private `refundIfPaid` into `refundCancelledBooking({
supabase, bookingId, feeRupees, ipAddress })`; the cancel route calls it (behaviour
identical) and the exhausted-search path calls it with `feeRupees = 0` (a full
refund — nobody provided a service). Reason code `booking_cancelled` is reused;
the note says it is an exhausted search.

### A4. `lib/matchingServer.ts`

- `runMatchingSweep()` — calls the RPC, then for every `exhausted` outcome issues
  the full auto-refund, returning `{ matched, expired, refunded }`.
- `matchBooking(bookingId)` — the single-booking form, used by the decline route
  to cascade immediately rather than waiting for the next inbox open.

### A5. Route wiring

- `GET /api/professionals/offers` invokes `runMatchingSweep()` in place of
  `sweep_new_bookings()`; it keeps the caller-scoped expiry as a belt.
- `POST /api/professionals/offers/:id/decline` reads `booking_id` and calls
  `matchBooking(booking_id)` after the tombstone, so a decline re-offers the job
  to the next candidate (or refunds when the field is empty).

### A6. Tests

- `test/matching.test.ts` — the lib: an exhausted outcome refunds; a non-exhausted
  outcome does not; the refund uses the captured payment and fee 0.
- `test/routes.offers.test.ts` — the inbox calls `run_matching_sweep`; the decline
  route cascades (asserts the `match_booking` RPC).
- `test/status.test.ts` — unchanged, but now exercises the restored edge.
- **Database** (`test/db.matching.test.ts` when a live DB is available): the
  advisory lock serialises two concurrent `match_booking` calls into one offer and
  one noop; an exhausted booking reaches `cancelled|no_professional_available`.

## Deferred (recorded, not forgotten)

| Deferred | Why | Lands in |
|---|---|---|
| Distance / rating scoring (§9.1) | Needs `earthdistance` and a ratings roll-up (Phase 8) | later Phase 5 wave |
| True cron schedule (`search_expires_at` sweeper) | §25.11 crons need a scheduler; the sweep is invoked on the inbox read and is idempotent so a cron calls the same RPC | ops/Phase 6 |
| Edge #20 30-min hold at `arrived` → reassign | Needs the location-ping history and a timer | later Phase 5 wave |
| `next_job_late_min` penalty flag | Column absent; analytics | Phase 9 |
| Instant-booking entry path (§31.1 Phase 10) | v2.0 milestone | Phase 10 |
