'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  IndianRupee,
  RefreshCcw,
  Search,
  Users,
  Wrench,
} from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import StatCard from '@/components/admin/StatCard';
import { useAuth } from '@/contexts/AuthContext';
import { fetchDashboard, type DashboardSummary } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export default function AdminHome() {
  const { profile, roleLabel } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDashboard()
      .then((res) => {
        if (!cancelled) setSummary(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell
        role="admin"
        eyebrow={roleLabel ?? 'Operations'}
        title={`${greeting}, ${profile?.full_name ?? 'there'}`}
      >
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
            We could not load the dashboard. Reload the page to try again.
          </div>
        ) : (
          <div className="space-y-8">
            <section aria-labelledby="today-heading">
              <h2 id="today-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                Today
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Bookings"
                  value={String(summary?.bookings.today ?? 0)}
                  hint="Created since midnight IST"
                  icon={CalendarCheck}
                  tone="blue"
                />
                <StatCard
                  label="Gross value"
                  value={inr.format(summary?.gmvToday ?? 0)}
                  hint="Booked today, cancellations excluded"
                  icon={IndianRupee}
                  tone="green"
                />
                <StatCard
                  label="Completed"
                  value={String(summary?.bookings.completedToday ?? 0)}
                  hint="Finished today"
                  icon={CheckCircle2}
                  tone="green"
                />
                <StatCard
                  label="Cancelled"
                  value={String(summary?.bookings.cancelledToday ?? 0)}
                  hint="Cancelled today"
                  icon={AlertTriangle}
                  tone="red"
                />
              </div>
            </section>

            <section aria-labelledby="queue-heading">
              <h2 id="queue-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                Live queues
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Awaiting a professional"
                  value={String(summary?.bookings.awaitingProfessional ?? 0)}
                  hint="Paid or searching"
                  icon={Search}
                  tone="amber"
                />
                <StatCard
                  label="Jobs in progress"
                  value={String(summary?.bookings.inProgress ?? 0)}
                  hint="Assigned through working"
                  icon={Wrench}
                  tone="blue"
                />
                <StatCard
                  label="KYC to review"
                  value={String(summary?.professionals.pendingKyc ?? 0)}
                  hint="Documents awaiting a verdict"
                  icon={Users}
                  tone="amber"
                />
                <StatCard
                  label="Refunds to approve"
                  value={String(summary?.refunds.pendingApproval ?? 0)}
                  hint="Requested, over the auto limit"
                  icon={RefreshCcw}
                  tone="red"
                />
              </div>
            </section>

            <section aria-labelledby="team-heading">
              <h2 id="team-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                Team
              </h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard
                  label="Professionals"
                  value={String(summary?.professionals.total ?? 0)}
                  hint="On the roster"
                  icon={Users}
                  tone="gray"
                />
                <StatCard
                  label="Verified"
                  value={String(summary?.professionals.verified ?? 0)}
                  hint="Cleared to take jobs"
                  icon={CheckCircle2}
                  tone="green"
                />
                <StatCard
                  label="Online now"
                  value={String(summary?.professionals.online ?? 0)}
                  hint="Marked available"
                  icon={Wrench}
                  tone="blue"
                />
              </div>
            </section>

            <nav className="flex flex-wrap gap-3">
              <Link
                href="/admin/bookings"
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Open the booking queue
              </Link>
              <Link
                href="/admin/professionals"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Open the professional roster
              </Link>
            </nav>
          </div>
        )}
      </RoleShell>
    </AuthGuard>
  );
}
