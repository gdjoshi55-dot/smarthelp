import { statusPresentation } from '@/lib/status';
import { parseNumeric } from '@/lib/money';
import { formatPrice } from '@/lib/catalogue';
import type { BookingRow, PricingBreakdown } from '@/lib/bookingClient';

/**
 * The price breakdown (§20.5's fourth section).
 *
 * **This component has no arithmetic in it.** It renders a
 * `pricing_snapshot` that `lib/pricing.ts` produced on the server. That is the
 * whole reason it exists as a separate file: the checkout screen and the booking
 * detail screen both need these lines, and a `+` sign added to either of them
 * would be a second implementation of an engine that already reconciles to the
 * paisa.
 *
 * Money arrives as `numeric` strings and is parsed with `parseNumeric`, which
 * does not route the value through a float — `₹613.60` read as a double is
 * `613.5999999999999`, and formatting that is how an invoice ends up a paisa
 * short.
 */

/** `₹613.60`, or `₹1,204.00` — the only place a rupee figure is formatted. */
function money(value: string | number): string {
  const amount = typeof value === 'string' ? parseNumeric(value) : value;
  return formatPrice(amount);
}

export function PriceBreakdown({
  breakdown,
  booking,
  totalLabel = 'Total payable',
}: {
  /** A fresh quote, when the screen is still deciding. */
  breakdown?: PricingBreakdown | null;
  /** Or the frozen snapshot, when the booking already exists. */
  booking?: BookingRow | null;
  totalLabel?: string;
}) {
  // Prefer the booking's own `pricing_snapshot` when there is one. §16 #19: the
  // price a customer agreed to is frozen, so a detail screen must never
  // recompute it from today's catalogue.
  const snapshot = booking?.pricing_snapshot as { totals?: Record<string, string> } | undefined;
  const totals = snapshot?.totals;
  const fresh = breakdown ?? null;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [];

  if (fresh) {
    rows.push({ label: 'Subtotal', value: money(fresh.subtotal) });
    if (fresh.discount > 0) {
      rows.push({
        label: fresh.discountCode ? `Discount (${fresh.discountCode})` : 'Discount',
        value: `-${money(fresh.discount)}`,
        muted: true,
      });
    }
    rows.push({ label: 'Platform fee', value: money(fresh.platformFee), muted: true });
    rows.push({ label: `GST (${(fresh.taxRate * 100).toFixed(0)}%)`, value: money(fresh.tax), muted: true });
  } else if (totals) {
    rows.push({ label: 'Subtotal', value: money(totals.subtotal) });
    if (parseNumeric(totals.discount ?? '0') > 0) {
      rows.push({
        label: booking?.discount_code ? `Discount (${booking.discount_code})` : 'Discount',
        value: `-${money(totals.discount)}`,
        muted: true,
      });
    }
    rows.push({ label: 'Platform fee', value: money(totals.platformFee), muted: true });
    rows.push({
      label: `GST (${(parseNumeric(booking?.tax_rate ?? '0') * 100).toFixed(0)}%)`,
      value: money(totals.tax),
      muted: true,
    });
  }

  const total =
    fresh?.total ?? (booking ? parseNumeric(booking.total_amount) : null);

  if (rows.length === 0 && total == null) {
    return (
      <p className="text-sm text-gray-500">
        A price breakdown will appear here once the booking exists.
      </p>
    );
  }

  return (
    <div>
      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className={`text-sm ${row.muted ? 'text-gray-600' : 'text-gray-900'}`}>{row.label}</dt>
            <dd
              className={`text-sm tabular-nums ${
                row.label.startsWith('Discount') ? 'text-emerald-700' : 'text-gray-900'
              }`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-gray-200 pt-3">
        <dt className="text-sm font-semibold text-gray-900">{totalLabel}</dt>
        <dd className="text-lg font-semibold tabular-nums text-gray-900">{money(total ?? 0)}</dd>
      </div>

      {fresh && fresh.lines.length > 1 ? (
        <ul className="mt-4 space-y-1.5 border-t border-gray-100 pt-3">
          {fresh.lines.map((line) => (
            <li key={line.serviceId} className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-gray-600">
                {line.label}
                {line.quantity > 1 ? ` × ${line.quantity}` : ''}
              </span>
              <span className="text-xs tabular-nums text-gray-700">{money(line.lineTotal)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The status pill (§20.6).
 *
 * Never colour alone: the badge carries `statusPresentation`'s label, and the
 * description is the accessible name a screen reader announces. §31.2 asks for
 * "no colour-only status" and this is the component that has to honour it — the
 * palette comes from `statusPresentation` rather than being chosen here, so a
 * status cannot look one way on the list and another on the detail screen.
 */
export function BookingStatusBadge({ status }: { status: string }) {
  const presentation = statusPresentation(status as never);
  return (
    <span
      title={presentation.description}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${presentation.badgeClass}`}
    >
      {presentation.label}
      <span className="sr-only">. {presentation.description}</span>
    </span>
  );
}