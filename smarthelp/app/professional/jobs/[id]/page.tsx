'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, CheckCircle, Clock, MapPin, Navigation, Timer, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { BookingStatusBadge } from '@/components/catalogue/PriceBreakdown';
import { EmptyState } from '@/components/catalogue/EmptyState';
import { formatDateTime } from '@/components/catalogue/bookingFormat';
import { OtpEntry } from '@/components/booking/OtpEntry';
import { ServiceTimer } from '@/components/booking/ServiceTimer';
import { usePoll } from '@/components/professional/usePoll';
import { VERIFICATION_COPY } from '@/components/professional/verificationCopy';
import { useAuth } from '@/contexts/AuthContext';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { statusPresentation } from '@/lib/status';
import {
  arriveJob,
  completeJob,
  fetchJobs,
  reportNoShow,
  startJourney,
  verifyServiceOtp,
  ProfessionalApiError,
  type ProJob,
} from '@/lib/professionalClient';
import type { BookingStatus } from '@/lib/supabase';

/** The reasons a professional can give for a no-show, from the UI-SPEC select. */
const NO_SHOW_REASONS = [
  'The customer was not available',
  'The customer could not be reached',
  'I could not access the address',
  'The address was not found',
] as const;

/**
 * `/professional/jobs/[id]` — the job's own screen (§20.6, §20.8).
 *
 * ## Why it reads the list it already has
 *
 * Phase 4 never adds a `GET /api/professionals/jobs/:id`, and deliberately so:
 * the professional's live jobs are one column-limited, ownership-filtered read
 * (`PRO_JOB_COLUMNS`, no `otp_hash`), and a second endpoint that shaped the same
 * row for the same caller would be a second place to get the strip list wrong.
 * So this screen polls the list it shares with the home page — 15s, per
 * Interaction Contract 1 — and picks the one row that matches the route. The
 * consequence the state must handle: a job that is *no longer* in the live set
 * is not "missing", it is finished or reassigned, and it says so.
 *
 * ## One action per state, derived from data
 *
 * What the screen offers comes from `job.status`, never from a guess or from a
 * disabled button (Interaction Contract 5): `accepted` starts the journey
 * (`start_journey`, 0031), `on_the_way` confirms arrival, `arrived` takes the
 * customer's code, `in_progress` shows the server-anchored timer. Every other
 * state renders a sentence about it and no button at all.
 *
 * ## Arrival is the geofenced one
 *
 * The device reports its own position and the server decides
 * (`POST …/arrive`). A refusal carries `details.reason === 'outside_arrival_radius'`,
 * and only then does this screen open the manual-override dialog — the reason
 * typed there is what `job.arrival_override` records against the professional,
 * so the dialog asks for a real one and sends nothing without it.
 */

/** One line for the professional, phrased about the person holding the phone. */
const ACTION_HINTS: Record<string, string> = {
  accepted: 'This job is in your schedule. Tap On my way when you start driving.',
  on_the_way: 'Confirm arrival once you are standing at the address.',
  arrived: 'Ask the customer for the start code, then enter it below.',
  otp_verified: 'The start code was accepted. The job is starting.',
  in_progress: 'You are on the clock. Finish the work, then mark the job complete.',
  completed: 'This job is finished. Your earnings will be available after the 24-hour hold.',
  no_show: 'This job is closed. It is recorded against your account.',
  cancelled: 'This job was cancelled.',
};

/** A coordinate the address snapshot may or may not carry. */
function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The device's position, as a promise so the arrival flow reads top to bottom.
 *
 * A refusal is an `Error` with a sentence a person can act on, not a code: the
 * only caller shows it in a toast, and "User denied Geolocation" is not that.
 */
function currentLocation(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('We could not get your location. Turn on location access and try again.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () =>
        reject(new Error('We could not get your location. Turn on location access and try again.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

function JobDetail({ id }: { id: string }) {
  const { professional } = useAuth();
  const verificationStatus = professional?.verification_status ?? 'not_submitted';
  const verified = verificationStatus === 'verified';

  const jobsPoll = usePoll(fetchJobs, { enabled: verified, intervalMs: 15000 });
  const serverNow = jobsPoll.data?.serverNow ?? null;
  const liveJob = useMemo(
    () => jobsPoll.data?.jobs.find((candidate) => candidate.id === id) ?? null,
    [jobsPoll.data, id]
  );

  const [arriving, setArriving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [geofence, setGeofence] = useState<{ distanceM: number | null; radiusM: number } | null>(
    null
  );
  const [overrideReason, setOverrideReason] = useState('');
  const [otpFailures, setOtpFailures] = useState(0);

  // The completed/no-show response is what walks the screen to its final state.
  // `me/jobs` lists only the live statuses, so once this route succeeds the job
  // leaves the poll — holding the returned row here is what lets the page show
  // `completed`/`no_show` instead of snapping to "not in your list".
  const [finishedJob, setFinishedJob] = useState<ProJob | null>(null);
  const [completing, setCompleting] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [noShowReason, setNoShowReason] = useState('');
  const [noShowing, setNoShowing] = useState(false);

  const job = finishedJob ?? liveJob;

  if (!verified) {
    const copy = VERIFICATION_COPY[verificationStatus] ?? VERIFICATION_COPY.not_submitted;
    return (
      <div
        className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5"
        role="status"
      >
        <p className="font-semibold text-amber-900">Verification: {copy.label}</p>
        <p className="text-sm text-amber-800">{copy.blurb}</p>
        <Link
          href="/professional/kyc"
          className="inline-flex w-fit items-center justify-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Upload documents
        </Link>
      </div>
    );
  }

  if (jobsPoll.loading && jobsPoll.data === null) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-xl">
        <p className="flex items-center gap-2 text-sm text-gray-600" role="status">
          Loading this job…
        </p>
      </div>
    );
  }

  if (jobsPoll.error && jobsPoll.data === null) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-xl">
        <div className="rounded-xl border border-red-200 bg-red-50 p-5" role="alert">
          <p className="flex items-center gap-2 font-semibold text-red-800">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            We could not load this job.
          </p>
          <button
            type="button"
            onClick={() => void jobsPoll.refresh()}
            className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <EmptyState
        title="This job is not in your list"
        message="It may have been completed or reassigned. Your jobs page shows everything that is still yours."
        action={{ href: '/professional/jobs', label: 'Back to jobs' }}
      />
    );
  }

  const presentation = statusPresentation(job.status as BookingStatus);
  const snapshot = (job.address_snapshot ?? {}) as Record<string, unknown>;
  const addressLine = [snapshot.line1, snapshot.line2, snapshot.area, snapshot.city, snapshot.pincode]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(', ');
  const destinationLat = coordinate(snapshot.lat);
  const destinationLng = coordinate(snapshot.lng);
  const navigateHref =
    destinationLat !== null && destinationLng !== null
      ? `https://www.google.com/maps/dir/?api=1&destination=${destinationLat},${destinationLng}`
      : null;

  const startJourneyNow = async () => {
    setStarting(true);
    try {
      await startJourney(job.id);
      toast.success("You're on your way.");
      await jobsPoll.refresh();
    } catch (e) {
      toast.error(
        e instanceof ProfessionalApiError ? e.message : 'Something went wrong. Please try again.'
      );
    } finally {
      setStarting(false);
    }
  };

  const confirmArrival = async (reason?: string) => {
    setArriving(true);
    try {
      const position = await currentLocation();
      await arriveJob(job.id, {
        lat: position.lat,
        lng: position.lng,
        overrideReason: reason ?? null,
      });
      toast.success('Arrival confirmed.');
      setGeofence(null);
      setOverrideReason('');
      await jobsPoll.refresh();
    } catch (e) {
      if (e instanceof ProfessionalApiError) {
        if (e.status === 422 && e.details?.reason === 'outside_arrival_radius') {
          setGeofence({
            distanceM: typeof e.details.distanceM === 'number' ? e.details.distanceM : null,
            radiusM: typeof e.details.radiusM === 'number' ? e.details.radiusM : 0,
          });
          return;
        }
        toast.error(e.message);
      } else {
        toast.error(
          e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.'
        );
      }
    } finally {
      setArriving(false);
    }
  };

  const submitOtp = async (code: string): Promise<boolean> => {
    try {
      await verifyServiceOtp(job.id, code);
      toast.success('Job started.');
      setOtpFailures(0);
      await jobsPoll.refresh();
      return true;
    } catch (e) {
      setOtpFailures((count) => count + 1);
      toast.error(
        e instanceof ProfessionalApiError
          ? e.message
          : 'Something went wrong. Please try again.'
      );
      return false;
    }
  };

  const completeNow = async () => {
    setCompleting(true);
    try {
      const result = await completeJob(job.id);
      setFinishedJob(result.job);
      setConfirmComplete(false);
      toast.success('Job completed.');
      await jobsPoll.refresh();
    } catch (e) {
      toast.error(
        e instanceof ProfessionalApiError ? e.message : 'Something went wrong. Please try again.'
      );
    } finally {
      setCompleting(false);
    }
  };

  const submitNoShow = async () => {
    setNoShowing(true);
    try {
      const result = await reportNoShow(job.id, noShowReason.trim());
      setFinishedJob(result.job);
      setNoShowOpen(false);
      setNoShowReason('');
      toast.success('Job cancelled.');
      await jobsPoll.refresh();
    } catch (e) {
      toast.error(
        e instanceof ProfessionalApiError ? e.message : 'Something went wrong. Please try again.'
      );
    } finally {
      setNoShowing(false);
    }
  };

  // Interaction Contract 2: at zero the Complete job CTA is emphasised; early,
  // it still completes but only behind a confirmation. Both compare the two
  // server-supplied instants — the device clock is never consulted.
  const timeUp =
    job.status === 'in_progress' &&
    !!job.ends_at &&
    !!serverNow &&
    new Date(job.ends_at).getTime() <= new Date(serverNow).getTime();

  return (
    <div className="space-y-6">
      <Link
        href="/professional/jobs"
        className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-blue-100 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All jobs
      </Link>

      <div className="rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex flex-wrap items-center gap-3">
          <BookingStatusBadge status={job.status} />
          <span className="text-xs font-semibold text-gray-500">{job.booking_number}</span>
        </div>
        <p className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <Clock className="h-4 w-4 text-gray-400" aria-hidden="true" />
          {job.scheduled_start_at ? formatDateTime(job.scheduled_start_at) : 'Time to be confirmed'}
        </p>
        <p className="mt-1 flex items-center gap-2 text-sm text-gray-700">
          <Timer className="h-4 w-4 text-gray-400" aria-hidden="true" />
          {job.duration_minutes} minutes
        </p>
        <p className="mt-1 flex items-center gap-2 text-sm text-gray-700">
          <Navigation className="h-4 w-4 text-gray-400" aria-hidden="true" />
          You earn {job.professional_gross ?? job.total_amount}
        </p>
      </div>

      <div className="rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <MapPin className="h-4 w-4 text-gray-400" aria-hidden="true" />
          Job address
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          {addressLine || 'The address is not available yet.'}
        </p>
        {typeof snapshot.landmark === 'string' && snapshot.landmark.trim() ? (
          <p className="mt-1 text-sm text-gray-600">Landmark: {snapshot.landmark}</p>
        ) : null}
        {typeof snapshot.access_notes === 'string' && snapshot.access_notes.trim() ? (
          <p className="mt-1 text-sm text-gray-600">{snapshot.access_notes}</p>
        ) : null}
        {navigateHref ? (
          <a
            href={navigateHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Navigation className="h-4 w-4" aria-hidden="true" />
            Navigate
          </a>
        ) : null}
      </div>

      <div className="rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-sm font-semibold text-gray-900">{presentation.label}</h2>

        {job.status === 'accepted' ? (
          <div className="mt-3">
            <p className="text-sm text-gray-600">{ACTION_HINTS[job.status]}</p>
            <button
              type="button"
              onClick={() => void startJourneyNow()}
              disabled={starting}
              aria-busy={starting}
              className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:w-auto"
            >
              <Navigation className="h-4 w-4" aria-hidden="true" />
              On my way
            </button>
          </div>
        ) : job.status === 'on_the_way' ? (
          <div className="mt-3">
            <p className="text-sm text-gray-600">{ACTION_HINTS[job.status]}</p>
            <button
              type="button"
              onClick={() => void confirmArrival()}
              disabled={arriving}
              aria-busy={arriving}
              className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:w-auto"
            >
              Confirm arrival
            </button>
          </div>
        ) : job.status === 'arrived' ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-gray-600">{ACTION_HINTS[job.status]}</p>
            <OtpEntry
              onSubmit={submitOtp}
              helperText={
                otpFailures >= PLATFORM_DEFAULTS.otpMaxAttempts
                  ? `Too many attempts — try again in ${PLATFORM_DEFAULTS.otpLockoutMinutes} minutes.`
                  : null
              }
            />
          </div>
        ) : job.status === 'in_progress' ? (
          <div className="mt-3 space-y-3">
            <ServiceTimer endsAt={job.ends_at} serverNow={serverNow} />
            <p className="text-sm text-gray-600">{ACTION_HINTS[job.status]}</p>
            <button
              type="button"
              onClick={() => (timeUp ? void completeNow() : setConfirmComplete(true))}
              disabled={completing}
              aria-busy={completing}
              className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:w-auto ${
                timeUp
                  ? 'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500'
                  : 'bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-500'
              }`}
            >
              <CheckCircle className="h-4 w-4" aria-hidden="true" />
              Complete job
            </button>
            <button
              type="button"
              onClick={() => setNoShowOpen(true)}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
              Cancel job
            </button>
          </div>
        ) : job.status === 'completed' ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-green-700">
            <CheckCircle className="h-4 w-4" aria-hidden="true" />
            {ACTION_HINTS[job.status]}
          </p>
        ) : (
          <p className="mt-2 text-sm text-gray-600">
            {ACTION_HINTS[job.status] ?? presentation.description}
          </p>
        )}
      </div>

      {confirmComplete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="complete-early-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="complete-early-title" className="text-base font-semibold text-gray-900">
              Complete this job early?
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              The timer has not finished. The customer will see this job as complete.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmComplete(false)}
                className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => void completeNow()}
                disabled={completing}
                aria-busy={completing}
                className="inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              >
                Complete job
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {noShowOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="no-show-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="no-show-title" className="flex items-center gap-2 text-base font-semibold text-gray-900">
              <XCircle className="h-4 w-4 text-red-600" aria-hidden="true" />
              Cancel this job?
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              The customer will be notified and this is recorded against your account. A reason is
              required.
            </p>
            <label
              htmlFor="no-show-reason"
              className="mt-4 block text-sm font-medium text-gray-700"
            >
              Why could the job not run?
            </label>
            <select
              id="no-show-reason"
              value={noShowReason}
              onChange={(event) => setNoShowReason(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="">Select a reason</option>
              <option value="Customer not available">Customer not available</option>
              <option value="Customer unreachable">Customer unreachable</option>
              <option value="Address not found">Address not found</option>
              <option value="Access refused">Access refused</option>
            </select>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setNoShowOpen(false);
                  setNoShowReason('');
                }}
                className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => void submitNoShow()}
                disabled={noShowing || noShowReason.trim() === ''}
                aria-busy={noShowing}
                className="inline-flex min-h-11 items-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
              >
                Cancel job
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {geofence ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="arrival-override-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="arrival-override-title" className="text-base font-semibold text-gray-900">
              You are outside the job address
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              {geofence.distanceM === null
                ? 'We could not measure your distance to this address.'
                : `You are ${geofence.distanceM} m away; the allowed radius is ${geofence.radiusM} m.`}{' '}
              Confirm only if you really are at the address — your reason is recorded.
            </p>

            <label
              htmlFor="arrival-override-reason"
              className="mt-4 block text-sm font-medium text-gray-700"
            >
              Why are you confirming here?
            </label>
            <textarea
              id="arrival-override-reason"
              rows={3}
              maxLength={500}
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder="Gate is locked, I am at the side entrance…"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            />

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setGeofence(null);
                  setOverrideReason('');
                }}
                className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmArrival(overrideReason.trim())}
                disabled={arriving || overrideReason.trim() === ''}
                aria-busy={arriving}
                className="inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              >
                Confirm arrival
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ProfessionalJobDetailPage({ params }: { params: { id: string } }) {
  return (
    <AuthGuard role="professional" capability="offer.accept">
      <RoleShell role="professional" eyebrow="Professional" title="Job details">
        <JobDetail id={params.id} />
      </RoleShell>
    </AuthGuard>
  );
}
