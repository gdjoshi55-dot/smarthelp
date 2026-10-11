'use client';

import Link from 'next/link';
import { CheckCircle, Loader2 } from 'lucide-react';

/**
 * `/payment-success` — a confirmation landing that mirrors pos-subscription's.
 *
 * SmartHelp's checkout confirms in place by polling the payment row, so this
 * page is a destination, not the only path. It exists so a redirect-based flow
 * (and any gateway return that lands a URL) has somewhere true to go.
 */
export default function PaymentSuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-600 to-emerald-800 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <div className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100">
          <CheckCircle className="h-12 w-12 text-emerald-600" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Payment successful</h1>
        <p className="mt-2 text-sm text-gray-500">
          Your payment has been received and your booking is confirmed.
        </p>
        <Loader2 className="mx-auto mt-4 h-6 w-6 animate-spin text-emerald-600" aria-hidden="true" />
        <Link
          href="/customer/bookings"
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"
        >
          View my bookings
        </Link>
      </div>
    </div>
  );
}
