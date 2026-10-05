'use client';

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

const VERIFICATION_COPY: Record<string, { label: string; tone: string; blurb: string }> = {
  not_submitted: {
    label: 'Not started',
    tone: 'bg-gray-100 text-gray-700',
    blurb: 'Upload your identity and address documents to start the review.',
  },
  submitted: {
    label: 'In review',
    tone: 'bg-amber-100 text-amber-800',
    blurb: 'We are checking your documents. This usually takes up to 48 hours.',
  },
  verified: {
    label: 'Verified',
    tone: 'bg-green-100 text-green-800',
    blurb: 'You are verified. Customers can now book you.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'bg-red-100 text-red-800',
    blurb: 'The documents were not readable. Upload clearer copies and try again.',
  },
  expired: {
    label: 'Expired',
    tone: 'bg-amber-100 text-amber-800',
    blurb: 'Your verification has expired. Please upload your documents again.',
  },
};

export default function ProfessionalHome() {
  const { professional } = useAuth();
  const status = professional?.verification_status ?? 'not_submitted';
  const copy = VERIFICATION_COPY[status] ?? VERIFICATION_COPY.not_submitted;
  const showVerificationGate = status !== 'verified';

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
              href="#kyc"
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
            <section className="bg-white border border-gray-200 rounded-xl p-6">
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
              <p className="mt-1 text-sm text-gray-600">
                {status === 'verified'
                  ? 'Accepted jobs for today will appear here.'
                  : 'Jobs are assigned only after your verification is approved.'}
              </p>
              <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                Availability and scheduling arrive in Phase 3.
              </div>
            </section>

            <section id="kyc" className="bg-white border border-gray-200 rounded-xl p-6">
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
              <p className="mt-4 text-xs text-gray-500">
                The upload form arrives in Phase 4. Signing in as a professional already works.
              </p>
            </section>
          </div>

          <div className="space-y-6">
            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900">Your rating</h2>
              <p className="mt-2 flex items-center gap-1.5 text-2xl font-semibold text-gray-900">
                <Star className="h-5 w-5 text-amber-400" aria-hidden="true" />
                {professional?.rating ? professional.rating.toFixed(1) : '—'}
                <span className="text-sm font-normal text-gray-500">
                  ({professional?.rating_count ?? 0} reviews)
                </span>
              </p>
            </section>

            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
                <IndianRupee className="h-4 w-4 text-gray-400" aria-hidden="true" />
                Earnings
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Payouts appear once jobs start running. Commission is deducted from the service price.
              </p>
            </section>
          </div>
        </div>
      </RoleShell>
    </AuthGuard>
  );
}
