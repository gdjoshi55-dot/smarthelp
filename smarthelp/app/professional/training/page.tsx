'use client';

import Link from 'next/link';
import { BookOpen, CheckCircle2, Clock, GraduationCap, ShieldCheck } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';

/**
 * `/professional/training` (§4, §20.10).
 *
 * Training is a gate on going live — the matching engine excludes a professional
 * whose `training_status` is not `completed` (`lib/availabilityServer.ts`) — but
 * the content itself is delivered out of band, so this page reports the status
 * and what the modules cover rather than pretending to play them in the browser.
 * The status is read from the database through `/api/auth/me`; there is no client
 * write here, because only staff move it.
 */

const MODULES: { title: string; blurb: string; minutes: number }[] = [
  {
    title: 'Safety and conduct',
    blurb: 'Arriving at a customer’s home, boundaries, and what to do when something feels wrong.',
    minutes: 20,
  },
  {
    title: 'Service quality standards',
    blurb: 'What “done” looks like for each service, and how the quality score is calculated.',
    minutes: 25,
  },
  {
    title: 'The service OTP and job flow',
    blurb: 'On the way, arriving, the customer’s code, completing a job, and no-shows.',
    minutes: 15,
  },
  {
    title: 'Earnings, payouts and commission',
    blurb: 'How your net is worked out and when money reaches your account.',
    minutes: 15,
  },
];

const STATUS: Record<string, { label: string; tone: string; blurb: string }> = {
  not_started: {
    label: 'Not started',
    tone: 'bg-gray-100 text-gray-700',
    blurb: 'Training opens once your documents are approved. You will be guided through it here.',
  },
  in_progress: {
    label: 'In progress',
    tone: 'bg-amber-100 text-amber-800',
    blurb: 'You are part-way through. Finish every module to start receiving job offers.',
  },
  completed: {
    label: 'Completed',
    tone: 'bg-green-100 text-green-800',
    blurb: 'You are trained. Keep your availability online to receive jobs.',
  },
};

function TrainingView() {
  const { professional } = useAuth();
  const status = professional?.training_status ?? 'not_started';
  const copy = STATUS[status] ?? STATUS.not_started;
  const complete = status === 'completed';

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-6">
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
              <GraduationCap className="h-5 w-5 text-gray-400" aria-hidden="true" />
              Onboarding training
            </h2>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${copy.tone}`}>
              {copy.label}
            </span>
          </div>
          <p className="mt-2 text-sm text-gray-600">{copy.blurb}</p>

          <ul className="mt-5 divide-y divide-gray-100">
            {MODULES.map((module) => (
              <li key={module.title} className="flex items-start gap-3 py-3">
                <span className="mt-0.5 shrink-0">
                  {complete ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />
                  ) : (
                    <BookOpen className="h-5 w-5 text-gray-400" aria-hidden="true" />
                  )}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{module.title}</p>
                  <p className="text-xs text-gray-500">{module.blurb}</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-gray-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {module.minutes} min
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="space-y-6">
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
            <ShieldCheck className="h-4 w-4 text-gray-400" aria-hidden="true" />
            Why it matters
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Job offers reach only professionals who are verified, trained and online. Completing
            training is what unlocks offers in your area.
          </p>
        </section>

        {status !== 'completed' ? (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
            <h2 className="text-base font-semibold text-amber-900">Next step</h2>
            <p className="mt-1 text-sm text-amber-800">
              {status === 'not_started'
                ? 'Upload your documents first; training is scheduled once they are approved.'
                : 'Finish the remaining modules to go live.'}
            </p>
            <Link
              href="/professional/kyc"
              className="mt-3 inline-flex items-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              Go to verification
            </Link>
          </section>
        ) : (
          <section className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-5">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
            <p className="text-sm text-green-900">
              Training complete. Keep your availability online to receive jobs.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

export default function ProfessionalTrainingPage() {
  return (
    <AuthGuard role="professional">
      <RoleShell role="professional" eyebrow="Professional" title="Training">
        <TrainingView />
      </RoleShell>
    </AuthGuard>
  );
}
