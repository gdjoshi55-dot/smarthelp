import { CUSTOMER_LADDER, statusPresentation } from '@/lib/status';

/**
 * The customer's booking stepper (§20.6).
 *
 * Renders `CUSTOMER_LADDER` and marks where the booking is. It does not decide
 * what the steps are — `lib/status.ts` owns the ladder, the aliases that fold
 * off-ladder states (`searching` reads as "Paid") and the presentation for each
 * one, all derived from the same transition table the database enforces. A
 * stepper that hard-coded its own labels would be a third copy of a table that
 * is already duplicated once, and it would disagree the first time §8.2 changed.
 *
 * The current step carries `aria-current="step"`, so the position is announced
 * rather than only coloured.
 */

export interface TimelineEntry {
  from_status: string | null;
  to_status: string;
  actor_role: string | null;
  created_at: string;
}

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function BookingTimeline({
  status,
  history,
}: {
  status: string;
  history?: TimelineEntry[];
}) {
  const presentation = statusPresentation(status as never);
  const currentStep = presentation.step;

  // A state that is not on the ladder at all — `cancelled` before the work
  // started, `refunded` after it — has no step to mark, so the ladder is not
  // rendered at all and the history below carries the story instead.
  if (currentStep == null) {
    return (
      <div>
        <p className="text-sm font-medium text-gray-900">{presentation.label}</p>
        <p className="mt-1 text-sm text-gray-600">{presentation.description}</p>
        {history && history.length > 0 ? <HistoryList entries={history} /> : null}
      </div>
    );
  }

  return (
    <div>
      <ol className="space-y-0">
        {CUSTOMER_LADDER.map((step, index) => {
          const done = index < currentStep;
          const current = index === currentStep;
          const stepPresentation = statusPresentation(step);

          return (
            <li key={step} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden="true"
                  className={`mt-1 flex h-3 w-3 shrink-0 items-center justify-center rounded-full border-2 ${
                    current
                      ? 'border-blue-600 bg-blue-600'
                      : done
                        ? 'border-blue-600 bg-blue-600'
                        : 'border-gray-300 bg-white'
                  }`}
                />
                {index < CUSTOMER_LADDER.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className={`w-0.5 flex-1 ${done ? 'bg-blue-600' : 'bg-gray-200'}`}
                  />
                ) : null}
              </div>
              <div className="pb-5">
                <p
                  aria-current={current ? 'step' : undefined}
                  className={`text-sm ${current ? 'font-semibold text-gray-900' : done ? 'text-gray-700' : 'text-gray-400'}`}
                >
                  {stepPresentation.label}
                  {current ? <span className="sr-only"> (current step)</span> : null}
                </p>
                {current && stepPresentation.description ? (
                  <p className="mt-0.5 text-xs text-gray-600">{stepPresentation.description}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {history && history.length > 0 ? <HistoryList entries={history} /> : null}
    </div>
  );
}

function HistoryList({ entries }: { entries: TimelineEntry[] }) {
  // Newest first: what a customer wants to know is what just happened.
  const ordered = [...entries].reverse();
  return (
    <details className="mt-2 rounded-lg bg-gray-50 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-gray-700">
        Status history ({entries.length})
      </summary>
      <ul className="mt-2 space-y-1.5">
        {ordered.map((entry, index) => (
          <li key={`${entry.to_status}-${index}`} className="text-xs text-gray-600">
            <span className="font-medium text-gray-800">
              {statusPresentation(entry.to_status as never).label}
            </span>
            {entry.from_status ? (
              <span> from {statusPresentation(entry.from_status as never).label}</span>
            ) : null}
            <span className="text-gray-500"> · {when(entry.created_at)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}