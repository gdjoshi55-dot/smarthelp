'use client';

import { useEffect, useState } from 'react';
import { IndianRupee, TrendingUp, Wallet, Landmark, RotateCcw } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import { PosShell } from '@/components/professional/PosShell';
import {
  fetchEarnings,
  type EarningsEntry,
  type EarningStatus,
  type EarningsSummary,
} from '@/lib/professionalClient';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/**
 * The status to a sentence: what the ledger says, what the professional sees.
 * `reversed` carries a reason on the row itself, shown beneath the amount.
 */
const STATUS_COPY: Record<EarningStatus, { label: string; tone: string }> = {
  pending: { label: 'In clearing', tone: 'bg-amber-100 text-amber-800' },
  available: { label: 'Available', tone: 'bg-green-100 text-green-800' },
  paid: { label: 'Paid out', tone: 'bg-blue-100 text-blue-800' },
  reversed: { label: 'Reversed', tone: 'bg-red-100 text-red-700' },
};

export default function ProfessionalEarnings() {
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [earnings, setEarnings] = useState<EarningsEntry[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEarnings()
      .then((res) => {
        if (!cancelled) {
          setSummary(res.summary);
          setEarnings(res.earnings);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = [
    {
      label: 'Total earned',
      value: summary?.lifetimeNet ?? 0,
      icon: TrendingUp,
      iconTone: 'bg-blue-100 text-blue-600',
      blurb: 'Net across every completed job',
    },
    {
      label: 'In clearing',
      value: summary?.heldNet ?? 0,
      icon: Wallet,
      iconTone: 'bg-amber-100 text-amber-600',
      blurb: 'Earned, awaiting the payout cycle',
    },
    {
      label: 'Available now',
      value: summary?.availableNet ?? 0,
      icon: IndianRupee,
      iconTone: 'bg-green-100 text-green-600',
      blurb: 'Ready to be paid out',
    },
    {
      label: 'Paid out',
      value: summary?.paidNet ?? 0,
      icon: Landmark,
      iconTone: 'bg-gray-100 text-gray-600',
      blurb: 'Transferred to your account',
    },
  ] as const;

  return (
    <AuthGuard role="professional">
      <PosShell
        icon={IndianRupee}
        title="Your earnings"
        subtitle="Every completed job, what was deducted, and what you take home"
      >
        {error ? (
          <div
            className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"
            role="alert"
          >
            We could not load your earnings. Pull down or reload the page to try again.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {cards.map(({ label, value, icon: Icon, iconTone, blurb }) => (
                <section key={label} className="rounded-2xl bg-white p-5 shadow-xl">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-600">{label}</p>
                    <span
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${iconTone}`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </div>
                  <p className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
                    {inr.format(value)}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">{blurb}</p>
                </section>
              ))}
            </div>

            {summary && summary.counts.reversed > 0 && (
              <section className="flex items-start gap-3 rounded-xl border border-red-100 bg-red-50 p-4">
                <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                <p className="text-sm text-red-800">
                  {summary.counts.reversed} booking{summary.counts.reversed === 1 ? '' : 's'} had
                  earnings reversed ({inr.format(summary.reversedNet)}). Reversals carry a reason in
                  the ledger below and on your payout statement.
                </p>
              </section>
            )}

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Ledger</h2>
              <p className="mt-1 text-sm text-gray-600">
                One row per completed job. Net amount is the service price minus the platform
                commission.
              </p>
              {earnings.length ? (
                <ul className="mt-4 divide-y divide-gray-100">
                  {earnings.map((entry) => {
                    const status = STATUS_COPY[entry.status] ?? STATUS_COPY.pending;
                    return (
                      <li key={entry.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">
                            {entry.serviceName ?? 'Completed job'}
                          </p>
                          <p className="text-xs text-gray-500">
                            {entry.bookingNumber ?? entry.bookingId.slice(0, 8)} ·{' '}
                            {new Date(entry.createdAt).toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </p>
                          {entry.status === 'reversed' && entry.reversedReason && (
                            <p className="mt-1 text-xs text-red-700">{entry.reversedReason}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
                            {status.label}
                          </span>
                          <span className="w-28 text-right text-sm font-semibold text-gray-900">
                            {inr.format(entry.netAmount)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-gray-600">
                  Nothing here yet. Earnings for each completed job will appear once your first job
                  runs.
                </p>
              )}
            </section>
          </div>
        )}
      </PosShell>
    </AuthGuard>
  );
}