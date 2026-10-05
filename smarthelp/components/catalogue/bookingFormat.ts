/**
 * Date and money formatting for the booking screens (§31.2).
 *
 * These live in one file because three components need the same sentence and
 * three copies of `Intl.DateTimeFormat` options is three chances to disagree
 * about what a booking looks like — one screen saying "2 Mar" while another says
 * "Mar 2" reads as two different bookings.
 *
 * Every formatter takes an ISO string and never a `Date`. The booking row hands
 * out timestamps as strings, and `new Date(someString)` on a bad value produces
 * an `Invalid Date` whose `.toLocaleString()` is the word "Invalid Date" — so
 * each one catches and returns the input, which at least is honest.
 */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'To be scheduled';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** The one-line form a booking card uses: "Sat, 2 Mar · 2:00 pm". */
export function formatBookingWhen(iso: string | null | undefined): string {
  if (!iso) return 'Instant — no time chosen';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}