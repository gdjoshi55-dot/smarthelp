'use client';

/**
 * One status, one pill. Booking, verification and availability statuses share
 * the vocabulary — the words differ, the meaning does not: green is good, amber
 * is pending, red is a problem, gray is inert.
 */
const TONES: Record<string, string> = {
  // Booking lifecycle
  draft: 'bg-gray-100 text-gray-700',
  payment_pending: 'bg-amber-100 text-amber-800',
  paid: 'bg-blue-100 text-blue-800',
  searching: 'bg-indigo-100 text-indigo-800',
  assigned: 'bg-indigo-100 text-indigo-800',
  accepted: 'bg-blue-100 text-blue-800',
  on_the_way: 'bg-blue-100 text-blue-800',
  arrived: 'bg-blue-100 text-blue-800',
  otp_verified: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-blue-100 text-blue-800',
  extension_requested: 'bg-amber-100 text-amber-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-700',
  refund_pending: 'bg-amber-100 text-amber-800',
  refunded: 'bg-gray-100 text-gray-700',
  disputed: 'bg-red-100 text-red-700',
  no_show: 'bg-red-100 text-red-700',
  closed: 'bg-gray-100 text-gray-700',
  // Verification
  not_submitted: 'bg-gray-100 text-gray-700',
  submitted: 'bg-amber-100 text-amber-800',
  in_review: 'bg-amber-100 text-amber-800',
  verified: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-red-100 text-red-700',
  // Availability / assignment
  offline: 'bg-gray-100 text-gray-700',
  online: 'bg-green-100 text-green-800',
  busy: 'bg-amber-100 text-amber-800',
  break: 'bg-gray-100 text-gray-700',
  offered: 'bg-amber-100 text-amber-800',
  withdrawn: 'bg-gray-100 text-gray-700',
};

export function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function StatusPill({ status }: { status: string }) {
  const tone = TONES[status] ?? 'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      {humanise(status)}
    </span>
  );
}
