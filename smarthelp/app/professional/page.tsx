'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BadgeCheck,
  CalendarClock,
  IndianRupee,
  Upload,
  Star,
  AlertCircle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';
import { fetchAvailability, fetchJobs, type AvailabilityState } from '@/lib/professionalClient';
import { usePoll } from '@/components/professional/usePoll';
import { JobCard } from '@/components/professional/JobCard';
import { VERIFICATION_COPY } from '@/components/professional/verificationCopy';

export default function ProfessionalHome() {
  const { professional } = useAuth();
  const status = professional?.verification_status ?? 'not_submitted';
  const copy = VERIFICATION_COPY[status] ?? VERIFICATION_COPY.not_submitted;
  const showVerificationGate = status !== 'verified';

  // The availability card reads the real state (§20.7). The page used to say
  // "Availability and scheduling arrive in Phase 3", which was both late and
  // untrue; this is the half of the home repair that belongs with the
  // availability work. Today's jobs from the API arrive with the jobs route.
  const [availability, setAvailability] = useState<AvailabilityState | null>(null);
  const [availabilityError, setAvailabilityError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAvailability()
      .then((state) => {
        if (!cancelled) setAvailability(state);
      })
      .catch(() => {
        if (!cancelled) setAvailabilityError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const online = availability?.availabilityStatus === 'online';

  // Today's jobs, from the route A2 was waiting on (B2). A verified professional
  // owns jobs; an unverified one has none, so the poll stays off until then.
  const jobsPoll = usePoll(fetchJobs, { enabled: status === 'verified' });
  const todaysJobs = jobsPoll.data?.jobs ?? [];

  return (
    <AuthGuard role="professional">
      <RoleShell role="professional" eyebrow="Professional" title="Your jobs and earnings">
        {showVerificationGate ? (
          <div
            className="mb-6 flex flex-col sm:flex-row sm:items-center gap-4 rounded-xl border border-amber-200 bg-amber-50 p-5"
            role="status"
          >
            <div className="shrink-0">
              {status === 'rejected' ? (
                <AlertCircle className="h-6 w-6 text-red-600" aria-hidden="true" />
              ) : status === 'submitted' ? (
                <Clock className="h-6 w-6 text-amber-600" aria-hidden="true" />
              ) : (
                <Upload className="h-6 w-6 text-amber-600" aria-hidden="true" />
              )}
            </div>
            <div className="flex-1">
              <p className="font-semibold text-amber-900">
                Verification: {copy.label}
              </p>
              <p className="mt-0.5 text-sm text-amber-800">{copy.blurb}</p>
            </div>
            <Link
              href="/professional/kyc"
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {status === 'rejected' || status === 'expired' ? 'Re-upload' : 'Upload documents'}
            </Link>
          </div>
        ) : (
          <div
            className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-5"
            role="status"
          >
            <CheckCircle2 className="h-6 w-6 text-green-600" aria-hidden="true" />
            <p className="text-sm text-green-900">
              <span className="font-semibold">You are verified.</span> Customers can see your profile
              and book you.
            </p>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">Today&apos;s jobs</h2>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${copy.tone}`}
                >
                  {status === 'verified' ? (
                    <>
                      <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> Verified
                    </>
                  ) : (
                    copy.label
                  )}
                </span>
              </div>
              {todaysJobs.length ? (
                <ul className="mt-4 space-y-3">
                  {todaysJobs.map((job) => (
                    <li key={job.id}>
                      <JobCard job={job} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-gray-600">
                  {status === 'verified'
                    ? 'Accepted jobs for today will appear here.'
                    : 'Jobs are assigned only after your verification is approved.'}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-gray-600">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                <span
                  className={`h-2 w-2 rounded-full ${online ? 'bg-green-500' : 'bg-gray-400'}`}
                  aria-hidden="true"
                />
                <span>
                  {availabilityError
                    ? 'We could not load your availability.'
                    : online
                      ? 'You are online for new jobs.'
                      : 'You are offline. Go online to receive jobs.'}
                </span>
                <Link
                  href="/professional/availability"
                  className="font-semibold text-blue-600 hover:text-blue-700"
                >
                  Manage availability
                </Link>
              </div>
            </section>

            <section id="kyc" className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Verification documents</h2>
              <p className="mt-1 text-sm text-gray-600">
                Aadhaar or passport, plus a selfie holding the same document. Photos stay private and
                are only visible to the verification team.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-gray-700">
                {['Identity document', 'Address proof', 'Selfie with document'].map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-gray-400" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/professional/kyc"
                className="mt-4 inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {status === 'not_submitted' ? 'Upload documents' : 'View documents'}
              </Link>
            </section>
          </div>

          <div className="space-y-6">
            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Your rating</h2>
              <p className="mt-2 flex items-center gap-1.5 text-2xl font-semibold text-gray-900">
                <Star className="h-5 w-5 text-amber-400" aria-hidden="true" />
                {professional?.rating ? professional.rating.toFixed(1) : '—'}
                <span className="text-sm font-normal text-gray-500">
                  ({professional?.rating_count ?? 0} reviews)
                </span>
              </p>
            </section>

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
                <IndianRupee className="h-4 w-4 text-gray-400" aria-hidden="true" />
                Earnings
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Payouts appear once jobs start running. Commission is deducted from the service price.
              </p>
              <Link
                href="/professional/earnings"
                className="mt-3 inline-block font-semibold text-blue-600 hover:text-blue-700"
              >
                View your ledger
              </Link>
            </section>
          </div>
        </div>
      </RoleShell>
    </AuthGuard>
  );
}
