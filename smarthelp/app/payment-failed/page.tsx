'use client';

import Link from 'next/link';
import { XCircle } from 'lucide-react';

/**
 * `/payment-failed` — the counterweight to `/payment-success`, matching
 * pos-subscription's page. SmartHelp's checkout already offers "Try again" in
 * place; this page is the landing for a redirect-based return.
 */
export default function PaymentFailedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-red-600 to-red-800 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <div className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full bg-red-100">
          <XCircle className="h-12 w-12 text-red-600" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Payment failed</h1>
        <p className="mt-2 text-sm text-gray-500">
          Your payment could not be processed. No money has left your account.
          Please try again.
        </p>
        <Link
          href="/services"
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}
