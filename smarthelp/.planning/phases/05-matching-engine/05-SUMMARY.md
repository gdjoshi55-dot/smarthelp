---
phase: 05-matching-engine
type: summary
date: 2026-10-12
status: complete
spec: §9.1, §9.4, §8.2, §16 #20, §25.11
---

# Phase 5 — Matching engine: summary

**Complete as of 2026-10-12.** Migration `0032_matching_engine.sql` built and
applied to the live project (29 files, **30 applied, 0 outstanding**), the app
mirror landed, and both §31.1 exit criteria are proven by
`test/db.matching.test.ts`. The suite is **824 tests across 50 files** (the floor
when the phase began: 798 / 46), `npm run test:db` is green across all eight live
files (**99 tests**, floor 96 / 7), and typecheck, lint and build exit 0.

## The engine

Phase 4 shipped the offer *ledger*, not the matcher: `booking_assignments` (0012)
with the `uniq_active_assignment_per_booking` double-accept guarantee, the
`accept_offer`/`decline_offer` CAS RPCs, and a one-line `sweep_new_bookings()`
that offered each booking to the first eligible professional in `created_at`
order. Its own header said Phase 5 replaces it whole. `0032` does:

- **Restores the spec's `assigned -> searching` edge.** 0011's deployed table
  omitted `'assigned'` from the predecessors of `searching` because Phase 4 could
  not reassign; `0032` re-creates `enforce_booking_transition()` as 0011 verbatim
  with that one addition (the history write, the actor GUCs and the immutability
  guard are untouched). This is the §8.2 row "offer expired or professional
  declined".
- **`expire_stale_offers(p_now)`** — flips every past-TTL `offered` row to
  `expired` globally and returns the affected booking ids, so the sweeper
  re-offers them in the same pass. Phase 4's expiry was per-caller on the inbox
  read; this is the eager, global half.
- **`rank_candidates(p_booking_id)`** — the eligible professionals for a booking,
  best first. Eligibility is 0012's shape (verified, online, available today,
  skilled for every service, free on the time-off calendar and the schedule),
  minus anyone who has already held an offer (`uniq_prof_booking_offer` makes a
  re-offer a bug). Ordering is D3: repeat, then load, then tenure
  (`accepted_offers`, `created_at`, `id`).
- **`match_booking(p_booking_id)`** — `pg_advisory_xact_lock(hashtext('assign:' ||
  id))`, tombstone the booking's stale offers, then walk the legal hops one at a
  time: `paid -> searching` (stamp `search_started_at` / `search_expires_at`),
  `assigned -> searching` when a decline or expiry left it there, then offer the
  best candidate (`best -> assigned`, a fresh `booking_assignments` row,
  `total_offers` bumped) or, when the field is empty and the window has closed,
  `searching -> cancelled` with `cancellation_reason_code =
  'no_professional_available'`. Returns `{outcome:
  offered|searching|exhausted|noop, ...}`.
- **`run_matching_sweep()`** — the producer: expire globally, then match every
  waiting booking (`paid`, `searching`, or `assigned` with a dead round) and
  return one outcome row per booking. Idempotent, so the inbox read and a future
  cron call the same RPC.
- **`sweep_new_bookings()` is dropped.** All four new functions are `security
  definer`, revoked from `public`/`anon`/`authenticated`, granted to
  `service_role` only.

## The app mirror

- **`lib/matchingServer.ts`** — the honest boundary. The two things that must not
  be raced (who gets the offer, the booking's state) are decided in Postgres; this
  module calls the engine and does the one thing SQL cannot, which is reach the
  Razorpay gateway. `runMatchingSweep()` tallies `{matched, searching, exhausted,
  refunded}` and refunds each exhausted booking; `matchBooking()` is the
  single-booking form the decline route calls to cascade immediately. A
  `refund` seam in `MatchingOptions` lets the tests assert the call without a
  gateway stand-in.
- **`lib/refundServer.ts`** — the cancel route's private `refundIfPaid` was
  extracted into one shared `refundCapturedBooking({ supabase, bookingId,
  feeRupees, reasonCode?, note?, ipAddress? })`. The exhaustion path calls it with
  `feeRupees: 0` (nobody provided a service, so no fee is withheld); the
  cancel-of-paid path calls it unchanged. One money path, already tested, reused.
- **`lib/status.ts`** — `assigned`'s successors gain `'searching'`, so the API
  guard agrees with the restored SQL edge; `test/status.test.ts` walks the pair
  table against the trigger and is the proof.
- **`lib/constants.ts`** — `PLATFORM_DEFAULTS.searchWindowMinutes` (30, §16 #20),
  mirrored as `v_search_window_min` in `0032` the same way `offerTtlMinutes` is.
- **Routes.** `GET /api/professionals/offers` now calls `runMatchingSweep()` in
  place of `sweep_new_bookings()` (keeping its caller-scoped expiry as a belt);
  `POST /api/professionals/offers/[id]/decline` reads the booking id and calls
  `matchBooking(booking_id)` after the tombstone, returning
  `{ declined: true, reassigned }`.

## The gates

| Gate | Result |
|---|---|
| Migration gate | `0032` (and the Phase 4 leftover `0031`) applied to the live project — 29 files, 30 applied, 0 outstanding |
| Exit criterion 1 — no double assignment under concurrency | **proven by `test/db.matching.test.ts`**: 20 connections call `match_booking` on one booking concurrently; exactly one offer results, the booking is `assigned`, and exactly one live assignment exists |
| Exit criterion 2 — exhausted search auto-refunds | **proven** at the DB level (a booking with no candidate past its window reaches `cancelled` / `no_professional_available`) and at the lib level (`test/matching.test.ts`: an exhausted outcome refunds with fee 0; a non-exhausted outcome does not; a null payment counts nothing refunded) |
| Tier-4 chain | typecheck / lint / build exit 0 → `npm test` **824 / 50 files, 0 failed** (floor 798 / 46) → `test:db` **99 / 8 files** (floor 96 / 7) → no code commits |
| Floors | Phase 4 landed at 798 / 96; Phase 5 lands at **824 / 99** — 26 full-suite and 3 db tests above it |

## The four decisions, with reasons

Stated in full in `05-PLAN.md` (D1–D4).

- **D1 — fan-out is round-based, not simultaneous.** `uniq_active_assignment_per_
  booking` permits at most one live (`offered`|`accepted`) assignment per booking,
  which *is* the double-assign guarantee; offering the same booking to three
  professionals at once is structurally impossible without dropping it. The engine
  ranks and offers in rounds — a decline or expiry advances `round_no` and the
  next candidate is offered. `attempt_no` / `round_no` on the ledger exist for
  exactly this, and the exit criterion (no double assignment) is the reason the
  literal "fan-out" reading was not taken.
- **D2 — exhaustion routes through `searching -> cancelled`.** The spec has both
  `searching -> cancelled` and `searching -> refund_pending`; the deployed table
  permits the former and Phase 3 built exactly one money edge
  (`cancelled -> refund_pending`). Exhaustion walks `searching -> cancelled`
  (`no_professional_available`) and the extracted cancel-of-paid auto-refund pays
  the money back. One path, already tested.
- **D3 — ranking uses what the schema actually holds.** Distance needs
  `earthdistance`, which 0002 does not install, and there is no `favourites` table
  until Phase 8. So ranking is repeat → load → tenure, and `score` /
  `distance_km` are written as `null` rather than a fabricated number — the same
  choice 0012 made.
- **D4 — `run_matching_sweep()` is the single producer and the sweeper is the
  entry point.** The inbox read calls it today and the §25.11 cron calls the same
  idempotent RPC when a scheduler exists; `sweep_new_bookings()` is dropped.

## Deviations, with reasons

- **The extracted refund helper is `refundCapturedBooking`, not the plan's
  `refundCancelledBooking`, and takes an args object.** It is used by two callers
  — the cancel route and the exhaustion path — so a name that names one of them
  would be wrong; `CapturedRefund` is the reported shape.
- **`SweepSummary` reports `{matched, searching, exhausted, refunded}`, not the
  plan's `{matched, expired, refunded}`.** The RPC returns one row per matched
  booking, not per expired offer, so an `expired` count was not observable from
  the return value; the interesting tally is how many searches are still open.
- **`0031_pro_on_the_way.sql` was applied in the same run.** It is a Phase 4
  leftover that had not been pushed; `npm run db:migrate` applied it alongside
  `0032`. No Phase 5 content.
- **No packages were installed** and `vercel.json` is unchanged.
- **No source, test, migration or config file was committed by this phase.** The
  code working tree remains uncommitted for the branch owner.

## Deferred (recorded, not forgotten)

| Deferred | Why | Lands in |
|---|---|---|
| Distance / rating scoring (§9.1) | Needs `earthdistance` and a ratings roll-up (Phase 8) | later Phase 5 wave |
| True cron schedule (`search_expires_at` sweeper) | §25.11 crons need a scheduler; the sweep is invoked on the inbox read and is idempotent so a cron calls the same RPC | ops/Phase 6 |
| Edge #20 30-min hold at `arrived` → reassign | Needs the location-ping history and a timer | later Phase 5 wave |
| `next_job_late_min` penalty flag | Column absent; analytics | Phase 9 |
| Instant-booking entry path (§31.1 Phase 10) | v2.0 milestone | Phase 10 |

## Deliberately out of scope

Distance/rating ranking, the `earthdistance` extension and the ratings roll-up.
The `professional_schedule` overlap term as an input to *slot availability* math
(still a Phase 1 deferral). Phase 6's admin console; Phase 7's Realtime; Phase 8's
recurring/surge/favourites. **No refund UI, no new cron, no new package.**
