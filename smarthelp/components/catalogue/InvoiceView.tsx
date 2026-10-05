'use client';

import { Printer } from 'lucide-react';
import { PriceBreakdown } from './PriceBreakdown';
import { formatDateTime } from './bookingFormat';
import { parseNumeric } from '@/lib/money';
import { formatPrice } from '@/lib/catalogue';
import type { InvoiceResult } from '@/lib/bookingClient';

/**
 * The receipt (§20.6).
 *
 * It renders the frozen money columns, not a fresh quote — see the note on the
 * invoice route. The one thing it adds beyond `PriceBreakdown` is the line-item
 * detail, because a receipt that shows only a total cannot answer "what was I
 * charged for", and §31.2's review criterion is that the numbers on this page
 * can be reconciled against the booking without a database.
 *
 * `print:` is scoped to this panel so the browser prints the receipt and not the
 * whole detail page — the status timeline and the reschedule form are useless on
 * paper and would print as a second page of noise.
 */

export function InvoiceView({ data }: { data: InvoiceResult }) {
  const { booking, invoice } = data;
  const address = booking.address_snapshot as {
    formatted?: string;
    line1?: string;
    city?: string;
    locality_name?: string;
  };

  const addressLine =
    address?.formatted ??
    [address?.line1, address?.city ?? address?.locality_name].filter(Boolean).join(', ');

  const fee = parseNumeric(booking.cancellation_fee);

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-6 print:border-0 print:p-0"
      aria-label="Invoice"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Invoice</h2>
          <p className="mt-0.5 font-mono text-sm text-gray-600">{invoice.bookingNumber}</p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 print:hidden"
        >
          <Printer className="h-3.5 w-3.5" aria-hidden="true" />
          Print
        </button>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-gray-500">Booked for</dt>
          <dd className="text-gray-900">{formatDateTime(booking.scheduled_start_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Duration</dt>
          <dd className="text-gray-900">
            {booking.duration_minutes >= 60
              ? `${Math.floor(booking.duration_minutes / 60)} h${
                  booking.duration_minutes % 60 ? ` ${booking.duration_minutes % 60} m` : ''
                }`
              : `${booking.duration_minutes} min`}
          </dd>
        </div>
        {addressLine ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-gray-500">Address</dt>
            <dd className="text-gray-900">{addressLine}</dd>
          </div>
        ) : null}
      </dl>

      {invoice.items.length > 0 ? (
        <table className="mt-4 w-full text-sm">
          <caption className="sr-only">Services on this booking</caption>
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
              <th scope="col" className="py-1.5 font-medium">
                Service
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, index) => (
              <tr key={`${item.service_name}-${index}`} className="border-b border-gray-100">
                <td className="py-2 text-gray-900">{item.service_name}</td>
                <td className="py-2 text-right tabular-nums text-gray-700">{item.quantity}</td>
                <td className="py-2 text-right tabular-nums text-gray-900">
                  {formatPrice(parseNumeric(item.line_total))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="mt-4 border-t border-gray-200 pt-4">
        <PriceBreakdown booking={booking} totalLabel="Total" />
      </div>

      {fee > 0 ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          A cancellation fee of {formatPrice(fee)} was charged against this booking.
        </p>
      ) : null}
    </section>
  );
}