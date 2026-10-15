'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Clock, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { EmptyState } from '@/components/catalogue/EmptyState';
import { OfferCard } from '@/components/professional/OfferCard';
import { JobCard } from '@/components/professional/JobCard';
import { usePoll } from '@/components/professional/usePoll';
import { useAuth } from '@/contexts/AuthContext';
import { VERIFICATION_COPY } from '@/components/professional/verificationCopy';
import {
  acceptOffer,
  declineOffer,
  fetchJobs,
  fetchOffers,
  ProfessionalApiError,
  type Offer,
} from '@/lib/professionalClient';

/**
 * The offers inbox and the professional's jobs (§14.3, §20.7).
 *
 * Both lists poll every 5s (Interaction Contract 1). The accept/decline actions
 * are server-authoritative (Interaction Contract 4): no optimistic removal — the
 * card leaves the inbox because the response said so and the poll re-read it, or
 * because a 409 told us someone else won and the poll caught up.
 *
 * The 409 copy paths are the Copywriting Contract's, verbatim, and none of them
 * opens a modal: a taken or overlapping offer is a fact to relay and move on
 * from, not a decision to confirm.
 */
export default function ProfessionalJobsPage() {
  const { professional } = useAuth();
  const status = professional?.verification_status ?? 'not_submitted';
  const verified = status === 'verified';

  const offersPoll = usePoll(fetchOffers, { enabled: verified });
  const jobsPoll = usePoll(fetchJobs, { enabled: verified });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDecline, setPendingDecline] = useState<Offer | null>(null);

  const offers = offersPoll.data?.offers ?? [];
  const serverNow = offersPoll.data?.serverNow ?? new Date().toISOString();
  const jobs = jobsPoll.data?.jobs ?? [];

  async function handleAccept(offer: Offer) {
    setBusyId(offer.id);
    try {
      await acceptOffer(offer.id);
      toast.success('Offer accepted. The job is in your schedule.');
      await Promise.all([offersPoll.refresh(), jobsPoll.refresh()]);
    } catch (e) {
      if (e instanceof ProfessionalApiError) {
        if (e.code === 'ASSIGNMENT_TAKEN') {
          toast.error('This job was just accepted by someone else. It has been removed from your inbox.');
          await offersPoll.refresh();
        } else if (e.code === 'PROFESSIONAL_UNAVAILABLE') {
          toast.error('That time overlaps another job. Your offer could not be accepted — refresh to see current offers.');
        } else if (e.code === 'STALE_VERSION') {
          toast.error('This job changed on another device. We refreshed it — check the latest status and try again.');
          await Promise.all([offersPoll.refresh(), jobsPoll.refresh()]);
        } else {
          toast.error(e.message);
        }
      } else {
        toast.error('Something went wrong. Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDecline() {
    const offer = pendingDecline;
    if (!offer) return;
    setPendingDecline(null);
    setBusyId(offer.id);
    try {
      await declineOffer(offer.id);
      toast.success('Offer declined.');
      await offersPoll.refresh();
    } catch (e) {
      toast.error(e instanceof ProfessionalApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AuthGuard role="professional">
      <RoleShell role="professional" eyebrow="Professional" title="Jobs">
        {!verified ? <VerificationGate status={status} /> : null}

        <section
          aria-labelledby="offers-heading"
          className="rounded-2xl bg-white p-6 shadow-xl"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 id="offers-heading" className="text-lg font-bold text-gray-900">
              Offers
            </h2>
            {offersPoll.error ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                Connection lost — retrying…
              </span>
            ) : null}
          </div>

          {offersPoll.loading && offersPoll.data === null ? (
            <p className="flex items-center gap-2 text-sm text-gray-600" role="status">
              Loading offers…
            </p>
          ) : offers.length ? (
            <ul className="space-y-4">
              {offers.map((offer) => (
                <li key={offer.id}>
                  <OfferCard
                    offer={offer}
                    serverNow={serverNow}
                    busy={busyId === offer.id}
                    onAccept={handleAccept}
                    onDecline={setPendingDecline}
                  />
                </li>
              ))}
            </ul>
          ) : verified ? (
            <EmptyState
              title="No offers right now"
              message="New jobs appear here as they come in. Keep yourself online to get them."
            />
          ) : (
            <p className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-8 text-center text-sm text-gray-600">
              Offers appear once your verification is approved.
            </p>
          )}
        </section>

        <section
          aria-labelledby="jobs-heading"
          className="mt-6 rounded-2xl bg-white p-6 shadow-xl"
        >
          <h2 id="jobs-heading" className="mb-4 text-lg font-bold text-gray-900">
            Today&apos;s jobs
          </h2>

          {jobsPoll.loading && jobsPoll.data === null ? (
            <p className="flex items-center gap-2 text-sm text-gray-600" role="status">
              Loading this job…
            </p>
          ) : jobs.length ? (
            <ul className="space-y-4">
              {jobs.map((job) => (
                <li key={job.id}>
                  <JobCard job={job} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No jobs today"
              message="Accepted jobs for today will appear here. Check the offers tab for new work."
            />
          )}
        </section>

        <ConfirmationDialog
          isOpen={pendingDecline !== null}
          onClose={() => setPendingDecline(null)}
          onConfirm={confirmDecline}
          title="Decline this job?"
          message="You will not be offered this job again. This is recorded on your response history."
          confirmText="Decline job"
          cancelText="Keep offer"
          type="warning"
          isLoading={busyId !== null}
        />
      </RoleShell>
    </AuthGuard>
  );
}

function VerificationGate({ status }: { status: string }) {
  const copy = VERIFICATION_COPY[status] ?? VERIFICATION_COPY.not_submitted;
  return (
    <div
      className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 sm:flex-row sm:items-center"
      role="status"
    >
      <div className="flex-1">
        <p className="flex items-center gap-2 font-semibold text-amber-900">
          {status === 'submitted' ? (
            <Clock className="h-5 w-5 text-amber-600" aria-hidden="true" />
          ) : (
            <Upload className="h-5 w-5 text-amber-600" aria-hidden="true" />
          )}
          Verification: {copy.label}
        </p>
        <p className="mt-0.5 text-sm text-amber-800">
          {copy.blurb} Offers are paused until your documents are approved.
        </p>
      </div>
      <Link
        href="/professional/kyc"
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        Upload documents
      </Link>
    </div>
  );
}
