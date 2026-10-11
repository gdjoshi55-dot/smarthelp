'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

/**
 * The running job's remaining time (§22.3, Interaction Contract 2).
 *
 * The arithmetic is `ends_at − serverNow`, and both terms come from the server:
 * the endpoint that answers a poll stamps `serverNow` when it reads the row, and
 * `ends_at` was written by `verify_service_otp`. Between polls the component
 * ticks locally once a second, and re-anchors itself whenever a poll hands it a
 * fresh pair — so a device whose clock is ten minutes fast still shows the
 * honest number, and a backgrounded tab that missed a minute catches up on the
 * next poll instead of drifting.
 *
 * No `Date.now()` appears here by design. A timer that compared the server's
 * expiry against the phone's own clock is exactly the drift this contract
 * forbids, and it cannot be tested at the boundary where it matters.
 */
function remainingSeconds(endsAt: string | null | undefined, serverNow: string | null | undefined) {
  if (!endsAt || !serverNow) return null;
  const end = Date.parse(endsAt);
  const now = Date.parse(serverNow);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round((end - now) / 1000));
}

export function ServiceTimer({
  endsAt,
  serverNow,
  className,
}: {
  endsAt: string | null | undefined;
  serverNow: string | null | undefined;
  className?: string;
}) {
  const [remaining, setRemaining] = useState<number | null>(() =>
    remainingSeconds(endsAt, serverNow)
  );

  useEffect(() => {
    const anchored = remainingSeconds(endsAt, serverNow);
    setRemaining(anchored);
    if (anchored === null) return;

    const id = window.setInterval(() => {
      setRemaining((current) => (current === null ? current : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [endsAt, serverNow]);

  if (remaining === null) return null;

  if (remaining <= 0) {
    return (
      <p
        className={`flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 ${
          className ?? ''
        }`}
        role="status"
      >
        <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
        Time&apos;s up
      </p>
    );
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const clock = `${minutes}:${String(seconds).padStart(2, '0')}`;

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 ${
        className ?? ''
      }`}
      role="timer"
      aria-label={`${minutes} minutes ${seconds} seconds remaining`}
    >
      <Clock className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
      <span className="text-xl font-semibold tabular-nums text-amber-900">{clock}</span>
      <span className="text-sm text-amber-800">left on this job</span>
    </div>
  );
}
