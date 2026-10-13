'use client';

import type { LucideIcon } from 'lucide-react';

/**
 * A dashboard metric (§20.11). One number, one label, one line of context.
 *
 * `tone` colours the icon chip only; the figure stays neutral so a page of
 * cards reads as numbers, not as an alert wall. The value is a string because
 * the caller has already formatted it — rupees, a count, a percentage — and
 * this component does not guess which.
 */
export default function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'blue',
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'gray';
}) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    amber: 'bg-amber-100 text-amber-600',
    red: 'bg-red-100 text-red-600',
    gray: 'bg-gray-100 text-gray-600',
  };

  return (
    <section className="rounded-2xl bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-600">{label}</p>
        {Icon ? (
          <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${tones[tone]}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight text-gray-900 tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </section>
  );
}
