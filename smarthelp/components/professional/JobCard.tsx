'use client';

import Link from 'next/link';
import { ChevronRight, Clock, MapPin } from 'lucide-react';
import { BookingStatusBadge } from '@/components/catalogue/PriceBreakdown';
import type { ProJob } from '@/lib/professionalClient';

/**
 * A job the professional already owns (§20.7).
 *
 * Unlike the offer card, the address is present — the job is theirs — so the
 * card shows the area and links to the job-detail flow. The status chip comes
 * from `statusPresentation` (via `BookingStatusBadge`): Interaction Contract 5
 * forbids inventing a status colour, so there is none here.
 *
 * It links to `/professional/jobs/[id]`, which Task B3 builds. A job with no
 * next action on this screen is still a doorway to the flow that has one.
 */
export function JobCard({ job }: { job: ProJob }) {
  return (
    <Link
      href={`/professional/jobs/${job.id}`}
      className="block rounded-2xl bg-white p-6 shadow-xl transition-shadow hover:shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookingStatusBadge status={job.status} />
            <span className="truncate text-xs font-semibold text-gray-500">
              {job.booking_number}
            </span>
          </div>
          <p className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <Clock className="h-4 w-4 text-gray-400" aria-hidden="true" />
            {formatWindow(job.scheduled_start_at, job.scheduled_end_at)}
          </p>
          {job.area ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-gray-600">
              <MapPin className="h-4 w-4 text-gray-400" aria-hidden="true" />
              {job.area}
            </p>
          ) : null}
        </div>
        <ChevronRight className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
      </div>
    </Link>
  );
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start) return 'Time to be confirmed';
  const startDate = new Date(start);
  const date = startDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const startTime = startDate.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (!end) return `${date} · ${startTime}`;
  const endTime = new Date(end).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${date} · ${startTime} – ${endTime}`;
}
