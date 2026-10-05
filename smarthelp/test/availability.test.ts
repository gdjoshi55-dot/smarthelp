import { describe, expect, it } from 'vitest';
import {
  computeSlots,
  estimateInstant,
  etaLabel,
  formatClock,
  weekdayOf,
  wallClockToInstant,
  zoneDate,
  zoneOffsetMinutes,
  type ProfessionalAvailability,
  type SlotQuery,
} from '@/lib/availability';

/**
 * The slot engine (§9.1), tested as the pure function it is.
 *
 * The clock is always passed in. Every case that matters is a case about "now" —
 * an hour ago, in twenty minutes, midnight in the city's zone — and a slot engine
 * that reads the wall clock cannot be tested at all, which is how the bugs get
 * in. So `now` is a required-ish parameter of `computeSlots` in every test here.
 *
 * 2026-04-15 is a Wednesday and 2026-04-19 a Sunday; weekday 3 and 0.
 */

const KOL = 'Asia/Kolkata';
const WED = '2026-04-15';
const SUN = '2026-04-19';

/** 09:00–18:00, seven days a week, so a weekday mistake cannot hide in the fixtures. */
function pro(id: string, overrides: Partial<ProfessionalAvailability> = {}): ProfessionalAvailability {
  return {
    id,
    windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 })),
    busy: [],
    ...overrides,
  };
}

function slots(overrides: Partial<SlotQuery> = {}) {
  return computeSlots({
    date: WED,
    timeZone: KOL,
    durationMinutes: 60,
    leadMinutes: 0,
    capacity: 5,
    professionals: [pro('p1')],
    // 08:00 the same morning, so the lead-time cases have something to bite on.
    now: wallClockToInstant(WED, 480, KOL),
    ...overrides,
  });
}

const labels = (day: { slots: { label: string }[] }) => day.slots.map((s) => s.label);

describe('time zone conversion', () => {
  it('converts a wall clock in the city zone to the right instant', () => {
    // Asia/Kolkata is UTC+5:30, so 10:00 there is 04:30Z.
    expect(wallClockToInstant(WED, 600, KOL).toISOString()).toBe('2026-04-15T04:30:00.000Z');
    expect(formatClock(new Date('2026-04-15T04:30:00.000Z'), KOL)).toBe('10:00');
  });

  it('reads the offset that applies at that instant, not a fixed one', () => {
    // The night before the European spring-forward, Berlin is UTC+1; by midday
    // it is UTC+2. A single fixed offset books the second half of the day an
    // hour out, and nothing in a Kolkata-only fixture would catch it.
    expect(zoneOffsetMinutes(new Date('2026-03-29T00:00:00Z'), 'Europe/Berlin')).toBe(60);
    expect(zoneOffsetMinutes(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin')).toBe(120);
  });

  it('survives the hour a zone skips', () => {
    // 29 March 2026: 02:00 does not exist in Berlin, and 01:00 → 03:00 is one
    // hour of real time while being two on the clock.
    expect(wallClockToInstant('2026-03-29', 60, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T00:00:00.000Z'
    );
    expect(wallClockToInstant('2026-03-29', 180, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z'
    );
  });

  it('takes the date from the zone, not from UTC', () => {
    // 15:00Z is 20:30 the same day in Kolkata and 11:00 in New York; 02:00Z is
    // already the 15th in Kolkata and still the 14th in New York. This is the
    // reason `serverNow` is echoed back with every response.
    expect(zoneDate(new Date('2026-04-15T15:00:00Z'), KOL)).toBe('2026-04-15');
    expect(zoneDate(new Date('2026-04-15T02:00:00Z'), 'America/New_York')).toBe('2026-04-14');
    expect(zoneDate(new Date('2026-04-15T18:30:00Z'), KOL)).toBe('2026-04-16');
  });

  it('reads the weekday from the calendar date', () => {
    expect(weekdayOf(WED)).toBe(3);
    expect(weekdayOf(SUN)).toBe(0);
  });
});

describe('computeSlots', () => {
  it('offers the grid inside working hours, snapped to the granularity', () => {
    const day = slots();
    // Thirty-minute grid from 09:00; the last start is 18:00 − 60 minutes.
    expect(labels(day)[0]).toBe('09:00');
    expect(labels(day)[1]).toBe('09:30');
    expect(labels(day).at(-1)).toBe('17:00');
    expect(day.slots).toHaveLength(17);
    expect(day.slots.every((s) => s.bookable)).toBe(true);
    expect(day.bookableCount).toBe(17);
  });

  it('snaps a window that starts mid-hour forward to the next boundary', () => {
    const day = slots({
      professionals: [pro('p1', { windows: [{ weekday: 3, startMinute: 547, endMinute: 1080 }] })],
    });
    // 09:07 is not a slot anybody can book; 09:30 is.
    expect(labels(day)[0]).toBe('09:30');
  });

  it('respects the weekday: a Sunday window yields nothing on a Wednesday', () => {
    const day = slots({
      professionals: [pro('p1', { windows: [{ weekday: 0, startMinute: 540, endMinute: 1080 }] })],
    });
    expect(day.slots).toHaveLength(0);
    expect(day.bookableCount).toBe(0);
  });

  it('refuses a duration that cannot fit before closing', () => {
    const day = slots({ durationMinutes: 600 });
    // A ten-hour job cannot fit in a nine-hour shift, so the day is empty rather
    // than a slot that ends after the professional goes home.
    expect(day.slots).toHaveLength(0);
  });

  it('holds back slots inside the lead time, and says why', () => {
    const day = slots({ leadMinutes: 180 });
    // Now is 08:00 and the lead is three hours, so the earliest bookable start
    // is 11:00 — four grid positions, and the boundary slot itself is offered
    // rather than shaved off by a minute of rounding.
    const held = day.slots.filter((s) => s.reason === 'lead_time');
    expect(held.map((s) => s.label)).toEqual(['09:00', '09:30', '10:00', '10:30']);
    for (const slot of held) {
      expect(slot.bookable).toBe(false);
      expect(slot.remaining).toBe(0);
    }
    expect(day.slots.find((s) => s.bookable)?.label).toBe('11:00');
  });

  it('counts how many professionals are free, capped by the capacity', () => {
    const day = slots({
      professionals: [pro('p1'), pro('p2'), pro('p3')],
      capacity: 2,
    });
    // Three are free but the area allows two at once.
    expect(day.slots[0]).toMatchObject({ remaining: 2, bookable: true });
    expect(day.maxRemaining).toBe(2);
  });

  it('reports at_capacity rather than pretending a full day is free', () => {
    const day = slots({ capacity: 0 });
    expect(day.slots.every((s) => s.bookable === false)).toBe(true);
    expect(day.slots[0].reason).toBe('at_capacity');
  });

  it('reports no_professional_available when nobody is free', () => {
    const day = slots({ professionals: [] });
    expect(day.slots).toHaveLength(0);

    const workingButBusy = slots({
      professionals: [
        pro('p1', {
          busy: [
            {
              startsAt: wallClockToInstant(WED, 0, KOL).toISOString(),
              endsAt: wallClockToInstant(WED, 1440, KOL).toISOString(),
            },
          ],
        }),
      ],
    });
    expect(workingButBusy.slots).toHaveLength(17);
    expect(workingButBusy.slots.every((s) => s.reason === 'no_professional_available')).toBe(true);
    expect(workingButBusy.bookableCount).toBe(0);
  });

  it('treats a busy window as half-open, so a job ending at 11:00 frees 11:00', () => {
    const day = slots({
      durationMinutes: 120,
      professionals: [
        pro('p1', {
          busy: [
            {
              startsAt: wallClockToInstant(WED, 600, KOL).toISOString(),
              endsAt: wallClockToInstant(WED, 660, KOL).toISOString(),
            },
          ],
        }),
      ],
    });
    // 10:00–12:00 collides with 10:00–11:00. 08:00–10:00 and 11:00–13:00 do not.
    const byLabel = new Map(day.slots.map((s) => [s.label, s]));
    expect(byLabel.get('09:00')?.bookable).toBe(false);
    expect(byLabel.get('11:00')?.bookable).toBe(true);
  });

  it('unions the windows but requires one professional to cover the whole slot', () => {
    // p1 works 09:00–12:00, p2 works 11:00–15:00. Together they are 09:00–15:00,
    // but a two-hour job has to fit inside one person's shift, not across the
    // handover.
    const day = slots({
      durationMinutes: 120,
      professionals: [
        pro('p1', { windows: [{ weekday: 3, startMinute: 540, endMinute: 720 }] }),
        pro('p2', { windows: [{ weekday: 3, startMinute: 660, endMinute: 900 }] }),
      ],
    });
    const byLabel = new Map(day.slots.map((s) => [s.label, s]));
    expect(labels(day)[0]).toBe('09:00');
    expect(labels(day).at(-1)).toBe('13:00');
    expect(byLabel.get('10:00')?.bookable).toBe(true); // 10:00–12:00, inside p1
    expect(byLabel.get('12:00')?.bookable).toBe(true); // 12:00–14:00, inside p2
    expect(byLabel.get('10:30')?.bookable).toBe(false); // spans the handover
    expect(byLabel.get('10:30')?.reason).toBe('no_professional_available');
  });

  it('merges overlapping windows so a split shift is not a hole', () => {
    // 09:00–12:00 and 10:00–15:00. Only a merge makes 10:00–13:00 possible:
    // neither window contains it on its own.
    const day = slots({
      durationMinutes: 180,
      professionals: [
        pro('p1', {
          windows: [
            { weekday: 3, startMinute: 540, endMinute: 720 },
            { weekday: 3, startMinute: 600, endMinute: 900 },
          ],
        }),
      ],
    });
    const byLabel = new Map(day.slots.map((s) => [s.label, s]));
    expect(byLabel.get('10:00')?.bookable).toBe(true);
    expect(byLabel.get('12:00')?.bookable).toBe(true); // 12:00–15:00, in the second
    expect(labels(day).at(-1)).toBe('12:00');
  });

  it('excludes slots that clash with a whole-day hold', () => {
    const day = slots({
      professionals: [pro('p1'), pro('p2')],
      reservations: [
        {
          startsAt: wallClockToInstant(WED, 600, KOL).toISOString(),
          endsAt: wallClockToInstant(WED, 720, KOL).toISOString(),
        },
      ],
    });
    const byLabel = new Map(day.slots.map((s) => [s.label, s]));
    expect(byLabel.get('11:00')?.bookable).toBe(false);
    expect(byLabel.get('09:00')?.bookable).toBe(true);
  });

  it('sorts the day and reports the server clock it used', () => {
    const now = wallClockToInstant(WED, 480, KOL);
    const day = slots({ now, professionals: [pro('p2'), pro('p1')] });
    const starts = day.slots.map((s) => s.start);
    expect([...starts].sort()).toEqual(starts);
    expect(day.serverNow).toBe(now.toISOString());
    expect(day.date).toBe(WED);
    expect(day.timeZone).toBe(KOL);
  });
});

describe('the instant estimate', () => {
  it('counts minutes from now, not from midnight', () => {
    const now = wallClockToInstant(WED, 480, KOL);
    const day = slots({ now });
    const estimate = estimateInstant(day, now);
    // 09:00 is an hour away, and there is one professional free.
    expect(estimate.etaMinutes).toBe(60);
    expect(estimate.prosAvailable).toBe(1);
    expect(estimate.start).toBe(day.slots[0].start);
    expect(estimate.reason).toBeNull();
  });

  it('honours the lead time in the estimate', () => {
    const now = wallClockToInstant(WED, 480, KOL);
    const day = slots({ now, leadMinutes: 180 });
    // The first bookable slot is 11:00, three hours out.
    expect(estimateInstant(day, now).etaMinutes).toBe(180);
  });

  it('answers null when the day is full, and carries the reason', () => {
    const now = wallClockToInstant(WED, 480, KOL);
    const day = slots({ now, capacity: 0 });
    const estimate = estimateInstant(day, now);
    expect(estimate.etaMinutes).toBeNull();
    expect(estimate.start).toBeNull();
    expect(estimate.prosAvailable).toBe(0);
    expect(estimate.reason).toBe('at_capacity');
  });

  it('labels the estimate in words a person can read', () => {
    expect(etaLabel(null)).toBe('No slots today');
    expect(etaLabel(45)).toBe('in 45 min');
    expect(etaLabel(60)).toBe('in 1 hr');
    expect(etaLabel(90)).toBe('in 1 hr 30 min');
  });
});
