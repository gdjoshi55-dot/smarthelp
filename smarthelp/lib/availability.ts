import type { Serviceability } from './catalogue';
import { SLOT_GRANULARITY_MIN } from './constants';

/**
 * Availability (§9.1) as a pure function.
 *
 * "Availability is derived, never stored as a boolean." This is the derivation.
 * It takes the rows that decide whether a service can happen — the lead time, the
 * merged working windows of the professionals who can do it, the windows they
 * are away for, and the locality's capacity — and returns the slots for a day,
 * with a reason attached to every slot it will not offer.
 *
 * Nothing here touches the database or `Date.now()`, so the whole thing is
 * unit-testable with a fixed clock. `now` is a parameter for that reason: the
 * interesting cases are all "an hour ago", "in twenty minutes", and "at
 * midnight in Asia/Kolkata".
 *
 * One input is not wired to a table yet. §9.1 lists "not already reserved" among
 * the inputs, and that is `professional_schedule`, created with `bookings` in
 * Phase 2 and consumed by matching in Phase 5. It arrives here as `busy` on each
 * professional and as `reservations` for the day; today the caller fills the
 * first from `professional_time_off` and leaves the second empty. The algorithm
 * below does not need to know which is which.
 */

// ── Time zones ──────────────────────────────────────────────
//
// Slots are wall-clock times in the *city's* zone ("10:00" means ten in the
// morning where the professional is driving), while every timestamp in the
// database is an instant. So the two directions both have to exist, and both
// have to handle a zone whose offset changes inside the day.
//
// Asia/Kolkata has no daylight saving, which makes it a poor thing to test the
// conversion against — a naive implementation passes there and books a cleaning
// slot for the wrong hour in Berlin. `test/availability.test.ts` checks a
// daylight-saving zone for exactly that reason.

function zoneParts(instant: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU builds still emit hour 24 for midnight under `hour12: false`.
    // Left alone it silently moves every midnight slot to the previous day.
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Minutes east of UTC at that instant. Asia/Kolkata → 330. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * The instant for a wall-clock time in a zone.
 *
 * The offset depends on the instant, and the instant is what we are computing,
 * so one pass cannot do it: treat the wall time as UTC, read the offset that
 * would apply there, correct, then read the offset again in case the correction
 * crossed a transition. Two passes settle every real zone; the loop stops early
 * when the second pass changes nothing.
 */
export function wallClockToInstant(date: string, minuteOfDay: number, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const wallMs = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * 60000;

  let guess = wallMs;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = wallMs - zoneOffsetMinutes(new Date(guess), timeZone) * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** `YYYY-MM-DD` in the given zone. The default `date` for an availability query. */
export function zoneDate(now: Date, timeZone: string): string {
  const p = zoneParts(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The weekday of a calendar date: 0 Sunday … 6 Saturday, matching
 * `professional_working_hours.weekday`.
 *
 * Read from the date string rather than from an instant, because the weekday of
 * a calendar date is a calendar fact and does not depend on the zone.
 */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `HH:mm` in the given zone, for the slot chips. */
export function formatClock(instant: Date, timeZone: string): string {
  const p = zoneParts(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// ── Inputs ───────────────────────────────────────────────────

/** A working window as minutes from local midnight, so 09:00 is 540. */
export interface DailyWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** An absolute interval a professional is not available for, as instants. */
export interface BusyWindow {
  startsAt: string;
  endsAt: string;
}

export interface ProfessionalAvailability {
  id: string;
  /** `professional_working_hours` rows, in any order. */
  windows: DailyWindow[];
  /** `professional_time_off` today, plus reservations from Phase 5. */
  busy: BusyWindow[];
}

export interface SlotQuery {
  /** `YYYY-MM-DD` in `timeZone`. */
  date: string;
  timeZone: string;
  durationMinutes: number;
  /** `service_areas.lead_minutes`, already the max of the area's and the service's. */
  leadMinutes: number;
  /** `service_areas.slot_capacity`. */
  capacity: number;
  professionals: ProfessionalAvailability[];
  /** The server clock. Passed in so the tests can pin it. */
  now?: Date;
  /** Whole-day holds (a locality closure, a Phase 5 reservation set). */
  reservations?: BusyWindow[];
  granularityMinutes?: number;
}

export type SlotReason = 'lead_time' | 'no_professional_available' | 'at_capacity';

export interface Slot {
  /** Instants, ISO 8601 with `Z`. */
  start: string;
  end: string;
  /** Wall clock in the city's zone, which is what a person reads. */
  label: string;
  durationMinutes: number;
  /** Professionals free for the whole window, capped by `slot_capacity`. */
  remaining: number;
  bookable: boolean;
  /** Why not, when `bookable` is false. `null` on a bookable slot. */
  reason: SlotReason | null;
}

export interface SlotDay {
  date: string;
  timeZone: string;
  durationMinutes: number;
  slots: Slot[];
  /** Slots with `remaining > 0`. */
  bookableCount: number;
  /** The largest `remaining` anywhere in the day - how many could run at once. */
  maxRemaining: number;
  serverNow: string;
}

/**
 * What `GET /api/availability` answers with, before the route adds the location
 * banner on top.
 *
 * It lives here rather than in `availabilityServer.ts` because the browser needs
 * the same shape to render the slot picker, and that module reaches for the
 * service-role client. Type-only, so it costs nothing at runtime.
 */
export interface AvailabilityResult {
  service: {
    id: string;
    name: string;
    slug: string;
    minDurationMinutes: number;
    maxDurationMinutes: number;
  };
  location: { localityId: string; localityName: string; timeZone: string };
  durationMinutes: number;
  /** The durations this service actually offers, so a 400 is recoverable. */
  validDurations: number[];
  serviceable: Serviceability;
  day: SlotDay;
}

// ── Interval helpers ────────────────────────────────────────

interface Interval {
  from: number;
  to: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out: Interval[] = [{ ...sorted[0] }];

  for (const next of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (next.from <= last.to) {
      last.to = Math.max(last.to, next.to);
    } else {
      out.push({ ...next });
    }
  }
  return out;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  // Half-open intervals: a job ending at 11:00 does not block one starting at 11:00.
  return aStart < bEnd && bStart < aEnd;
}

function isFree(
  professional: ProfessionalAvailability,
  windows: Interval[],
  startMinute: number,
  endMinute: number,
  startMs: number,
  endMs: number
): boolean {
  const covered = windows.some((w) => w.from <= startMinute && w.to >= endMinute);
  if (!covered) return false;

  return !professional.busy.some((b) => {
    const bStart = Date.parse(b.startsAt);
    const bEnd = Date.parse(b.endsAt);
    if (Number.isNaN(bStart) || Number.isNaN(bEnd)) return false;
    return overlaps(startMs, endMs, bStart, bEnd);
  });
}

const MINUTES_PER_DAY = 1440;

/**
 * The slots for one day, every candidate accounted for.
 *
 * A candidate that is not offered is still returned, with `bookable: false` and
 * a `reason`. The alternative — dropping it — makes an empty day
 * indistinguishable from a broken query, and it gives the client nothing to say
 * when a person asks why 10:00 is not on the list. The client filters on
 * `bookable`; the server never hides a slot it cannot explain.
 */
export function computeSlots(query: SlotQuery): SlotDay {
  const {
    date,
    timeZone,
    durationMinutes,
    leadMinutes,
    capacity,
    professionals,
    now = new Date(),
    reservations = [],
    granularityMinutes = SLOT_GRANULARITY_MIN,
  } = query;

  const weekday = weekdayOf(date);
  const earliestBookable = now.getTime() + Math.max(0, leadMinutes) * 60000;

  // Working hours for that weekday, per professional and unioned across them.
  const perProfessional = professionals.map((pro) =>
    mergeIntervals(
      pro.windows
        .filter((w) => w.weekday === weekday)
        .map((w) => ({
          from: Math.max(0, w.startMinute),
          // A window cannot cross midnight — `professional_working_hours`
          // forbids it with `end_time > start_time` — so the end is clamped to
          // the end of the day rather than trusted.
          to: Math.min(MINUTES_PER_DAY, w.endMinute),
        }))
        .filter((w) => w.to > w.from)
    )
  );

  const union = mergeIntervals(perProfessional.flat());

  const slots: Slot[] = [];

  for (const window of union) {
    // Walk the grid from the window's own start, snapped forward to the next
    // granularity boundary, so a 09:07 window yields 09:30 and not 09:07.
    const firstStart = Math.ceil(window.from / granularityMinutes) * granularityMinutes;

    for (let start = firstStart; start + durationMinutes <= window.to; start += granularityMinutes) {
      const startInstant = wallClockToInstant(date, start, timeZone);
      const endInstant = wallClockToInstant(date, start + durationMinutes, timeZone);
      const startMs = startInstant.getTime();
      const endMs = endInstant.getTime();

      const free = professionals.filter((pro, i) => {
        if (
          reservations.some((r) => {
            const rStart = Date.parse(r.startsAt);
            const rEnd = Date.parse(r.endsAt);
            if (Number.isNaN(rStart) || Number.isNaN(rEnd)) return false;
            return overlaps(startMs, endMs, rStart, rEnd);
          })
        ) {
          return false;
        }
        return isFree(pro, perProfessional[i], start, start + durationMinutes, startMs, endMs);
      });

      let reason: SlotReason | null = null;
      let remaining = Math.min(free.length, Math.max(0, capacity));

      if (startMs < earliestBookable) {
        reason = 'lead_time';
        remaining = 0;
      } else if (free.length === 0) {
        reason = 'no_professional_available';
        remaining = 0;
      } else if (remaining === 0) {
        reason = 'at_capacity';
      }

      slots.push({
        start: startInstant.toISOString(),
        end: endInstant.toISOString(),
        label: formatClock(startInstant, timeZone),
        durationMinutes,
        remaining,
        bookable: reason === null,
        reason,
      });
    }
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));

  return {
    date,
    timeZone,
    durationMinutes,
    slots,
    bookableCount: slots.filter((s) => s.bookable).length,
    maxRemaining: slots.reduce((max, s) => Math.max(max, s.remaining), 0),
    serverNow: now.toISOString(),
  };
}

/** The first slot a customer could actually take, for the instant-booking card. */
export function earliestBookableSlot(day: SlotDay): Slot | null {
  return day.slots.find((s) => s.bookable) ?? null;
}

export interface InstantEstimate {
  etaMinutes: number | null;
  prosAvailable: number;
  start: string | null;
  reason: SlotReason | null;
}

/**
 * "As soon as possible" (§9.1), for the instant-booking card.
 *
 * Measured from now, not from midnight, so `etaMinutes` is a number of minutes
 * a person can read. `null` means there is no slot today at all — which is an
 * answer, and the copy says so, rather than a slot at some invented time.
 */
export function estimateInstant(day: SlotDay, now: Date = new Date()): InstantEstimate {
  const slot = earliestBookableSlot(day);
  if (!slot) {
    return {
      etaMinutes: null,
      prosAvailable: 0,
      start: null,
      reason: day.slots.length > 0 ? (day.slots[0].reason ?? 'at_capacity') : 'no_professional_available',
    };
  }
  return {
    etaMinutes: Math.max(0, Math.round((Date.parse(slot.start) - now.getTime()) / 60000)),
    prosAvailable: slot.remaining,
    start: slot.start,
    reason: null,
  };
}

/** `1 h 30 m` for the estimate copy. Formatting lives in `lib/catalogue.ts`. */
export function etaLabel(minutes: number | null): string {
  if (minutes == null) return 'No slots today';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} hr` : `in ${hours} hr ${rest} min`;
}
